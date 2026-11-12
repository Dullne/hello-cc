import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureSelectedCwdIdentity } from '../lib/process/selected-cwd-identity.mjs';

test('selected directory identity rejects persistent alias and same-path replacement', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-selected-cwd-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const original = path.join(base, 'original');
  const replacement = path.join(base, 'replacement');
  const alias = path.join(base, 'selected');
  fs.mkdirSync(original);
  fs.mkdirSync(replacement);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(original, alias, linkType);
  const first = captureSelectedCwdIdentity(alias);
  try {
    assert.equal(first.assertUnchanged(), undefined);
    if (process.platform === 'win32') assert.equal(first.identity.platform, 'win32');
    else assert.equal(first.identity.ino, fs.statSync(original, { bigint: true }).ino.toString());
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, linkType);
    assert.throws(() => first.assertUnchanged(), { code: 'PROJECT_PATH_CHANGED' });
  } finally { first.release(); first.release(); }

  const second = captureSelectedCwdIdentity(original);
  try {
    fs.renameSync(original, path.join(base, 'moved-original'));
    fs.mkdirSync(original);
    assert.throws(() => second.assertUnchanged(), { code: 'PROJECT_PATH_CHANGED' });
  } finally { second.release(); }
});
