import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { CliError } from '../../shared/errors.mjs';
import { redactSecrets } from '../../shared/redact.mjs';
import { projectStateDir, legacyProjectStateDir } from '../paths.mjs';
import { ensurePrivateProjectStateDir } from '../private-state.mjs';
import { unsafeDirectoryAcl } from '../project-trust.mjs';
import { nativePaths } from './store.mjs';

const PAGE_SIZE = 100;
const WORKER_COLUMNS = 'peer, provider, session_id, cwd, status, updated_at';

function missing(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function unavailable() {
  return new CliError('NATIVE_HISTORY_UNAVAILABLE', 'Stored native history cannot be read; inspect the native state before retrying');
}

function validateEntry(file, directory = false) {
  const stat = missing(file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) || unsafeDirectoryAcl(file, stat)) {
    throw new CliError('NATIVE_STATE_UNSAFE', 'Stored native history must use owned state without symlinks or writable aliases');
  }
  return stat;
}

function historyPaths(ctx) {
  const root = fs.realpathSync(ctx.root), state = projectStateDir(root);
  if (state === legacyProjectStateDir(root)) {
    // History is project-state scoped, not an authority to follow a caller's
    // arbitrary --db path into another project. The live runtime validates
    // its selected DB separately before it may write.
    return nativePaths({ root: ctx.root, dbPath: path.join(root, '.hello-cc', 'mesh.db'),
      initialRootIdentity: ctx.initialRootIdentity });
  }
  // The general resolver repairs missing/pending private authority markers.
  // History must not perform that transition or tighten existing permissions.
  const existing = ensurePrivateProjectStateDir(root, { create: false });
  if (!existing) return null;
  const dir = path.join(existing, 'native');
  if (!validateEntry(dir, true)) return null;
  for (const name of ['runtime.json', 'state.db', 'state.db-wal', 'state.db-shm', 'runtime.log']) {
    try { validateEntry(path.join(dir, name)); }
    catch (error) {
      if ((name === 'state.db-wal' || name === 'state.db-shm') && !missing(path.join(dir, name))) continue;
      throw error;
    }
  }
  return { dir, db: path.join(dir, 'state.db') };
}

function withHistory(ctx, read, absent) {
  let db;
  try {
    const paths = historyPaths(ctx);
    if (!paths) return absent();
    const before = validateEntry(paths.db);
    if (!before) return absent();
    // A read-only SQLite connection preserves committed data still in WAL.
    // SQLite may maintain its own WAL/SHM sidecars; never initialize a store,
    // run migrations, chmod state, or alter project records here.
    db = new DatabaseSync(paths.db, { readOnly: true, timeout: 1000 });
    const after = validateEntry(paths.db);
    if (!after || before.dev !== after.dev || before.ino !== after.ino) throw unavailable();
    db.exec('BEGIN'); // Keep the worker and its retained rows in one read snapshot.
    const result = read(db);
    const current = validateEntry(paths.db);
    if (!current || before.dev !== current.dev || before.ino !== current.ino) throw unavailable();
    const safe = redactSecrets(result);
    for (const row of safe.workers || (safe.worker ? [safe.worker] : [])) {
      if (row.capabilities_json !== undefined && row.capabilities_json !== null) row.capabilities_json = JSON.stringify(row.capabilities_json);
    }
    for (const row of safe.deliveries || []) {
      if (row.detail !== undefined && row.detail !== null) row.detail = JSON.stringify(row.detail);
    }
    return safe;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw unavailable();
  } finally { if (db) db.close(); }
}

function workerColumns(db) {
  const columns = db.prepare('PRAGMA table_info(workers)').all();
  return WORKER_COLUMNS + (columns.some(column => column.name === 'cwd_identity')
    ? ', cwd_identity' : ', NULL AS cwd_identity') +
    (columns.some(column => column.name === 'capabilities_json') ? ', capabilities_json' : '');
}

function parseStored(value) {
  if (value === null || value === undefined) return value;
  try { return JSON.parse(value); }
  catch { throw new CliError('NATIVE_HISTORY_INVALID', 'Stored native history contains invalid event data'); }
}

function workerRow(row) {
  if (row && row.capabilities_json !== undefined && row.capabilities_json !== null) {
    return { ...row, capabilities_json: parseStored(row.capabilities_json) };
  }
  return row;
}

export function readNativeHistory(ctx, { limit = PAGE_SIZE } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) {
    throw new CliError('BAD_ARGS', 'Native history limit must be an integer from 1 to 100');
  }
  return withHistory(ctx, db => {
    const rows = db.prepare('SELECT ' + workerColumns(db) + ' FROM workers ORDER BY updated_at DESC, peer LIMIT ?').all(limit + 1);
    return { workers: rows.slice(0, limit).map(workerRow), truncated: rows.length > limit };
  }, () => ({ workers: [], truncated: false }));
}

export function readNativeWorkerHistory(ctx, peer, { after = 0 } = {}) {
  if (typeof peer !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(peer) || peer.toLowerCase() === 'all') {
    throw new CliError('BAD_ARGS', 'Native history requires one valid worker name');
  }
  if (!Number.isSafeInteger(after) || after < 0) throw new CliError('BAD_ARGS', 'Native history cursor must be a nonnegative safe integer');
  const absent = () => { throw new CliError('NATIVE_HISTORY_NOT_FOUND', 'No retained native history exists for this worker'); };
  return withHistory(ctx, db => {
    const worker = workerRow(db.prepare('SELECT ' + workerColumns(db) + ' FROM workers WHERE peer = ?').get(peer));
    if (!worker) return absent();
    const rows = db.prepare('SELECT id, peer, payload, created_at FROM provider_events WHERE peer = ? AND id > ? ORDER BY id LIMIT ?')
      .all(peer, after, PAGE_SIZE + 1);
    const deliveries = db.prepare('SELECT * FROM deliveries WHERE peer = ? ORDER BY id DESC LIMIT ?').all(peer, PAGE_SIZE + 1);
    const events = rows.slice(0, PAGE_SIZE).map(row => ({ ...row, payload: parseStored(row.payload) }));
    return { worker, events,
      deliveries: deliveries.slice(0, PAGE_SIZE).map(row => ({ ...row,
        detail: parseStored(row.detail) })),
      truncated: rows.length > PAGE_SIZE, deliveriesTruncated: deliveries.length > PAGE_SIZE,
      nextAfter: events.at(-1)?.id ?? after };
  }, absent);
}
