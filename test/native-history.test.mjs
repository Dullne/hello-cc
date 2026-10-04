import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createNativeStore, nativePaths } from '../lib/runtime/native/store.mjs';
import { readNativeHistory, readNativeWorkerHistory } from '../lib/runtime/native/history.mjs';
import { privateProjectAuthorityPath } from '../lib/runtime/private-state.mjs';

function fixture(t) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-history-')));
  const root = path.join(sandbox, 'project'); fs.mkdirSync(root);
  const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') }, stores = [];
  t.after(() => { for (const store of stores) { try { store.close(); } catch {} } fs.rmSync(sandbox, { recursive: true, force: true }); });
  return { sandbox, ctx, store() { const store = createNativeStore(ctx); stores.push(store); return store; } };
}

function save(store, ctx, peer = 'worker', extra = {}) {
  store.saveWorker({ peer, provider: 'codex', sessionId: 'session-' + peer, cwd: ctx.root, status: 'closed', ...extra });
}

test('missing native state and missing database remain missing during history reads', t => {
  const f = fixture(t);
  assert.deepEqual(readNativeHistory(f.ctx), { workers: [], truncated: false });
  assert.throws(() => readNativeWorkerHistory(f.ctx, 'worker'), { code: 'NATIVE_HISTORY_NOT_FOUND' });
  assert.deepEqual(fs.readdirSync(f.ctx.root), []);
  const paths = nativePaths(f.ctx, { create: true });
  const before = fs.readdirSync(paths.dir);
  assert.deepEqual(readNativeHistory(f.ctx), { workers: [], truncated: false });
  assert.throws(() => readNativeWorkerHistory(f.ctx, 'worker'), { code: 'NATIVE_HISTORY_NOT_FOUND' });
  assert.deepEqual(fs.readdirSync(paths.dir), before);
  assert.equal(fs.existsSync(paths.db), false);
});

test('invalid limits, worker names and cursors are rejected before inspecting any project', () => {
  const ctx = { root: '/missing-history-fixture' };
  for (const limit of [0, -1, 101, 1.5, Infinity, NaN, '10', null]) {
    assert.throws(() => readNativeHistory(ctx, { limit }), { code: 'BAD_ARGS' });
  }
  for (const peer of ['', null, undefined, 'all', 'ALL', '../worker', 'a/b', 'a\\b', 'a b', 'x'.repeat(129)]) {
    assert.throws(() => readNativeWorkerHistory(ctx, peer), { code: 'BAD_ARGS' });
  }
  for (const after of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.throws(() => readNativeWorkerHistory(ctx, 'worker', { after }), { code: 'BAD_ARGS' });
  }
});

test('history reads committed WAL data without opening raw SQLite file descriptors', t => {
  const f = fixture(t), store = f.store();
  store.db.exec('PRAGMA wal_autocheckpoint = 0');
  save(store, f.ctx);
  store.event('worker', { type: 'assistant', text: 'retained WAL event' });
  store.queue('worker', 1, 'submission-1');
  const paths = nativePaths(f.ctx);
  assert.ok(fs.statSync(paths.db + '-wal').size > 0);
  const originalOpen = fs.openSync;
  t.mock.method(fs, 'openSync', function (file, ...args) {
    assert.notEqual(typeof file === 'string' ? path.resolve(file) : file, paths.db, 'raw descriptor closure would release another SQLite connection locks');
    return originalOpen.call(this, file, ...args);
  });
  const result = readNativeWorkerHistory(f.ctx, 'worker');
  assert.equal(result.worker.session_id, 'session-worker');
  assert.equal(result.events[0].payload.text, 'retained WAL event');
  assert.equal(result.deliveries[0].submission_id, 'submission-1');
  assert.equal(result.nextAfter, result.events[0].id);
  assert.equal(result.truncated, false);
  assert.equal(readNativeHistory(f.ctx).workers[0].peer, 'worker');
  assert.equal(store.worker('worker').status, 'closed');
});

