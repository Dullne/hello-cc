import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { assertPinnedSessionLaunchAllowed, preparePinnedCwdLaunch, spawnPinnedCwdProcess, spawnPinnedCwdPty } from '../lib/process/pinned-cwd.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { JsonRpcProcess } from '../lib/integrations/native/jsonrpc.mjs';
import { createCodexAppServer } from '../lib/web/codex-app-server.mjs';

const windows = { skip: process.platform !== 'win32', timeout: 10000 };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-win-pinned-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }));
  const cwd = path.join(root, 'selected'); fs.mkdirSync(cwd);
  return { root, cwd };
}
function collect(stream) {
  const chunks = []; stream.on('data', chunk => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString();
}

test('Windows rollout gate uses case-insensitive environment names before native preparation', windows, () => {
  for (const name of ['hcc_pinned_launch_mode', 'Hcc_Pinned_Launch_Mode']) {
    assert.throws(() => assertPinnedSessionLaunchAllowed({ env: { [name]: 'hold' } }), { code: 'PINNED_LAUNCH_PAUSED' });
  }
});

test('Windows pinned launch binds the selected identity and preserves literal provider arguments', windows, async t => {
  const { cwd } = fixture(t), expectedIdentity = captureSelectedCwdSnapshot(cwd);
  const args = ['', '中文 & $() %PATH%', 'a"b', 'trailing\\'];
  const child = spawnPinnedCwdProcess(process.execPath, ['-e',
    'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)}))', ...args],
  { cwd, expectedIdentity, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.close());
  const output = collect(child.stdout); child.stderr.resume(); child.stdin.end();
  assert.deepEqual(await once(child, 'close'), [0, null]);
  assert.deepEqual(JSON.parse(output()), { cwd, args });
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('Windows prepared launch is a one-use native capability and cannot become an ordinary spawn recipe', windows, async t => {
  const { cwd } = fixture(t);
  const binding = preparePinnedCwdLaunch(cwd, process.execPath, ['-e', 'process.exit(0)']);
  t.after(() => binding.release());
  assert.equal(binding.platform, 'win32');
  assert.equal(binding.identity.platform, 'win32');
  assert.throws(() => binding.command, { code: 'WINDOWS_PINNED_SPAWN_REQUIRED' });
  assert.throws(() => fs.renameSync(cwd, cwd + '-moved'));
  const child = binding.spawnOwned();
  t.after(() => child.close());
  binding.release(); // Native controller independently retains its lease.
  assert.throws(() => binding.spawnOwned(), { code: 'PROJECT_PATH_CHANGED' });
  child.stdout.resume(); child.stderr.resume(); child.stdin.end();
  assert.deepEqual(await once(child, 'close'), [0, null]);
});

test('Windows launch rejects stale selection and released prepared capability before user code', windows, t => {
  const { cwd, root } = fixture(t);
  const expectedIdentity = captureSelectedCwdSnapshot(cwd);
  fs.renameSync(cwd, path.join(root, 'original')); fs.mkdirSync(cwd);
  assert.throws(() => spawnPinnedCwdProcess(process.execPath, ['-e', ''], { cwd, expectedIdentity }),
    { code: 'PROJECT_PATH_CHANGED' });
  assert.deepEqual(fs.readdirSync(cwd), []);
  const binding = preparePinnedCwdLaunch(cwd, process.execPath, ['-e', '']); binding.release();
  assert.throws(() => binding.spawnOwned(), { code: 'PROJECT_PATH_CHANGED' });
});

test('Windows launch hold is enforced and unsafe spawn options never bypass ownership', windows, t => {
  const { cwd } = fixture(t);
  assert.throws(() => spawnPinnedCwdProcess(process.execPath, [], { cwd, env: { HCC_PINNED_LAUNCH_MODE: 'hold' } }),
    { code: 'PINNED_LAUNCH_PAUSED' });
  for (const name of ['hcc_pinned_launch_mode', 'Hcc_Pinned_Launch_Mode']) {
    assert.throws(() => spawnPinnedCwdProcess(process.execPath, [], { cwd, env: { [name]: 'hold' } }),
      { code: 'PINNED_LAUNCH_PAUSED' });
  }
  for (const options of [{ shell: true }, { detached: true }, { stdio: [0, 1, 2] }, { uid: 123 }, { windowsVerbatimArguments: true }]) {
    assert.throws(() => spawnPinnedCwdProcess(process.execPath, [], { cwd, ...options }),
      { code: 'WINDOWS_PROCESS_OPTIONS_UNSUPPORTED' });
  }
  assert.throws(() => spawnPinnedCwdProcess(process.execPath, [], { cwd }, () => {}),
    { code: 'WINDOWS_PINNED_SPAWN_REQUIRED' });
  assert.throws(() => spawnPinnedCwdPty({ spawn() { assert.fail('unprotected PTY spawn'); } }, process.execPath, [], { cwd }),
    { code: 'WINDOWS_PINNED_PTY_REQUIRED' });
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('Windows JSONRPC resolves a Node provider and closes its owned process after EOF grace', windows, async t => {
  const { cwd } = fixture(t);
  const file = path.join(cwd, 'peer.mjs');
  fs.writeFileSync(file, `import readline from 'node:readline';
    readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
      process.stdout.write(JSON.stringify({id:m.id,result:{cwd:process.cwd(),args:process.argv.slice(2)}})+'\\n')});
    setInterval(()=>{},1000);`);
  const rpc = new JsonRpcProcess({ binary: file, args: ['%!& "中文'], cwd,
    expectedIdentity: captureSelectedCwdSnapshot(cwd), closeEofGraceMs: 20, closeKillTimeoutMs: 1000 });
  t.after(() => rpc.close());
  await rpc.start();
  assert.deepEqual(await rpc.request('echo'), { cwd, args: ['%!& "中文'] });
  await rpc.close();
  assert.equal(rpc.childClosed, true);
  assert.equal(rpc.child.killed, true);
  assert.ok(rpc.child.exitCode !== null);
});

test('Windows JSONRPC cleanup rejects an unconfirmed native Job observation', windows, async t => {
  const { cwd } = fixture(t);
  const rpc = new JsonRpcProcess({ binary: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd,
    closeEofGraceMs: 10, closeKillTimeoutMs: 100 });
  await rpc.start();
  const native = rpc.child._controller;
  t.after(() => native.close());
  rpc.child._controller = {
    poll() { throw new Error('injected observation failure'); },
    terminate() { native.terminate(); }, close() { native.close(); }
  };
  await new Promise(resolve => rpc.child.once('close', resolve));
  await assert.rejects(rpc.close(), { code: 'NATIVE_CLOSE_FAILED' });
});

test('Windows Codex AppServer uses resolved provider transport and confirmed owned-tree shutdown', windows, async t => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'codex.mjs'), `import readline from 'node:readline';
    readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
      if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'fake-windows-provider'}})+'\\n')});
    setInterval(()=>{},1000);`);
  const server = createCodexAppServer({ cwd, expectedCwdIdentity: captureSelectedCwdSnapshot(cwd),
    env: { ...process.env, PATH: cwd, PATHEXT: '.MJS' }, requestTimeoutMs: 2000, closeTimeoutMs: 50 });
  t.after(() => server.close());
  assert.deepEqual(await server.initialize(), { userAgent: 'fake-windows-provider' });
  assert.equal(server.snapshot().status, 'ready');
  const pid = server.snapshot().pid;
  await server.close();
  assert.equal(server.snapshot().processExited, true);
  const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
  assert.equal(loadWindowsNative().inspectProcess(pid).state, 'dead');
});
