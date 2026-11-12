import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensurePrivateProjectStateDir } from '../lib/runtime/private-state.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { claimNativeOwner, createNativeStore, nativePaths, readNativeOwnerStatus,
  acquireNativeOwnerWrite, writeNativePointer, readNativePointer } from '../lib/runtime/native/store.mjs';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

const windows = { skip: process.platform !== 'win32' };
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-native-db-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = path.join(base, 'profile'), root = path.join(base, 'project');
  fs.mkdirSync(home); fs.mkdirSync(root);
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const state = ensurePrivateProjectStateDir(root, { create: true });
  const rootIdentity = captureSelectedCwdSnapshot(root), identity = inspectProcessIdentity(process.pid).identity;
  const ctx = { root, dbPath: path.join(state, 'mesh.db'), initialRootIdentity: rootIdentity };
  return { base, root, ctx, rootIdentity, identity };
}

test('Windows native owner refuses a database hard link introduced while its WAL connection is open', windows, t => {
  const f = fixture(t), generation = randomUUID();
  const owner = claimNativeOwner(f.ctx, { rootIdentity: f.rootIdentity, identity: f.identity, generation });
  const store = createNativeStore(f.ctx, { owner });
  const paths = nativePaths(f.ctx), alias = path.join(f.base, 'foreign-link.db');
  try {
    store.event('worker', { text: 'before' });
    fs.linkSync(paths.db, alias);
    assert.throws(() => store.event('worker', { text: 'must not write' }), { code: 'NATIVE_STATE_UNSAFE' });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM provider_events').get().n, 1);
  } finally { fs.unlinkSync(alias); store.close(); }
});

test('Windows native store retains directory and leaf identity through real WAL work and Symbol.dispose', windows, t => {
  const f = fixture(t), store = createNativeStore(f.ctx), paths = nativePaths(f.ctx);
  let closed = false;
  try {
    store.event('worker', { text: 'persisted' });
    assert.equal(fs.existsSync(paths.db + '-wal'), true);
    for (const target of [paths.db, paths.dir]) assert.throws(() => fs.renameSync(target, target + '-moved'),
      error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
    store.db[Symbol.dispose](); closed = true;
    assert.equal(fs.existsSync(paths.db + '-wal'), false);
    fs.renameSync(paths.db, paths.db + '-moved'); fs.renameSync(paths.db + '-moved', paths.db);
    fs.renameSync(paths.dir, paths.dir + '-moved'); fs.renameSync(paths.dir + '-moved', paths.dir);
    const reopened = createNativeStore(f.ctx);
    try { assert.deepEqual(reopened.events('worker')[0].payload, { text: 'persisted' }); }
    finally { reopened.close(); }
  } finally { if (!closed) store.close(); }
});

test('Windows native owner read/write claims release short-lived database pins and publish private pointers', windows, t => {
  const f = fixture(t), generation = randomUUID();
  const owner = claimNativeOwner(f.ctx, { rootIdentity: f.rootIdentity, identity: f.identity, generation });
  try {
    assert.equal(readNativeOwnerStatus(f.ctx).state, 'live');
    const finish = acquireNativeOwnerWrite(f.ctx, generation); finish(true);
    const pointer = { root: f.root, meshDb: f.ctx.dbPath, port: 14222, token: 'a'.repeat(64), generation,
      pid: process.pid, rootIdentity: f.rootIdentity };
    writeNativePointer(f.ctx, pointer);
    assert.equal(readNativePointer(f.ctx).generation, generation);
    const paths = nativePaths(f.ctx);
    assert.equal(loadWindowsNative().inspectPathSecurity(paths.pointer).private, true);
    writeNativePointer(f.ctx, { ...pointer, port: 14223 });
    assert.equal(readNativePointer(f.ctx).port, 14223);
    owner.release();
  } finally { owner.db.close(); }
  const paths = nativePaths(f.ctx);
  fs.renameSync(paths.db, paths.db + '-moved'); fs.renameSync(paths.db + '-moved', paths.db);
  fs.renameSync(paths.dir, paths.dir + '-moved'); fs.renameSync(paths.dir + '-moved', paths.dir);
});

test('Windows native database close failure retains protection until a successful disposal retry', windows, t => {
  const f = fixture(t), original = DatabaseSync.prototype.close;
  let failClose = true, store;
  DatabaseSync.prototype.close = function (...args) {
    if (failClose) throw Object.assign(new Error('Injected SQLite close failure'), { code: 'TEST_SQLITE_CLOSE' });
    return original.apply(this, args);
  };
  try { store = createNativeStore(f.ctx); }
  finally { DatabaseSync.prototype.close = original; }
  const paths = nativePaths(f.ctx);
  try {
    assert.throws(() => store.close(), { code: 'TEST_SQLITE_CLOSE' });
    assert.equal(store.db.prepare('SELECT 1 AS n').get().n, 1);
    assert.throws(() => fs.renameSync(paths.dir, paths.dir + '-moved'), error => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code));
  } finally { failClose = false; store.db[Symbol.dispose](); }
  fs.renameSync(paths.dir, paths.dir + '-moved'); fs.renameSync(paths.dir + '-moved', paths.dir);
});

test('Windows native owner rejects an unsafe live WAL sidecar before another fenced write', windows, t => {
  const f = fixture(t), generation = randomUUID();
  const owner = claimNativeOwner(f.ctx, { rootIdentity: f.rootIdentity, identity: f.identity, generation });
  const store = createNativeStore(f.ctx, { owner }), paths = nativePaths(f.ctx);
  const alias = path.join(f.base, 'foreign-wal');
  try {
    store.event('worker', { text: 'before' });
    fs.linkSync(paths.db + '-wal', alias);
    assert.throws(() => store.event('worker', { text: 'must not write' }), { code: 'NATIVE_STATE_UNSAFE' });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM provider_events').get().n, 1);
  } finally { fs.unlinkSync(alias); store.close(); }
});

test('Windows native derived writer retries a failed SQLite close without replaying its committed transaction', windows, t => {
  const f = fixture(t), generation = randomUUID();
  const owner = claimNativeOwner(f.ctx, { rootIdentity: f.rootIdentity, identity: f.identity, generation });
  const original = DatabaseSync.prototype.close;
  let failClose = true, finish;
  DatabaseSync.prototype.close = function (...args) {
    if (failClose) throw Object.assign(new Error('Injected derived-writer close failure'), { code: 'TEST_SQLITE_CLOSE' });
    return original.apply(this, args);
  };
  try { finish = acquireNativeOwnerWrite(f.ctx, generation); }
  finally { DatabaseSync.prototype.close = original; }
  try {
    assert.throws(() => finish(true), { code: 'TEST_SQLITE_CLOSE' });
    failClose = false;
    assert.doesNotThrow(() => finish(true), 'cleanup retry must not COMMIT an already ended transaction');
    owner.assertCurrent(); owner.release();
  } finally { failClose = false; finish(); owner.db.close(); }
  const paths = nativePaths(f.ctx);
  fs.renameSync(paths.dir, paths.dir + '-moved'); fs.renameSync(paths.dir + '-moved', paths.dir);
});
