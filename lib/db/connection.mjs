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
import { projectStateDir, legacyProjectStateDir } from '../runtime/paths.mjs';
import { privateProjectStateDir, ensurePrivateProjectStateDir } from '../runtime/private-state.mjs';
import { unsafeDirectoryAcl } from '../runtime/project-trust.mjs';
import { assertSelectedCwdSnapshot } from '../process/selected-cwd-identity.mjs';

const MIGRATION_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

function managedDatabase(ctx) {
  if (!ctx.root) return false;
  const requestedRoot = path.resolve(ctx.root);
  let canonicalRoot = requestedRoot;
  try { canonicalRoot = fs.realpathSync.native(requestedRoot); } catch {}
  const requestedDb = path.resolve(ctx.dbPath);
  let canonicalCandidate = requestedDb;
  let parent = path.dirname(requestedDb);
  const missingParents = [];
  for (;;) {
    try {
      canonicalCandidate = path.join(fs.realpathSync.native(parent),
        ...missingParents, path.basename(requestedDb));
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT' || path.dirname(parent) === parent) break;
      missingParents.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
  }
  const candidates = new Set([requestedDb, canonicalCandidate]);
  try { candidates.add(fs.realpathSync.native(requestedDb)); } catch {}
  const within = (parent, candidate) => {
    const relative = path.relative(parent, candidate);
    return relative !== '' && relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const managed = [requestedRoot, canonicalRoot].some(root =>
    [legacyProjectStateDir(root), privateProjectStateDir(root)].some(stateDir =>
      [...candidates].some(db => within(stateDir, db))));
  if (managed) return true;
  // A context may have captured A's local or private .hello-cc DB before its
  // root alias was repointed to B. A reserved state path is never an explicit
  // external DB just because it no longer belongs to the current root.
  const reservedStatePath = db => path.dirname(db).split(path.sep).some(segment =>
    segment.toLowerCase() === '.hello-cc');
  if ([...candidates].some(reservedStatePath)) {
    throw new CliError('PROJECT_PATH_FORBIDDEN',
      `Private database path is not bound to the current project root: ${requestedDb}`);
  }
  return false;
}

function secureOwnedSqliteFile(file, { create = false, readOnly = false, optional = false } = {}) {
  const changed = () => new CliError('PROJECT_PATH_FORBIDDEN', `SQLite file changed during validation: ${file}`);
  const safeStat = stat => stat && !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
    (process.platform === 'win32' || (stat.mode & 0o022) === 0) &&
    !unsafeDirectoryAcl(file, stat);
  const stillSame = (current, original) => safeStat(current) &&
    current.dev === original.dev && current.ino === original.ino;
  const recheck = () => {
    try { return fs.lstatSync(file); }
    catch (error) {
      if (!optional || error?.code !== 'ENOENT') throw error;
      // An optional WAL/SHM/journal may disappear as SQLite closes its last
      // connection. Do not accept a different file rebuilt at the same path.
      try { fs.lstatSync(file); }
      catch (again) {
        if (again?.code === 'ENOENT') return null;
        throw again;
      }
      throw changed();
    }
  };
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!create) return false;
    try {
      const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT |
        fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.closeSync(fd);
    } catch (creationError) {
      if (creationError?.code !== 'EEXIST') throw creationError;
    }
    stat = fs.lstatSync(file);
  }
  if (!safeStat(stat)) {
    // ACL inspection invokes ls and may outlive a retiring optional sidecar.
    // Missing is safe to skip; a rebuilt or otherwise unsafe file is not.
    if (optional && !recheck()) return false;
    throw new CliError('PROJECT_PATH_FORBIDDEN', `SQLite file must be an owned non-writable regular file: ${file}`);
  }
  // Never open/close an existing SQLite file outside SQLite: on POSIX, close()
  // can release locks held by another SQLite connection in this process.
  const current = recheck();
  if (!current) return false;
  if (!stillSame(current, stat)) throw changed();
  if (!readOnly && process.platform !== 'win32' && (current.mode & 0o777) !== 0o600) {
    try { fs.chmodSync(file, 0o600); }
    catch (error) {
      if (!optional || error?.code !== 'ENOENT') throw error;
      if (!recheck()) return false;
      throw changed();
    }
    const tightened = recheck();
    if (!tightened) return false;
    if (!stillSame(tightened, stat) || (tightened.mode & 0o777) !== 0o600) throw changed();
  }
  return true;
}

function secureManagedDatabaseFile(dbPath, create, readOnly = false) {
  if (!secureOwnedSqliteFile(dbPath, { create, readOnly })) {
    throw new CliError('NOT_FOUND', `Project database does not exist: ${dbPath}`);
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    secureOwnedSqliteFile(`${dbPath}${suffix}`, { readOnly, optional: true });
  }
}

export function createConnectionHelpers({ now, dedupePeerBindings, redactedLogText }) {
  let projectMigrationFanoutDepth = 0;
  const migratedRegisteredProjectDbs = new Set();

  function connect(ctx, options = {}) {
    if (ctx.initialRootIdentity) assertSelectedCwdSnapshot(ctx.initialRootIdentity);
    let dbPath = ctx.dbPath;
    if (managedDatabase(ctx)) {
      const rootWasMissing = options.create !== false && !fs.existsSync(ctx.root);
      const pendingDefault = rootWasMissing ? path.join(privateProjectStateDir(ctx.root), 'mesh.db') : null;
      if (options.create !== false && !fs.existsSync(ctx.root)) {
        fs.mkdirSync(ctx.root, { recursive: true });
      }
      if (rootWasMissing && path.resolve(dbPath) === pendingDefault) {
        dbPath = path.join(projectStateDir(ctx.root), 'mesh.db');
      }
      if (rootWasMissing && path.resolve(ctx.dbPath) === pendingDefault &&
          projectStateDir(ctx.root) === privateProjectStateDir(ctx.root)) {
        ensurePrivateProjectStateDir(ctx.root, { create: true });
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
    try {
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
    } catch (error) {
      try { db.close(); } catch {}
      throw error;
    }
  }

  function connectReadOnly(ctx) {
    if (ctx.initialRootIdentity) assertSelectedCwdSnapshot(ctx.initialRootIdentity);
    const managed = managedDatabase(ctx);
    const dbPath = managed
      ? resolveProjectDatabase({ root: ctx.root, db: ctx.dbPath, createStateDir: false }).db
      : ctx.dbPath;
    if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
      throw new CliError('NOT_FOUND', `Project database does not exist: ${dbPath}`);
    }
    if (managed) secureManagedDatabaseFile(dbPath, false, true);
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
            db: project.db || path.join(projectStateDir(project.root), 'mesh.db'),
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
