import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';
import { readPrivateTextFile, openPrivateAppendFile } from '../lib/runtime/private-file.mjs';
import * as privateFiles from '../lib/runtime/private-file.mjs';
import { listWindowsPrivateDirectory } from '../lib/platform/windows-private-state.mjs';

const windows = process.platform === 'win32';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-private-file-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const directory = path.join(base, 'private'); loadWindowsNative().createPrivateDirectory(directory);
  return { base, directory };
}

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
