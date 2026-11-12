import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const windows = { skip: process.platform !== 'win32', timeout: 15000 };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-owned-process-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('hcc-owned-process-'));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  });
  const cwd = path.join(root, '中文 & spaces');
  fs.mkdirSync(cwd);
  const put = (name, content) => { const file = path.join(cwd, name); fs.writeFileSync(file, content); return file; };
  return { root, cwd, put };
}

async function api() {
  return import('../lib/platform/windows-process.mjs');
}

function collect(stream) {
  const chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}

async function attributeAttacker(t, directory, target) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const probe = fileURLToPath(new URL('./helpers/windows-file-probe.ps1', import.meta.url));
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe,
    '-Path', directory, '-Target', target, '-WaitForSignal'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const output = collect(child.stdout), errors = collect(child.stderr);
  const completed = once(child, 'close');
  let ready = false;
  for (let i = 0; i < 500; i++) {
    if (output().includes(Buffer.from('{"ready":true}'))) { ready = true; break; }
    if (child.exitCode !== null) break;
    await sleep(10);
  }
  assert.equal(ready, true, errors().toString());
  return async () => {
    child.stdin.end('GO\n');
    assert.deepEqual(await completed, [0, null], errors().toString());
    return JSON.parse(output().toString().trim().split(/\r?\n/).at(-1));
  };
}

test('owned Windows process preserves literal argv, Unicode cwd and explicit environment', windows, async t => {
  const { spawnWindowsOwnedProcess } = await api();
  const { cwd, put } = fixture(t);
  const file = put('argv.mjs', 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.HCC_TEST_VALUE}));');
  const args = ['', '中文 空格', 'a"b', "single'quote", '%!^&|<>()', 'tail\\', 'space \\', '--flag', '$(noop)', 'line\r\nbreak', '\\\\"quote'];
  const child = spawnWindowsOwnedProcess(process.execPath, [file, ...args], { cwd,
    env: { ...process.env, HCC_TEST_VALUE: 'literal 中文 %!&' } });
  t.after(() => child.close());
  const output = collect(child.stdout);
  const errors = collect(child.stderr);
  const closed = once(child, 'close');
  child.stdin.end();
  assert.ok(child.pid > 0);
  assert.match(child.creationTime, /^[1-9][0-9]+$/);
  assert.deepEqual(await closed, [0, null]);
  assert.equal(errors().length, 0);
  assert.deepEqual(JSON.parse(output()), { args, cwd, value: 'literal 中文 %!&' });
});

test('stdin is streamed with backpressure, binary bytes and EOF preserved', windows, async t => {
  const { spawnWindowsOwnedProcess } = await api();
  const { cwd, put } = fixture(t);
  const file = put('echo.mjs', 'process.stdin.pipe(process.stdout); process.stdin.on("end",()=>process.stderr.write("eof"));');
  const child = spawnWindowsOwnedProcess(process.execPath, [file], { cwd });
  t.after(() => child.close());
  const output = collect(child.stdout), errors = collect(child.stderr);
  const closed = once(child, 'close');
  const input = Buffer.alloc(300000);
  for (let i = 0; i < input.length; i++) input[i] = i % 256;
  child.stdin.end(input);
  assert.deepEqual(await closed, [0, null]);
  assert.deepEqual(output(), input);
  assert.equal(errors().toString(), 'eof');
});

test('root exit precedes close until inherited output and descendants finish', windows, async t => {
  const { spawnWindowsOwnedProcess } = await api();
  const { cwd, put } = fixture(t);
  const file = put('parent.mjs', `import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e','setTimeout(()=>process.stdout.write("late-output"),350)'],{stdio:['ignore',1,2],detached:true});
    child.unref(); process.exit(7);`);
  const child = spawnWindowsOwnedProcess(process.execPath, [file], { cwd });
  t.after(() => child.close());
  const output = collect(child.stdout);
  child.stderr.resume();
  const events = [];
  child.on('exit', code => events.push(['exit', code]));
  child.on('close', code => events.push(['close', code]));
  const closed = once(child, 'close');
  child.stdin.end();
  assert.deepEqual(await closed, [7, null]);
  assert.deepEqual(events, [['exit', 7], ['close', 7]]);
  assert.equal(output().toString(), 'late-output');
});

