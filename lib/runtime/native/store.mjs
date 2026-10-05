import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { CliError } from '../../shared/errors.mjs';
import { resolveProjectDatabase, ensurePrivateProjectStateSubdirectory } from '../project-path.mjs';
import { unsafeDirectoryAcl } from '../project-trust.mjs';
import { readPrivateTextFile } from '../private-file.mjs';

function statOrMissing(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function privateDatabase(file) {
  let stat = statOrMissing(file);
  if (!stat) {
    try {
      const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT |
        fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.closeSync(fd);
    } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    stat = fs.lstatSync(file);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) ||
      unsafeDirectoryAcl(file, stat)) {
    throw new CliError('NATIVE_STATE_UNSAFE', `Native database must be an owned regular file: ${file}`);
  }
  // Opening and closing an existing SQLite inode outside SQLite can cancel
  // this process's POSIX advisory locks held by another live connection.
  // The already-validated private parent prevents a different UID from
  // replacing the leaf, so metadata checks do not need a second raw fd.
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
  const current = fs.lstatSync(file);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
      current.dev !== stat.dev || current.ino !== stat.ino ||
      (typeof process.getuid === 'function' && current.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (current.mode & 0o777) !== 0o600) ||
      unsafeDirectoryAcl(file, current)) {
    throw new CliError('NATIVE_STATE_UNSAFE', `Native database changed during validation: ${file}`);
  }
}

export function nativePaths(ctx, { create = false } = {}) {
  const root = fs.realpathSync(ctx.root);
  let dir;
  try {
    resolveProjectDatabase({ root, createStateDir: create });
    dir = ensurePrivateProjectStateSubdirectory(root, 'native', { create });
  } catch (error) {
    if (error?.code === 'PROJECT_PATH_FORBIDDEN') {
      throw new CliError('NATIVE_STATE_UNSAFE', error.message);
    }
    throw error;
  }
  if (!dir) return null;
  for (const name of ['runtime.json', 'state.db', 'state.db-wal', 'state.db-shm', 'runtime.log']) {
    const file = path.join(dir, name);
    const stat = statOrMissing(file);
    if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) ||
        unsafeDirectoryAcl(file, stat))) {
      // SQLite removes its WAL/SHM sidecars when the last connection closes.
      // If one vanished between lstat and the ACL check, there is no unsafe
      // file left to validate; a replacement at the path must still fail.
      if ((name === 'state.db-wal' || name === 'state.db-shm') && !statOrMissing(file)) continue;
      throw new CliError('NATIVE_STATE_UNSAFE', `Native state file is not a regular file: ${file}`);
    }
  }
  return { dir, pointer: path.join(dir, 'runtime.json'), db: path.join(dir, 'state.db'), log: path.join(dir, 'runtime.log') };
}

