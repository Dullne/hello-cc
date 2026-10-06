import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createNativeLauncher } from '../lib/runtime/native/launcher.mjs';
import { nativeRequest } from '../lib/runtime/native/client.mjs';
import { claimNativeOwner, nativePaths, readNativePointer, writeNativePointer } from '../lib/runtime/native/store.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { redactSecrets } from '../lib/shared/redact.mjs';
import { createNativeTestRoot } from './helpers/native-root.mjs';

async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (check()) return; await delay(25); }
  assert.fail('native daemon did not finish shutdown');
}

async function fixture(t) {
  const directory = await createNativeTestRoot('hcc-native-launcher-', { projectSubdir: 'empty project' });
  const root = path.join(directory, 'empty project'), home = path.join(directory, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const ctx = { root, dbPath: path.join(root, '.hello-cc', 'mesh.db') };
  const children = [];
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, USERPROFILE: home,
    NODE_NO_WARNINGS: '1', HCC_RUNTIME_URL: '', NO_COLOR: '1' };
  t.after(async () => {
    try {
      if (readNativePointer(ctx)) {
        try { await nativeRequest(ctx, 'POST', '/down', {}, { timeoutMs: 2000 }); } catch {}
        if (children.length) await until(() => !readNativePointer(ctx));
      }
    } finally {
      // Preserve bounded public failure evidence before this fixture removes
      // its private runtime log; never publish the complete log or pointer.
      const exitCodes = children.map(child => child.exitCode).filter(code => Number.isInteger(code) && code !== 0);
      if (exitCodes.length) {
        try {
          const lines = fs.readFileSync(path.join(root, '.hello-cc', 'native', 'runtime.log'), 'utf8')
            .slice(-8192).split(/\r?\n/);
          const errors = lines.filter(line => /^(?:hcc:|HCC_PINNED_|\{"code":)/.test(line)).slice(-6).map(line => {
            try { const value = JSON.parse(line); return { code: value.code, message: value.message }; }
            catch { return { code: line.match(/^(HCC_PINNED_[A-Z_]+)/)?.[1] || null, message: line }; }
          });
          t.diagnostic(JSON.stringify(redactSecrets({ nativeRuntimeFailure: { exitCodes, errors } })));
        } catch (error) {
          t.diagnostic(JSON.stringify({ nativeRuntimeFailure: { exitCodes, logReadError: error.code || 'UNKNOWN' } }));
        }
      }
      // Only children created by this fixture are eligible for fallback cleanup.
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  return { ctx, env, spawnProcess: (...args) => { const child = spawn(...args); children.push(child); return child; }, children };
}

test('shared native launcher starts a real empty-project daemon once and reuses it across competing launchers', async t => {
  const f = await fixture(t);
  const firstLauncher = createNativeLauncher({ env: f.env, spawnProcess: f.spawnProcess, pollMs: 25 });
  // A second factory has no shared promise map: coordination must use the
  // loopback launch lock, just as independent CLI/Web processes do.
  const otherLauncher = createNativeLauncher({ env: f.env, spawnProcess: f.spawnProcess, pollMs: 25 });
  const first = firstLauncher(f.ctx);
  assert.equal(first, firstLauncher(f.ctx));
  const [a, b] = await Promise.all([first, otherLauncher(f.ctx)]);
  assert.equal(f.children.length, 1);
  assert.equal(a.generation, b.generation); assert.equal(a.root, f.ctx.root);
  assert.deepEqual(a.workers, []);
  assert.equal((await firstLauncher(f.ctx)).generation, a.generation);
  assert.equal(f.children.length, 1);
  assert.equal((await nativeRequest(f.ctx, 'POST', '/down', {})).stopping, true);
  await until(() => !readNativePointer(f.ctx));
});

test('failed native launch releases its reservation and a later explicit attempt observes a fresh failure', async t => {
  const f = await fixture(t); let attempts = 0;
  const ensure = createNativeLauncher({ env: f.env, pollMs: 5, spawnProcess() {
    attempts++;
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('error', Object.assign(new Error('fixture spawn denied'), { code: 'EACCES' })));
    return child;
  } });
  await assert.rejects(ensure(f.ctx), { code: 'NATIVE_RUNTIME_START_FAILED' });
  await assert.rejects(ensure(f.ctx), { code: 'NATIVE_RUNTIME_START_FAILED' });
  assert.equal(attempts, 2); assert.equal(readNativePointer(f.ctx), null);
});

test('native daemon never starts on a replacement root between capture and child spawn', async t => {
  const f = await fixture(t);
  const original = `${f.ctx.root}-original`;
  let replaced = false;
  const ensure = createNativeLauncher({ env: f.env, pollMs: 10,
    spawnProcess(command, args, options) {
      fs.renameSync(f.ctx.root, original);
      fs.mkdirSync(f.ctx.root);
      replaced = true;
      return f.spawnProcess(command, args, options);
    }
  });
  await assert.rejects(ensure(f.ctx), { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(replaced, true);
  assert.equal(readNativePointer(f.ctx), null);
});

test('native launcher rejects a root replaced after the CLI selected it', async t => {
  const f = await fixture(t);
  const selected = captureSelectedCwdSnapshot(f.ctx.root);
  fs.renameSync(f.ctx.root, `${f.ctx.root}-original`);
  fs.mkdirSync(f.ctx.root);
  const ensure = createNativeLauncher({ env: f.env,
    spawnProcess() { assert.fail('replacement project must not start a native daemon'); } });
  assert.throws(() => ensure({ ...f.ctx, initialRootIdentity: selected }),
    { code: 'PROJECT_PATH_CHANGED' });
});

test('native launcher refuses a stopping or mismatched daemon instead of spawning a replacement', async t => {
  const f = await fixture(t);
  const rootIdentity = captureSelectedCwdSnapshot(f.ctx.root);
  writeNativePointer(f.ctx, { root: f.ctx.root, meshDb: f.ctx.dbPath, pid: process.pid,
    rootIdentity,
    port: 1, token: 'x'.repeat(64), generation: 'test-generation' });
  let calls = 0;
  const ensure = createNativeLauncher({ spawnProcess() { assert.fail('must not replace an existing daemon'); },
    request: async () => { calls++; return { root: f.ctx.root, meshDb: f.ctx.dbPath, generation: 'test-generation', stopping: true }; } });
  await assert.rejects(ensure(f.ctx), { code: 'NATIVE_OWNER_UNVERIFIED' });
  assert.equal(calls, 0);
  fs.rmSync(nativePaths(f.ctx).pointer);
  const ownerIdentity = inspectProcessIdentity(process.pid).identity;
  const owner = claimNativeOwner(f.ctx, { rootIdentity, identity: ownerIdentity, generation: 'test-generation' });
  try {
    writeNativePointer(f.ctx, { root: f.ctx.root, meshDb: f.ctx.dbPath, pid: process.pid,
      rootIdentity, ownerIdentity, ownerVersion: 2, stateGeneration: owner.stateGeneration,
      port: 1, token: 'x'.repeat(64), generation: 'test-generation' });
    await assert.rejects(ensure(f.ctx), { code: 'NATIVE_RUNTIME_STOPPING' });
    assert.equal(calls, 1);
    const wrong = createNativeLauncher({ request: async () => ({ root: os.tmpdir(), meshDb: f.ctx.dbPath, generation: 'wrong' }) });
    await assert.rejects(wrong(f.ctx), { code: 'NATIVE_RESPONSE_INVALID' });
  } finally {
    fs.rmSync(nativePaths(f.ctx).pointer, { force: true });
    owner.release(); owner.db.close();
  }
});
