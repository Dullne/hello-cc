// Database connection helpers extracted from bin/hcc.mjs.
// Factory pattern: callers inject the functions that remain in bin/hcc.mjs
// (now, dedupePeerBindings, redactedLogText) while everything else is imported
// directly from lib/ modules.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CliError } from '../shared/errors.mjs';
import {
  DB_SCHEMA_VERSION,
  execWithBusyRetry
} from './schema.mjs';
import { initSchemaWithBackup } from './migration-backup.mjs';
import { readProjectRegistry } from '../runtime/projects.mjs';
import { resolveProjectDatabase } from '../runtime/project-path.mjs';

const MIGRATION_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export function createConnectionHelpers({ now, dedupePeerBindings, redactedLogText }) {
  let projectMigrationFanoutDepth = 0;
  const migratedRegisteredProjectDbs = new Set();

  function connect(ctx, options = {}) {
    if (options.create === false && !fs.existsSync(ctx.dbPath)) {
      throw new CliError('NOT_FOUND', `Project database does not exist: ${ctx.dbPath}`);
    }
    if (options.create !== false) fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
    const db = new DatabaseSync(ctx.dbPath, { timeout: 5000 });
    db.exec('PRAGMA busy_timeout = 5000;');
    execWithBusyRetry(db, 'PRAGMA journal_mode = WAL;', { ignoreBusy: true });
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA wal_autocheckpoint = 1000;');
    db.exec('PRAGMA foreign_keys = ON;');
    initSchemaWithBackup(db, ctx.dbPath, {
      beforePostMigrationIndexes: dedupePeerBindings
    });
    if (options.migrateRegistered !== false) migrateRegisteredProjectDbs(ctx);
    return db;
  }

  function connectReadOnly(ctx) {
    if (!fs.existsSync(ctx.dbPath) || !fs.statSync(ctx.dbPath).isFile()) {
      throw new CliError('NOT_FOUND', `Project database does not exist: ${ctx.dbPath}`);
    }
    return new DatabaseSync(ctx.dbPath, { timeout: 5000, readOnly: true });
  }

  function migrateRegisteredProjectDbs(ctx) {
    if (projectMigrationFanoutDepth > 0) return;
    projectMigrationFanoutDepth += 1;
    try {
      const currentDb = path.resolve(ctx.dbPath);
      const seen = new Set([currentDb]);
      for (const project of readProjectRegistry()) {
        let resolved;
        try {
          resolved = resolveProjectDatabase({
            root: project.root,
            db: project.db || path.join(project.root, '.hello-cc', 'mesh.db'),
            createStateDir: false
          });
        } catch (err) {
          console.error(redactedLogText(`[${new Date().toISOString()}] skipping registered project DB migration for ${project.db || project.root}: ${err?.message || err}`));
          continue;
        }
        const root = resolved.root;
        const dbPath = resolved.db;
        if (seen.has(dbPath)) continue;
        seen.add(dbPath);
        const cacheKey = `${dbPath}:${DB_SCHEMA_VERSION}`;
        if (migratedRegisteredProjectDbs.has(cacheKey)) continue;
        if (!fs.existsSync(root) || !fs.existsSync(dbPath)) continue;
        const failedMarker = `${dbPath}.migration-failed`;
        try {
          if (Date.now() - fs.statSync(failedMarker).mtimeMs < MIGRATION_FAILURE_COOLDOWN_MS) continue;
        } catch {}
        let db = null;
        try {
          db = new DatabaseSync(dbPath, { timeout: 5000 });
          db.exec('PRAGMA busy_timeout = 5000;');
          execWithBusyRetry(db, 'PRAGMA journal_mode = WAL;', { ignoreBusy: true });
          db.exec('PRAGMA synchronous = NORMAL;');
          db.exec('PRAGMA foreign_keys = ON;');
          initSchemaWithBackup(db, dbPath, {
            beforePostMigrationIndexes: dedupePeerBindings
          });
          migratedRegisteredProjectDbs.add(cacheKey);
          try { fs.rmSync(failedMarker, { force: true }); } catch {}
        } catch (err) {
          console.error(redactedLogText(`[${new Date().toISOString()}] skipping registered project DB migration for ${dbPath}: ${err?.message || err}`));
          try { fs.writeFileSync(failedMarker, String(now())); } catch {}
          continue;
        } finally {
          try { db?.close(); } catch {}
        }
      }
    } finally {
      projectMigrationFanoutDepth -= 1;
    }
  }

  return { connect, connectReadOnly, migrateRegisteredProjectDbs };
}
