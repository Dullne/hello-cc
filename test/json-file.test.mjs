import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJsonSafe, writeJsonSafe } from '../lib/shared/json-file.mjs';

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-json-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('old predictable temp symlink and readable file cannot capture a JSON write', (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, 'runtime.json');
  const oldTemp = `${file}.tmp.${process.pid}`;
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'unchanged victim', { mode: 0o644 });
  if (process.platform !== 'win32') fs.chmodSync(victim, 0o644);
  let symlinkAvailable = true;
  try { fs.symlinkSync(victim, oldTemp); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error?.code)) throw error;
    symlinkAvailable = false;
    t.diagnostic('symlink creation is unavailable on this Windows host');
  }

  if (symlinkAvailable) {
    writeJsonSafe(file, { token: 'private-token-1' }, { mode: 0o600 });
    assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged victim');
    assert.equal(fs.lstatSync(oldTemp).isSymbolicLink(), true);
    assert.deepEqual(readJsonSafe(file), { token: 'private-token-1' });
    fs.unlinkSync(oldTemp);
  }

  fs.writeFileSync(oldTemp, 'unchanged readable file', { mode: 0o644 });
  if (process.platform !== 'win32') fs.chmodSync(oldTemp, 0o644);
  writeJsonSafe(file, { token: 'private-token-2' }, { mode: 0o600 });
  assert.equal(fs.readFileSync(oldTemp, 'utf8'), 'unchanged readable file');
  if (process.platform !== 'win32') assert.equal(fs.statSync(oldTemp).mode & 0o777, 0o644);
  assert.deepEqual(readJsonSafe(file), { token: 'private-token-2' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('ordinary JSON replacement stays atomic and leaves no temp file', (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, 'nested', 'state.json');
  writeJsonSafe(file, { old: true });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writeJsonSafe(file, { current: [1, 2] }, { mode: 0o600 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "current": [\n    1,\n    2\n  ]\n}\n');
  assert.deepEqual(readJsonSafe(file), { current: [1, 2] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('chmod and rename failures do not publish JSON or leave a secret temp file', (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"old":true}\n');

  if (process.platform !== 'win32') {
    const chmod = t.mock.method(fs, 'fchmodSync', () => {
      const error = new Error('injected chmod failure');
      error.code = 'EACCES';
      throw error;
    });
    assert.throws(() => writeJsonSafe(file, { token: 'not-published' }, { mode: 0o600 }),
      { code: 'EACCES' });
    chmod.mock.restore();
    assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}\n');
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  }

  const rename = t.mock.method(fs, 'renameSync', () => {
    const error = new Error('injected rename failure');
    error.code = 'EACCES';
    throw error;
  });
  assert.throws(() => writeJsonSafe(file, { token: 'not-published' }, { mode: 0o600 }),
    { code: 'EACCES' });
  rename.mock.restore();
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}\n');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});
