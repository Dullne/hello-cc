import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createConnectionHelpers } from '../lib/db/connection.mjs';
import { ensurePrivateProjectBufferDirectory, resolveProjectDatabase } from '../lib/runtime/project-path.mjs';

const hcc = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-private-state-'));
  const root = path.join(sandbox, 'project');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(root, { mode: 0o755 });
  fs.mkdirSync(home, { mode: 0o700 });
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  return { sandbox, root, home, state: path.join(root, '.hello-cc'), db: path.join(root, '.hello-cc', 'mesh.db') };
}

function cliEnvironment(home, extra = {}) {
  return { ...process.env, HOME: home, HCC_INTERNAL_WEB_MANAGED_RUN: '0', ...extra };
}

function runCli(fixture, args) {
  const previousUmask = process.umask(0o022);
  let result;
  try {
    result = spawnSync(process.execPath, [hcc, '--root', fixture.root, '--json', ...args], {
      cwd: fixture.root, env: cliEnvironment(fixture.home), encoding: 'utf8', timeout: 20000
    });
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return result;
}

function mode(file) { return fs.statSync(file).mode & 0o777; }

test('init creates a private managed directory and database under umask 022', (t) => {
  const f = fixture(t);
  runCli(f, ['init', '--no-guidance']);
  assert.equal(mode(f.state), 0o700);
  assert.equal(mode(f.db), 0o600);

  const db = new DatabaseSync(f.db, { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'mesh.init'").get().count, 1); }
  finally { db.close(); }
});

test('init tightens an existing owned state directory and database without replacing data', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.state, { mode: 0o755 });
  const db = new DatabaseSync(f.db);
  db.exec('CREATE TABLE existing_data (value TEXT); INSERT INTO existing_data VALUES (\'preserved\');');
  db.close();
  fs.chmodSync(f.db, 0o644);

  runCli(f, ['init', '--no-guidance']);
  assert.equal(mode(f.state), 0o700);
  assert.equal(mode(f.db), 0o600);
  const reopened = new DatabaseSync(f.db, { readOnly: true });
  try { assert.equal(reopened.prepare('SELECT value FROM existing_data').get().value, 'preserved'); }
  finally { reopened.close(); }
});

test('managed SQLite sidecars remain behind the private directory while the connection is live', (t) => {
  const f = fixture(t);
  const previousUmask = process.umask(0o022);
  try {
    const { connect } = createConnectionHelpers({ now: () => 1, dedupePeerBindings() {}, redactedLogText: value => value });
    const db = connect({ root: f.root, dbPath: f.db }, { migrateRegistered: false });
    try {
      db.exec('CREATE TABLE permission_probe (value TEXT); INSERT INTO permission_probe VALUES (\'secret\');');
      assert.equal(mode(f.state), 0o700);
      assert.equal(mode(f.db), 0o600);
      assert.equal(fs.existsSync(`${f.db}-wal`), true);
      assert.equal(fs.existsSync(`${f.db}-shm`), true);
    } finally { db.close(); }
  } finally { process.umask(previousUmask); }
});

test('explicit external CLI database retains its path and parent directory permissions', (t) => {
  const f = fixture(t);
  const external = path.join(f.sandbox, 'external');
  const db = path.join(external, 'selected.db');
  fs.mkdirSync(external, { mode: 0o755 });
  runCli(f, ['--db', db, 'init', '--no-guidance']);
  assert.equal(fs.existsSync(db), true);
  assert.equal(mode(external), 0o755);
  assert.equal(fs.existsSync(f.state), false);
});

test('a custom managed nested database gets private parents and file', (t) => {
  const f = fixture(t);
  const nested = path.join(f.state, 'nested');
  const db = path.join(nested, 'selected.db');
  runCli(f, ['--db', db, 'init', '--no-guidance']);
  assert.equal(mode(f.state), 0o700);
  assert.equal(mode(nested), 0o700);
  assert.equal(mode(db), 0o600);
});

test('a canonical database path under a symlinked root remains managed', (t) => {
  const f = fixture(t);
  const alias = path.join(f.sandbox, 'project-alias');
  fs.symlinkSync(f.root, alias, 'dir');
  const aliased = { ...f, root: alias };
  runCli(aliased, ['--db', f.db, 'init', '--no-guidance']);
  assert.equal(mode(f.state), 0o700);
  assert.equal(mode(f.db), 0o600);
});

test('read-only path resolution and connection do not change existing permissions', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.state, { mode: 0o755 });
  const db = new DatabaseSync(f.db);
  db.exec('CREATE TABLE existing_data (value TEXT)');
  db.close();
  fs.chmodSync(f.db, 0o644);

  resolveProjectDatabase({ root: f.root, db: f.db, createStateDir: false });
  const { connectReadOnly } = createConnectionHelpers({ now: () => 1, dedupePeerBindings() {}, redactedLogText: value => value });
  const reader = connectReadOnly({ root: f.root, dbPath: f.db });
  reader.close();
  assert.equal(mode(f.state), 0o755);
  assert.equal(mode(f.db), 0o644);
});

