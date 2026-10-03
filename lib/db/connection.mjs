// Database connection helpers extracted from bin/hcc.mjs.
// Factory pattern: callers inject the functions that remain in bin/hcc.mjs
// (now, dedupePeerBindings, redactedLogText) while everything else is imported
// directly from lib/ modules.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { CliError } from '../shared/errors.mjs';
import {
  DB_SCHEMA_VERSION,
  execWithBusyRetry
} from './schema.mjs';
import { initSchemaWithBackup } from './migration-backup.mjs';
import { readProjectRegistry } from '../runtime/projects.mjs';
import { resolveProjectDatabase, secureExistingProjectStateDirectory } from '../runtime/project-path.mjs';

const MIGRATION_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

function managedDatabase(ctx) {
  if (!ctx.root) return false;
  const requestedRoot = path.resolve(ctx.root);
  let canonicalRoot = requestedRoot;
  try { canonicalRoot = fs.realpathSync.native(requestedRoot); } catch {}
  const requestedDb = path.resolve(ctx.dbPath);
  let canonicalCandidate = requestedDb;
  try {
    canonicalCandidate = path.join(fs.realpathSync.native(path.dirname(requestedDb)), path.basename(requestedDb));
  } catch {}
  return [requestedRoot, canonicalRoot].some(root =>
    [requestedDb, canonicalCandidate].some(db => {
      const relative = path.relative(path.join(root, '.hello-cc'), db);
      return relative !== '' && relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }));
}

function secureManagedDatabaseFile(dbPath, create) {
  let stat;
  try { stat = fs.lstatSync(dbPath); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!create) throw new CliError('NOT_FOUND', `Project database does not exist: ${dbPath}`);
    try {
      const fd = fs.openSync(dbPath, fs.constants.O_RDWR | fs.constants.O_CREAT |
        fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.closeSync(fd);
    } catch (creationError) {
      if (creationError?.code !== 'EEXIST') throw creationError;
    }
    stat = fs.lstatSync(dbPath);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new CliError('PROJECT_PATH_FORBIDDEN', `Project database must be an owned regular file: ${dbPath}`);
  }
  const fd = fs.openSync(dbPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new CliError('PROJECT_PATH_FORBIDDEN', `Project database changed during validation: ${dbPath}`);
    }
    if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
    const current = fs.lstatSync(dbPath);
    if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new CliError('PROJECT_PATH_FORBIDDEN', `Project database changed during validation: ${dbPath}`);
    }
  } finally { fs.closeSync(fd); }
}

export function createConnectionHelpers({ now, dedupePeerBindings, redactedLogText }) {
  let projectMigrationFanoutDepth = 0;
  const migratedRegisteredProjectDbs = new Set();

  function connect(ctx, options = {}) {
    let dbPath = ctx.dbPath;
    if (managedDatabase(ctx)) {
      if (options.create !== false && !fs.existsSync(ctx.root)) {
        fs.mkdirSync(ctx.root, { recursive: true });
      }
      const resolved = resolveProjectDatabase({
        root: ctx.root,
        db: dbPath,
        createStateDir: options.create !== false,
        createDatabaseParents: options.create !== false
      });
      dbPath = resolved.db;
      if (options.create === false) secureExistingProjectStateDirectory(resolved.root);
      secureManagedDatabaseFile(dbPath, options.create !== false);
    } else {
      if (options.create === false && !fs.existsSync(dbPath)) {
        throw new CliError('NOT_FOUND', `Project database does not exist: ${dbPath}`);
      }
      if (options.create !== false) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    db.exec('PRAGMA busy_timeout = 5000;');
    execWithBusyRetry(db, 'PRAGMA journal_mode = WAL;', { ignoreBusy: true });
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA wal_autocheckpoint = 1000;');
    db.exec('PRAGMA foreign_keys = ON;');
    initSchemaWithBackup(db, dbPath, {
      beforePostMigrationIndexes: dedupePeerBindings
    });
    if (options.migrateRegistered !== false) migrateRegisteredProjectDbs(ctx);
    return db;
  }

  function connectReadOnly(ctx) {
    const dbPath = managedDatabase(ctx)
      ? resolveProjectDatabase({ root: ctx.root, db: ctx.dbPath, createStateDir: false }).db
      : ctx.dbPath;
    if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
      throw new CliError('NOT_FOUND', `Project database does not exist: ${dbPath}`);
    }
    return new DatabaseSync(dbPath, { timeout: 5000, readOnly: true });
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
          secureExistingProjectStateDirectory(root);
          secureManagedDatabaseFile(dbPath, false);
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