test('terminating the owned Job stops the child and grandchild without PID lookup killing', windows, async t => {
  const { spawnWindowsOwnedProcess } = await api();
  const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
  const native = loadWindowsNative();
  const { cwd, put } = fixture(t);
  const file = put('tree.mjs', `import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.stdout.write(child.pid+'\\n'); setInterval(()=>{},1000);`);
  const child = spawnWindowsOwnedProcess(process.execPath, [file], { cwd });
  t.after(() => child.close());
  child.stderr.resume();
  const [data] = await once(child.stdout, 'data');
  const descendant = Number(String(data).trim());
  assert.equal(native.inspectProcess(descendant).state, 'live');
  const closed = once(child, 'close');
  assert.equal(child.kill(), true);
  await closed;
  assert.equal(native.inspectProcess(child.pid).state, 'dead');
  assert.equal(native.inspectProcess(descendant).state, 'dead');
});

test('silent children can close before producing any output', windows, async t => {
  const { spawnWindowsOwnedProcess } = await api();
  const { cwd } = fixture(t);
  const child = spawnWindowsOwnedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd });
  t.after(() => child.close());
  child.stdout.resume(); child.stderr.resume();
  await child.close();
  assert.ok(child.exitCode !== null);
});

test('close drains discarded output and follows readable end events', windows, async t => {
  const { spawnWindowsOwnedProcess } = await api();
  const { cwd } = fixture(t);
  const child = spawnWindowsOwnedProcess(process.execPath, ['-e', 'process.stdout.write("done");'], { cwd });
  t.after(() => child.close());
  let stdoutEnded = false, stderrEnded = false;
  child.stdout.on('end', () => { stdoutEnded = true; });
  child.stderr.on('end', () => { stderrEnded = true; });
  child.stdout.resume(); child.stderr.resume();
  await once(child, 'close');
  assert.equal(stdoutEnded, true);
  assert.equal(stderrEnded, true);
  const abandoned = spawnWindowsOwnedProcess(process.execPath,
    ['-e', 'setInterval(()=>process.stdout.write(Buffer.alloc(65536)),1)'], { cwd });
  t.after(() => abandoned.close());
  abandoned.stdout.destroy(); abandoned.stderr.destroy();
  await abandoned.close();
});

