import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertHookRootIdentity, hookRootIdentityValue } from '../lib/core/sessions/hook-root-identity.mjs';

test('Windows hook receipts validate full native identity and reject replacement and malformed schemas',
  { skip: process.platform !== 'win32' }, t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-hook-win-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'project'); fs.mkdirSync(root);
    const receipt = hookRootIdentityValue(root), snapshot = JSON.parse(receipt);
    assert.equal(assertHookRootIdentity(root, receipt).identity.platform, 'win32');
    for (const identity of [null, [], { dev: '1', ino: '2', birthtimeNs: null },
      { ...snapshot.identity, fileId: '0'.repeat(32) },
      { ...snapshot.identity, creationTime: '0' },
      { ...snapshot.identity, version: 2 },
      { ...snapshot.identity, volumeSerial: '-1' }]) {
      assert.throws(() => assertHookRootIdentity(root, JSON.stringify({ ...snapshot, identity })),
        { code: 'HOOK_ROOT_IDENTITY_MISMATCH' });
    }
    fs.renameSync(root, path.join(base, 'old-project')); fs.mkdirSync(root);
    assert.throws(() => assertHookRootIdentity(root, receipt), { code: 'HOOK_ROOT_IDENTITY_MISMATCH' });
  });
