import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { inspectProcessIdentity, compareProcessIdentity, isProcessIdentityIncompatible,
  waitForProcessIdentityExit } from '../lib/process/identity.mjs';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

const windows = { skip: process.platform !== 'win32' };

test('Windows identity uses native creation time and explicitly image-based evidence', windows, () => {
  const observed = inspectProcessIdentity(process.pid);
  assert.equal(observed.state, 'live');
  const native = loadWindowsNative().inspectProcess(process.pid);
  assert.deepEqual(observed.identity, {
    pid: process.pid,
    startToken: `win32:v1:${native.creationTime}`,
    commandHash: createHash('sha256').update('win32:image-path:v1\0').update(native.imagePath).digest('hex')
  });
  assert.deepEqual(inspectProcessIdentity(process.pid), observed);
  assert.equal(compareProcessIdentity(observed.identity, observed.identity), 'live');
});

test('Windows child identity becomes confirmed dead after its owned child exits', windows, async t => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();'],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, 'spawn');
  const observed = inspectProcessIdentity(child.pid);
  assert.equal(observed.state, 'live');
  const exit = once(child, 'exit');
  child.stdin.end();
  await exit;
  assert.deepEqual(inspectProcessIdentity(child.pid), { state: 'dead', identity: null });
  assert.deepEqual(await waitForProcessIdentityExit(observed.identity, { timeoutMs: 1000 }), { state: 'dead', identity: null });
});

test('invalid Windows PIDs never produce a live identity', windows, () => {
  for (const value of [undefined, null, {}, Symbol('invalid'), NaN, Infinity, -1, 0, 1.5, 4294967296]) {
    assert.deepEqual(inspectProcessIdentity(value), { state: 'unknown', identity: null });
  }
});

test('missing native component remains unknown instead of trusting PID existence', windows, t => {
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(filename, ...args) {
    if (String(filename).replaceAll('\\', '/').endsWith('/native/bin/win32-x64/hcc-windows.json')) {
      throw Object.assign(new Error('missing native fixture'), { code: 'ENOENT' });
    }
    return Reflect.apply(original, fs, [filename, ...args]);
  });
  assert.deepEqual(inspectProcessIdentity(process.pid), { state: 'unknown', identity: null });
  assert.deepEqual(inspectProcessIdentity(4294967295), { state: 'unknown', identity: null });
});

test('unsupported Windows native architecture remains unknown', windows, () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'arch', { ...descriptor, value: 'arm64' });
  try { assert.deepEqual(inspectProcessIdentity(process.pid), { state: 'unknown', identity: null }); }
  finally { Object.defineProperty(process, 'arch', descriptor); }
});

test('incompatible Windows token versions do not prove ownership or process exit', () => {
  const current = { pid: 42, startToken: 'win32:v1:134073387256789000', commandHash: 'a'.repeat(64) };
  const future = { ...current, startToken: 'win32:v2:134073387256789000' };
  assert.equal(isProcessIdentityIncompatible(current, future), true);
  assert.equal(compareProcessIdentity(current, future), 'unknown');
  assert.equal(compareProcessIdentity(future, current), 'unknown');
  assert.equal(compareProcessIdentity(current, { ...current, startToken: 'win32:v1:134073387256789001' }), 'dead');
  assert.equal(compareProcessIdentity(current, { ...future, pid: 43 }), 'dead');
});
