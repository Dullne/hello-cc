import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireNativeOwnerWrite, claimNativeOwner, nativePaths, readNativeOwnerStatus,
  writeNativePointer } from '../lib/runtime/native/store.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { provisionPrivateProjectGeneration } from '../lib/runtime/private-state.mjs';

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-owner-'));
  const root = path.join(sandbox, 'project');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
  const rootIdentity = captureSelectedCwdSnapshot(root);
  const identity = inspectProcessIdentity(process.pid).identity;
  const owners = [];
  const withHome = fn => {
    const old = process.env.HOME;
    process.env.HOME = home;
    try { return fn(); } finally { process.env.HOME = old; }
  };
  t.after(() => {
    for (const owner of owners) { try { owner.db.close(); } catch {} }
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  return { ctx, home, rootIdentity, identity, withHome,
    claim(generation, inspect) {
      const owner = withHome(() => claimNativeOwner(ctx, { rootIdentity, identity, generation,
        ...(inspect ? { inspect } : {}) }));
      owners.push(owner);
      return owner;
    } };
}

test('native owner claim rejects a live or uninspectable incumbent until explicit release', t => {
  const f = fixture(t);
  const first = f.claim('first');
  assert.equal(f.withHome(() => readNativeOwnerStatus(f.ctx)).state, 'live');
  assert.throws(() => f.claim('second'), { code: 'NATIVE_RUNTIME_IN_USE' });
  assert.throws(() => f.claim('second', () => ({ state: 'unknown' })), { code: 'NATIVE_RUNTIME_IN_USE' });
  assert.throws(() => f.withHome(() => acquireNativeOwnerWrite(f.ctx, 'second')),
    { code: 'NATIVE_OWNER_UNVERIFIED' });
  first.release();
  const second = f.claim('second');
  assert.equal(f.withHome(() => readNativeOwnerStatus(f.ctx)).generation, 'second');
  second.release();
});

test('legacy pointer from a live or uncertain daemon blocks the first durable claim', t => {
  const f = fixture(t);
  f.withHome(() => writeNativePointer(f.ctx, { root: f.rootIdentity.canonical,
    meshDb: path.resolve(f.ctx.dbPath),
    pid: process.pid, port: 12345, token: 'x'.repeat(64), generation: 'legacy' }));
  assert.throws(() => f.claim('fresh'), { code: 'NATIVE_OWNER_UNVERIFIED' });
  assert.throws(() => f.claim('fresh', () => ({ state: 'unknown' })),
    { code: 'NATIVE_OWNER_UNVERIFIED' });
  assert.equal(f.withHome(() => readNativeOwnerStatus(f.ctx)).state, 'absent');
  // Cold-drained old daemons without a root receipt can be migrated only
  // after their process is confirmed dead, not merely unreachable on HTTP.
  f.withHome(() => writeNativePointer(f.ctx, { root: f.rootIdentity.canonical,
    meshDb: path.resolve(f.ctx.dbPath), pid: 99999999, port: 12345,
    token: 'x'.repeat(64), generation: 'legacy' }));
  const fresh = f.claim('fresh', () => ({ state: 'dead' }));
  fresh.release();
});

test('a forced takeover is serialized and the old writer fails stopped on its next write', t => {
  const f = fixture(t);
  let losses = 0;
  const first = f.withHome(() => claimNativeOwner(f.ctx, { rootIdentity: f.rootIdentity,
    identity: f.identity, generation: 'first', onLoss: () => { losses++; } }));
  const paths = f.withHome(() => nativePaths(f.ctx));
  const mesh = new DatabaseSync(paths.meshDb);
  mesh.exec('CREATE TABLE data (value TEXT)');
  first.setMesh(mesh);
  first.withWrite(() => mesh.prepare('INSERT INTO data(value) VALUES (?)').run('before'));
  const second = f.claim('second', () => ({ state: 'dead' }));
  assert.throws(() => first.withWrite(() => mesh.prepare('INSERT INTO data(value) VALUES (?)').run('after')),
    { code: 'NATIVE_OWNER_LOST' });
  assert.equal(first.lost, true);
  assert.equal(losses, 1);
  assert.throws(() => mesh.prepare('INSERT INTO data(value) VALUES (?)').run('outside'));
  assert.deepEqual(mesh.prepare('SELECT value FROM data').all().map(row => row.value), ['before']);
  second.release();
  mesh.close(); first.db.close();
});

test('native derived writer holds the owner lock and rejects stale generations before mesh access', t => {
  const f = fixture(t);
  const owner = f.claim('first');
  const finish = f.withHome(() => acquireNativeOwnerWrite(f.ctx, 'first'));
  finish();
  assert.throws(() => f.withHome(() => acquireNativeOwnerWrite(f.ctx, 'other')),
    { code: 'NATIVE_OWNER_UNVERIFIED' });
  owner.release();
  assert.throws(() => f.withHome(() => acquireNativeOwnerWrite(f.ctx, 'first')),
    { code: 'NATIVE_OWNER_UNVERIFIED' });
});

test('explicit B generation gets a separate native pointer and owner without touching A', t => {
  const f = fixture(t);
  fs.chmodSync(f.ctx.root, 0o777);
  const first = f.claim('first');
  const aPaths = f.withHome(() => nativePaths(f.ctx));
  f.withHome(() => writeNativePointer(f.ctx, { root: f.rootIdentity.canonical,
    meshDb: path.resolve(f.ctx.dbPath), rootIdentity: f.rootIdentity,
    ownerVersion: 2, ownerIdentity: f.identity, pid: f.identity.pid,
    stateGeneration: first.stateGeneration, port: 12345,
    token: 'a'.repeat(64), generation: first.generation }));
  const aPointer = fs.readFileSync(aPaths.pointer, 'utf8');
  first.release(); first.db.close();
  fs.renameSync(f.ctx.root, `${f.ctx.root}-old`);
  fs.mkdirSync(f.ctx.root, { mode: 0o777 });
  fs.chmodSync(f.ctx.root, 0o777);
  const bIdentity = captureSelectedCwdSnapshot(f.ctx.root);
  const bDirectory = f.withHome(() => provisionPrivateProjectGeneration(f.ctx.root));
  assert.ok(bDirectory);
  const second = f.withHome(() => claimNativeOwner(f.ctx, { rootIdentity: bIdentity,
    identity: f.identity, generation: 'second' }));
  try {
    const bPaths = f.withHome(() => nativePaths(f.ctx));
    assert.notEqual(bPaths.dir, aPaths.dir);
    assert.equal(path.dirname(bPaths.dir), bDirectory);
    assert.equal(fs.readFileSync(aPaths.pointer, 'utf8'), aPointer);
    f.withHome(() => writeNativePointer(f.ctx, { root: bIdentity.canonical,
      meshDb: path.resolve(f.ctx.dbPath), rootIdentity: bIdentity,
      ownerVersion: 2, ownerIdentity: f.identity, pid: f.identity.pid,
      stateGeneration: second.stateGeneration, port: 12346,
      token: 'b'.repeat(64), generation: second.generation }));
    assert.equal(fs.readFileSync(aPaths.pointer, 'utf8'), aPointer);
    assert.equal(JSON.parse(fs.readFileSync(bPaths.pointer, 'utf8')).generation, 'second');
  } finally { second.release(); second.db.close(); }
});

test('inherited native owner markers fail closed for ordinary CLI write commands', t => {
  const f = fixture(t);
  const bin = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
  const env = { ...process.env, HOME: path.dirname(f.ctx.root), HCC_ROOT: f.ctx.root,
    HCC_DB: f.ctx.dbPath, HCC_PEER: 'worker',
    HCC_NATIVE_OWNER: 'native:first:worker:00000000-0000-4000-8000-000000000001' };
  for (const args of [
    ['msg', 'send', '--to', 'other', '--body', 'blocked'],
    ['task', 'next'],
    ['lock', 'acquire', '--resource', 'src/file', '--task', '1']
  ]) {
    const result = spawnSync(process.execPath, [bin, ...args], { cwd: f.ctx.root, env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Native workers must use their scoped MCP tools/);
    assert.equal(fs.existsSync(path.join(f.ctx.root, '.hello-cc')), false);
  }
  const allowed = spawnSync(process.execPath, [bin, 'mcp', 'serve', '--peer', 'worker'],
    { cwd: f.ctx.root, env, encoding: 'utf8' });
  assert.equal(allowed.status, 1);
  assert.doesNotMatch(allowed.stderr, /Native workers must use their scoped MCP tools/);
});

test('removing the inherited marker does not isolate same-account native worker writes', t => {
  const f = fixture(t);
  const owner = f.claim('first');
  const paths = f.withHome(() => nativePaths(f.ctx));
  assert.equal(f.withHome(() => readNativeOwnerStatus(f.ctx)).state, 'live');
  const bin = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
  const env = { ...process.env, HOME: f.home, HCC_ROOT: f.ctx.root,
    HCC_DB: f.ctx.dbPath, HCC_PEER: 'worker', NODE_NO_WARNINGS: '1' };
  delete env.HCC_NATIVE_OWNER;
  const result = spawnSync(process.execPath, [bin, 'msg', 'send', '--to', 'other', '--body', 'marker-removed'],
    { cwd: f.ctx.root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const mesh = new DatabaseSync(paths.meshDb, { readOnly: true });
  try {
    assert.deepEqual(mesh.prepare('SELECT sender, recipient, body FROM messages').all().map(row => ({ ...row })),
      [{ sender: 'worker', recipient: 'other', body: 'marker-removed' }]);
  } finally { mesh.close(); owner.release(); }
});
