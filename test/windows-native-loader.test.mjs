import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loaderUrl = new URL('../lib/platform/windows-native.mjs', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function loader() {
  const module = await import(loaderUrl);
  assert.equal(typeof module.loadWindowsNative, 'function');
  return module.loadWindowsNative;
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-native-loader-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'native', 'windows', 'addon.cc');
  const binary = path.join(directory, 'native', 'bin', 'win32-x64', 'hcc-windows.node');
  const manifest = path.join(path.dirname(binary), 'hcc-windows.json');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(source, '// deliberately different test source\n');
  fs.writeFileSync(binary, 'not a native executable');
  const metadata = {
    manifestVersion: 1, protocolVersion: 1, napiVersion: 8,
    platform: 'win32', arch: 'x64',
    sourceSha256: sha256(Buffer.concat([Buffer.from('addon.cc\0'), fs.readFileSync(source), Buffer.from('\0')])),
    binarySha256: sha256(fs.readFileSync(binary))
  };
  return { directory, source, binary, manifest, metadata };
}

test('loading another platform does not inspect files or load a native module', async () => {
  const load = await loader();
  assert.equal(load({ platform: 'linux', root: 'a-directory-that-does-not-exist' }), null);
  assert.equal(load({ platform: 'darwin', root: 'a-directory-that-does-not-exist' }), null);
});

test('missing Windows manifest fails closed before native loading', async t => {
  const load = await loader();
  const f = fixture(t);
  assert.throws(() => load({ platform: 'win32', arch: 'x64', root: f.directory }),
    error => error.code === 'WINDOWS_NATIVE_UNAVAILABLE' && error.extra.reason === 'manifest_missing');
});

test('protocol and target mismatches fail closed before native loading', async t => {
  const load = await loader();
  const f = fixture(t);
  for (const changed of [{ protocolVersion: 2 }, { manifestVersion: 2 }, { napiVersion: 9 },
    { platform: 'linux' }, { arch: 'arm64' }]) {
    fs.writeFileSync(f.manifest, JSON.stringify({ ...f.metadata, ...changed }));
    assert.throws(() => load({ platform: 'win32', arch: 'x64', root: f.directory }),
      error => error.code === 'WINDOWS_NATIVE_UNAVAILABLE' && error.extra.reason === 'manifest_incompatible');
  }
});

test('source changes and binary changes are rejected before native loading', async t => {
  const load = await loader();
  const f = fixture(t);
  fs.writeFileSync(f.manifest, JSON.stringify(f.metadata));
  fs.appendFileSync(f.source, '// changed after build\n');
  assert.throws(() => load({ platform: 'win32', arch: 'x64', root: f.directory }),
    error => error.code === 'WINDOWS_NATIVE_UNAVAILABLE' && error.extra.reason === 'source_mismatch');
  fs.writeFileSync(f.manifest, JSON.stringify({ ...f.metadata,
    sourceSha256: sha256(Buffer.concat([Buffer.from('addon.cc\0'), fs.readFileSync(f.source), Buffer.from('\0')])) }));
  fs.appendFileSync(f.binary, 'changed');
  assert.throws(() => load({ platform: 'win32', arch: 'x64', root: f.directory }),
    error => error.code === 'WINDOWS_NATIVE_UNAVAILABLE' && error.extra.reason === 'binary_mismatch');
});

test('a corrupt native image reports unavailable without leaking a raw module loader error', async t => {
  const load = await loader();
  const f = fixture(t);
  fs.writeFileSync(f.manifest, JSON.stringify(f.metadata));
  assert.throws(() => load({ platform: 'win32', arch: 'x64', root: f.directory }),
    error => error.code === 'WINDOWS_NATIVE_UNAVAILABLE' && error.extra.reason === 'load_failed');
});

test('adding a native header invalidates the source proof', async t => {
  const load = await loader();
  const f = fixture(t);
  fs.writeFileSync(f.manifest, JSON.stringify(f.metadata));
  fs.writeFileSync(path.join(path.dirname(f.source), 'filesystem.h'), '// new ABI input\n');
  assert.throws(() => load({ platform: 'win32', arch: 'x64', root: f.directory }),
    error => error.code === 'WINDOWS_NATIVE_UNAVAILABLE' && error.extra.reason === 'source_mismatch');
});

test('real Windows process identity is stable and names the current executable',
  { skip: process.platform !== 'win32' }, async () => {
    const load = await loader();
    const native = load({ root });
    assert.equal(native.capabilities.processIdentity, true);
    const first = native.inspectProcess(process.pid);
    const again = native.inspectProcess(process.pid);
    assert.equal(first.state, 'live');
    assert.equal(first.pid, process.pid);
    assert.match(first.creationTime, /^[1-9][0-9]+$/);
    assert.equal(first.creationTime, again.creationTime);
    assert.equal(fs.realpathSync(first.imagePath).toLowerCase(), fs.realpathSync(process.execPath).toLowerCase());
    assert.equal(again.imagePath, first.imagePath);
    assert.equal(Object.hasOwn(first, 'commandLine'), false);
  });

test('invalid PID observations never claim dead or live and do not coerce caller values',
  { skip: process.platform !== 'win32' }, async () => {
    const native = (await loader())({ root });
    for (const pid of [undefined, null, '1', -1, 0, 1.5, NaN, Infinity, 4294967296, {}]) {
      const observed = native.inspectProcess(pid);
      assert.equal(observed.state, 'unknown');
      assert.equal(observed.reason, 'invalid_pid');
      assert.equal(observed.pid, null);
    }
  });

test('exited Windows process is reported dead instead of retaining its former identity',
  { skip: process.platform !== 'win32' }, async t => {
    const native = (await loader())({ root });
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume();'],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    await once(child, 'spawn');
    const live = native.inspectProcess(child.pid);
    assert.equal(live.state, 'live');
    const exited = once(child, 'exit');
    child.stdin.end();
    await exited;
    const dead = native.inspectProcess(child.pid);
    assert.equal(dead.state, 'dead');
    assert.equal(Object.hasOwn(dead, 'creationTime'), false);
    assert.equal(Object.hasOwn(dead, 'imagePath'), false);
  });

test('malformed manifests are rejected as metadata failures', async t => {
  const load = await loader();
  const f = fixture(t);
  fs.writeFileSync(f.manifest, '{"protocolVersion":');
  assert.throws(() => load({ platform: 'win32', arch: 'x64', root: f.directory }),
    error => error.code === 'WINDOWS_NATIVE_UNAVAILABLE' && error.extra.reason === 'manifest_invalid');
});
