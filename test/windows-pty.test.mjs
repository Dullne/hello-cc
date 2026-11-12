import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';

const windows = { skip: process.platform !== 'win32', timeout: 10000 };
async function fixture(t) {
  const { spawnWindowsPty } = await import('../lib/platform/windows-pty.mjs');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-windows-pty-'));
  const children = [];
  t.after(async () => { for (const child of children) await child.closeOwned(); await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); });
  return { cwd, spawn(args, options = {}) { const child = spawnWindowsPty(process.execPath, args,
    { cwd, expectedIdentity: captureSelectedCwdSnapshot(cwd), cols: 90, rows: 30, ...options }); children.push(child); return child; } };
}
async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await sleep(10); } assert.fail('Timed out waiting for ConPTY'); }

test('Windows PTY adapter decodes Unicode, supports callback disposal and reports complete output before exit', windows, async t => {
  const f = await fixture(t), child = f.spawn(['-e', 'process.stdout.write("中文🙂\\r\\n");']);
  let output = '', unexpected = false;
  const removed = child.onData(() => { unexpected = true; }); removed.dispose();
  child.onData(data => { output += data; });
  const event = await new Promise(resolve => child.onExit(resolve));
  assert.equal(event.exitCode, 0); assert.equal(unexpected, false);
  assert.match(output, /中文🙂/);
  assert.ok(child.pid > 0); assert.match(child.creationTime, /^[0-9]+$/);
  assert.equal(child.processIdentity.pid, child.pid);
  assert.equal(child.processIdentity.startToken, `win32:v1:${child.creationTime}`);
  assert.match(child.processIdentity.commandHash, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(child.processIdentity));
  await child.closeOwned();
});

test('Windows PTY adapter sends literal input, resizes, and resumes paused output', windows, async t => {
  const f = await fixture(t), child = f.spawn(['-e',
    'process.stdin.setRawMode(true);process.stdin.resume();console.log("READY");process.stdin.on("data",d=>console.log("VALUE:"+d.toString()));']);
  let output = ''; child.onData(data => { output += data; });
  await until(() => output.includes('READY'));
  assert.deepEqual(child.processIdentity, inspectProcessIdentity(child.pid).identity);
  child.pause(); child.resize(110, 32); assert.equal(child.write('中文 &!'), true);
  await sleep(80); assert.doesNotMatch(output, /VALUE:/);
  child.resume(); await until(() => output.includes('VALUE:中文 &!'));
  await child.closeOwned();
});

test('Windows PTY Job cancellation closes a silent root and its detached grandchild', windows, async t => {
  const f = await fixture(t), child = f.spawn(['-e',
    'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});console.log("PID:"+c.pid);setInterval(()=>{},1000);']);
  let output = ''; child.onData(data => { output += data; });
  await until(() => /PID:[0-9]+/.test(output));
  const descendant = Number(output.match(/PID:([0-9]+)/)[1]);
  child.terminateOwned(); await child.closeOwned();
  const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
  assert.equal(loadWindowsNative().inspectProcess(descendant).state, 'dead');
  assert.equal(loadWindowsNative().inspectProcess(child.pid).state, 'dead');
});

test('Windows PTY refuses stale directory selection and bounded input never silently drops', windows, async t => {
  const f = await fixture(t), expectedIdentity = captureSelectedCwdSnapshot(f.cwd);
  fs.renameSync(f.cwd, f.cwd + '-old'); fs.mkdirSync(f.cwd); t.after(() => fs.rmSync(f.cwd + '-old', { recursive: true, force: true }));
  const { spawnWindowsPty } = await import('../lib/platform/windows-pty.mjs');
  assert.throws(() => spawnWindowsPty(process.execPath, ['-e', ''], { cwd: f.cwd, expectedIdentity }), { code: 'PROJECT_PATH_CHANGED' });
  const child = f.spawn(['-e', 'setInterval(()=>{},1000)']);
  assert.throws(() => child.write('x'.repeat(65537)), { code: 'WINDOWS_PTY_INPUT_TOO_LARGE' });
  assert.throws(() => child.kill('SIGTERM'), { code: 'WINDOWS_SIGNAL_UNSUPPORTED' });
  child.onData(() => {}); await child.closeOwned();
});
