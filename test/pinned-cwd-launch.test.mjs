import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePinnedCwdLaunch } from '../lib/process/pinned-cwd.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-pinned-cwd-'));
  const trusted = path.join(sandbox, 'trusted');
  const selected = path.join(sandbox, 'selected');
  const replacement = path.join(sandbox, 'replacement');
  fs.mkdirSync(trusted, { mode: 0o700 });
  fs.mkdirSync(selected);
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(selected, 'marker'), 'OLD');
  fs.writeFileSync(path.join(replacement, 'marker'), 'NEW');
  t.after(() => {
    try { fs.chmodSync(selected, 0o700); } catch {}
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  return { sandbox, trusted, selected, replacement };
}

function launchMarker(binding, options = {}) {
  const result = spawnSync(binding.command, binding.args, {
    cwd: binding.cwd,
    env: binding.env,
    encoding: 'utf8',
    timeout: 10000,
    ...options
  });
  binding.release();
  return result;
}

test('pinned launch runs an ordinary command in the selected directory', (t) => {
  const { trusted, selected } = fixture(t);
  const binding = preparePinnedCwdLaunch(selected, process.execPath,
    ['-e', 'process.stdout.write(require("node:fs").readFileSync("marker", "utf8"))'],
    { bootstrapCwd: trusted });
  assert.equal(binding.identity.mode, 'descriptor');
  assert.equal(binding.cwd, fs.realpathSync(trusted));
  const result = launchMarker(binding);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OLD');
});

test('pinned launch rejects B captured after the caller selected A', (t) => {
  const { sandbox, trusted, selected, replacement } = fixture(t);
  const expectedIdentity = captureSelectedCwdSnapshot(selected);
  fs.renameSync(selected, path.join(sandbox, 'original'));
  fs.renameSync(replacement, selected);
  assert.throws(() => preparePinnedCwdLaunch(selected, process.execPath, ['-e', ''],
    { bootstrapCwd: trusted, expectedIdentity }), { code: 'PROJECT_PATH_CHANGED' });
});

test('pinned launch rejects a selected directory replaced before startup', (t) => {
  const { sandbox, trusted, selected, replacement } = fixture(t);
  const binding = preparePinnedCwdLaunch(selected, process.execPath,
    ['-e', 'process.stdout.write(require("node:fs").readFileSync("marker", "utf8"))'],
    { bootstrapCwd: trusted });
  fs.renameSync(selected, path.join(sandbox, 'original'));
  fs.symlinkSync(replacement, selected);
  const result = launchMarker(binding);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /PINNED_CWD_CHANGED/);
});

function injectSwap(binding, marker, selected, replacement, original) {
  const swap = 'fs.renameSync(' + JSON.stringify(selected) + ',' + JSON.stringify(original) +
    ');fs.symlinkSync(' + JSON.stringify(replacement) + ',' + JSON.stringify(selected) + ');';
  assert.ok(binding.args[1].includes(marker));
  binding.args[1] = binding.args[1].replace(marker, swap);
}

test('pinned launch rejects a replacement between directory open and chdir', (t) => {
  const { sandbox, trusted, selected, replacement } = fixture(t);
  const binding = preparePinnedCwdLaunch(selected, process.execPath,
    ['-e', 'process.stdout.write(require("node:fs").readFileSync("marker", "utf8"))'],
    { bootstrapCwd: trusted });
  injectSwap(binding, '/* PINNED_TEST_AFTER_OPEN */', selected, replacement,
    path.join(sandbox, 'original'));
  const result = launchMarker(binding);
  assert.equal(result.status, 42, result.stderr);
  assert.equal(result.stdout, '');
});

test('pinned launch keeps the original inode after chdir even if its path is replaced', (t) => {
  const { sandbox, trusted, selected, replacement } = fixture(t);
  const binding = preparePinnedCwdLaunch(selected, process.execPath,
    ['-e', 'process.stdout.write(require("node:fs").readFileSync("marker", "utf8"))'],
    { bootstrapCwd: trusted });
  injectSwap(binding, '/* PINNED_TEST_BEFORE_EXEC */', selected, replacement,
    path.join(sandbox, 'original'));
  const result = launchMarker(binding);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OLD');
});

test('relative command resolves from pinned cwd after selected path is replaced', (t) => {
  const { sandbox, trusted, selected, replacement } = fixture(t);
  fs.writeFileSync(path.join(selected, 'tool'), '#!/bin/sh\nprintf OLD', { mode: 0o700 });
  fs.writeFileSync(path.join(replacement, 'tool'), '#!/bin/sh\nprintf NEW', { mode: 0o700 });
  const binding = preparePinnedCwdLaunch(selected, './tool', [], { bootstrapCwd: trusted });
  injectSwap(binding, '/* PINNED_TEST_BEFORE_EXEC */', selected, replacement,
    path.join(sandbox, 'original'));
  const result = launchMarker(binding);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OLD');
});

test('relative PATH entry resolves from pinned cwd after selected path is replaced', (t) => {
  const { sandbox, trusted, selected, replacement } = fixture(t);
  fs.mkdirSync(path.join(selected, 'bin'));
  fs.mkdirSync(path.join(replacement, 'bin'));
  fs.writeFileSync(path.join(selected, 'bin', 'tool'), '#!/bin/sh\nprintf OLD', { mode: 0o700 });
  fs.writeFileSync(path.join(replacement, 'bin', 'tool'), '#!/bin/sh\nprintf NEW', { mode: 0o700 });
  const binding = preparePinnedCwdLaunch(selected, 'tool', [], {
    bootstrapCwd: trusted, env: { PATH: 'bin:/usr/bin:/bin' }
  });
  injectSwap(binding, '/* PINNED_TEST_BEFORE_EXEC */', selected, replacement,
    path.join(sandbox, 'original'));
  const result = launchMarker(binding);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OLD');
});

