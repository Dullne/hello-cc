import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { CliError } from '../../shared/errors.mjs';
import { resolveProjectDatabase, ensurePrivateProjectStateSubdirectory } from '../project-path.mjs';
import { privateProjectStateManifest } from '../private-state.mjs';
import { assertSelectedCwdSnapshot, captureSelectedCwdSnapshot, sameSelectedCwdIdentity } from '../../process/selected-cwd-identity.mjs';
import { compareProcessIdentity, inspectProcessIdentity } from '../../process/identity.mjs';
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
  const requestedRoot = ctx.root;
  const root = fs.realpathSync(requestedRoot);
  let dir, selected;
  try {
    // Preserve the caller's root spelling so the resolver can map a legacy
    // /var/... DB spelling through macOS's /var -> /private/var alias.
    selected = resolveProjectDatabase({ root: requestedRoot, db: ctx.dbPath, createStateDir: create });
    dir = ensurePrivateProjectStateSubdirectory(root, 'native', { create });
    if (dir && path.dirname(dir) !== selected.stateDir) {
      throw new CliError('PROJECT_PATH_CHANGED', 'Native state does not match the selected project database generation');
    }
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
  return { dir, pointer: path.join(dir, 'runtime.json'), db: path.join(dir, 'state.db'), log: path.join(dir, 'runtime.log'),
    meshDb: selected.db };
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
  const selectedRootIdentity = ctx.initialRootIdentity || ctx.rootIdentity;
  if (selectedRootIdentity && !sameSelectedCwdIdentity(selectedRootIdentity, value.rootIdentity)) {
    throw new CliError('PROJECT_PATH_CHANGED', 'Native runtime pointer does not match the selected project directory');
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

function completeProcessIdentity(value) {
  return Number.isInteger(value?.pid) && value.pid > 0 &&
    typeof value.startToken === 'string' && value.startToken.length > 0 &&
    typeof value.commandHash === 'string' && /^[a-f0-9]{64}$/.test(value.commandHash);
}

function priorProcessExited(identity, inspect) {
  const observed = inspect(identity.pid);
  if (observed?.state === 'dead') return true;
  return observed?.state === 'live' && completeProcessIdentity(observed.identity) &&
    compareProcessIdentity(identity, observed.identity) === 'dead';
}

// A legacy daemon does not know the owner row. A live or uninspectable pointer
// cannot be silently upgraded, even if its loopback control endpoint is down.
function assertPriorPointerStopped(ctx, rootIdentity, inspect) {
  const pointer = readNativePointer({ root: ctx.root, dbPath: ctx.dbPath });
  if (!pointer) return;
  if (pointer.rootIdentity && !sameSelectedCwdIdentity(rootIdentity, pointer.rootIdentity)) {
    throw new CliError('PROJECT_PATH_CHANGED', 'Native runtime pointer belongs to another project directory');
  }
  if (!Number.isInteger(pointer.pid) || pointer.pid <= 0) {
    throw new CliError('NATIVE_OWNER_UNVERIFIED', 'Saved native runtime has no verifiable process identity; drain it with its installed build');
  }
  const savedIdentity = pointer.ownerIdentity || pointer.processIdentity;
  const identity = completeProcessIdentity(savedIdentity) && savedIdentity.pid === pointer.pid
    ? savedIdentity : null;
  if (!identity) {
    if (inspect(pointer.pid)?.state !== 'dead') {
      throw new CliError('NATIVE_OWNER_UNVERIFIED', 'A legacy native runtime may still be alive; drain it with its installed build');
    }
  } else if (!priorProcessExited(identity, inspect)) {
    throw new CliError('NATIVE_RUNTIME_IN_USE', 'Saved native runtime is live or its process exit is unconfirmed');
  }
}

// The same SQLite connection owns the fencing row and all native-store writes.
// Every synchronous write also holds BEGIN IMMEDIATE here, so a claimant cannot
// replace the generation until the old write finishes or its process dies.
export function claimNativeOwner(ctx, { rootIdentity, identity, generation,
  inspect = inspectProcessIdentity, onLoss = () => {} }) {
  if (!completeProcessIdentity(identity) || identity.pid !== process.pid ||
      typeof generation !== 'string' || !generation || !rootIdentity) {
    throw new CliError('NATIVE_OWNER_UNVERIFIED', 'Native runtime needs a complete process identity before it can write');
  }
  assertSelectedCwdSnapshot(rootIdentity);
  assertPriorPointerStopped(ctx, rootIdentity, inspect);
  const paths = nativePaths(ctx, { create: true });
  assertSelectedCwdSnapshot(rootIdentity);
  const meshDb = paths.meshDb;
  const stateGeneration = privateProjectStateManifest(ctx.root).generation || null;
  privateDatabase(paths.db);
  const db = new DatabaseSync(paths.db, { timeout: 5000 });
  let claimed = false;
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS native_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        epoch INTEGER NOT NULL, generation TEXT NOT NULL,
        root_identity TEXT NOT NULL, mesh_db TEXT NOT NULL, state_generation TEXT,
        pid INTEGER NOT NULL,
        start_token TEXT NOT NULL, command_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'released'))
      );`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT * FROM native_owner WHERE singleton=1').get();
      if (previous) {
        let savedRoot;
        try { savedRoot = JSON.parse(previous.root_identity); } catch { /* Fail closed below. */ }
        if (!sameSelectedCwdIdentity(rootIdentity, savedRoot)) {
          throw new CliError('PROJECT_PATH_CHANGED', 'Native owner record belongs to another project directory');
        }
        if (previous.mesh_db !== meshDb || previous.state_generation !== stateGeneration) {
          throw new CliError('PROJECT_PATH_CHANGED', 'Native owner record belongs to another state generation');
        }
        if (previous.state !== 'released' && !priorProcessExited({ pid: previous.pid,
          startToken: previous.start_token, commandHash: previous.command_hash }, inspect)) {
          throw new CliError('NATIVE_RUNTIME_IN_USE', 'Native runtime owner is live or its process exit is unconfirmed');
        }
      }
      db.prepare(`INSERT INTO native_owner(singleton,epoch,generation,root_identity,mesh_db,state_generation,pid,start_token,command_hash,state)
        VALUES (1,?,?,?,?,?,?,?,?,'active') ON CONFLICT(singleton) DO UPDATE SET
        epoch=excluded.epoch,generation=excluded.generation,root_identity=excluded.root_identity,
        mesh_db=excluded.mesh_db,state_generation=excluded.state_generation,
        pid=excluded.pid,start_token=excluded.start_token,command_hash=excluded.command_hash,state='active'`)
        .run((previous?.epoch || 0) + 1, generation, JSON.stringify(rootIdentity), meshDb, stateGeneration,
          identity.pid, identity.startToken, identity.commandHash);
      assertSelectedCwdSnapshot(rootIdentity);
      db.exec('COMMIT');
      claimed = true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { db.close(); throw error; }
  if (!claimed) throw new CliError('NATIVE_OWNER_UNVERIFIED', 'Native owner was not claimed');
  let writeDepth = 0;
  let lost = false;
  let mesh = null;
  function failStop() {
    if (lost) return;
    lost = true;
    try { mesh?.exec('PRAGMA query_only = ON'); } catch {}
    onLoss();
  }
  function assertRow() {
    const row = db.prepare('SELECT generation,mesh_db,state_generation,pid,start_token,command_hash,state FROM native_owner WHERE singleton=1').get();
    if (!row || row.generation !== generation || row.pid !== identity.pid ||
        row.start_token !== identity.startToken || row.command_hash !== identity.commandHash ||
        row.mesh_db !== meshDb || row.state_generation !== stateGeneration || row.state !== 'active') {
      failStop();
      throw new CliError('NATIVE_OWNER_LOST', 'Native runtime ownership changed; all further writes are stopped');
    }
  }
  const owner = {
    db, generation, stateGeneration,
    setMesh(value) { mesh = value; if (mesh) mesh.exec('PRAGMA query_only = ON'); },
    assertCurrent() {
      if (lost) throw new CliError('NATIVE_OWNER_LOST', 'Native runtime ownership was lost');
      assertRow();
    },
    withWrite(fn) {
      if (lost) throw new CliError('NATIVE_OWNER_LOST', 'Native runtime ownership was lost');
      if (writeDepth) return fn();
      db.exec('BEGIN IMMEDIATE');
      let enabled = false;
      try {
        assertRow();
        writeDepth = 1;
        if (mesh) { mesh.exec('PRAGMA query_only = OFF'); enabled = true; }
        const result = fn();
        if (result && typeof result.then === 'function') throw new TypeError('Native owner writes must be synchronous');
        if (enabled) { mesh.exec('PRAGMA query_only = ON'); enabled = false; }
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { if (enabled) mesh.exec('PRAGMA query_only = ON'); } catch { failStop(); }
        try { db.exec('ROLLBACK'); } catch { failStop(); }
        throw error;
      } finally { writeDepth = 0; }
    },
    release(fn) {
      this.withWrite(() => {
        fn?.();
        db.prepare("UPDATE native_owner SET state='released' WHERE singleton=1 AND generation=?").run(generation);
      });
      lost = true;
    }
  };
  Object.defineProperty(owner, 'lost', { enumerable: true, get: () => lost });
  return owner;
}

export function readNativeOwnerStatus(ctx, inspect = inspectProcessIdentity) {
  const paths = nativePaths(ctx);
  if (!paths || !statOrMissing(paths.db)) return { state: 'absent' };
  privateDatabase(paths.db);
  const db = new DatabaseSync(paths.db, { readOnly: true, timeout: 1000 });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='native_owner'").get()) {
      return { state: 'absent' };
    }
    const row = db.prepare('SELECT generation,mesh_db,state_generation,pid,start_token,command_hash,state FROM native_owner WHERE singleton=1').get();
    if (!row) return { state: 'absent' };
    const identity = { pid: row.pid, startToken: row.start_token, commandHash: row.command_hash };
    const details = { generation: row.generation, meshDb: row.mesh_db, stateGeneration: row.state_generation, identity };
    if (row.state === 'released') return { state: 'released', ...details };
    if (row.state !== 'active' || !completeProcessIdentity(identity)) {
      return { state: 'unknown', ...details };
    }
    const observed = inspect(identity.pid);
    if (observed?.state === 'dead' || (observed?.state === 'live' &&
        completeProcessIdentity(observed.identity) && compareProcessIdentity(identity, observed.identity) === 'dead')) {
      return { state: 'dead', ...details };
    }
    return { state: observed?.state === 'live' && completeProcessIdentity(observed.identity) &&
      compareProcessIdentity(identity, observed.identity) === 'live'
      ? 'live' : 'unknown', ...details };
  } finally { db.close(); }
}

export function assertNativePointerOwner(ctx, pointer) {
  if (!pointer || pointer.ownerVersion !== 2 || !completeProcessIdentity(pointer.ownerIdentity) ||
      pointer.ownerIdentity.pid !== pointer.pid) {
    throw new CliError('NATIVE_OWNER_UNVERIFIED', 'Native runtime pointer predates owner fencing; drain it with its installed build');
  }
  const owner = readNativeOwnerStatus(ctx);
  const expectedGeneration = privateProjectStateManifest(ctx.root).generation || null;
  if (owner.state === 'dead' && owner.generation === pointer.generation) {
    throw new CliError('NATIVE_RUNTIME_OFFLINE', 'Native runtime owner has exited');
  }
  if (owner.state !== 'live' || owner.generation !== pointer.generation ||
      owner.meshDb !== nativePaths(ctx).meshDb || owner.stateGeneration !== expectedGeneration ||
      pointer.stateGeneration !== expectedGeneration ||
      owner.identity.pid !== pointer.ownerIdentity.pid ||
      owner.identity.startToken !== pointer.ownerIdentity.startToken ||
      owner.identity.commandHash !== pointer.ownerIdentity.commandHash) {
    throw new CliError('NATIVE_OWNER_UNVERIFIED', 'Native runtime pointer does not match a live persistent owner');
  }
}

export function nativeOwnerGeneration(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === 'native' && parts[1] && parts[1].length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(parts[2]) && /^[a-f0-9-]{36}$/.test(parts[3])
    ? parts[1] : null;
}

// Hooks and scoped MCP run in different processes. They acquire the same
// state.db writer lock before opening or writing mesh.db; the native daemon's
// writes take this lock in the same order. A new generation cannot claim the
// row until an old derived write has finished.
export function acquireNativeOwnerWrite(ctx, expectedGeneration) {
  if (typeof expectedGeneration !== 'string' || !expectedGeneration) {
    throw new CliError('NATIVE_OWNER_UNVERIFIED', 'Native worker has no owner generation');
  }
  const rootIdentity = ctx.initialRootIdentity || ctx.rootIdentity || captureSelectedCwdSnapshot(ctx.root);
  assertSelectedCwdSnapshot(rootIdentity);
  const paths = nativePaths(ctx);
  if (!paths || !statOrMissing(paths.db)) {
    throw new CliError('NATIVE_OWNER_UNVERIFIED', 'Native worker has no persistent owner record');
  }
  privateDatabase(paths.db);
  const db = new DatabaseSync(paths.db, { timeout: 5000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT * FROM native_owner WHERE singleton=1').get();
    let savedRoot;
    try { savedRoot = JSON.parse(row?.root_identity || 'null'); } catch {}
    const identity = { pid: row?.pid, startToken: row?.start_token, commandHash: row?.command_hash };
    const observed = completeProcessIdentity(identity) ? inspectProcessIdentity(identity.pid) : null;
    if (!row || row.state !== 'active' || row.generation !== expectedGeneration ||
        row.mesh_db !== paths.meshDb ||
        row.state_generation !== (privateProjectStateManifest(ctx.root).generation || null) ||
        !sameSelectedCwdIdentity(rootIdentity, savedRoot) ||
        observed?.state !== 'live' || !completeProcessIdentity(observed.identity) ||
        compareProcessIdentity(identity, observed.identity) !== 'live') {
      throw new CliError('NATIVE_OWNER_UNVERIFIED', 'Native worker owner is no longer live or does not own this state generation');
    }
    assertSelectedCwdSnapshot(rootIdentity);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    throw error;
  }
  let finished = false;
  return function (success = false) {
    if (finished) return;
    finished = true;
    try { db.exec(success ? 'COMMIT' : 'ROLLBACK'); }
    finally { db.close(); }
  };
}

export function withNativeOwnerWrite(ctx, expectedGeneration, fn) {
  const finish = acquireNativeOwnerWrite(ctx, expectedGeneration);
  let success = false;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new TypeError('Native owner writes must be synchronous');
    success = true;
    return result;
  } finally { finish(success); }
}

export function createNativeStore(ctx, { owner = null } = {}) {
  const paths = nativePaths(ctx, { create: true });
  if (!owner) privateDatabase(paths.db);
  const db = owner?.db || new DatabaseSync(paths.db, { timeout: 5000 });
  const write = fn => owner ? owner.withWrite(fn) : fn();
  try {
    if (!owner) db.exec('PRAGMA journal_mode = WAL');
    write(() => {
    db.exec(`
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
    if (!owner) db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('PRAGMA table_info(workers)').all().some(column => column.name === 'sandbox')) {
        // Only the legacy schema implies the former workspace-write default.
        // A missing value in the new schema must never escalate on reopen.
        db.exec(`ALTER TABLE workers ADD COLUMN sandbox TEXT;
          UPDATE workers SET sandbox='workspace-write' WHERE provider='codex';`);
      }
      if (!owner) db.exec('COMMIT');
    } catch (error) {
      try { if (!owner) db.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
      throw error;
    }
    });
  } catch (error) {
    if (!owner) try { db.close(); } catch { /* Preserve the initialization failure. */ }
    throw error;
  }
  const now = () => Date.now();
  return {
    db,
    worker(peer) { return db.prepare('SELECT * FROM workers WHERE peer = ?').get(peer) || null; },
    workers() { return db.prepare('SELECT * FROM workers ORDER BY peer').all(); },
    saveWorker(worker) {
      return write(() => {
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
      });
    },
    queue(peer, messageId, submissionId, origin = 'peer') {
      if (!['peer', 'user'].includes(origin)) throw new CliError('BAD_ARGS', 'Unknown native message origin');
      write(() => db.prepare(`INSERT OR IGNORE INTO deliveries(peer,message_id,submission_id,state,origin,updated_at) VALUES (?,?,?,'queued',?,?)`)
        .run(peer, messageId, submissionId, origin, now()));
      return this.delivery(peer, messageId);
    },
    delivery(peer, messageId) { return db.prepare('SELECT * FROM deliveries WHERE peer=? AND message_id=?').get(peer, messageId) || null; },
    pending(peer) { return db.prepare("SELECT * FROM deliveries WHERE peer=? AND state='queued' ORDER BY id LIMIT 1").get(peer) || null; },
    updateDelivery(id, state, turnId = null, detail = null) {
      write(() => db.prepare('UPDATE deliveries SET state=?,turn_id=COALESCE(?,turn_id),detail=?,updated_at=? WHERE id=?')
        .run(state, turnId, detail ? JSON.stringify(detail) : null, now(), id));
    },
    deliveries(peer = null) {
      return peer ? db.prepare('SELECT * FROM deliveries WHERE peer=? ORDER BY id DESC LIMIT 100').all(peer)
        : db.prepare('SELECT * FROM deliveries ORDER BY id DESC LIMIT 100').all();
    },
    event(peer, payload) {
      write(() => {
      db.prepare('INSERT INTO provider_events(peer,payload,created_at) VALUES (?,?,?)').run(peer, JSON.stringify(payload), now());
      // Event inspection is bounded; authoritative messages remain in mesh.db.
      db.prepare('DELETE FROM provider_events WHERE id < (SELECT MAX(id)-2000 FROM provider_events)').run();
      });
    },
    events(peer, after = 0) {
      return db.prepare('SELECT * FROM provider_events WHERE peer=? AND id>? ORDER BY id LIMIT 100').all(peer, after)
        .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    },
    disconnected() {
      write(() => {
      db.prepare("UPDATE workers SET status='disconnected',updated_at=? WHERE status!='closed'").run(now());
      db.prepare("UPDATE deliveries SET state='uncertain',updated_at=? WHERE state IN ('dispatching','submitted','accepted')").run(now());
      });
    },
    close() { db.close(); }
  };
}