test('native stdin queue stays bounded when the child never reads and cancellation is nonblocking', windows, async t => {
  const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
  const native = loadWindowsNative();
  const { cwd } = fixture(t);
  const controller = native.startOwnedProcess({ file: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'], cwd, env: process.env });
  t.after(() => controller.close());
  const data = Buffer.alloc(64 * 1024, 1);
  assert.throws(() => controller.writeStdin(Buffer.alloc(65537)));
  assert.throws(() => controller.readStdout(65537));
  assert.throws(() => controller.poll.call({}));
  let rejected = false;
  for (let i = 0; i < 32; i++) {
    if (!controller.writeStdin(data)) { rejected = true; break; }
  }
  assert.equal(rejected, true);
  assert.ok(controller.poll().pendingBytes <= 1024 * 1024);
  await sleep(20);
  controller.terminate();
  for (let i = 0; i < 100; i++) {
    const state = controller.poll();
    if (state.activeProcesses === 0 && state.exited && state.stdinClosed) break;
    await sleep(10);
  }
  assert.equal(controller.poll().activeProcesses, 0);
  assert.equal(controller.poll().exited, true);
  assert.equal(controller.poll().stdinClosed, true);
  controller.close();
});

test('invalid executable fails synchronously and a later launch remains usable', windows, async t => {
  const { spawnWindowsOwnedProcess } = await api();
  const { cwd } = fixture(t);
  for (let i = 0; i < 8; i++) assert.throws(() => spawnWindowsOwnedProcess(path.join(cwd, 'missing.exe'), [], { cwd }),
    error => error.code === 'WINDOWS_PROCESS_ERROR');
  const child = spawnWindowsOwnedProcess(process.execPath, ['-e', 'process.exit(0)'], { cwd });
  t.after(() => child.close());
  child.stdout.resume(); child.stderr.resume();
  assert.deepEqual(await once(child, 'close'), [0, null]);
});

test('exiting the native host closes its Job and kills the still-running descendants', windows, async t => {
  const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
  const native = loadWindowsNative();
  const { cwd, put } = fixture(t);
  const tree = put('abandoned-tree.mjs', `import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
    process.stdout.write(child.pid+'\\n'); setInterval(()=>{},1000);`);
  const host = put('native-host.mjs', `import {spawnWindowsOwnedProcess} from ${JSON.stringify(new URL('../lib/platform/windows-process.mjs', import.meta.url).href)};
    const child=spawnWindowsOwnedProcess(process.execPath,[${JSON.stringify(tree)}],{cwd:${JSON.stringify(cwd)}});
    child.stderr.resume(); child.stdout.once('data',data=>{
      process.stdout.write(JSON.stringify({root:child.pid,descendant:Number(String(data).trim())}),()=>process.exit(0));
    });`);
  const owner = spawn(process.execPath, [host], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (owner.exitCode === null) owner.kill(); });
  const output = collect(owner.stdout), errors = collect(owner.stderr);
  assert.deepEqual(await once(owner, 'close'), [0, null]);
  assert.equal(errors().length, 0);
  const pids = Object.values(JSON.parse(output()));
  for (let i = 0; i < 100 && pids.some(pid => native.inspectProcess(pid).state !== 'dead'); i++) await sleep(10);
  for (const pid of pids) assert.equal(native.inspectProcess(pid).state, 'dead');
});

test('native launch rejects malformed strings, duplicate environment keys and borrowed receivers', windows, async t => {
  const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
  const native = loadWindowsNative();
  const { cwd } = fixture(t);
  const options = { file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env: process.env };
  for (const change of [{ args: ['bad\0argument'] }, { file: 'node.exe' }, { cwd: '.' },
    { env: { PATH: 'one', Path: 'two' } }, { inheritHandles: [] }]) {
    assert.throws(() => native.startOwnedProcess({ ...options, ...change }),
      error => error.code === 'WINDOWS_PROCESS_ERROR');
  }
  const controller = native.startOwnedProcess(options);
  t.after(() => controller.close());
  if (typeof native.captureDirectory === 'function') {
    const lease = native.captureDirectory(cwd);
    try { assert.throws(() => controller.poll.call(lease), error => error.code === 'WINDOWS_PROCESS_ERROR'); }
    finally { lease.close(); }
  }
  controller.terminate();
  for (let i = 0; i < 100 && !controller.poll().exited; i++) await sleep(10);
  assert.equal(controller.poll().exited, true);
  controller.close();
});

test('native process entry points reject extra arguments and unknown option fields', windows, async t => {
  const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
  const native = loadWindowsNative();
  const { cwd } = fixture(t);
  const options = { file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env: process.env };
  let accidentallyCreated;
  try {
    assert.throws(() => { accidentallyCreated = native.startOwnedProcess(options, 'extra'); });
  } finally { accidentallyCreated?.close(); }
  try {
    assert.throws(() => { accidentallyCreated = native.startOwnedProcess({ ...options, unsupported: true }); });
  } finally { accidentallyCreated?.close(); }
  const controller = native.startOwnedProcess(options);
  t.after(() => controller.close());
  for (const name of ['poll', 'terminate', 'close', 'closeStdin', 'resume']) {
    assert.throws(() => controller[name]('extra'), name);
  }
  assert.throws(() => controller.readStdout(1, 2));
  assert.throws(() => controller.readStderr(1, 2));
  assert.throws(() => controller.writeStdin(Buffer.from('x'), 'extra'));
  controller.terminate();
  for (let i = 0; i < 100 && !controller.poll().exited; i++) await sleep(10);
  controller.close();
});

test('observation failure never turns close into a confirmed successful termination', windows, async t => {
  const { spawnWindowsOwnedProcess } = await api();
  const { cwd } = fixture(t);
  const child = spawnWindowsOwnedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd });
  child.on('error', () => {});
  const real = child._controller;
  t.after(() => real.close());
  // Fault only the native observation boundary; real Job termination and
  // handle cleanup remain active so this fixture cannot orphan its process.
  child._controller = {
    poll() { throw new Error('injected process observation failure'); },
    terminate() { real.terminate(); },
    close() { real.close(); }
  };
  await new Promise(resolve => child.once('close', resolve));
  await assert.rejects(child.close(), error => error.code === 'WINDOWS_PROCESS_CLOSE_UNCONFIRMED');
});

