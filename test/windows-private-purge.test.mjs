import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';
import { captureDirectory } from '../lib/platform/windows-filesystem.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-purge-test-'));
  let parent, lease;
  t.after(() => { parent?.close(); lease?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const native = loadWindowsNative();
  const root = path.join(base, 'private'); native.createPrivateDirectory(root);
  const target = path.join(root, 'state'); native.createPrivateDirectory(target);
  lease = captureDirectory(root); parent = lease.openDirectory('');
  return { base, root, target, parent, native };
}
const windows = { skip: process.platform !== 'win32' };

test('native private purge removes only the bound directory and closes all retained handles', windows, t => {
  const { root, target, parent, native } = fixture(t);
  fs.mkdirSync(path.join(target, 'nested')); fs.writeFileSync(path.join(target, 'nested', 'private.txt'), 'private');
  fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
  const expected = native.inspectDirectory(target).identity;
  const result = native.removePrivateDirectory(parent, 'state', expected);
  assert.equal(result.removed, true); assert.equal(result.deletedEntries, 3);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'keep');
});

test('native private purge preflight refuses junctions, hardlinks and stale identities without deleting ordinary files', windows, t => {
  const { base, target, parent, native } = fixture(t);
  const expected = native.inspectDirectory(target).identity;
  const keep = path.join(target, 'a-first.txt'); fs.writeFileSync(keep, 'keep');
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside');
  const junction = path.join(target, 'z-junction'); fs.symlinkSync(outside, junction, 'junction');
  assert.throws(() => native.removePrivateDirectory(parent, 'state', expected), { code: 'PROJECT_PATH_FORBIDDEN' });
  fs.unlinkSync(junction);
  const link = path.join(target, 'z-hard.txt'); fs.linkSync(keep, link);
  assert.throws(() => native.removePrivateDirectory(parent, 'state', expected), { code: 'PROJECT_PATH_FORBIDDEN' });
  fs.unlinkSync(link);
  assert.throws(() => native.removePrivateDirectory(parent, 'state', { ...expected, fileId: '0'.repeat(32) }), { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(fs.readFileSync(keep, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(outside, 'outside.txt'), 'utf8'), 'outside');
  assert.deepEqual(fs.readdirSync(target), ['a-first.txt']);
});

test('native private purge rejects invalid capabilities and path names before deletion', windows, t => {
  const { target, parent, native } = fixture(t); const expected = native.inspectDirectory(target).identity;
  for (const name of ['', '../state', 'state/child', 'state\\child', 'state:stream', 'state.', 'NUL']) {
    assert.throws(() => native.removePrivateDirectory(parent, name, expected), { code: 'BAD_ARGS' });
  }
  assert.throws(() => native.removePrivateDirectory({}, 'state', expected));
  assert.throws(() => native.removePrivateDirectory(parent, 'state', expected, 'ignored'), { code: 'BAD_ARGS' });
  assert.equal(fs.existsSync(target), true);
});

test('native private purge reports incomplete deletion without claiming a successful receipt', windows, t => {
  const { target, parent, native } = fixture(t);
  const first = path.join(target, 'first.txt'), readOnly = path.join(target, 'read-only.txt');
  fs.writeFileSync(first, 'first'); fs.writeFileSync(readOnly, 'read only');
  fs.chmodSync(readOnly, 0o444);
  try {
    assert.throws(() => native.removePrivateDirectory(parent, 'state', native.inspectDirectory(target).identity), error => {
      assert.ok(['WINDOWS_PRIVATE_PURGE_UNCONFIRMED', 'PROJECT_PATH_FORBIDDEN'].includes(error.code));
      assert.equal(error.partial, error.deletedEntries > 0);
      assert.equal(typeof error.deletedEntries, 'number');
      return true;
    });
    assert.equal(fs.readFileSync(readOnly, 'utf8'), 'read only');
    assert.equal(fs.readdirSync(target).some(name => name.startsWith('.hcc-purge-pin-')), false);
  } finally { fs.chmodSync(readOnly, 0o600); }
  assert.equal(native.removePrivateDirectory(parent, 'state', native.inspectDirectory(target).identity).removed, true);
});