test('read-only managed connection rejects a database symlink without chmoding its target', (t) => {
  const f = fixture(t);
  const outside = path.join(f.sandbox, 'outside.db');
  fs.mkdirSync(f.state, { mode: 0o755 });
  fs.writeFileSync(outside, 'sentinel', { mode: 0o644 });
  fs.symlinkSync(outside, f.db, 'file');
  const { connectReadOnly } = createConnectionHelpers({ now: () => 1, dedupePeerBindings() {}, redactedLogText: value => value });
  assert.throws(() => connectReadOnly({ root: f.root, dbPath: f.db }), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(mode(f.state), 0o755);
  assert.equal(mode(outside), 0o644);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel');
});

test('managed state and buffer symlinks are rejected without touching their targets', (t) => {
  const f = fixture(t);
  const outside = path.join(f.sandbox, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.state, 'dir');
  assert.throws(() => ensurePrivateProjectBufferDirectory(f.root), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(fs.readdirSync(outside).length, 0);
  fs.unlinkSync(f.state);

  fs.mkdirSync(f.state, { mode: 0o755 });
  assert.equal(ensurePrivateProjectBufferDirectory(f.root, 'bufs', { create: false }), null);
  assert.equal(fs.existsSync(path.join(f.state, 'bufs')), false);
  fs.symlinkSync(outside, path.join(f.state, 'bufs'), 'dir');
  assert.throws(() => ensurePrivateProjectBufferDirectory(f.root), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(fs.readdirSync(outside).length, 0);
});

test('buffer directory creation and reuse tighten only the managed directories', (t) => {
  const f = fixture(t);
  const bufs = ensurePrivateProjectBufferDirectory(f.root);
  assert.equal(mode(f.state), 0o700);
  assert.equal(mode(bufs), 0o700);
  fs.chmodSync(f.state, 0o755);
  fs.chmodSync(bufs, 0o755);
  assert.equal(ensurePrivateProjectBufferDirectory(f.root), bufs);
  assert.equal(mode(f.state), 0o700);
  assert.equal(mode(bufs), 0o700);
});

test('internal PTY bridge creates its input, output, resize and metadata privately', async (t) => {
  const f = fixture(t);
  const peer = 'private-pty';
  const previousUmask = process.umask(0o022);
  let child;
  try {
    child = spawn(process.execPath, [hcc, '--root', f.root, 'run', '--peer', peer,
      '--kind', 'shell', '--', process.execPath, '-e', 'process.stdout.write("private output"); setTimeout(() => {}, 1500)'], {
      cwd: f.root,
      env: cliEnvironment(f.home, { HCC_INTERNAL_WEB_MANAGED_RUN: '1' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } finally { process.umask(previousUmask); }
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const bufs = path.join(f.state, 'bufs');
  const files = ['in', 'out', 'resize', 'meta'].map(suffix => path.join(bufs, `${peer}.${suffix}`));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && files.some(file => !fs.existsSync(file)) && child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  try {
    assert.ok(files.every(file => fs.existsSync(file)), stderr || 'PTY bridge files were not created');
    assert.equal(mode(f.state), 0o700);
    assert.equal(mode(bufs), 0o700);
    for (const file of files) assert.equal(mode(file), 0o600, file);
  } finally {
    await closed;
  }
});
