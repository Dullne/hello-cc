import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createContext } from '../lib/cli-runtime.mjs';
import { createConnectionHelpers } from '../lib/db/connection.mjs';
import { ensurePrivateProjectBufferDirectory, resolveProjectDatabase } from '../lib/runtime/project-path.mjs';
import { createExternalSessions } from '../lib/web/external-sessions.mjs';

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

test('managed SQLite refuses preexisting symlink or cross-user-writable sidecars', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.state, { mode: 0o700 });
  const initial = new DatabaseSync(f.db);
  initial.exec('CREATE TABLE preserved (value TEXT)');
  initial.close();
  const outside = path.join(f.sandbox, 'outside');
  fs.writeFileSync(outside, 'sentinel', { mode: 0o600 });
  const { connect, connectReadOnly } = createConnectionHelpers({ now: () => 1,
    dedupePeerBindings() {}, redactedLogText: value => value });
  const wal = `${f.db}-wal`;
  fs.symlinkSync(outside, wal);
  assert.throws(() => connect({ root: f.root, dbPath: f.db }, { migrateRegistered: false }),
    { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.throws(() => connectReadOnly({ root: f.root, dbPath: f.db }),
    { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel');
  fs.unlinkSync(wal);
  fs.writeFileSync(wal, 'attacker-controlled', { mode: 0o600 });
  fs.chmodSync(wal, 0o666);
  assert.throws(() => connect({ root: f.root, dbPath: f.db }, { migrateRegistered: false }),
    { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(fs.statSync(wal).mode & 0o777, 0o666);
});

test('managed SQLite tolerates an optional sidecar removed between path checks', (t) => {
  const f = fixture(t);
  runCli(f, ['init', '--no-guidance']);
  const sidecar = `${f.db}-shm`;
  fs.writeFileSync(sidecar, 'retiring sidecar', { mode: 0o600 });
  const checkedSidecar = fs.realpathSync.native(sidecar);
  const lstat = fs.lstatSync.bind(fs);
  let observations = 0;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === checkedSidecar && ++observations === 2) {
      fs.unlinkSync(sidecar);
      throw Object.assign(new Error('sidecar removed before recheck'), { code: 'ENOENT' });
    }
    return lstat(file, ...args);
  });
  const { connectReadOnly } = createConnectionHelpers({ now: () => 1,
    dedupePeerBindings() {}, redactedLogText: value => value });
  const reader = connectReadOnly({ root: f.root, dbPath: f.db });
  try { assert.equal(reader.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
  finally { reader.close(); }
  assert.equal(observations, 3);
});

test('managed SQLite tolerates a sidecar removed during its ACL check', (t) => {
  const f = fixture(t);
  runCli(f, ['init', '--no-guidance']);
  const sidecar = `${f.db}-shm`;
  fs.writeFileSync(sidecar, 'retiring sidecar', { mode: 0o600 });
  const checkedSidecar = fs.realpathSync.native(sidecar);
  const lstat = fs.lstatSync.bind(fs);
  let removed = false;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    const stat = lstat(file, ...args);
    if (file === checkedSidecar && !removed) {
      removed = true;
      fs.unlinkSync(sidecar);
    }
    return stat;
  });
  const { connectReadOnly } = createConnectionHelpers({ now: () => 1,
    dedupePeerBindings() {}, redactedLogText: value => value });
  const reader = connectReadOnly({ root: f.root, dbPath: f.db });
  try { assert.equal(reader.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
  finally { reader.close(); }
  assert.equal(removed, true);
});

test('managed SQLite rejects a sidecar rebuilt after a path check reports it missing', (t) => {
  const f = fixture(t);
  runCli(f, ['init', '--no-guidance']);
  const sidecar = `${f.db}-shm`;
  const retired = `${sidecar}.retired`;
  fs.writeFileSync(sidecar, 'original sidecar', { mode: 0o600 });
  const checkedSidecar = fs.realpathSync.native(sidecar);
  const lstat = fs.lstatSync.bind(fs);
  let observations = 0;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === checkedSidecar && ++observations === 2) {
      fs.renameSync(sidecar, retired);
      fs.writeFileSync(sidecar, 'rebuilt sidecar', { mode: 0o600 });
      throw Object.assign(new Error('original sidecar removed before recheck'), { code: 'ENOENT' });
    }
    return lstat(file, ...args);
  });
  const { connectReadOnly } = createConnectionHelpers({ now: () => 1,
    dedupePeerBindings() {}, redactedLogText: value => value });
  assert.throws(() => connectReadOnly({ root: f.root, dbPath: f.db }), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(observations, 3);
  assert.equal(fs.readFileSync(retired, 'utf8'), 'original sidecar');
  assert.equal(fs.readFileSync(sidecar, 'utf8'), 'rebuilt sidecar');
});

test('managed SQLite tolerates an optional sidecar removed while tightening its permissions', (t) => {
  const f = fixture(t);
  runCli(f, ['init', '--no-guidance']);
  const sidecar = `${f.db}-journal`;
  fs.writeFileSync(sidecar, 'retiring sidecar', { mode: 0o644 });
  const checkedSidecar = fs.realpathSync.native(sidecar);
  const chmod = fs.chmodSync.bind(fs);
  let removed = false;
  t.mock.method(fs, 'chmodSync', (file, ...args) => {
    if (file === checkedSidecar && !removed) {
      removed = true;
      fs.unlinkSync(sidecar);
      throw Object.assign(new Error('sidecar removed before chmod'), { code: 'ENOENT' });
    }
    return chmod(file, ...args);
  });
  const { connect } = createConnectionHelpers({ now: () => 1,
    dedupePeerBindings() {}, redactedLogText: value => value });
  const reader = connect({ root: f.root, dbPath: f.db }, { migrateRegistered: false });
  try { assert.equal(reader.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
  finally { reader.close(); }
  assert.equal(removed, true);
  assert.equal(fs.existsSync(sidecar), false);
});

test('managed SQLite rejects an optional sidecar replaced between path checks', (t) => {
  const f = fixture(t);
  runCli(f, ['init', '--no-guidance']);
  const sidecar = `${f.db}-shm`;
  const retired = `${sidecar}.retired`;
  fs.writeFileSync(sidecar, 'original sidecar', { mode: 0o600 });
  const checkedSidecar = fs.realpathSync.native(sidecar);
  const lstat = fs.lstatSync.bind(fs);
  let observations = 0;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === checkedSidecar && ++observations === 2) {
      fs.renameSync(sidecar, retired);
      fs.writeFileSync(sidecar, 'new sidecar', { mode: 0o600 });
    }
    return lstat(file, ...args);
  });
  const { connectReadOnly } = createConnectionHelpers({ now: () => 1,
    dedupePeerBindings() {}, redactedLogText: value => value });
  assert.throws(() => connectReadOnly({ root: f.root, dbPath: f.db }), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(observations, 2);
  assert.equal(fs.readFileSync(retired, 'utf8'), 'original sidecar');
  assert.equal(fs.readFileSync(sidecar, 'utf8'), 'new sidecar');
});

test('managed SQLite never treats a vanished main database as an optional sidecar', (t) => {
  const f = fixture(t);
  runCli(f, ['init', '--no-guidance']);
  const checkedDb = fs.realpathSync.native(f.db);
  const lstat = fs.lstatSync.bind(fs);
  let observations = 0;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === checkedDb && ++observations === 3) {
      fs.unlinkSync(f.db);
      throw Object.assign(new Error('database removed before recheck'), { code: 'ENOENT' });
    }
    return lstat(file, ...args);
  });
  const { connectReadOnly } = createConnectionHelpers({ now: () => 1,
    dedupePeerBindings() {}, redactedLogText: value => value });
  assert.throws(() => connectReadOnly({ root: f.root, dbPath: f.db }));
  assert.equal(observations, 3);
  assert.equal(fs.existsSync(f.db), false);
});

