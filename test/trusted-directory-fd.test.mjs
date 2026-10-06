import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureTrustedDirectoryFd } from '../lib/process/pinned-cwd.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';

test('trusted directory FD retains A after selected pathname is rebound to B', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-fd-capture-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const selected = path.join(sandbox, 'selected');
  const replacement = path.join(sandbox, 'replacement');
  fs.mkdirSync(selected);
  fs.mkdirSync(replacement);
  const expected = captureSelectedCwdSnapshot(selected);
  const held = captureTrustedDirectoryFd(selected, expected);
  try {
    fs.renameSync(selected, path.join(sandbox, 'original'));
    fs.symlinkSync(replacement, selected);
    assert.equal(fs.fstatSync(held.fd, { bigint: true }).ino.toString(), expected.identity.ino);
    assert.notEqual(fs.statSync(selected, { bigint: true }).ino.toString(), expected.identity.ino);
    assert.throws(() => captureTrustedDirectoryFd(selected, expected), { code: 'PROJECT_PATH_CHANGED' });
  } finally {
    held.release();
    held.release();
  }
});

test('launch hold is enforced before opening the selected directory', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-fd-hold-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const previous = process.env.HCC_PINNED_LAUNCH_MODE;
  process.env.HCC_PINNED_LAUNCH_MODE = 'hold';
  try {
    assert.throws(() => captureTrustedDirectoryFd(sandbox), { code: 'PINNED_LAUNCH_PAUSED' });
  } finally {
    if (previous === undefined) delete process.env.HCC_PINNED_LAUNCH_MODE;
    else process.env.HCC_PINNED_LAUNCH_MODE = previous;
  }
});
