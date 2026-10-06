import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContext } from '../lib/cli-runtime.mjs';
import { projectDbPath } from '../lib/runtime/paths.mjs';
import { createConnectionHelpers } from '../lib/db/connection.mjs';
import { writeGuidance } from '../lib/guidance.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { HOOK_ROOT_IDENTITY_ENV, hookRootIdentityValue } from '../lib/core/sessions/hook-root-identity.mjs';

test('CLI context keeps the selected project when a root symlink is retargeted', (t) => {
  if (process.platform === 'win32') { t.skip('directory symlink permissions vary on Windows'); return; }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cli-context-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const first = path.join(sandbox, 'first');
  const second = path.join(sandbox, 'second');
  const alias = path.join(sandbox, 'selected');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.symlinkSync(first, alias, 'dir');

  const ctx = createContext({ root: alias }, {
    cwd: sandbox,
    detectRoot: () => alias
  });
  assert.equal(ctx.root, fs.realpathSync(first));
  assert.equal(ctx.dbPath, projectDbPath(first));

  fs.unlinkSync(alias);
  fs.symlinkSync(second, alias, 'dir');
  assert.equal(ctx.root, fs.realpathSync(first));
  assert.equal(ctx.dbPath, projectDbPath(first));
});

test('CLI context preserves a missing root for commands that create it', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cli-context-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const missing = path.join(sandbox, 'new-project');
  const ctx = createContext({ root: missing }, {
    cwd: sandbox,
    detectRoot: () => missing
  });
  assert.equal(ctx.root, missing);
  assert.equal(ctx.dbPath, projectDbPath(missing));
});

test('CLI context refuses a rebound inode before database or guidance writes', t => {
  if (process.platform === 'win32') return t.skip('POSIX directory identity required');
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cli-rebind-')));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const selected = path.join(sandbox, 'selected');
  const original = path.join(sandbox, 'original');
  fs.mkdirSync(selected);
  const ctx = createContext({ root: selected }, { cwd: sandbox, detectRoot: () => selected });
  fs.renameSync(selected, original);
  fs.mkdirSync(selected);
  const { connect } = createConnectionHelpers({ now: () => 0, dedupePeerBindings: () => {},
    redactedLogText: value => value });
  assert.throws(() => connect(ctx), { code: 'PROJECT_PATH_CHANGED' });
  assert.throws(() => writeGuidance(ctx.root, { expectedSnapshot: ctx.initialRootIdentity }),
    { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(fs.existsSync(path.join(selected, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(selected, '.hello-cc')), false);
});

test('background child rejects a replacement root after its pinned chdir', t => {
  if (process.platform === 'win32') return t.skip('POSIX directory identity required');
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cli-child-rebind-')));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const selected = path.join(sandbox, 'selected');
  fs.mkdirSync(selected);
  const expected = captureSelectedCwdSnapshot(selected);
  fs.renameSync(selected, path.join(sandbox, 'original'));
  fs.mkdirSync(selected);
  const previous = process.env.HCC_PINNED_ROOT_IDENTITY;
  process.env.HCC_PINNED_ROOT_IDENTITY = JSON.stringify({ canonical: expected.canonical,
    identity: expected.identity });
  try {
    assert.throws(() => createContext({ root: selected }, {
      cwd: sandbox, detectRoot: () => selected
    }), { code: 'PROJECT_PATH_CHANGED' });
  } finally {
    if (previous === undefined) delete process.env.HCC_PINNED_ROOT_IDENTITY;
    else process.env.HCC_PINNED_ROOT_IDENTITY = previous;
  }
});

test('a managed provider HCC command refuses its rebound launch root before context creation', t => {
  if (process.platform === 'win32') return t.skip('POSIX directory identity required');
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cli-provider-')));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const selected = path.join(sandbox, 'selected');
  const original = path.join(sandbox, 'original');
  fs.mkdirSync(selected);
  const marker = hookRootIdentityValue(selected);
  const previous = process.env[HOOK_ROOT_IDENTITY_ENV];
  process.env[HOOK_ROOT_IDENTITY_ENV] = marker;
  try {
    assert.equal(createContext({ root: selected }, { cwd: sandbox, detectRoot: () => selected }).root, selected);
    fs.renameSync(selected, original);
    fs.mkdirSync(selected);
    assert.throws(() => createContext({ root: selected }, {
      cwd: sandbox, detectRoot: () => selected
    }), { code: 'HOOK_ROOT_IDENTITY_MISMATCH' });
    assert.equal(fs.existsSync(path.join(selected, '.hello-cc')), false);
  } finally {
    if (previous === undefined) delete process.env[HOOK_ROOT_IDENTITY_ENV];
    else process.env[HOOK_ROOT_IDENTITY_ENV] = previous;
  }
});
