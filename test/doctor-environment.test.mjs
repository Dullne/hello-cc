import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));

test('environment doctor works before project initialization without creating state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-environment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, '--root', root, '--json', 'doctor', '--environment'], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, HCC_ROOT: '', HCC_DB: '', HCC_NATIVE_OWNER: '' }
  });
  assert.ok(result.stdout.trim(), result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.data.node.version, process.versions.node);
  assert.equal(output.data.node.required, '>=24.0.0');
  assert.equal(output.data.platform.os, process.platform);
  assert.equal(output.data.platform.arch, process.arch);
  assert.equal(output.data.database_checked, false);
  if (process.platform === 'win32' && !output.data.native.capabilities?.persistentTerminal) {
    assert.equal(output.data.ready, false);
    assert.equal(result.status, 1);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('environment doctor refuses database-only options instead of silently skipping requested checks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-environment-options-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, '--root', root, '--json', 'doctor', '--environment', '--codex'], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, HCC_ROOT: '', HCC_DB: '', HCC_NATIVE_OWNER: '' }
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr.trim()).error.code, 'BAD_ARGS');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('environment doctor remains usable when SQLite is unavailable', () => {
  const result = spawnSync(process.execPath,
    ['--no-experimental-sqlite', cli, '--json', 'doctor', '--environment'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, HCC_NATIVE_OWNER: '' }
    });
  assert.ok(result.stdout.trim(), result.stderr);
  assert.equal(JSON.parse(result.stdout).data.database_checked, false);
});

test('environment doctor help is available without SQLite or environment readiness', () => {
  const result = spawnSync(process.execPath,
    ['--no-experimental-sqlite', cli, 'doctor', '--environment', '--help'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, HCC_NATIVE_OWNER: '' }
    });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /doctor --environment/);
});
