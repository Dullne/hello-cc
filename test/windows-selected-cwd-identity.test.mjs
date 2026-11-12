import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureSelectedCwdIdentity, captureSelectedCwdSnapshot, assertSelectedCwdSnapshot,
  sameSelectedCwdIdentity } from '../lib/process/selected-cwd-identity.mjs';

const windows = process.platform === 'win32';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-selected-win-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, '项目 with spaces');
  fs.mkdirSync(root);
  return { base, root };
}

test('selected Windows snapshots retain native identity without writing to the project', { skip: !windows }, t => {
  const { root } = fixture(t);
  const snapshot = captureSelectedCwdSnapshot(root);
  assert.equal(snapshot.identity.platform, 'win32');
  assert.equal(snapshot.identity.version, 1);
  assert.match(snapshot.identity.volumeSerial, /^[0-9]+$/);
  assert.match(snapshot.identity.fileId, /^[a-f0-9]{32}$/);
  assert.match(snapshot.identity.creationTime, /^[1-9][0-9]*$/);
  assert.equal(Object.hasOwn(snapshot.identity, 'ino'), false);
  assert.equal(Object.isFrozen(snapshot.identity), true);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.doesNotThrow(() => assertSelectedCwdSnapshot(snapshot));
  assert.equal(sameSelectedCwdIdentity(snapshot, captureSelectedCwdSnapshot(root.toUpperCase())), true);
});

test('selected Windows observer detects junction rebinding and same-path replacement after releasing its handle',
  { skip: !windows }, t => {
    const { base, root } = fixture(t);
    const other = path.join(base, 'other'); fs.mkdirSync(other);
    const alias = path.join(base, 'alias'); fs.symlinkSync(root, alias, 'junction');
    const binding = captureSelectedCwdIdentity(alias);
    try {
      assert.equal(binding.mode, 'observed');
      assert.equal(binding.assertUnchanged(), undefined);
      assert.deepEqual(fs.readdirSync(root), []);
      fs.unlinkSync(alias); fs.symlinkSync(other, alias, 'junction');
      assert.throws(() => binding.assertUnchanged(), { code: 'PROJECT_PATH_CHANGED' });
    } finally { binding.release(); binding.release(); }
    const snapshot = captureSelectedCwdSnapshot(root);
    const second = captureSelectedCwdIdentity(root, snapshot);
    try {
      second.dropDescriptor(); second.dropDescriptor();
      assert.equal(second.mode, 'snapshot');
      assert.equal(second.assertUnchanged(), undefined);
      fs.renameSync(root, root + '-old'); fs.mkdirSync(root);
      assert.throws(() => second.assertUnchanged(), { code: 'PROJECT_PATH_CHANGED' });
      assert.throws(() => assertSelectedCwdSnapshot(snapshot), { code: 'PROJECT_PATH_CHANGED' });
      assert.throws(() => captureSelectedCwdIdentity(root, snapshot), { code: 'PROJECT_PATH_CHANGED' });
    } finally { second.release(); }
    assert.throws(() => second.assertUnchanged(), { code: 'PROJECT_PATH_CHANGED' });
  });

test('selected identity comparison rejects partial, incompatible and cross-platform identities', () => {
  const snapshot = { canonical: 'C:\\project', identity: { version: 1, platform: 'win32',
    volumeSerial: '42', fileId: 'a'.repeat(32), creationTime: '12345' } };
  assert.equal(sameSelectedCwdIdentity(snapshot, structuredClone(snapshot)), true);
  for (const identity of [{}, { dev: '1', ino: '2', birthtimeNs: '3' },
    { ...snapshot.identity, version: 2 }, { ...snapshot.identity, volumeSerial: undefined },
    { ...snapshot.identity, fileId: 'b'.repeat(32) }, { ...snapshot.identity, creationTime: '0' }]) {
    assert.equal(sameSelectedCwdIdentity(snapshot, { ...snapshot, identity }), false);
  }
  assert.equal(sameSelectedCwdIdentity({ canonical: 'x' }, { canonical: 'x' }), false);
  assert.equal(sameSelectedCwdIdentity({ canonical: 'x', identity: {} }, { canonical: 'x', identity: {} }), false);
  const posix = { canonical: '/project', identity: { dev: '1', ino: '2', birthtimeNs: '3' } };
  assert.equal(sameSelectedCwdIdentity(posix, structuredClone(posix)), true);
});
