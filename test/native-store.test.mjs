import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { createNativeStore, nativePaths, readNativePointer, writeNativePointer } from '../lib/runtime/native/store.mjs';

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-store-'));
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(root);
  const stores = [];
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch {} }
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
  return {
    sandbox, ctx,
    pointer: (extra = {}) => ({ root: fs.realpathSync(root), meshDb: path.resolve(ctx.dbPath),
      pid: process.pid, port: 32123, token: 'test-token-'.repeat(5), generation: 'test-generation', ...extra }),
    store() { const store = createNativeStore(ctx); stores.push(store); return store; }
  };
}

test('native pointer writes use private permissions and leave no temporary files', (t) => {
  const f = fixture(t);
  assert.equal(nativePaths(f.ctx), null);
  assert.equal(readNativePointer(f.ctx), null);
  const first = f.pointer();
  writeNativePointer(f.ctx, first);
  const paths = nativePaths(f.ctx);
  assert.deepEqual(readNativePointer(f.ctx), first);
  const second = f.pointer({ generation: 'replacement-generation' });
  writeNativePointer(f.ctx, second);
  assert.deepEqual(readNativePointer(f.ctx), second);
  assert.deepEqual(fs.readdirSync(paths.dir), ['runtime.json']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(paths.pointer).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.dir).mode & 0o777, 0o700);
  }
});

test('native writers tighten existing owned state and database while reads remain non-mutating', (t) => {
  const f = fixture(t);
  const state = path.join(f.ctx.root, '.hello-cc');
  const native = path.join(state, 'native');
  const dbPath = path.join(native, 'state.db');
  fs.mkdirSync(native, { recursive: true, mode: 0o755 });
  fs.chmodSync(state, 0o755);
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('existing')");
  legacy.close();
  fs.chmodSync(dbPath, 0o644);

  assert.equal(nativePaths(f.ctx).db, fs.realpathSync(dbPath));
  assert.equal(readNativePointer(f.ctx), null);
  assert.equal(fs.statSync(state).mode & 0o777, 0o755);
  assert.equal(fs.statSync(native).mode & 0o777, 0o755);
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o644);

  const store = f.store();
  assert.equal(store.db.prepare('SELECT value FROM preserved').get().value, 'existing');
  assert.equal(fs.statSync(state).mode & 0o777, 0o700);
  assert.equal(fs.statSync(native).mode & 0o777, 0o700);
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  store.saveWorker({ peer: 'worker', provider: 'codex', cwd: f.ctx.root, status: 'ready' });
  assert.equal(fs.existsSync(`${dbPath}-wal`), true);
  assert.equal(fs.existsSync(`${dbPath}-shm`), true);
});

test('opening a second native store never raw-opens an active SQLite database inode', (t) => {
  const f = fixture(t);
  const first = f.store();
  first.saveWorker({ peer: 'worker', provider: 'codex', cwd: f.ctx.root, status: 'ready' });
  const dbPath = nativePaths(f.ctx).db;
  const originalOpen = fs.openSync;
  fs.openSync = function checkedOpen(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === dbPath) {
      throw new Error('raw open of an active SQLite database');
    }
    return originalOpen.call(this, file, ...args);
  };
  try {
    const second = f.store();
    assert.equal(second.worker('worker')?.provider, 'codex');
  } finally {
    fs.openSync = originalOpen;
  }
});

test('native store closes its connection when schema initialization fails', (t) => {
  const f = fixture(t);
  const originalExec = DatabaseSync.prototype.exec;
  const originalClose = DatabaseSync.prototype.close;
  const failure = new Error('injected native schema failure');
  let opened = null;
  let closed = false;
  DatabaseSync.prototype.exec = function failInitialSchema(sql) {
    if (String(sql).startsWith('PRAGMA journal_mode = WAL')) {
      opened = this;
      throw failure;
    }
    return originalExec.call(this, sql);
  };
  DatabaseSync.prototype.close = function recordClose() {
    if (this === opened) closed = true;
    return originalClose.call(this);
  };
  try {
    assert.throws(() => createNativeStore(f.ctx), error => error === failure);
    assert.ok(opened);
    assert.equal(closed, true);
    assert.equal(opened.isOpen, false);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    DatabaseSync.prototype.close = originalClose;
  }
});

