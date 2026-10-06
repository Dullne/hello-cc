import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { migrateLegacyProjectState } from '../lib/runtime/state-migration.mjs';
import { ensurePrivateProjectStateDir, privateProjectStateDir,
  provisionPrivateProjectGeneration } from '../lib/runtime/private-state.mjs';
import { ensureDshIntegration, inspectDshIntegration } from '../lib/integrations/dsh.mjs';

const hccBin = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-state-migration-'));
  const previousHome = process.env.HOME;
  const home = path.join(sandbox, 'home');
  const root = path.join(sandbox, 'project');
  const source = path.join(root, '.hello-cc');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(source, { mode: 0o700 });
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  return { sandbox, home, root, source, destination: () => privateProjectStateDir(root) };
}

function database(file, sql) {
  const db = new DatabaseSync(file);
  try { db.exec(sql); }
  finally { db.close(); }
}

function readCount(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Number(Object.values(db.prepare(`SELECT count(*) FROM ${table}`).get())[0]); }
  finally { db.close(); }
}

function offlineOptions() {
  return { confirmedOffline: true, assertOffline: () => true };
}

function assertNoCommittedOrStagedState(f) {
  const destination = f.destination();
  assert.equal(fs.existsSync(destination), false);
  const projects = path.dirname(destination);
  if (fs.existsSync(projects)) {
    assert.equal(fs.readdirSync(projects).some((name) => name.includes('.migration-')), false);
  }
}

test('explicit offline migration snapshots WAL and nested SQLite, keeps source untouched, and commits a private marker', (t) => {
  const f = fixture(t);
  const mesh = path.join(f.source, 'mesh.db');
  const seed = path.join(f.sandbox, 'seed.db');
  const writer = new DatabaseSync(seed);
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages(body) VALUES ('wal row')");
    assert.equal(fs.existsSync(`${seed}-wal`), true);
    fs.copyFileSync(seed, mesh);
    fs.copyFileSync(`${seed}-wal`, `${mesh}-wal`);
  } finally { writer.close(); }
  const native = path.join(f.source, 'native');
  const custom = path.join(f.source, 'plugins', 'nested');
  const bufs = path.join(f.source, 'bufs');
  fs.mkdirSync(native, { mode: 0o700 });
  fs.mkdirSync(path.dirname(custom), { mode: 0o700 });
  fs.mkdirSync(custom, { mode: 0o700 });
  fs.mkdirSync(bufs, { mode: 0o700 });
  database(path.join(native, 'state.db'), "CREATE TABLE deliveries (body TEXT); INSERT INTO deliveries VALUES ('native')");
  database(path.join(custom, 'extra.sqlite'), "CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (1),(2)");
  fs.writeFileSync(path.join(f.source, 'web.log'), 'legacy log\n', { mode: 0o600 });
  fs.writeFileSync(path.join(bufs, 'old.out'), 'terminal output', { mode: 0o600 });
  fs.writeFileSync(path.join(bufs, 'old.meta'), JSON.stringify({ wrapper_pid: 2147483647 }), { mode: 0o600 });
  fs.writeFileSync(path.join(f.source, 'runtime.json'), JSON.stringify({ pid: 2147483647, token: 'old' }), { mode: 0o600 });
  fs.writeFileSync(path.join(native, 'runtime.json'), JSON.stringify({ pid: 2147483647, token: 'old' }), { mode: 0o600 });
  const originalDb = fs.readFileSync(mesh);
  const originalWal = fs.readFileSync(`${mesh}-wal`);
  const originalListing = fs.readdirSync(f.source).sort();

  const result = migrateLegacyProjectState(f.root, offlineOptions());
  const destination = f.destination();
  assert.equal(result.stateDir, destination);
  assert.equal(result.databases, 3);
  assert.equal(result.omittedPointers, 2);
  assert.equal(readCount(path.join(destination, 'mesh.db'), 'messages'), 1);
  assert.equal(readCount(path.join(destination, 'native', 'state.db'), 'deliveries'), 1);
  assert.equal(readCount(path.join(destination, 'plugins', 'nested', 'extra.sqlite'), 'items'), 2);
  assert.equal(fs.readFileSync(path.join(destination, 'web.log'), 'utf8'), 'legacy log\n');
  assert.equal(fs.readFileSync(path.join(destination, 'bufs', 'old.out'), 'utf8'), 'terminal output');
  assert.equal(fs.existsSync(path.join(destination, 'runtime.json')), false);
  assert.equal(fs.existsSync(path.join(destination, 'native', 'runtime.json')), false);
  assert.equal(fs.existsSync(path.join(destination, '.sqlite-work')), false);
  assert.equal(fs.existsSync(path.join(destination, 'mesh.db-wal')), false);
  assert.equal(ensurePrivateProjectStateDir(f.root), destination);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(destination, 'mesh.db')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(destination, '.project-root.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.source).sort(), originalListing);
  assert.deepEqual(fs.readFileSync(mesh), originalDb);
  assert.deepEqual(fs.readFileSync(`${mesh}-wal`), originalWal);
});