test('managed connection validation never opens an existing SQLite file outside SQLite', (t) => {
  const f = fixture(t);
  const { connect } = createConnectionHelpers({ now: () => 1,
    dedupePeerBindings() {}, redactedLogText: value => value });
  const ctx = { root: f.root, dbPath: f.db };
  const first = connect(ctx, { migrateRegistered: false });
  try {
    const sqliteFiles = new Set([f.db, `${f.db}-wal`, `${f.db}-shm`].map(file => fs.realpathSync.native(file)));
    const open = fs.openSync.bind(fs);
    t.mock.method(fs, 'openSync', (file, ...args) => {
      if (sqliteFiles.has(file)) throw new Error(`native open of live SQLite file: ${file}`);
      return open(file, ...args);
    });
    const second = connect(ctx, { migrateRegistered: false });
    try {
      first.exec('CREATE TABLE IF NOT EXISTS validation_probe (value INTEGER)');
      second.exec('INSERT INTO validation_probe VALUES (1)');
      assert.equal(first.prepare('SELECT COUNT(*) AS count FROM validation_probe').get().count, 1);
    } finally { second.close(); }
  } finally { first.close(); }
});

test('managed connection closes a newly opened database when schema initialization fails', (t) => {
  const f = fixture(t);
  let opened = null;
  const { connect } = createConnectionHelpers({ now: () => 1,
    dedupePeerBindings(db) {
      opened = db;
      throw new Error('schema callback failed');
    },
    redactedLogText: value => value
  });
  assert.throws(() => connect({ root: f.root, dbPath: f.db }, { migrateRegistered: false }),
    /schema callback failed/);
  assert.ok(opened);
  assert.equal(opened.isOpen, false);
});