test('absolute command inside captured root uses pinned cwd after path replacement', (t) => {
  const { sandbox, trusted, selected, replacement } = fixture(t);
  fs.writeFileSync(path.join(selected, 'tool'), '#!/bin/sh\nprintf OLD', { mode: 0o700 });
  fs.writeFileSync(path.join(replacement, 'tool'), '#!/bin/sh\nprintf NEW', { mode: 0o700 });
  const binding = preparePinnedCwdLaunch(selected, path.join(selected, 'tool'), [], { bootstrapCwd: trusted });
  injectSwap(binding, '/* PINNED_TEST_BEFORE_EXEC */', selected, replacement,
    path.join(sandbox, 'original'));
  const result = launchMarker(binding);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OLD');
});

test('absolute PATH entry inside captured root uses pinned cwd after path replacement', (t) => {
  const { sandbox, trusted, selected, replacement } = fixture(t);
  fs.mkdirSync(path.join(selected, 'bin'));
  fs.mkdirSync(path.join(replacement, 'bin'));
  fs.writeFileSync(path.join(selected, 'bin', 'tool'), '#!/bin/sh\nprintf OLD', { mode: 0o700 });
  fs.writeFileSync(path.join(replacement, 'bin', 'tool'), '#!/bin/sh\nprintf NEW', { mode: 0o700 });
  const binding = preparePinnedCwdLaunch(selected, 'tool', [], {
    bootstrapCwd: trusted, env: { PATH: `${path.join(selected, 'bin')}:/usr/bin:/bin` }
  });
  injectSwap(binding, '/* PINNED_TEST_BEFORE_EXEC */', selected, replacement,
    path.join(sandbox, 'original'));
  const result = launchMarker(binding);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OLD');
});

test('pinned launch preserves executable-only directories without a silent ordinary-spawn fallback', (t) => {
  const { trusted, selected } = fixture(t);
  fs.chmodSync(selected, 0o111);
  const binding = preparePinnedCwdLaunch(selected, process.execPath,
    ['-e', 'process.stdout.write(require("node:fs").readFileSync("marker", "utf8"))'],
    { bootstrapCwd: trusted });
  // Root can still open mode-0111 directories on Linux, so descriptor mode is
  // equally valid there. Non-root macOS exercises the stat-only fallback.
  assert.ok(['descriptor', 'stat-only'].includes(binding.identity.mode));
  const result = launchMarker(binding);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OLD');
});

test('pinned launch acknowledges only after entering the selected inode', (t) => {
  const { trusted, selected } = fixture(t);
  const binding = preparePinnedCwdLaunch(selected, process.execPath,
    ['-e', 'process.stdout.write(require("node:fs").readFileSync("marker", "utf8"))'],
    { bootstrapCwd: trusted, acknowledge: true });
  assert.equal(binding.acknowledged(), false);
  assert.ok(binding.ackPath.startsWith(`${fs.realpathSync(trusted)}${path.sep}`));
  const result = spawnSync(binding.command, binding.args, {
    cwd: binding.cwd,
    env: binding.env,
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OLD');
  assert.equal(binding.acknowledged(), true);
  binding.release();
  assert.equal(fs.existsSync(binding.ackPath), false);
});

test('pinned launch does not acknowledge a changed directory or delete a foreign marker', (t) => {
  const { sandbox, trusted, selected, replacement } = fixture(t);
  const binding = preparePinnedCwdLaunch(selected, process.execPath, ['-e', ''],
    { bootstrapCwd: trusted, acknowledge: true });
  fs.renameSync(selected, path.join(sandbox, 'original'));
  fs.symlinkSync(replacement, selected);
  const result = spawnSync(binding.command, binding.args, {
    cwd: binding.cwd,
    env: binding.env,
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(result.status, 41, result.stderr);
  assert.equal(binding.acknowledged(), false);
  fs.writeFileSync(binding.ackPath, 'foreign', { mode: 0o600 });
  binding.release();
  assert.equal(fs.readFileSync(binding.ackPath, 'utf8'), 'foreign');
});

test('pinned launch matches platform behavior for executable text without a shebang', (t) => {
  const { trusted, selected } = fixture(t);
  const script = path.join(selected, 'plain-script');
  fs.writeFileSync(script, 'printf SCRIPT_OK', { mode: 0o700 });
  const ordinary = spawnSync(script, [], { cwd: selected, encoding: 'utf8' });
  const binding = preparePinnedCwdLaunch(selected, script, [], { bootstrapCwd: trusted });
  const pinned = launchMarker(binding);
  if (ordinary.error?.code === 'ENOEXEC') {
    assert.equal(pinned.status, 127,
      JSON.stringify({ signal: pinned.signal, error: pinned.error?.code, stderr: pinned.stderr }));
    assert.match(pinned.stderr, /HCC_PINNED_EXEC_FAILED:ENOEXEC/);
    assert.equal(pinned.stdout, '');
  } else {
    assert.equal(ordinary.status, 0, ordinary.stderr || ordinary.error?.message);
    assert.equal(pinned.status, ordinary.status, pinned.stderr);
    assert.equal(pinned.stdout, ordinary.stdout);
  }
});
