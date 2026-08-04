import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { inspectProcessIdentity } from '../lib/process/identity.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');

function runHcc(root, home, args) {
  return execFileSync(process.execPath, [hccBin, '--root', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HCC_RUNTIME_URL: '' }
  });
}

function fixture(t, name) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-pointer-${name}-`));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'project');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  runHcc(root, home, ['init', '--no-guidance']);
  const directory = path.join(root, '.hello-cc', 'bufs');
  fs.mkdirSync(directory, { recursive: true });
  const orphan = path.join(directory, 'old-orphan.out');
  fs.writeFileSync(orphan, 'old');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(orphan, old, old);
  const db = new DatabaseSync(path.join(root, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  try {
    db.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
    db.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(Math.floor(Date.now() / 1000)));
  } finally {
    db.close();
  }
  return {
    root,
    home,
    orphan,
    pointer: path.join(root, '.hello-cc', 'runtime.json')
  };
}

test('manual GC reclaims a confirmed-dead fingerprinted runtime pointer', (t) => {
  const state = fixture(t, 'dead');
  const pid = 2_147_483_647;
  fs.writeFileSync(state.pointer, JSON.stringify({
    pid,
    process_identity: {
      pid,
      startToken: 'boot:dead',
      commandHash: 'd'.repeat(64)
    },
    base_url: 'http://127.0.0.1:1'
  }));

  const result = JSON.parse(runHcc(
    state.root,
    state.home,
    ['--json', 'gc', '--older-than', '0', '--yes']
  )).data;

  assert.equal(result.buf_files, 1);
  assert.equal(result.deferred_buf_files, 0);
  assert.equal(fs.existsSync(state.orphan), false);
  assert.equal(fs.existsSync(state.pointer), false);
});

test('manual GC keeps an unreachable pointer with a live matching fingerprint fail closed', (t) => {
  const state = fixture(t, 'alive');
  const observed = inspectProcessIdentity(process.pid);
  if (observed.state !== 'live') {
    t.skip('complete process identity unavailable');
    return;
  }
  fs.writeFileSync(state.pointer, JSON.stringify({
    pid: process.pid,
    process_identity: observed.identity,
    base_url: 'http://127.0.0.1:1'
  }));

  const result = JSON.parse(runHcc(
    state.root,
    state.home,
    ['--json', 'gc', '--older-than', '0', '--yes']
  )).data;

  assert.equal(result.buf_files, 0);
  assert.ok(result.deferred_buf_files >= 1);
  assert.equal(fs.existsSync(state.orphan), true);
  assert.equal(fs.existsSync(state.pointer), true);
});
