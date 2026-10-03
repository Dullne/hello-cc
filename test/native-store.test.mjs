import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
    fs.writeFileSync(paths.pointer, content);
    assert.throws(() => readNativePointer(f.ctx), { code: 'NATIVE_STATE_INVALID' }, name);
  }
  fs.writeFileSync(paths.pointer, 'x'.repeat(16385));
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