test('native paths allow a SQLite sidecar to retire during inspection', (t) => {
  const f = fixture(t);
  const paths = nativePaths(f.ctx, { create: true });
  const sidecar = `${paths.db}-shm`;
  fs.writeFileSync(sidecar, 'temporary', { mode: 0o600 });
  const originalStat = fs.lstatSync;
  let retired = false;
  fs.lstatSync = function retireSidecar(file, ...args) {
    const stat = originalStat.call(this, file, ...args);
    if (file === sidecar && !retired) {
      retired = true;
      fs.unlinkSync(sidecar);
    }
    return stat;
  };
  try {
    assert.equal(nativePaths(f.ctx)?.db, paths.db);
    assert.equal(retired, true);
  } finally {
    fs.lstatSync = originalStat;
  }
});

for (const parent of ['.hello-cc', path.join('.hello-cc', 'native')]) {
  for (const dangling of [false, true]) {
    test(`native paths refuse ${dangling ? 'dangling' : 'existing'} directory symlink at ${parent}`, (t) => {
      if (process.platform === 'win32') { t.skip('directory symlink permissions vary on Windows'); return; }
      const f = fixture(t);
      const target = path.join(f.sandbox, 'external-state');
      if (!dangling) fs.mkdirSync(target);
      const link = path.join(f.ctx.root, parent);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, 'dir');
      for (const create of [false, true]) assert.throws(() => nativePaths(f.ctx, { create }), { code: 'NATIVE_STATE_UNSAFE' });
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      if (!dangling) assert.deepEqual(fs.readdirSync(target), []);
      else assert.equal(fs.existsSync(target), false);
    });
  }
}

for (const filename of ['runtime.json', 'state.db', 'state.db-wal', 'state.db-shm', 'runtime.log']) {
  test(`native paths reject dangling symlinks and hardlinks for ${filename}`, (t) => {
    const f = fixture(t);
    const paths = nativePaths(f.ctx, { create: true });
    const file = path.join(paths.dir, filename);
    const missingTarget = path.join(f.sandbox, 'missing-target');
    if (process.platform !== 'win32') {
      fs.symlinkSync(missingTarget, file);
      assert.throws(() => nativePaths(f.ctx), { code: 'NATIVE_STATE_UNSAFE' });
      assert.throws(() => writeNativePointer(f.ctx, f.pointer()), { code: 'NATIVE_STATE_UNSAFE' });
      assert.equal(fs.existsSync(missingTarget), false);
      fs.unlinkSync(file);
    }
    const original = path.join(f.sandbox, 'protected-file');
    fs.writeFileSync(original, 'test file must remain unchanged');
    fs.linkSync(original, file);
    assert.equal(fs.lstatSync(file).nlink, 2);
    assert.throws(() => nativePaths(f.ctx), { code: 'NATIVE_STATE_UNSAFE' });
    assert.throws(() => f.store(), { code: 'NATIVE_STATE_UNSAFE' });
    assert.equal(fs.readFileSync(original, 'utf8'), 'test file must remain unchanged');
  });
}

test('native pointer rejects malformed envelopes and mismatched project identities', (t) => {
  const f = fixture(t);
  const paths = nativePaths(f.ctx, { create: true });
  const candidates = [
    ['invalid JSON', '{'], ['null JSON', 'null'], ['array JSON', '[]'],
    ['wrong root', JSON.stringify(f.pointer({ root: f.sandbox }))],
    ['wrong database', JSON.stringify(f.pointer({ meshDb: path.join(f.sandbox, 'other.db') }))],
    ['port below range', JSON.stringify(f.pointer({ port: 0 }))],
    ['port above range', JSON.stringify(f.pointer({ port: 65536 }))],
    ['noninteger port', JSON.stringify(f.pointer({ port: 0.5 }))],
    ['short token', JSON.stringify(f.pointer({ token: 'short' }))],
    ['wrong generation type', JSON.stringify(f.pointer({ generation: 7 }))]
  ];
  for (const [name, content] of candidates) {
    fs.writeFileSync(paths.pointer, content, { mode: 0o600 });
    assert.throws(() => readNativePointer(f.ctx), { code: 'NATIVE_STATE_INVALID' }, name);
  }
  fs.writeFileSync(paths.pointer, 'x'.repeat(16385), { mode: 0o600 });
  assert.throws(() => readNativePointer(f.ctx), { code: 'NATIVE_STATE_UNSAFE' });
});

