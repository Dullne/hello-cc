import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerCleanup } from './helpers/fixture-cleanup.mjs';

test('fixture cleanup releases a live pinned child before removing its directory', { skip: process.platform !== 'win32' }, async () => {
  const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
  const native = loadWindowsNative();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-fixture-cleanup-'));
  const hooks = [], context = { after(fn) { hooks.push(fn); } };
  let child;
  try {
    registerCleanup(context, () => fs.rmSync(root, { recursive: true }));
    const lease = native.captureDirectory(root);
    try {
      child = native.startOwnedProcess({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: root, env: process.env, lease });
    } finally { lease.close(); }
    registerCleanup(context, async () => {
      child.terminate();
      for (let i = 0; i < 500 && !child.poll().exited; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(child.poll().exited, true);
      child.close();
    });
    for (const hook of hooks) await hook();
    assert.equal(fs.existsSync(root), false);
    assert.equal(native.inspectProcess(child.pid).state, 'dead');
  } finally {
    child?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('fixture cleanup continues releasing resources after another cleanup fails', async () => {
  const hooks = [], released = [], context = { after(fn) { hooks.push(fn); } };
  registerCleanup(context, () => released.push('directory'));
  registerCleanup(context, () => { throw new Error('close failed'); });
  registerCleanup(context, () => released.push('child'));
  await assert.rejects(async () => { for (const hook of hooks) await hook(); }, /close failed/);
  assert.deepEqual(released, ['child', 'directory']);
});