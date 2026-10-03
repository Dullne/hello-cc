import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openPrivateAppendFile } from '../lib/runtime/private-file.mjs';
import { readGlobalRuntimeFile, readRuntimeFile } from '../lib/runtime/state.mjs';
import { runtimePath, globalRuntimePath } from '../lib/runtime/paths.mjs';

test('managed append file rejects symlink and hardlink leaves without touching their targets', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-private-file-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outside = path.join(directory, 'outside');
  fs.writeFileSync(outside, 'sentinel', { mode: 0o600 });
  const link = path.join(directory, 'web.log');
  fs.symlinkSync(outside, link);
  assert.throws(() => openPrivateAppendFile(link), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel');
  fs.unlinkSync(link);
  fs.linkSync(outside, link);
  assert.throws(() => openPrivateAppendFile(link), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel');
});

test('managed append file rejects a formerly writable leaf and creates a private replacement', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-private-file-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'runtime.log');
  fs.writeFileSync(file, 'before', { mode: 0o666 });
  fs.chmodSync(file, 0o666);
  assert.throws(() => openPrivateAppendFile(file), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  fs.renameSync(file, `${file}.legacy`);
  const fd = openPrivateAppendFile(file);
  try { fs.writeSync(fd, '-after'); }
  finally { fs.closeSync(fd); }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), '-after');
  assert.equal(fs.readFileSync(`${file}.legacy`, 'utf8'), 'before');
});

test('runtime pointers reject redirected or publicly readable old leaves', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-private-pointer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  fs.mkdirSync(root, { mode: 0o700 });
  const pointer = runtimePath({ root });
  fs.mkdirSync(path.dirname(pointer), { mode: 0o700 });
  const outside = path.join(directory, 'outside');
  fs.writeFileSync(outside, 'sentinel', { mode: 0o600 });
  fs.symlinkSync(outside, pointer);
  assert.throws(() => readRuntimeFile({ root }), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel');
  fs.unlinkSync(pointer);
  fs.writeFileSync(pointer, '{"pid":1}', { mode: 0o600 });
  fs.chmodSync(pointer, 0o644);
  assert.throws(() => readRuntimeFile({ root }), { code: 'PROJECT_PATH_FORBIDDEN' });
  fs.chmodSync(pointer, 0o600);
  assert.deepEqual(readRuntimeFile({ root }), { pid: 1 });
});

test('global runtime pointer requires the same private leaf checks', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-global-pointer-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const pointer = globalRuntimePath();
  fs.mkdirSync(path.dirname(pointer), { mode: 0o700 });
  fs.writeFileSync(pointer, '{"pid":1}', { mode: 0o600 });
  fs.chmodSync(pointer, 0o644);
  assert.throws(() => readGlobalRuntimeFile(), { code: 'PROJECT_PATH_FORBIDDEN' });
  fs.chmodSync(pointer, 0o600);
  assert.deepEqual(readGlobalRuntimeFile(), { pid: 1 });
});
