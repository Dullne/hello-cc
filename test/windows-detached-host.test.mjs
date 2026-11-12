import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';
import { fileURLToPath } from 'node:url';

const windows = { skip: process.platform !== 'win32', timeout: 10000 };
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-detached-host-'));
  t.after(() => fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 }));
  return cwd;
}

test('detached service root requires an opaque pinned lease and handle-based cancellation', windows, async t => {
  const cwd = fixture(t), native = loadWindowsNative();
  assert.equal(typeof native.startDetachedHost, 'function');
  const options = { file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env: process.env };
  assert.throws(() => native.startDetachedHost(options), { code: 'WINDOWS_PROCESS_ERROR' });
  const lease = native.captureDirectory(cwd);
  let unexpected;
  try { assert.throws(() => { unexpected = native.startDetachedHost({ ...options, lease, suspended: true }); }, { code: 'WINDOWS_PROCESS_ERROR' }); }
  finally { unexpected?.close(); }
  const child = native.startDetachedHost({ ...options, lease }); lease.close();
  t.after(() => child.close());
  assert.equal(child.poll().exited, false);
  assert.throws(() => fs.renameSync(cwd, cwd + '-moved'));
  child.terminate();
  for (let i = 0; i < 100 && !child.poll().exited; i++) await sleep(10);
  assert.equal(child.poll().exited, true);
  child.close();
});

test('only service controllers can detach and no lease or Job owner is silently discarded', windows, async t => {
  const cwd = fixture(t), native = loadWindowsNative();
  assert.equal(typeof native.startDetachedHost, 'function');
  const owned = native.startOwnedProcess({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env: process.env });
  t.after(() => owned.close());
  assert.throws(() => owned.detach(), { code: 'WINDOWS_PROCESS_ERROR' });
  const lease = native.captureDirectory(cwd);
  const host = native.startDetachedHost({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd,
    env: process.env, lease }); lease.close();
  t.after(() => host.close());
  assert.throws(() => host.detach('extra'), { code: 'WINDOWS_PROCESS_ERROR' });
  host.terminate(); owned.terminate();
  for (let i = 0; i < 100 && (!host.poll().exited || !owned.poll().exited); i++) await sleep(10);
  host.close(); owned.close();
});