test('a suspended root owns its opaque directory pins and runs only after explicit resume', windows, async t => {
  const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
  const native = loadWindowsNative();
  const { root, cwd } = fixture(t);
  const marker = path.join(cwd, 'executed.json');
  const lease = native.captureDirectory(cwd);
  let controller;
  try {
    controller = native.startOwnedProcess({ file: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync("executed.json",JSON.stringify({cwd:process.cwd()}));'],
      cwd, env: process.env, lease, suspended: true });
  } finally { lease.close(); }
  t.after(() => controller.close());
  await sleep(80);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(controller.poll().suspended, true);
  for (const target of [cwd, root]) assert.throws(() => fs.renameSync(target, target + '-moved'));
  assert.equal(typeof controller.resume, 'function');
  controller.resume();
  assert.equal(controller.poll().suspended, false);
  for (let i = 0; i < 100 && !controller.poll().exited; i++) await sleep(10);
  assert.equal(controller.poll().exitCode, 0);
  assert.equal(JSON.parse(fs.readFileSync(marker)).cwd, cwd);
  controller.close();
});

test('suspended root cannot execute user code after the owning host exits', windows, async t => {
  const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
  const native = loadWindowsNative();
  const { cwd, put } = fixture(t);
  const marker = path.join(cwd, 'must-not-execute');
  const host = put('suspended-host.mjs', `import {loadWindowsNative} from ${JSON.stringify(new URL('../lib/platform/windows-native.mjs', import.meta.url).href)};
    const native=loadWindowsNative(),lease=native.captureDirectory(${JSON.stringify(cwd)});
    const child=native.startOwnedProcess({file:process.execPath,args:['-e',${JSON.stringify('require("node:fs").writeFileSync("must-not-execute","bad")')}],
      cwd:${JSON.stringify(cwd)},env:process.env,lease,suspended:true});
    process.stdout.write(String(child.pid),()=>process.exit(0));`);
  const owner = spawn(process.execPath, [host], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (owner.exitCode === null) owner.kill(); });
  const output = collect(owner.stdout), errors = collect(owner.stderr);
  assert.deepEqual(await once(owner, 'close'), [0, null]);
  assert.equal(errors().length, 0);
  const pid = Number(output().toString());
  assert.ok(pid > 0);
  for (let i = 0; i < 100 && native.inspectProcess(pid).state !== 'dead'; i++) await sleep(10);
  assert.equal(native.inspectProcess(pid).state, 'dead');
  assert.equal(fs.existsSync(marker), false);
});

