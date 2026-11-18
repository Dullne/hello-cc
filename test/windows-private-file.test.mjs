import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';
import { readPrivateTextFile, openPrivateAppendFile } from '../lib/runtime/private-file.mjs';
import * as privateFiles from '../lib/runtime/private-file.mjs';
import { listWindowsPrivateDirectory, withWindowsPrivateScope, withWindowsPrivateDirectory,
  inspectWindowsHomeAncestry, inspectWindowsPrivateDirectory, readWindowsPrivateFile
} from '../lib/platform/windows-private-state.mjs';

const windows = process.platform === 'win32';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-private-file-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const directory = path.join(base, 'private'); loadWindowsNative().createPrivateDirectory(directory);
  return { base, directory };
}

// Use the publisher's actual Windows access/share flags. The handle is held
// until the reader signals it, then released by another process during the read.
async function heldPublisher(file, { makePublic = '', deleteOnClose = false } = {}) {
  const source = `
    $ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PublisherHandle {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
}
'@
    $flags = if ($env:HCC_TEST_DELETE_ON_CLOSE -eq '1') { 0x04000000 } else { 0 }
    $held = [PublisherHandle]::CreateFileW($env:HCC_TEST_PUBLISH_FILE, [Convert]::ToUInt32('C0070000', 16), 1, [IntPtr]::Zero, 3, $flags, [IntPtr]::Zero)
    if ($held.IsInvalid) { throw ('CreateFileW failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    try {
      [Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
      if ([Console]::ReadLine() -ne 'release') { throw 'Missing release signal' }
      [Threading.Thread]::Sleep(100)
      if ($env:HCC_TEST_PUBLIC_PATH) {
        & icacls.exe $env:HCC_TEST_PUBLIC_PATH /grant '*S-1-1-0:(R)' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'ACL mutation failed' }
      }
    } finally { $held.Dispose() }
  `;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HCC_TEST_PUBLISH_FILE: file, HCC_TEST_PUBLIC_PATH: makePublic, HCC_TEST_DELETE_ON_CLOSE: deleteOnClose ? '1' : '0' }
  });
  const completed = once(child, 'close'); let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    await Promise.race([
      once(child.stdout, 'data').then(([chunk]) => assert.equal(chunk.toString().trim(), 'ready')),
      completed.then(() => { throw new Error(errors || 'Publisher exited before opening the file'); })
    ]);
  } catch (error) {
    if (child.exitCode === null) child.kill();
    await completed.catch(() => {});
    throw error;
  }
  return {
    release() { child.stdin.end('release\n'); },
    async closed() { assert.deepEqual(await completed, [0, null], errors); }
  };
}

test('private Windows reads wait for a published file writer to release its handle', { skip: !windows }, async t => {
  const { directory } = fixture(t), file = path.join(directory, 'runtime.json');
  fs.writeFileSync(file, '{"pid":123}\n');
  const publisher = await heldPublisher(file);
  publisher.release();
  try { assert.equal(readWindowsPrivateFile(file).toString(), '{"pid":123}\n'); }
  finally { await publisher.closed(); }
});

test('private Windows reads bound sharing contention and preserve the original refusal', { skip: !windows }, async t => {
  const { directory } = fixture(t), file = path.join(directory, 'runtime.json');
  fs.writeFileSync(file, 'private');
  const publisher = await heldPublisher(file), start = performance.now();
  try {
    assert.throws(() => readWindowsPrivateFile(file), error => error.code === 'PROJECT_FILE_FORBIDDEN' && error.win32Error === 32);
    assert.ok(performance.now() - start < 1500, 'Persistent sharing contention must remain bounded');
  } finally { publisher.release(); await publisher.closed(); }
});

for (const target of ['file', 'parent']) {
  test(`private Windows reads reject ${target} ACL drift while waiting for publication`, { skip: !windows }, async t => {
    const { directory } = fixture(t), file = path.join(directory, 'runtime.json');
    fs.writeFileSync(file, 'private');
    const publisher = await heldPublisher(file, { makePublic: target === 'file' ? file : directory });
    publisher.release();
    try { withWindowsPrivateScope(() => assert.throws(() => readWindowsPrivateFile(file), { code: 'PROJECT_PATH_FORBIDDEN' })); }
    finally { await publisher.closed(); }
  });
}

test('private Windows reads preserve missing-file semantics after sharing contention ends', { skip: !windows }, async t => {
  const { directory } = fixture(t), file = path.join(directory, 'runtime.json');
  fs.writeFileSync(file, 'private');
  const publisher = await heldPublisher(file, { deleteOnClose: true });
  publisher.release();
  try {
    assert.equal(readWindowsPrivateFile(file, { missing: true }), null);
    assert.throws(() => readWindowsPrivateFile(file), { code: 'PROJECT_FILE_NOT_FOUND' });
  } finally { await publisher.closed(); }
});

