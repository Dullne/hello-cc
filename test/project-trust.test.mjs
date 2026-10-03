import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stableProjectStateRoot, unsafeDirectoryAcl } from '../lib/runtime/project-trust.mjs';

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
