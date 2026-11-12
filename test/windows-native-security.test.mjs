import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

test('Windows private directory is restricted at creation and refuses public ACL grants',
  { skip: process.platform !== 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-security-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const native = loadWindowsNative();
    assert.equal(typeof native.createPrivateDirectory, 'function');
    assert.equal(typeof native.inspectPathSecurity, 'function');
    const directory = path.join(root, 'private');
    native.createPrivateDirectory(directory);
    const first = native.inspectPathSecurity(directory);
    assert.equal(first.private, true);
    assert.equal(first.ownerSid, first.userSid);
    assert.equal(first.protectedDacl, true);
    fs.writeFileSync(path.join(directory, 'child.txt'), 'private text');
    assert.equal(native.inspectPathSecurity(path.join(directory, 'child.txt')).private, true);
    const grant = spawnSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
    assert.equal(grant.status, 0, grant.stderr);
    assert.equal(native.inspectPathSecurity(directory).private, false);
    assert.throws(() => native.createPrivateDirectory(directory), { code: 'WINDOWS_PATH_EXISTS' });
  });

test('Windows security inspection refuses junctions without changing their targets',
  { skip: process.platform !== 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-security-link-'));
    const target = path.join(root, 'target');
    const link = path.join(root, 'junction');
    t.after(() => { if (fs.existsSync(link)) fs.unlinkSync(link); fs.rmSync(root, { recursive: true, force: true }); });
    const native = loadWindowsNative();
    assert.equal(typeof native.inspectPathSecurity, 'function');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'junction');
    assert.throws(() => native.inspectPathSecurity(link), { code: 'WINDOWS_REPARSE_FORBIDDEN' });
    assert.deepEqual(fs.readdirSync(target), []);
  });

test('Windows security boundary rejects aliases, invalid names and excess arguments before mutation',
  { skip: process.platform !== 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-security-input-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const native = loadWindowsNative();
    for (const name of ['private.', 'private ', 'CON', 'child:stream', 'a\\..\\other']) {
      assert.throws(() => native.createPrivateDirectory(root + '\\' + name));
    }
    assert.throws(() => native.createPrivateDirectory(root + '\\extra', 'ignored'));
    assert.throws(() => native.inspectPathSecurity(root, 'ignored'));
    assert.deepEqual(fs.readdirSync(root), []);
  });

test('Windows ancestor policy permits traversal grants but rejects foreign mutation rights',
  { skip: process.platform !== 'win32' }, t => {
    // Some developer environments intentionally grant other identities write
    // access to AppData/Temp. Such ancestry must remain untrusted.
    const root = fs.mkdtempSync(path.join(os.homedir(), '.hcc-security-ancestry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const native = loadWindowsNative();
    assert.equal(typeof native.inspectDirectoryAncestry, 'function');
    const child = path.join(root, 'child');
    native.createPrivateDirectory(child);
    assert.equal(native.inspectDirectoryAncestry(child).trusted, true);
    let grant = spawnSync('icacls.exe', [root, '/grant', '*S-1-1-0:(RX)'], { encoding: 'utf8', windowsHide: true });
    assert.equal(grant.status, 0, grant.stderr);
    assert.equal(native.inspectDirectoryAncestry(child).trusted, true);
    grant = spawnSync('icacls.exe', [root, '/grant', '*S-1-1-0:(WA)'], { encoding: 'utf8', windowsHide: true });
    assert.equal(grant.status, 0, grant.stderr);
    assert.equal(native.inspectDirectoryAncestry(child).trusted, false);
  });