test('private Windows readers admit real native publications while the writer is finishing', { skip: !windows, timeout: 20000 }, async t => {
  const { directory } = fixture(t), sleep = new Int32Array(new SharedArrayBuffer(4));
  const source = `
    import { captureDirectory } from ${JSON.stringify(new URL('../lib/platform/windows-filesystem.mjs', import.meta.url).href)};
    const lease = captureDirectory(process.env.HCC_TEST_PUBLISH_DIRECTORY), parent = lease.openDirectory('');
    const stop = () => { parent.close(); lease.close(); process.disconnect(); };
    process.on('message', index => {
      if (index === -1) { stop(); return; }
      try { parent.publish('runtime-' + index + '.json', Buffer.alloc(8 * 1024 * 1024, 97), { operation: 'create', private: true }); }
      catch (error) { console.error(error); process.exitCode = 1; stop(); }
    });
    process.send('ready');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    windowsHide: true, timeout: 18000, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, HCC_TEST_PUBLISH_DIRECTORY: directory }
  });
  const completed = once(child, 'close'); completed.catch(() => {}); let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    await Promise.race([
      once(child, 'message').then(([message]) => assert.equal(message, 'ready')),
      completed.then(() => { throw new Error(errors || 'Native publisher exited before readiness'); })
    ]);
    for (let index = 0; index < 12; index++) {
      child.send(index);
      const file = path.join(directory, `runtime-${index}.json`), deadline = performance.now() + 10000;
      let bytes;
      // Large files extend the native post-rename byte verification window;
      // these are the real native writer and real private reader, without hooks.
      do {
        bytes = readWindowsPrivateFile(file, { maxBytes: 10 * 1024 * 1024, missing: true });
        if (!bytes) Atomics.wait(sleep, 0, 0, 1);
      } while (!bytes && performance.now() < deadline);
      assert.equal(bytes?.length, 8 * 1024 * 1024);
      assert.equal(bytes[0], 97); assert.equal(bytes.at(-1), 97);
    }
  } finally {
    if (child.connected) child.send(-1);
    assert.deepEqual(await completed, [0, null], errors);
  }
});

test('private Windows reads use a held single-link object with its own ACL and size bound', { skip: !windows }, t => {
  const { directory } = fixture(t); const file = path.join(directory, '中文 file.txt');
  fs.writeFileSync(file, 'private text');
  assert.equal(readPrivateTextFile(file), 'private text');
  assert.equal(readPrivateTextFile(path.join(directory, 'missing.txt')), null);
  assert.throws(() => readPrivateTextFile(file, { maxBytes: 3 }), { code: 'PROJECT_PATH_FORBIDDEN' });
  const link = path.join(directory, 'hardlink.txt'); fs.linkSync(file, link);
  assert.throws(() => readPrivateTextFile(file)); fs.unlinkSync(link);
  const grant = spawnSync('icacls.exe', [file, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
  assert.equal(grant.status, 0, grant.stderr);
  assert.throws(() => readPrivateTextFile(file), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.deepEqual(fs.readdirSync(directory), ['中文 file.txt']);
});

test('private Windows enumeration refuses omitted objects and foreign pin lookalikes', { skip: !windows }, t => {
  const { base, directory } = fixture(t);
  assert.deepEqual(listWindowsPrivateDirectory(directory), []);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  const junction = path.join(directory, 'junction'); fs.symlinkSync(outside, junction, 'junction');
  assert.throws(() => listWindowsPrivateDirectory(directory), { code: 'PROJECT_PATH_FORBIDDEN' });
  fs.unlinkSync(junction);
  const lookalike = '.hcc-cwd-pin-' + 'a'.repeat(32); fs.writeFileSync(path.join(directory, lookalike), '');
  assert.deepEqual(listWindowsPrivateDirectory(directory), [lookalike]);
});

test('private append refuses unsupported native functionality before creating a file', { skip: !windows }, t => {
  const { directory } = fixture(t); const file = path.join(directory, 'worker.log');
  assert.throws(() => openPrivateAppendFile(file), { code: 'WINDOWS_NATIVE_UNAVAILABLE' });
  assert.equal(fs.existsSync(file), false);
});

test('owned Windows append resources create private logs, write exact bytes and retain their parent', { skip: !windows }, t => {
  assert.equal(typeof privateFiles.openPrivateAppendResource, 'function');
  const { directory } = fixture(t); const file = path.join(directory, 'worker.log');
  const resource = privateFiles.openPrivateAppendResource(file);
  try {
    assert.ok(resource.native);
    resource.write(Buffer.from('first\r\n')); resource.write(Buffer.from('中文 second\n'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'first\r\n中文 second\n');
    assert.equal(resource.snapshot().nlink, '1');
    assert.equal(resource.security().private, true);
    assert.throws(() => fs.renameSync(file, file + '-moved'));
    assert.throws(() => fs.renameSync(directory, directory + '-moved'));
  } finally { resource.close(); resource.close(); }
  assert.deepEqual(fs.readdirSync(directory), ['worker.log']);
  fs.renameSync(file, file + '-moved');
});

test('Windows log rotation keeps one private backup and reopens an empty append resource', { skip: !windows }, t => {
  const { directory } = fixture(t); const file = path.join(directory, 'worker.log');
  let resource = privateFiles.openPrivateAppendResource(file);
  try {
    resource.write('123456'); const identity = resource.snapshot().identity;
    resource = privateFiles.rotatePrivateAppendResource(file, resource, 5);
    assert.equal(resource.snapshot().size, '0'); assert.notDeepEqual(resource.snapshot().identity, identity);
    assert.equal(fs.readFileSync(file + '.1', 'utf8'), '123456');
    resource.write('new bytes'); resource = privateFiles.rotatePrivateAppendResource(file, resource, 5);
    assert.equal(fs.readFileSync(file + '.1', 'utf8'), 'new bytes');
    assert.equal(resource.security().private, true); assert.equal(loadWindowsNative().inspectPathSecurity(file + '.1').private, true);
    resource.write('ok'); const same = privateFiles.rotatePrivateAppendResource(file, resource, 5); assert.equal(same, resource);
  } finally { resource?.close(); }
  assert.deepEqual(fs.readdirSync(directory).sort(), ['worker.log', 'worker.log.1']);
});

test('Windows log rotation refuses active log owners and untrusted backups without losing either file', { skip: !windows }, t => {
  const { directory } = fixture(t); const file = path.join(directory, 'worker.log');
  let resource = privateFiles.openPrivateAppendResource(file), other;
  try {
    resource.write('oversize'); other = privateFiles.openPrivateAppendResource(file);
    fs.writeFileSync(file + '.1', 'old backup');
    assert.throws(() => privateFiles.rotatePrivateAppendResource(file, resource, 5));
    assert.equal(fs.readFileSync(file, 'utf8'), 'oversize'); assert.equal(fs.readFileSync(file + '.1', 'utf8'), 'old backup');
    other.close(); other = null; resource = privateFiles.openPrivateAppendResource(file);
    const grant = spawnSync('icacls.exe', [file + '.1', '/grant', '*S-1-1-0:(R)'], { windowsHide: true, encoding: 'utf8' }); assert.equal(grant.status, 0, grant.stderr);
    assert.throws(() => privateFiles.rotatePrivateAppendResource(file, resource, 5), { code: 'PROJECT_PATH_FORBIDDEN' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'oversize'); assert.equal(fs.readFileSync(file + '.1', 'utf8'), 'old backup');
  } finally { other?.close(); resource?.close(); }
});

function grantPublicRead(file) {
  const result = spawnSync('icacls.exe', [file, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

test('reused Windows private scopes reject file ACL drift and new hard links between reads', { skip: !windows }, t => {
  const { base, directory } = fixture(t), file = path.join(directory, 'data');
  fs.writeFileSync(file, 'retained');
  withWindowsPrivateScope(() => {
    assert.equal(readWindowsPrivateFile(file).toString(), 'retained');
    const alias = path.join(base, 'alias'); fs.linkSync(file, alias);
    assert.throws(() => readWindowsPrivateFile(file)); fs.unlinkSync(alias);
    assert.equal(readWindowsPrivateFile(file).toString(), 'retained');
    grantPublicRead(file);
    assert.throws(() => readWindowsPrivateFile(file), { code: 'PROJECT_PATH_FORBIDDEN' });
  });
  assert.deepEqual(fs.readdirSync(directory), ['data']);
});

test('reused Windows private scopes check parent ACL freshness on every read', { skip: !windows }, t => {
  const { directory } = fixture(t), file = path.join(directory, 'data'); fs.writeFileSync(file, 'retained');
  withWindowsPrivateScope(() => {
    readWindowsPrivateFile(file); grantPublicRead(directory);
    assert.throws(() => readWindowsPrivateFile(file), { code: 'PROJECT_PATH_FORBIDDEN' });
  });
  assert.deepEqual(fs.readdirSync(directory), ['data']);
});

test('a Windows scope admitted for public-read ancestry still enforces a later private-leaf requirement', { skip: !windows }, t => {
  const { directory } = fixture(t); grantPublicRead(directory);
  withWindowsPrivateScope(() => {
    assert.equal(inspectWindowsHomeAncestry(directory), true);
    assert.throws(() => inspectWindowsPrivateDirectory(directory), { code: 'PROJECT_PATH_FORBIDDEN' });
  });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('Windows private operations reject ACL drift inside their callback before returning', { skip: !windows }, t => {
  const { directory } = fixture(t);
  assert.throws(() => withWindowsPrivateDirectory(directory, () => grantPublicRead(directory)), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.deepEqual(fs.readdirSync(directory), []);
});