test('attribute-only reparse attacks cannot redirect a suspended or initialized root',
  { ...windows, timeout: 30000 }, async t => {
    const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
    const native = loadWindowsNative();
    const { root, cwd } = fixture(t);
    const target = path.join(root, 'replacement'); fs.mkdirSync(target);
    // This external process acquires attribute-write access before the lease.
    const beforeCapture = await attributeAttacker(t, cwd, target);
    const lease = native.captureDirectory(cwd), expected = lease.snapshot();
    const controller = native.startOwnedProcess({ file: process.execPath,
      args: ['-e', 'process.stdout.write(process.cwd());setInterval(()=>{},1000)'],
      cwd, env: process.env, lease, suspended: true });
    lease.close();
    t.after(() => controller.close());
    assert.deepEqual(await beforeCapture(), { win32Error: 145 });
    const afterCapture = await attributeAttacker(t, cwd, target);
    controller.resume();
    let output = '';
    for (let i = 0; i < 100 && !output; i++) { output += controller.readStdout()?.toString() || ''; await sleep(10); }
    assert.equal(output, cwd);
    assert.deepEqual(await afterCapture(), { win32Error: 145 });
    assert.deepEqual(native.inspectDirectory(cwd).identity, expected.identity);
    assert.deepEqual(fs.readdirSync(target), []);
    controller.terminate();
    for (let i = 0; i < 100 && !controller.poll().exited; i++) await sleep(10);
    controller.close();
    // Positive control verifies that the independent attacker can change this
    // exact directory once every native owner has released its sentinel.
    const afterClose = await attributeAttacker(t, cwd, target);
    assert.deepEqual(await afterClose(), { win32Error: 0 });
    assert.equal(fs.lstatSync(cwd).isSymbolicLink(), true);
    fs.unlinkSync(cwd);
  });

test('owner death racing root resume permits only original-directory entry or no user code',
  { ...windows, timeout: 30000 }, async t => {
    const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
    const native = loadWindowsNative();
    const { root, cwd, put } = fixture(t);
    const target = path.join(root, 'replacement'); fs.mkdirSync(target);
    const selected = path.join(cwd, 'selected'); fs.mkdirSync(selected);
    const expected = fs.statSync(selected, { bigint: true });
    const evidence = path.join(root, 'entry.json');
    const code = `const fs=require('node:fs');const s=fs.statSync('.',{bigint:true});
      fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({cwd:process.cwd(),dev:s.dev.toString(),ino:s.ino.toString()}));
      fs.writeFileSync('entry-marker','original');setInterval(()=>{},1000);`;
    // The attacker opens before launch and races owner shutdown after resume.
    const attack = await attributeAttacker(t, selected, target);
    const host = put('resume-host.mjs', `import {loadWindowsNative} from ${JSON.stringify(new URL('../lib/platform/windows-native.mjs', import.meta.url).href)};
      const native=loadWindowsNative(),lease=native.captureDirectory(${JSON.stringify(selected)});
      const child=native.startOwnedProcess({file:process.execPath,args:['-e',${JSON.stringify(code)}],
        cwd:${JSON.stringify(selected)},env:process.env,lease,suspended:true});lease.close();
      process.stdout.write(String(child.pid)+'\\n');
      process.stdin.once('data',()=>{child.resume();process.exit(0)});`);
    const owner = spawn(process.execPath, [host], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (owner.exitCode === null) owner.kill(); });
    const errors = collect(owner.stderr);
    const ownerClosed = once(owner, 'close');
    const [data] = await once(owner.stdout, 'data');
    const pid = Number(String(data).trim());
    assert.ok(pid > 0);
    for (const directory of [selected, cwd, root]) assert.throws(() => fs.renameSync(directory, directory + '-moved'));
    owner.stdin.end('GO\n');
    const attackResult = await attack();
    assert.ok([0, 145].includes(attackResult.win32Error), JSON.stringify(attackResult));
    assert.deepEqual(await ownerClosed, [0, null], errors().toString());
    for (let i = 0; i < 100 && native.inspectProcess(pid).state !== 'dead'; i++) await sleep(10);
    assert.equal(native.inspectProcess(pid).state, 'dead');
    if (fs.existsSync(evidence)) assert.deepEqual(JSON.parse(fs.readFileSync(evidence)), {
      cwd: selected, dev: expected.dev.toString(), ino: expected.ino.toString()
    });
    assert.deepEqual(fs.readdirSync(target), []);
    if (fs.lstatSync(selected).isSymbolicLink()) fs.unlinkSync(selected);
  });
