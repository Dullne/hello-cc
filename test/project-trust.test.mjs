import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { stableProjectStateRoot, unsafeDirectoryAcl } from '../lib/runtime/project-trust.mjs';

async function withAclListingCount(run) {
  const original = childProcess.spawnSync;
  let count = 0;
  childProcess.spawnSync = (command, ...args) => {
    if (path.basename(String(command)) === 'ls') count++;
    return original(command, ...args);
  };
  syncBuiltinESMExports();
  try { await run(() => count); }
  finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
}

test('ACL cache retains exact Number and BigInt stat signatures across alternating reads', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX ls ACL inspection');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-acl-stat-kinds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await withAclListingCount(async count => {
    const numberStat = fs.lstatSync(root), bigStat = fs.lstatSync(root, { bigint: true });
    assert.equal(unsafeDirectoryAcl(root, numberStat), false);
    assert.equal(unsafeDirectoryAcl(root, bigStat), false);
    assert.equal(count(), 2);
    for (let iteration = 0; iteration < 4; iteration++) {
      assert.equal(unsafeDirectoryAcl(root, numberStat), false);
      assert.equal(unsafeDirectoryAcl(root, bigStat), false);
    }
    assert.equal(count(), 2, 'unchanged stat representations must not evict each other');

    await sleep(2);
    fs.chmodSync(root, 0o750);
    const changedNumber = fs.lstatSync(root), changedBig = fs.lstatSync(root, { bigint: true });
    assert.notEqual(changedNumber.ctimeMs, numberStat.ctimeMs);
    assert.notEqual(changedBig.ctimeNs, bigStat.ctimeNs);
    assert.equal(unsafeDirectoryAcl(root, changedNumber), false);
    assert.equal(unsafeDirectoryAcl(root, changedBig), false);
    assert.equal(count(), 4, 'ctime changes must invalidate both exact signatures');
    assert.equal(unsafeDirectoryAcl(root, changedNumber), false);
    assert.equal(unsafeDirectoryAcl(root, changedBig), false);
    assert.equal(count(), 4);
  });
});

test('ACL mutation invalidates both warmed stat representations and rejects newly granted rights', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS directory ACL mutation');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-acl-cache-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await withAclListingCount(async count => {
    assert.equal(unsafeDirectoryAcl(root, fs.lstatSync(root)), false);
    assert.equal(unsafeDirectoryAcl(root, fs.lstatSync(root, { bigint: true })), false);
    assert.equal(count(), 2);
    await sleep(2);
    const acl = spawnSync('/bin/chmod', ['+a', 'everyone allow add_file,delete_child', root], { encoding: 'utf8' });
    if (acl.status !== 0) return t.skip('filesystem does not support directory ACLs');
    assert.equal(unsafeDirectoryAcl(root, fs.lstatSync(root)), true);
    assert.equal(unsafeDirectoryAcl(root, fs.lstatSync(root, { bigint: true })), true);
    assert.equal(count(), 4, 'ACL mutation must be inspected in both partitions');
    assert.equal(stableProjectStateRoot(root), null);
  });
});

test('macOS xattr marker cannot hide an ACL that grants another user directory rights', (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS ACL and xattr indicator');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-acl-indicator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const xattr = spawnSync('/usr/bin/xattr', ['-w', 'com.hello-cc.acl-test', '1', root], { encoding: 'utf8' });
  const acl = spawnSync('/bin/chmod', ['+a', 'everyone allow add_file,delete_child', root], { encoding: 'utf8' });
  if (xattr.status !== 0 || acl.status !== 0) {
    return t.skip('filesystem does not support both extended attributes and directory ACLs');
  }
  const listing = spawnSync('/bin/ls', ['-lde', root], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /allow/);
  assert.equal(unsafeDirectoryAcl(root), true);
  assert.equal(stableProjectStateRoot(root), null);
});