test('offline legacy schemas are read without schema, permission or business-record mutation', t => {
  const f = fixture(t), paths = nativePaths(f.ctx, { create: true });
  const db = new DatabaseSync(paths.db);
  db.exec(`CREATE TABLE workers (peer TEXT PRIMARY KEY, provider TEXT, session_id TEXT, cwd TEXT, status TEXT, updated_at INTEGER);
    CREATE TABLE provider_events (id INTEGER PRIMARY KEY, peer TEXT, payload TEXT, created_at INTEGER);
    CREATE TABLE deliveries (id INTEGER PRIMARY KEY, peer TEXT, message_id INTEGER, submission_id TEXT, state TEXT, turn_id TEXT, detail TEXT, updated_at INTEGER);`);
  db.prepare('INSERT INTO workers VALUES (?,?,?,?,?,?)').run('claude-new', 'claude', null, f.ctx.root, 'closed', 10);
  db.close();
  for (const directory of [path.dirname(paths.dir), paths.dir]) fs.chmodSync(directory, 0o755);
  fs.chmodSync(paths.db, 0o644);
  const before = fs.readFileSync(paths.db), mode = fs.statSync(paths.db).mode;
  const result = readNativeWorkerHistory(f.ctx, 'claude-new');
  assert.equal(result.worker.session_id, null);
  assert.equal(Object.hasOwn(result.worker, 'capabilities_json'), false);
  assert.deepEqual(result.events, []); assert.deepEqual(result.deliveries, []);
  assert.equal(result.nextAfter, 0); assert.equal(result.truncated, false);
  assert.deepEqual(fs.readFileSync(paths.db), before);
  assert.equal(fs.statSync(paths.db).mode, mode);
  assert.equal(fs.statSync(paths.dir).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.dirname(paths.dir)).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(f.ctx.root, '.hello-cc', 'mesh.db')), false);
});

test('worker pages are bounded and ordered by recency with a stable peer tie-breaker', t => {
  const f = fixture(t), store = f.store();
  for (let i = 0; i < 102; i++) save(store, f.ctx, 'worker-' + String(i).padStart(3, '0'));
  store.db.prepare('UPDATE workers SET updated_at = 10').run();
  store.db.prepare('UPDATE workers SET updated_at = 20 WHERE peer = ?').run('worker-101');
  const all = readNativeHistory(f.ctx);
  assert.equal(all.workers.length, 100); assert.equal(all.truncated, true);
  assert.equal(all.workers[0].peer, 'worker-101'); assert.equal(all.workers[1].peer, 'worker-000');
  assert.equal(readNativeHistory(f.ctx, { limit: 1 }).workers[0].peer, 'worker-101');
});

test('worker detail pages only the selected peer and supports forward event cursors', t => {
  const f = fixture(t), store = f.store(); save(store, f.ctx); save(store, f.ctx, 'other');
  for (let i = 1; i <= 102; i++) {
    store.event('worker', { type: 'event', index: i });
    store.queue('worker', i, 'submission-' + i);
  }
  store.event('other', { text: 'other worker private content' });
  store.queue('other', 999, 'other-submission');
  const first = readNativeWorkerHistory(f.ctx, 'worker');
  assert.equal(first.events.length, 100); assert.equal(first.nextAfter, 100); assert.equal(first.truncated, true);
  assert.equal(first.deliveries.length, 100); assert.equal(first.deliveries[0].message_id, 102);
  assert.ok(first.events.every(row => row.peer === 'worker')); assert.ok(first.deliveries.every(row => row.peer === 'worker'));
  const next = readNativeWorkerHistory(f.ctx, 'worker', { after: first.nextAfter });
  assert.deepEqual(next.events.map(row => row.payload.index), [101, 102]); assert.equal(next.nextAfter, 102);
  assert.equal(next.truncated, false); assert.equal(next.deliveriesTruncated, true);
  const end = readNativeWorkerHistory(f.ctx, 'worker', { after: 999 });
  assert.deepEqual(end.events, []); assert.equal(end.nextAfter, 999);
  assert.throws(() => readNativeWorkerHistory(f.ctx, 'missing'), { code: 'NATIVE_HISTORY_NOT_FOUND' });
});

test('stored event, receipt and optional capability secrets are redacted before exposure', t => {
  const f = fixture(t), store = f.store(); save(store, f.ctx);
  if (!store.db.prepare('PRAGMA table_info(workers)').all().some(column => column.name === 'capabilities_json')) {
    store.db.exec('ALTER TABLE workers ADD COLUMN capabilities_json TEXT');
  }
  store.db.prepare('UPDATE workers SET capabilities_json = ?').run(JSON.stringify({ resume: true, apiKey: 'capability-key' }));
  store.event('worker', { access_token: 'event-token', nested: { password: 'event-password' }, text: 'Authorization: Bearer inline-secret' });
  const delivery = store.queue('worker', 1, 'submission-1');
  store.updateDelivery(delivery.id, 'failed', null, { credentials: 'receipt-secret', message: 'Bearer receipt-bearer' });
  const result = readNativeWorkerHistory(f.ctx, 'worker'), raw = JSON.stringify(result);
  for (const secret of ['capability-key', 'event-token', 'event-password', 'inline-secret', 'receipt-secret', 'receipt-bearer']) assert.ok(!raw.includes(secret));
  assert.equal(result.events[0].payload.access_token, '[REDACTED]');
  assert.equal(JSON.parse(result.worker.capabilities_json).resume, true);
  assert.equal(JSON.parse(result.deliveries[0].detail).credentials, '[REDACTED]');
  assert.equal(JSON.parse(readNativeHistory(f.ctx).workers[0].capabilities_json).apiKey, '[REDACTED]');
});