test('native close of WAL sidecar drops POSIX locks but managed validation preserves them', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX advisory locks only');
  const f = fixture(t);
  fs.mkdirSync(f.state, { mode: 0o700 });
  const writer = new DatabaseSync(f.db);
  const contenderScript = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1], { timeout: 0 });
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK;');
      process.stdout.write('acquired');
    } catch (error) {
      process.stderr.write(String(error?.message || error));
      process.exitCode = 1;
    } finally { db.close(); }
  `;
  const contend = () => spawnSync(process.execPath,
    ['--input-type=module', '-e', contenderScript, f.db], { encoding: 'utf8', timeout: 10000 });
  try {
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE lock_probe (value INTEGER); BEGIN IMMEDIATE;');
    const { connectReadOnly } = createConnectionHelpers({ now: () => 1,
      dedupePeerBindings() {}, redactedLogText: value => value });
    const reader = connectReadOnly({ root: f.root, dbPath: f.db });
    reader.close();
    const protectedResult = contend();
    assert.equal(protectedResult.status, 1, protectedResult.stderr || protectedResult.stdout);
    assert.match(protectedResult.stderr, /locked|busy/i);

    const fd = fs.openSync(`${f.db}-shm`, fs.constants.O_RDONLY);
    fs.closeSync(fd);
    const brokenResult = contend();
    assert.equal(brokenResult.status, 0, brokenResult.stderr || brokenResult.stdout);
    assert.equal(brokenResult.stdout, 'acquired');
  } finally {
    try { writer.exec('ROLLBACK'); } catch {}
    writer.close();
  }
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

test('a root alias repointed from A to B cannot reopen A private state as an external database', (t) => {
  const f = fixture(t);
  const rootA = path.join(f.sandbox, 'a');
  const rootB = path.join(f.sandbox, 'b');
  const alias = path.join(f.sandbox, 'current');
  for (const root of [rootA, rootB]) {
    fs.mkdirSync(root);
    fs.chmodSync(root, 0o777); // Force private state instead of project-local state.
  }
  fs.symlinkSync(rootA, alias, 'dir');
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const created = createContext({ root: alias }, { cwd: alias, detectRoot: () => alias });
  // Keep a lexical-root context even if CLI context construction later pins
  // aliases: other callers can still supply this combination to connect().
  const ctx = { ...created, root: alias };
  assert.ok(ctx.dbPath.startsWith(path.join(fs.realpathSync.native(f.home), '.hello-cc', 'projects') + path.sep));
  const { connect, connectReadOnly } = createConnectionHelpers({ now: () => 1,
    dedupePeerBindings() {}, redactedLogText: value => value });
  const original = connect(ctx, { migrateRegistered: false });
  original.close();
  const oldDb = ctx.dbPath;

  fs.unlinkSync(alias);
  fs.symlinkSync(rootB, alias, 'dir');
  assert.throws(() => connect(ctx, { create: false, migrateRegistered: false }),
    { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.throws(() => connectReadOnly(ctx), { code: 'PROJECT_PATH_FORBIDDEN' });
  const externalSymlink = path.join(f.sandbox, 'external-alias.db');
  fs.symlinkSync(oldDb, externalSymlink);
  assert.throws(() => connectReadOnly({ ...ctx, dbPath: externalSymlink }),
    { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(fs.existsSync(oldDb), true);
});

test('a root alias repointed from A to B cannot reopen A project-local state as an external database', (t) => {
  const f = fixture(t);
  const rootA = path.join(f.sandbox, 'stable-a');
  const rootB = path.join(f.sandbox, 'stable-b');
  const alias = path.join(f.sandbox, 'stable-current');
  fs.mkdirSync(rootA, { mode: 0o700 });
  fs.mkdirSync(rootB, { mode: 0o700 });
  fs.symlinkSync(rootA, alias, 'dir');
  const created = createContext({ root: alias }, { cwd: alias, detectRoot: () => alias });
  const ctx = { ...created, root: alias };
  assert.equal(ctx.dbPath, path.join(fs.realpathSync.native(rootA), '.hello-cc', 'mesh.db'));
  const { connect, connectReadOnly } = createConnectionHelpers({ now: () => 1,
    dedupePeerBindings() {}, redactedLogText: value => value });
  const original = connect(ctx, { migrateRegistered: false });
  original.close();
  const oldDb = ctx.dbPath;

  fs.unlinkSync(alias);
  fs.symlinkSync(rootB, alias, 'dir');
  assert.throws(() => connect(ctx, { create: false, migrateRegistered: false }),
    { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.throws(() => connectReadOnly(ctx), { code: 'PROJECT_PATH_FORBIDDEN' });
  assert.equal(fs.existsSync(oldDb), true);
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

test('external adoption rejects weak old leaves and accepts newly private bridge files', (t) => {
  const f = fixture(t);
  const bufs = path.join(f.state, 'bufs');
  fs.mkdirSync(bufs, { recursive: true, mode: 0o755 });
  fs.chmodSync(f.state, 0o755);
  fs.chmodSync(bufs, 0o755);
  const legacyFiles = ['in', 'out', 'resize', 'meta'].map(suffix => path.join(bufs, `legacy.${suffix}`));
  for (const file of legacyFiles) fs.writeFileSync(file, file.endsWith('.meta')
    ? JSON.stringify({ id: 'legacy', generation: 'legacy-generation', wrapper_pid: process.pid })
    : 'old data');
  for (const file of legacyFiles) fs.chmodSync(file, 0o644);

  const outside = path.join(f.sandbox, 'outside');
  fs.writeFileSync(outside, 'outside data', { mode: 0o644 });
  fs.linkSync(outside, path.join(bufs, 'linked.out'));
  fs.writeFileSync(path.join(bufs, 'linked.meta'), JSON.stringify({ id: 'linked', generation: 'linked-generation' }));
  fs.symlinkSync(outside, path.join(bufs, 'symlink.out'));
  fs.writeFileSync(path.join(bufs, 'symlink.meta'), JSON.stringify({ id: 'symlink', generation: 'symlink-generation' }));

  const alias = path.join(f.sandbox, 'project-alias');
  fs.symlinkSync(f.root, alias, 'dir');
  const ctx = { root: alias, dbPath: path.join(alias, '.hello-cc', 'mesh.db') };
  const sessions = new Map();
  const runtime = createExternalSessions({
    ctx, sessions, sessionKey: (_project, id) => id,
    broadcast() {}, now: () => 1, tx() {}, connectWebProject() { throw new Error('unexpected database access'); },
    runtimeProjectContexts: () => [ctx], refreshPeerIoHeartbeat() {},
    redactedLogText: value => value, BUFS_DIR_NAME: 'bufs'
  });
  t.after(() => {
    clearInterval(runtime.externalScanPoller);
    clearInterval(runtime.bufsWatcherSyncPoller);
    for (const watcher of runtime.bufsWatchers.values()) watcher.close();
    for (const session of sessions.values()) {
      clearInterval(session.outputPoller);
      clearInterval(session.exitPoller);
      if (session.outputFd !== null) fs.closeSync(session.outputFd);
    }
  });

  assert.equal(mode(f.state), 0o700);
  assert.equal(mode(bufs), 0o700);
  for (const file of legacyFiles) assert.equal(mode(file), 0o644, file);
  assert.equal(sessions.has('legacy'), false);
  assert.equal(sessions.has('linked'), false);
  assert.equal(sessions.has('symlink'), false);
  assert.equal(mode(outside), 0o644);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside data');
  for (const file of legacyFiles) {
    const content = fs.readFileSync(file);
    fs.unlinkSync(file);
    fs.writeFileSync(file, content, { mode: 0o600 });
  }
  runtime.adoptExternalSession('legacy', ctx, path.join(alias, '.hello-cc', 'bufs'));
  assert.equal(sessions.has('legacy'), true);
  const firstSession = sessions.get('legacy');
  clearInterval(firstSession.outputPoller);
  clearInterval(firstSession.exitPoller);
  if (firstSession.outputFd !== null) fs.closeSync(firstSession.outputFd);
  sessions.delete('legacy');
  runtime.adoptExternalSession('legacy', ctx, path.join(alias, '.hello-cc', 'bufs'));
  assert.equal(sessions.has('legacy'), true);
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