test('native store restart preserves queued and terminal records and marks only in-flight deliveries uncertain', (t) => {
  const f = fixture(t);
  const store = f.store();
  store.saveWorker({ peer: 'worker-a', provider: 'claude', cwd: f.ctx.root, sessionId: 'owned-session', status: 'ready' });
  store.saveWorker({ peer: 'worker-a', provider: 'claude', cwd: f.ctx.root, sessionId: null, status: 'running' });
  store.saveWorker({ peer: 'worker-closed', provider: 'codex', cwd: f.ctx.root, sessionId: 'closed-session', status: 'closed' });
  const states = ['queued', 'dispatching', 'submitted', 'accepted', 'completed', 'failed', 'uncertain'];
  states.forEach((state, index) => {
    const receipt = store.queue('worker-a', index + 1, `submission-${index + 1}`);
    store.updateDelivery(receipt.id, state, `turn-${index + 1}`, { state });
  });
  const queued = store.queue('worker-a', 1, 'different-submission');
  assert.equal(queued.submission_id, 'submission-1', 'the same durable message must retain its original submission ID');
  assert.equal(store.pending('worker-a').message_id, 1);
  store.close();
  const restarted = f.store();
  restarted.disconnected();
  assert.equal(restarted.worker('worker-a').status, 'disconnected');
  assert.equal(restarted.worker('worker-a').session_id, 'owned-session');
  assert.equal(restarted.worker('worker-closed').status, 'closed');
  states.forEach((state, index) => {
    const actual = restarted.delivery('worker-a', index + 1);
    const expected = ['dispatching', 'submitted', 'accepted'].includes(state) ? 'uncertain' : state;
    assert.equal(actual.state, expected, state);
    assert.equal(actual.turn_id, `turn-${index + 1}`);
  });
  assert.equal(restarted.pending('worker-a').message_id, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(nativePaths(f.ctx).db).mode & 0o777, 0o600);
});


test('native delivery origin is durable and duplicate queueing cannot promote peer messages', (t) => {
  const f = fixture(t), store = f.store();
  assert.equal(store.queue('a', 1, 'peer-original').origin, 'peer');
  assert.equal(store.queue('a', 1, 'user-retry', 'user').origin, 'peer');
  assert.equal(store.queue('a', 2, 'user-original', 'user').origin, 'user');
  store.updateDelivery(2, 'submitted', 'turn-user', { received: true });
  assert.equal(store.delivery('a', 2).origin, 'user');
  assert.throws(() => store.queue('a', 3, 'invalid-origin', 'spoofed'), { code: 'BAD_ARGS' });
  store.close();
  const resumed = f.store();
  assert.equal(resumed.delivery('a', 1).origin, 'peer');
  assert.equal(resumed.delivery('a', 2).origin, 'user');
});

test('legacy native deliveries migrate as peer data without inferred user authority', (t) => {
  const f = fixture(t), paths = nativePaths(f.ctx, { create: true });
  const legacy = new DatabaseSync(paths.db);
  legacy.exec(`CREATE TABLE deliveries (
    id INTEGER PRIMARY KEY, peer TEXT NOT NULL, message_id INTEGER NOT NULL,
    submission_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, turn_id TEXT,
    detail TEXT, updated_at INTEGER NOT NULL, UNIQUE(peer, message_id));
    INSERT INTO deliveries VALUES (1,'web',1,'legacy','queued',NULL,NULL,1);`);
  legacy.close();
  const migrated = f.store();
  assert.equal(migrated.delivery('web', 1).origin, 'peer');
  assert.equal(migrated.queue('web', 2, 'new-local-user', 'user').origin, 'user');
});