test('project history does not follow another supplied mesh database or mix identical peers', t => {
  const first = fixture(t), second = fixture(t), a = first.store(), b = second.store();
  save(a, first.ctx, 'worker', { sessionId: 'first-session' }); save(b, second.ctx, 'worker', { sessionId: 'second-session' });
  const context = { ...first.ctx, dbPath: second.ctx.dbPath };
  assert.equal(readNativeHistory(context).workers[0].session_id, 'first-session');
  assert.equal(readNativeWorkerHistory(second.ctx, 'worker').worker.session_id, 'second-session');
});

test('unsafe state symlinks, hard links and writable databases are refused', t => {
  const f = fixture(t), store = f.store(); save(store, f.ctx); store.close();
  const paths = nativePaths(f.ctx), original = paths.db + '.saved'; fs.renameSync(paths.db, original);
  fs.symlinkSync(original, paths.db);
  assert.throws(() => readNativeHistory(f.ctx), { code: 'NATIVE_STATE_UNSAFE' });
  fs.unlinkSync(paths.db); fs.linkSync(original, paths.db);
  assert.throws(() => readNativeWorkerHistory(f.ctx, 'worker'), { code: 'NATIVE_STATE_UNSAFE' });
  fs.unlinkSync(paths.db); fs.renameSync(original, paths.db); fs.chmodSync(paths.db, 0o666);
  assert.throws(() => readNativeHistory(f.ctx), { code: 'NATIVE_STATE_UNSAFE' });
  assert.equal(fs.statSync(paths.db).mode & 0o777, 0o666);
});

test('all opened history connections close on successful reads and parsing failures', t => {
  const f = fixture(t), store = f.store(); save(store, f.ctx); store.event('worker', { text: 'data' });
  const opened = new Set(), prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (...args) { if (this !== store.db) opened.add(this); return prepare.apply(this, args); });
  readNativeHistory(f.ctx); readNativeWorkerHistory(f.ctx, 'worker');
  store.db.prepare("UPDATE provider_events SET payload = 'invalid json'").run();
  assert.throws(() => readNativeWorkerHistory(f.ctx, 'worker'), { code: 'NATIVE_HISTORY_INVALID' });
  assert.equal(opened.size, 3); assert.ok([...opened].every(db => !db.isOpen));
});

test('history readers enforce SQLite read-only mode and do not initialize an empty database', t => {
  const f = fixture(t), store = f.store(); save(store, f.ctx);
  const prepare = DatabaseSync.prototype.prepare;
  let checked = false;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (...args) {
    if (this !== store.db && !checked) {
      checked = true;
      assert.throws(() => this.exec("UPDATE workers SET status='changed'"), /readonly|read-only/i);
    }
    return prepare.apply(this, args);
  });
  readNativeHistory(f.ctx); assert.equal(checked, true); assert.equal(store.worker('worker').status, 'closed');
  t.mock.restoreAll();
  const empty = fixture(t), paths = nativePaths(empty.ctx, { create: true }); fs.writeFileSync(paths.db, '', { mode: 0o600 });
  assert.throws(() => readNativeHistory(empty.ctx), { code: 'NATIVE_HISTORY_UNAVAILABLE' });
  assert.equal(fs.statSync(paths.db).size, 0);
});

test('private history reads preserve a missing authority marker instead of repairing state', t => {
  const f = fixture(t), historyHome = path.join(f.sandbox, 'home'); fs.mkdirSync(historyHome, { mode: 0o700 });
  t.mock.method(os, 'homedir', () => historyHome);
  fs.chmodSync(f.ctx.root, 0o777);
  const store = f.store(); save(store, f.ctx); store.close();
  const authority = privateProjectAuthorityPath(f.ctx.root); fs.unlinkSync(authority);
  assert.equal(readNativeHistory(f.ctx).workers[0].peer, 'worker');
  assert.equal(readNativeWorkerHistory(f.ctx, 'worker').worker.session_id, 'session-worker');
  assert.equal(fs.existsSync(authority), false);
  assert.deepEqual(fs.readdirSync(f.ctx.root), []);
});