test('offline migration targets B generation without touching historical private A', t => {
  const f = fixture(t);
  fs.rmSync(f.source, { recursive: true });
  fs.chmodSync(f.root, 0o777);
  const oldDir = ensurePrivateProjectStateDir(f.root, { create: true });
  fs.writeFileSync(path.join(oldDir, 'A-only'), 'preserved', { mode: 0o600 });
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o777 });
  fs.chmodSync(f.root, 0o777);
  fs.mkdirSync(f.source, { mode: 0o700 });
  database(path.join(f.source, 'mesh.db'),
    "CREATE TABLE b_data(value TEXT); INSERT INTO b_data VALUES ('B-only')");
  const next = provisionPrivateProjectGeneration(f.root);
  assert.equal(fs.existsSync(next), false);
  const result = migrateLegacyProjectState(f.root, offlineOptions());
  assert.equal(result.stateDir, next);
  assert.equal(readCount(path.join(next, 'mesh.db'), 'b_data'), 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(next, '.project-root.json'), 'utf8')).version, 2);
  assert.equal(fs.readFileSync(path.join(oldDir, 'A-only'), 'utf8'), 'preserved');
  assert.equal(fs.existsSync(path.join(oldDir, 'mesh.db')), false);
});

test('migration is fail-closed without both confirmation and caller offline assertion', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'web.log'), 'source');
  assert.throws(() => migrateLegacyProjectState(f.root), { code: 'STATE_MIGRATION_OFFLINE_REQUIRED' });
  assert.throws(() => migrateLegacyProjectState(f.root, { confirmedOffline: true }),
    { code: 'STATE_MIGRATION_OFFLINE_REQUIRED' });
  assert.throws(() => migrateLegacyProjectState(f.root, {
    confirmedOffline: true, assertOffline: () => false
  }), { code: 'STATE_MIGRATION_OFFLINE_REQUIRED' });
  assertNoCommittedOrStagedState(f);
});

test('live or unverified runtime and PTY pointers prevent commit', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'runtime.json'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => migrateLegacyProjectState(f.root, offlineOptions()), { code: 'STATE_MIGRATION_UNSAFE' });
  assertNoCommittedOrStagedState(f);
  fs.unlinkSync(path.join(f.source, 'runtime.json'));
  const bufs = path.join(f.source, 'bufs');
  fs.mkdirSync(bufs, { mode: 0o700 });
  fs.writeFileSync(path.join(bufs, 'unknown.meta'), '{}');
  assert.throws(() => migrateLegacyProjectState(f.root, offlineOptions()), { code: 'STATE_MIGRATION_UNSAFE' });
  assertNoCommittedOrStagedState(f);
});

