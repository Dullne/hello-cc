import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectProcessIdentity } from '../lib/process/identity.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-down-pointer-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'project');
  const home = path.join(sandbox, 'home');
  const state = path.join(root, '.hello-cc');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, home, pointer: path.join(state, 'runtime.json') };
}

function runDown({ root, home }, env = {}) {
  return spawnSync(process.execPath, [hccBin, '--root', root, 'down'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HCC_RUNTIME_URL: '', ...env }
  });
}

function writePointer(file, runtime) {
  fs.writeFileSync(file, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
}

test('down removes a local pointer only when its immutable process identity is confirmed dead', (t) => {
  const state = fixture(t);
  const pid = 2_147_483_647;
  writePointer(state.pointer, {
    product: 'hello-cc',
    pid,
    process_identity: { pid, startToken: 'dead:start', commandHash: 'd'.repeat(64) },
    base_url: 'http://127.0.0.1:1'
  });

  const result = runDown(state);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(state.pointer), false);
  assert.match(result.stdout, /stale runtime pointer removed/i);
  assert.doesNotMatch(result.stdout, /runtime stopped/i);
});

test('down keeps an unreachable pointer whose immutable process identity is still live', (t) => {
  const state = fixture(t);
  const observed = inspectProcessIdentity(process.pid);
  if (observed.state !== 'live') {
    t.skip('complete process identity unavailable');
    return;
  }
  writePointer(state.pointer, {
    product: 'hello-cc',
    pid: process.pid,
    process_identity: observed.identity,
    base_url: 'http://127.0.0.1:1'
  });

  const result = runDown(state);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(state.pointer), true);
  assert.doesNotMatch(result.stdout, /runtime stopped/i);
});

test('down keeps an unreachable pointer when process ownership evidence is incomplete', (t) => {
  const state = fixture(t);
  writePointer(state.pointer, {
    product: 'hello-cc',
    pid: process.pid,
    base_url: 'http://127.0.0.1:1'
  });

  const result = runDown(state);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(state.pointer), true);
  assert.doesNotMatch(result.stdout, /runtime stopped/i);
});

test('down never treats an unreachable environment runtime as a local stale pointer', (t) => {
  const state = fixture(t);
  const result = runDown(state, {
    HCC_RUNTIME_URL: 'http://127.0.0.1:1',
    HCC_RUNTIME_TOKEN: 'test-token'
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /runtime stopped|stale runtime pointer removed/i);
});