test('a detached service survives launcher exit and retains its original cwd pins until its own exit', windows, async t => {
  const cwd = fixture(t), native = loadWindowsNative();
  assert.equal(typeof native.startDetachedHost, 'function');
  const entry = path.join(cwd, 'entry.json'), done = path.join(cwd, 'done');
  const service = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(entry)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));
    setTimeout(()=>fs.writeFileSync(${JSON.stringify(done)},'done'),1200);`;
  const host = path.join(cwd, 'launcher.mjs');
  fs.writeFileSync(host, `import {loadWindowsNative} from ${JSON.stringify(new URL('../lib/platform/windows-native.mjs', import.meta.url).href)};
    const native=loadWindowsNative(),lease=native.captureDirectory(${JSON.stringify(cwd)});
    const child=native.startDetachedHost({file:process.execPath,args:['-e',${JSON.stringify(service)}],cwd:${JSON.stringify(cwd)},env:process.env,lease});
    lease.close();process.stdout.write(String(child.pid),()=>{child.detach();process.exit(0)});`);
  const owner = spawn(process.execPath, [host], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (owner.exitCode === null) owner.kill(); });
  let output = '', errors = '';
  owner.stdout.on('data', data => { output += data; }); owner.stderr.on('data', data => { errors += data; });
  assert.deepEqual(await once(owner, 'close'), [0, null], errors);
  const pid = Number(output);
  assert.equal(native.inspectProcess(pid).state, 'live');
  assert.throws(() => fs.renameSync(cwd, cwd + '-moved'));
  for (let i = 0; i < 100 && !fs.existsSync(entry); i++) await sleep(10);
  assert.deepEqual(JSON.parse(fs.readFileSync(entry)), { pid, cwd });
  for (let i = 0; i < 300 && native.inspectProcess(pid).state !== 'dead'; i++) await sleep(10);
  assert.equal(native.inspectProcess(pid).state, 'dead');
  assert.equal(fs.readFileSync(done, 'utf8'), 'done');
});

test('service stdout and stderr retain the same private append capability after caller resources close', windows, async t => {
  const cwd = fixture(t), native = loadWindowsNative();
  assert.equal(typeof native.startDetachedHost, 'function');
  const logs = path.join(cwd, 'logs'); native.createPrivateDirectory(logs);
  const logDirectory = native.captureDirectory(logs), parent = logDirectory.openDirectory('');
  const log = parent.openAppendFile('service.log', { private: true });
  log.write(Buffer.from('before\n'));
  const lease = native.captureDirectory(cwd);
  const child = native.startDetachedHost({ file: process.execPath, args: ['-e',
    'setTimeout(()=>{process.stdout.write("stdout\\n");process.stderr.write("stderr\\n")},100);'],
  cwd, env: process.env, lease, log });
  t.after(() => child.close());
  lease.close(); log.close(); parent.close(); logDirectory.close();
  assert.throws(() => fs.renameSync(logs, logs + '-moved'));
  assert.throws(() => fs.renameSync(path.join(logs, 'service.log'), path.join(logs, 'moved.log')));
  for (let i = 0; i < 100 && !child.poll().exited; i++) await sleep(10);
  assert.equal(child.poll().exitCode, 0);
  child.close();
  assert.equal(fs.readFileSync(path.join(logs, 'service.log'), 'utf8'), 'before\nstdout\nstderr\n');
});

test('launcher death before explicit handoff leaves a runnable service instead of a suspended orphan', windows, async t => {
  const cwd = fixture(t), native = loadWindowsNative();
  const done = path.join(cwd, 'completed');
  const source = `import {loadWindowsNative} from ${JSON.stringify(new URL('../lib/platform/windows-native.mjs', import.meta.url).href)};
    const native=loadWindowsNative(),lease=native.captureDirectory(${JSON.stringify(cwd)});
    const child=native.startDetachedHost({file:process.execPath,args:['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(done)},process.cwd());setTimeout(()=>{},200)`)}],
      cwd:${JSON.stringify(cwd)},env:process.env,lease});
    process.stdout.write(String(child.pid),()=>process.exit(0));`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  owner.stdout.on('data', data => { output += data; }); owner.stderr.on('data', data => { errors += data; });
  assert.deepEqual(await once(owner, 'close'), [0, null], errors);
  const pid = Number(output);
  for (let i = 0; i < 100 && native.inspectProcess(pid).state !== 'dead'; i++) await sleep(10);
  assert.equal(native.inspectProcess(pid).state, 'dead');
  assert.equal(fs.readFileSync(done, 'utf8'), cwd);
});

test('JavaScript detached service boundary rejects arbitrary programs, Node flags and alternate entry files', windows, async t => {
  const { spawnWindowsServiceHost } = await import('../lib/platform/windows-service-host.mjs');
  const cwd = fixture(t);
  const options = { cwd, env: process.env };
  for (const [file, args] of [[process.execPath, ['-e', 'process.exit(0)']],
    [process.execPath, [path.join(cwd, 'hcc.mjs'), '--root', cwd, '--db', path.join(cwd, 'mesh.db'), 'native', 'serve']],
    [path.join(cwd, 'other.exe'), []]]) {
    assert.throws(() => spawnWindowsServiceHost(file, args, options), { code: 'WINDOWS_SERVICE_ENTRY_INVALID' });
  }
});

test('trusted HCC entry runs with retained private logging and refuses premature handoff', windows, async t => {
  const { spawnPinnedHccService } = await import('../lib/process/pinned-cwd.mjs');
  const { openPrivateAppendResource } = await import('../lib/runtime/private-file.mjs');
  const { captureSelectedCwdSnapshot } = await import('../lib/process/selected-cwd-identity.mjs');
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-service-entry-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }));
  const cwd = path.join(base, 'project'), home = path.join(base, 'profile'), logs = path.join(base, 'logs');
  fs.mkdirSync(cwd); fs.mkdirSync(home); loadWindowsNative().createPrivateDirectory(logs);
  const logPath = path.join(logs, 'web.log'), log = openPrivateAppendResource(logPath);
  const entry = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
  let child;
  try {
    child = spawnPinnedHccService(process.execPath, [entry, '--root', cwd, '--db', path.join(cwd, 'mesh.db'), 'web', '--help'],
      { cwd, env: { ...process.env, USERPROFILE: home, HOME: home, HCC_WEB_CHILD: '1' }, log,
        expectedIdentity: captureSelectedCwdSnapshot(cwd) });
  } finally { log.close(); }
  t.after(() => child.close());
  assert.throws(() => child.unref(), { code: 'WINDOWS_SERVICE_HANDOFF_REQUIRED' });
  assert.deepEqual(await once(child, 'close'), [0, null]);
  assert.match(fs.readFileSync(logPath, 'utf8'), /hello-cc|hcc/);
});