test('symlinks, hardlinks, FIFOs, and orphaned WAL files are not migrated', (t) => {
  const f = fixture(t);
  const external = path.join(f.sandbox, 'external');
  fs.writeFileSync(external, 'do not read');
  const link = path.join(f.source, 'bad');
  fs.symlinkSync(external, link);
  assert.throws(() => migrateLegacyProjectState(f.root, offlineOptions()), { code: 'STATE_MIGRATION_UNSAFE' });
  fs.unlinkSync(link);
  fs.linkSync(external, link);
  assert.throws(() => migrateLegacyProjectState(f.root, offlineOptions()), { code: 'STATE_MIGRATION_UNSAFE' });
  fs.unlinkSync(link);
  const fifo = path.join(f.source, 'pipe');
  const mkfifo = spawnSync('mkfifo', [fifo]);
  if (!mkfifo.error && mkfifo.status === 0) {
    assert.throws(() => migrateLegacyProjectState(f.root, offlineOptions()), { code: 'STATE_MIGRATION_UNSAFE' });
    fs.unlinkSync(fifo);
  }
  fs.writeFileSync(path.join(f.source, 'missing.db-wal'), 'orphan');
  assert.throws(() => migrateLegacyProjectState(f.root, offlineOptions()), { code: 'STATE_MIGRATION_UNSAFE' });
  assertNoCommittedOrStagedState(f);
  assert.equal(fs.readFileSync(external, 'utf8'), 'do not read');
});

test('non-private legacy source and an existing destination are never overwritten', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.source, 0o755);
  assert.throws(() => migrateLegacyProjectState(f.root, offlineOptions()), { code: 'STATE_MIGRATION_UNSAFE' });
  assert.equal(fs.statSync(f.source).mode & 0o777, 0o755);
  fs.chmodSync(f.source, 0o700);
  const existing = f.destination();
  fs.mkdirSync(existing, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(existing, 'sentinel'), 'preserve');
  assert.throws(() => migrateLegacyProjectState(f.root, offlineOptions()), { code: 'STATE_MIGRATION_EXISTS' });
  assert.equal(fs.readFileSync(path.join(existing, 'sentinel'), 'utf8'), 'preserve');
});

test('verified legacy DSH artifacts are archived and setup can rebuild against the private path', (t) => {
  const f = fixture(t);
  const ctx = { root: f.root, cwd: f.root, json: false };
  const first = ensureDshIntegration(ctx, { hccBin, mode: 'hooks' });
  assert.equal(first.patchPath, path.join(fs.realpathSync(f.source), 'dsh', 'cordis.patch.yml'));
  const original = Object.fromEntries(['hooks.json', 'cordis.patch.yml', 'managed.json']
    .map((name) => [name, fs.readFileSync(path.join(f.source, 'dsh', name))]));

  const migrated = migrateLegacyProjectState(f.root, offlineOptions());
  assert.equal(migrated.dsh.mode, 'hooks');
  assert.equal(migrated.dsh.rebuildCommand, 'hcc dsh setup --mode hooks');
  assert.equal(inspectDshIntegration(ctx, { hccBin, mode: 'hooks' }).state, 'missing');
  for (const [name, bytes] of Object.entries(original)) {
    assert.deepEqual(fs.readFileSync(path.join(migrated.dsh.archivePath, name)), bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.source, 'dsh', name)), bytes);
  }
  const rebuilt = ensureDshIntegration(ctx, { hccBin, mode: 'hooks' });
  assert.equal(rebuilt.ready, true);
  assert.equal(inspectDshIntegration(ctx, { hccBin, mode: 'hooks' }).ready, true);
  const patch = fs.readFileSync(path.join(f.destination(), 'dsh', 'cordis.patch.yml'), 'utf8');
  assert.equal(JSON.parse(patch.match(/configPath: (.+)/)[1]), path.join(f.destination(), 'dsh', 'hooks.json'));
});

test('edited DSH managed artifacts abort migration without changing the legacy files', (t) => {
  const f = fixture(t);
  const ctx = { root: f.root, cwd: f.root, json: false };
  ensureDshIntegration(ctx, { hccBin, mode: 'cordis' });
  const patch = path.join(f.source, 'dsh', 'cordis.patch.yml');
  fs.appendFileSync(patch, '# custom edit\n');
  const original = fs.readFileSync(patch);
  assert.throws(() => migrateLegacyProjectState(f.root, offlineOptions()), { code: 'STATE_MIGRATION_UNSAFE' });
  assertNoCommittedOrStagedState(f);
  assert.deepEqual(fs.readFileSync(patch), original);
});
