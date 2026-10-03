import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { CliError } from '../../shared/errors.mjs';

function statOrMissing(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function directory(file, create) {
  let stat = statOrMissing(file);
  if (!stat && create) {
    try { fs.mkdirSync(file, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    stat = fs.lstatSync(file);
  }
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CliError('NATIVE_STATE_UNSAFE', `Native state must be a real directory: ${file}`);
  if (create) {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new CliError('NATIVE_STATE_UNSAFE', `Native state must be owned by the current user: ${file}`);
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        throw new CliError('NATIVE_STATE_UNSAFE', `Native state directory changed: ${file}`);
      }
      if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o700) fs.fchmodSync(fd, 0o700);
      const current = fs.lstatSync(file);
      if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
        throw new CliError('NATIVE_STATE_UNSAFE', `Native state directory changed: ${file}`);
      }
    } finally { fs.closeSync(fd); }
  }
  return true;
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
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new CliError('NATIVE_STATE_UNSAFE', `Native database must be an owned regular file: ${file}`);
  }
  const fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new CliError('NATIVE_STATE_UNSAFE', `Native database changed during validation: ${file}`);
    }
    if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
    const current = fs.lstatSync(file);
    if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new CliError('NATIVE_STATE_UNSAFE', `Native database changed during validation: ${file}`);
    }
  } finally { fs.closeSync(fd); }
}

export function nativePaths(ctx, { create = false } = {}) {
  const root = fs.realpathSync(ctx.root);
  const parent = path.join(root, '.hello-cc');
  if (!directory(parent, create)) return null;
  const dir = path.join(parent, 'native');
  if (!directory(dir, create)) return null;
  for (const name of ['runtime.json', 'state.db', 'state.db-wal', 'state.db-shm', 'runtime.log']) {
    const file = path.join(dir, name);
    const stat = statOrMissing(file);
    if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)) {
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
  if (!paths || !fs.existsSync(paths.pointer)) return null;
  if (fs.statSync(paths.pointer).size > 16384) throw new CliError('NATIVE_STATE_UNSAFE', 'Native runtime pointer is too large');
  let value;
  try { value = JSON.parse(fs.readFileSync(paths.pointer, 'utf8')); }
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

export function createNativeStore(ctx) {
  const paths = nativePaths(ctx, { create: true });
  privateDatabase(paths.db);
  const db = new DatabaseSync(paths.db, { timeout: 5000 });
  db.exec(`PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS workers (
      peer TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT,
      cwd TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL
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
  const now = () => Date.now();
  return {
    db,
    worker(peer) { return db.prepare('SELECT * FROM workers WHERE peer = ?').get(peer) || null; },
    workers() { return db.prepare('SELECT * FROM workers ORDER BY peer').all(); },
    saveWorker(worker) {
      db.prepare(`INSERT INTO workers(peer, provider, session_id, cwd, status, updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(peer) DO UPDATE SET provider=excluded.provider, session_id=COALESCE(excluded.session_id,workers.session_id),
        cwd=excluded.cwd, status=excluded.status, updated_at=excluded.updated_at`)
        .run(worker.peer, worker.provider, worker.sessionId || null, worker.cwd, worker.status, now());
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