export function writeNativePointer(ctx, value) {
  const paths = nativePaths(ctx, { create: true });
  const temporary = path.join(paths.dir, `.runtime-${randomBytes(12).toString('hex')}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, paths.pointer); }
  finally { fs.rmSync(temporary, { force: true }); }
}

export function readNativePointer(ctx) {
  const paths = nativePaths(ctx);
  if (!paths) return null;
  let raw;
  try { raw = readPrivateTextFile(paths.pointer, { maxBytes: 16384 }); }
  catch (error) {
    if (error?.code === 'PROJECT_PATH_FORBIDDEN') {
      throw new CliError('NATIVE_STATE_UNSAFE', error.message);
    }
    throw error;
  }
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new CliError('NATIVE_STATE_INVALID', 'Native runtime pointer is invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.root !== fs.realpathSync(ctx.root) || value.meshDb !== path.resolve(ctx.dbPath) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.token !== 'string' || value.token.length < 32 || value.token.length > 256 ||
      typeof value.generation !== 'string' || !value.generation || value.generation.length > 128) {
    throw new CliError('NATIVE_STATE_INVALID', 'Native runtime pointer does not match this project');
  }
  return value;
}

export function parseNativeCwdIdentity(value, cwd) {
  let record;
  try { record = JSON.parse(value || 'null'); } catch { return null; }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1 ||
      record.requested !== cwd || record.canonical !== cwd ||
      !record.identity || typeof record.identity !== 'object' ||
      typeof record.identity.dev !== 'string' || typeof record.identity.ino !== 'string' ||
      !/^\d+$/.test(record.identity.dev) || !/^\d+$/.test(record.identity.ino) ||
      !(record.identity.birthtimeNs === null ||
        (typeof record.identity.birthtimeNs === 'string' && /^\d+$/.test(record.identity.birthtimeNs)))) return null;
  return record;
}

export function createNativeStore(ctx) {
  const paths = nativePaths(ctx, { create: true });
  privateDatabase(paths.db);
  const db = new DatabaseSync(paths.db, { timeout: 5000 });
  try {
    db.exec(`PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS workers (
      peer TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT,
      cwd TEXT NOT NULL, cwd_identity TEXT, status TEXT NOT NULL, updated_at INTEGER NOT NULL, sandbox TEXT
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY, peer TEXT NOT NULL, message_id INTEGER NOT NULL,
      submission_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, turn_id TEXT,
      detail TEXT, origin TEXT NOT NULL DEFAULT 'peer', updated_at INTEGER NOT NULL, UNIQUE(peer, message_id)
    );
    CREATE TABLE IF NOT EXISTS provider_events (
      id INTEGER PRIMARY KEY, peer TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );`);
  // Existing deliveries came from the shared message bus. Migration must not
  // promote a stored sender name into user authority.
    if (!db.prepare('PRAGMA table_info(deliveries)').all().some(column => column.name === 'origin')) {
      db.exec("ALTER TABLE deliveries ADD COLUMN origin TEXT NOT NULL DEFAULT 'peer'");
    }
    // Historical workers keep a null identity until a new owned worker records
    // one. Never infer a saved session's identity from today's pathname.
    if (!db.prepare('PRAGMA table_info(workers)').all().some(column => column.name === 'cwd_identity')) {
      db.exec('ALTER TABLE workers ADD COLUMN cwd_identity TEXT');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('PRAGMA table_info(workers)').all().some(column => column.name === 'sandbox')) {
        // Only the legacy schema implies the former workspace-write default.
        // A missing value in the new schema must never escalate on reopen.
        db.exec(`ALTER TABLE workers ADD COLUMN sandbox TEXT;
          UPDATE workers SET sandbox='workspace-write' WHERE provider='codex';`);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
      throw error;
    }
  } catch (error) {
    try { db.close(); } catch { /* Preserve the initialization failure. */ }
    throw error;
  }
  const now = () => Date.now();
  return {
    db,
    worker(peer) { return db.prepare('SELECT * FROM workers WHERE peer = ?').get(peer) || null; },
    workers() { return db.prepare('SELECT * FROM workers ORDER BY peer').all(); },
    saveWorker(worker) {
      const previous = this.worker(worker.peer);
      const sandbox = worker.provider === 'codex'
        ? worker.sandbox === undefined ? previous ? previous.sandbox : 'workspace-write' : worker.sandbox
        : worker.sandbox ?? null;
      if ((worker.provider === 'codex' && !['read-only', 'workspace-write'].includes(sandbox)) ||
          (worker.provider !== 'codex' && sandbox !== null)) {
        throw new CliError('BAD_ARGS', 'Only Codex workers support read-only or workspace-write sandbox policies');
      }
      if (previous?.provider === worker.provider && previous.session_id && previous.sandbox !== sandbox) {
        throw new CliError('NATIVE_SANDBOX_MISMATCH', 'A saved native session cannot change its sandbox policy');
      }
      const cwdIdentity = worker.cwdIdentity ? JSON.stringify({ version: 1,
        requested: worker.cwdIdentity.requested, canonical: worker.cwdIdentity.canonical,
        identity: worker.cwdIdentity.identity }) : null;
      db.prepare(`INSERT INTO workers(peer, provider, session_id, cwd, cwd_identity, status, updated_at, sandbox) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(peer) DO UPDATE SET provider=excluded.provider, session_id=COALESCE(excluded.session_id,workers.session_id),
        cwd=excluded.cwd, cwd_identity=COALESCE(excluded.cwd_identity,workers.cwd_identity),
        status=excluded.status, updated_at=excluded.updated_at, sandbox=excluded.sandbox`)
        .run(worker.peer, worker.provider, worker.sessionId || null, worker.cwd, cwdIdentity, worker.status, now(), sandbox);
    },
    queue(peer, messageId, submissionId, origin = 'peer') {
      if (!['peer', 'user'].includes(origin)) throw new CliError('BAD_ARGS', 'Unknown native message origin');
      db.prepare(`INSERT OR IGNORE INTO deliveries(peer,message_id,submission_id,state,origin,updated_at) VALUES (?,?,?,'queued',?,?)`)
        .run(peer, messageId, submissionId, origin, now());
      return this.delivery(peer, messageId);
    },
    delivery(peer, messageId) { return db.prepare('SELECT * FROM deliveries WHERE peer=? AND message_id=?').get(peer, messageId) || null; },
    pending(peer) { return db.prepare("SELECT * FROM deliveries WHERE peer=? AND state='queued' ORDER BY id LIMIT 1").get(peer) || null; },
    updateDelivery(id, state, turnId = null, detail = null) {
      db.prepare('UPDATE deliveries SET state=?,turn_id=COALESCE(?,turn_id),detail=?,updated_at=? WHERE id=?')
        .run(state, turnId, detail ? JSON.stringify(detail) : null, now(), id);
    },
    deliveries(peer = null) {
      return peer ? db.prepare('SELECT * FROM deliveries WHERE peer=? ORDER BY id DESC LIMIT 100').all(peer)
        : db.prepare('SELECT * FROM deliveries ORDER BY id DESC LIMIT 100').all();
    },
    event(peer, payload) {
      db.prepare('INSERT INTO provider_events(peer,payload,created_at) VALUES (?,?,?)').run(peer, JSON.stringify(payload), now());
      // Event inspection is bounded; authoritative messages remain in mesh.db.
      db.prepare('DELETE FROM provider_events WHERE id < (SELECT MAX(id)-2000 FROM provider_events)').run();
    },
    events(peer, after = 0) {
      return db.prepare('SELECT * FROM provider_events WHERE peer=? AND id>? ORDER BY id LIMIT 100').all(peer, after)
        .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    },
    disconnected() {
      db.prepare("UPDATE workers SET status='disconnected',updated_at=? WHERE status!='closed'").run(now());
      db.prepare("UPDATE deliveries SET state='uncertain',updated_at=? WHERE state IN ('dispatching','submitted','accepted')").run(now());
    },
    close() { db.close(); }
  };
}