test('legacy native worker rows migrate without inventing a directory identity', (t) => {
  const f = fixture(t), paths = nativePaths(f.ctx, { create: true });
  const legacy = new DatabaseSync(paths.db);
  legacy.exec(`CREATE TABLE workers (
    peer TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT,
    cwd TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  legacy.prepare('INSERT INTO workers VALUES (?,?,?,?,?,?)')
    .run('old', 'codex', 'old-thread', f.ctx.root, 'closed', 1);
  legacy.close();
  const store = f.store();
  assert.equal(store.worker('old').session_id, 'old-thread');
  assert.equal(store.worker('old').cwd_identity, null);
  store.saveWorker({ peer: 'new', provider: 'codex', cwd: f.ctx.root,
    cwdIdentity: captureSelectedCwdSnapshot(f.ctx.root), sessionId: 'new-thread', status: 'closed' });
  const identity = JSON.parse(store.worker('new').cwd_identity);
  assert.equal(identity.version, 1);
  assert.equal(identity.canonical, fs.realpathSync(f.ctx.root));
});


test('native worker sandbox persists through status updates and restart without escalation', (t) => {
  const f = fixture(t), store = f.store();
  const worker = { peer: 'readonly', provider: 'codex', cwd: f.ctx.root, sessionId: 'saved-session', status: 'ready' };
  store.saveWorker({ ...worker, sandbox: 'read-only' });
  for (const status of ['running', 'error', 'uncertain', 'closed']) {
    store.saveWorker({ ...worker, sessionId: null, status });
    assert.equal(store.worker(worker.peer).sandbox, 'read-only', status);
    assert.equal(store.worker(worker.peer).session_id, 'saved-session', status);
  }
  assert.throws(() => store.saveWorker({ ...worker, sandbox: 'workspace-write' }), { code: 'NATIVE_SANDBOX_MISMATCH' });
  assert.equal(store.worker(worker.peer).sandbox, 'read-only');
  store.saveWorker({ ...worker, peer: 'legacy-default' });
  store.saveWorker({ ...worker, peer: 'claude', provider: 'claude' });
  store.saveWorker({ ...worker, peer: 'dsh', provider: 'dsh', sandbox: null });
  store.close();
  const restarted = f.store();
  restarted.disconnected();
  assert.equal(restarted.worker(worker.peer).sandbox, 'read-only');
  assert.equal(restarted.worker('legacy-default').sandbox, 'workspace-write');
  assert.equal(restarted.worker('claude').sandbox, null);
  assert.equal(restarted.worker('dsh').sandbox, null);
});

test('native worker store rejects unsupported sandbox policies before writing', (t) => {
  const f = fixture(t), store = f.store();
  for (const sandbox of [null, '', false, 1, {}, [], 'danger-full-access', 'ReadOnly']) {
    assert.throws(() => store.saveWorker({ peer: 'invalid', provider: 'codex', cwd: f.ctx.root, status: 'ready', sandbox }), { code: 'BAD_ARGS' });
  }
  for (const provider of ['claude', 'dsh']) {
    assert.throws(() => store.saveWorker({ peer: provider, provider, cwd: f.ctx.root, status: 'ready', sandbox: 'read-only' }), { code: 'BAD_ARGS' });
  }
  assert.equal(store.workers().length, 0);
});

test('legacy native worker migration adds Codex compatibility policy without granting it to other providers', (t) => {
  const f = fixture(t), paths = nativePaths(f.ctx, { create: true });
  const legacy = new DatabaseSync(paths.db);
  legacy.exec(`CREATE TABLE workers (
    peer TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT,
    cwd TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  for (const provider of ['codex', 'claude', 'dsh']) {
    legacy.prepare('INSERT INTO workers VALUES (?,?,?,?,?,?)').run(provider, provider, `old-${provider}`, f.ctx.root, 'closed', 7);
  }
  legacy.close();
  const migrated = f.store();
  assert.equal(migrated.worker('codex').sandbox, 'workspace-write');
  for (const provider of ['claude', 'dsh']) assert.equal(migrated.worker(provider).sandbox, null);
  for (const provider of ['codex', 'claude', 'dsh']) {
    assert.equal(migrated.worker(provider).session_id, `old-${provider}`);
    assert.equal(migrated.worker(provider).status, 'closed');
    assert.equal(migrated.worker(provider).updated_at, 7);
  }
  migrated.saveWorker({ peer: 'readonly', provider: 'codex', sessionId: 'new-readonly', cwd: f.ctx.root, status: 'idle', sandbox: 'read-only' });
  migrated.close();
  assert.equal(f.store().worker('readonly').sandbox, 'read-only', 'reopening the store must not repeat a broad permission migration');
});

test('an existing sandbox column with NULL policy is not silently migrated or defaulted on save', (t) => {
  const f = fixture(t), store = f.store();
  const worker = { peer: 'missing-policy', provider: 'codex', sessionId: 'saved-session', cwd: f.ctx.root, status: 'closed' };
  store.saveWorker({ ...worker, sandbox: 'read-only' });
  store.db.prepare('UPDATE workers SET sandbox=NULL WHERE peer=?').run(worker.peer);
  store.close();
  const reopened = f.store();
  const before = reopened.worker(worker.peer);
  assert.equal(before.sandbox, null);
  assert.throws(() => reopened.saveWorker({ ...worker, status: 'opening' }), { code: 'BAD_ARGS' });
  for (const sandbox of ['read-only', 'workspace-write']) {
    assert.throws(() => reopened.saveWorker({ ...worker, sandbox }), { code: 'NATIVE_SANDBOX_MISMATCH' });
  }
  assert.deepEqual(reopened.worker(worker.peer), before);
});

test('legacy worker sandbox schema and compatibility backfill migrate atomically', (t) => {
  const f = fixture(t), paths = nativePaths(f.ctx, { create: true });
  const legacy = new DatabaseSync(paths.db);
  legacy.exec(`CREATE TABLE workers (
    peer TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT,
    cwd TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TRIGGER reject_backfill BEFORE UPDATE ON workers BEGIN
      SELECT RAISE(ABORT, 'test sandbox backfill failure');
    END;`);
  legacy.prepare('INSERT INTO workers VALUES (?,?,?,?,?,?)').run('saved', 'codex', 'old-session', f.ctx.root, 'closed', 7);
  legacy.close();
  assert.throws(() => f.store(), /test sandbox backfill failure/);
  const inspection = new DatabaseSync(paths.db);
  try {
    assert.equal(inspection.prepare('PRAGMA table_info(workers)').all().some(column => column.name === 'sandbox'), false);
    assert.equal(inspection.prepare("SELECT session_id FROM workers WHERE peer='saved'").get().session_id, 'old-session');
    inspection.exec('DROP TRIGGER reject_backfill');
  } finally { inspection.close(); }
  assert.equal(f.store().worker('saved').sandbox, 'workspace-write');
});


test('native pointer rejects a replacement directory even if the original pathname is restored before validation', t => {
  const f = fixture(t);
  const selected = f.ctx.root;
  const original = path.join(f.sandbox, 'original');
  const replacement = path.join(f.sandbox, 'replacement');
  fs.mkdirSync(replacement);
  const expected = captureSelectedCwdSnapshot(selected);
  fs.renameSync(selected, original);
  fs.renameSync(replacement, selected);
  writeNativePointer(f.ctx, f.pointer({ rootIdentity: captureSelectedCwdSnapshot(selected) }));
  fs.renameSync(selected, replacement);
  fs.renameSync(original, selected);
  let accesses = 0;
  const swappingCtx = {
    dbPath: f.ctx.dbPath,
    initialRootIdentity: expected,
    get root() {
      accesses++;
      if (accesses === 1) {
        fs.renameSync(selected, original);
        fs.renameSync(replacement, selected);
      } else if (accesses === 2) {
        fs.renameSync(selected, replacement);
        fs.renameSync(original, selected);
      }
      return selected;
    }
  };
  try {
    assert.throws(() => readNativePointer(swappingCtx), { code: 'PROJECT_PATH_CHANGED' });
    assert.equal(accesses, 2);
  } finally {
    if (fs.existsSync(original)) {
      fs.renameSync(selected, replacement);
      fs.renameSync(original, selected);
    }
  }
});


test('native pointer without a root receipt is not authorized by a selected project identity', t => {
  const f = fixture(t);
  writeNativePointer(f.ctx, f.pointer());
  assert.throws(() => readNativePointer({ ...f.ctx,
    initialRootIdentity: captureSelectedCwdSnapshot(f.ctx.root) }), { code: 'PROJECT_PATH_CHANGED' });
});
