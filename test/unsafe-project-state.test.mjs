import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const hcc = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
const migrationModule = fileURLToPath(new URL('../lib/runtime/state-migration.mjs', import.meta.url));
const privateStateModule = fileURLToPath(new URL('../lib/runtime/private-state.mjs', import.meta.url));

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-unsafe-root-'));
  const home = path.join(sandbox, 'home');
  const root = path.join(sandbox, 'shared-project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root, { mode: 0o777 });
  fs.chmodSync(root, 0o777);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const hash = createHash('sha256').update(fs.realpathSync(root)).digest('hex');
  return { sandbox, home, root, state: path.join(home, '.hello-cc', 'projects', hash) };
}

function run(f, args) {
  return spawnSync(process.execPath, [hcc, '--root', f.root, '--json', ...args], {
    cwd: f.root, env: { ...process.env, HOME: f.home, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8', timeout: 20000
  });
}

test('an arbitrary cross-UID-writable project keeps SQLite and sidecars in private user state', (t) => {
  const f = fixture(t);
  const result = run(f, ['init', '--no-guidance']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);
  assert.equal(fs.statSync(f.state).mode & 0o777, 0o700);
  const dbPath = path.join(f.state, 'mesh.db');
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'mesh.init'").get().count, 1);
  } finally { db.close(); }
  const attackerDirectory = path.join(f.sandbox, 'attacker');
  fs.mkdirSync(attackerDirectory);
  fs.symlinkSync(attackerDirectory, path.join(f.root, '.hello-cc'), 'dir');
  const status = run(f, ['status']);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.deepEqual(fs.readdirSync(attackerDirectory), []);
});

test('a private project beneath a replaceable ancestor also uses private state', (t) => {
  const f = fixture(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-unsafe-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.chmodSync(f.root, 0o700);
  fs.chmodSync(f.sandbox, 0o777);
  const selected = { ...f, home, state: path.join(home, '.hello-cc', 'projects',
    createHash('sha256').update(fs.realpathSync(f.root)).digest('hex')) };
  const result = run(selected, ['init', '--no-guidance']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);
  assert.equal(fs.existsSync(path.join(selected.state, 'mesh.db')), true);
});

test('a stable but unwritable directory remains selectable through private state', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const f = fixture(t);
  fs.chmodSync(f.root, 0o555);
  const result = run(f, ['init', '--no-guidance']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);
  assert.equal(fs.existsSync(path.join(f.state, 'mesh.db')), true);
});

test('an unsafe root with legacy state fails closed without creating an empty private database', (t) => {
  const f = fixture(t);
  const legacy = path.join(f.root, '.hello-cc');
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, 'mesh.db'), 'legacy-sentinel', { mode: 0o600 });
  const result = run(f, ['init', '--no-guidance']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /STATE_MIGRATION_REQUIRED|offline migration/i);
  assert.equal(fs.readFileSync(path.join(legacy, 'mesh.db'), 'utf8'), 'legacy-sentinel');
  assert.equal(fs.existsSync(f.state), false);
});

test('offline migration preserves legacy SQLite data and makes private state authoritative', (t) => {
  const f = fixture(t);
  const legacy = path.join(f.root, '.hello-cc');
  fs.mkdirSync(legacy, { mode: 0o700 });
  const oldDbPath = path.join(legacy, 'mesh.db');
  const oldDb = new DatabaseSync(oldDbPath);
  oldDb.exec("CREATE TABLE legacy_probe(value TEXT); INSERT INTO legacy_probe VALUES ('kept');");
  oldDb.close();
  const withoutConfirmation = run(f, ['migrate-state']);
  assert.notEqual(withoutConfirmation.status, 0);
  assert.equal(fs.existsSync(f.state), false);
  const migration = run(f, ['migrate-state', '--offline', '--yes']);
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);
  const newDb = new DatabaseSync(path.join(f.state, 'mesh.db'), { readOnly: true });
  try { assert.equal(newDb.prepare('SELECT value FROM legacy_probe').get().value, 'kept'); }
  finally { newDb.close(); }
  assert.equal(fs.existsSync(oldDbPath), true);
  const status = run(f, ['init', '--no-guidance']);
  assert.equal(status.status, 0, status.stderr || status.stdout);
});

test('offline CLI migration rebuilds DSH configuration for the private state path', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o700);
  for (const args of [['init', '--no-guidance'], ['dsh', 'setup', '--mode', 'hooks']]) {
    const result = run(f, args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const legacyDsh = path.join(f.root, '.hello-cc', 'dsh');
  const oldPatch = fs.readFileSync(path.join(legacyDsh, 'cordis.patch.yml'), 'utf8');
  assert.match(oldPatch, /\.hello-cc\/dsh\/hooks\.json/);
  fs.chmodSync(f.root, 0o777);
  const migration = run(f, ['migrate-state', '--offline', '--yes']);
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);
  const newDsh = path.join(f.state, 'dsh');
  const newPatch = fs.readFileSync(path.join(newDsh, 'cordis.patch.yml'), 'utf8');
  assert.match(newPatch, /\.hello-cc\/projects\//);
  assert.doesNotMatch(newPatch, /shared-project\/\.hello-cc\/dsh/);
  assert.equal(fs.existsSync(path.join(legacyDsh, 'managed.json')), true);
  assert.equal(fs.readdirSync(newDsh).some((name) => name.startsWith('.legacy-managed-')), true);
});

test('a removed migrated store cannot silently reactivate the retained legacy database', (t) => {
  const f = fixture(t);
  const legacy = path.join(f.root, '.hello-cc');
  fs.mkdirSync(legacy, { mode: 0o700 });
  const oldDbPath = path.join(legacy, 'mesh.db');
  const oldDb = new DatabaseSync(oldDbPath);
  oldDb.exec("CREATE TABLE legacy_probe(value TEXT); INSERT INTO legacy_probe VALUES ('old');");
  oldDb.close();
  const migration = run(f, ['migrate-state', '--offline', '--yes']);
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);
  assert.equal(fs.existsSync(`${f.state}.authority.json`), true);
  fs.chmodSync(f.root, 0o700);
  fs.rmSync(f.state, { recursive: true });
  const retry = run(f, ['init', '--no-guidance']);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr + retry.stdout, /STATE_AUTHORITY_MISSING|previously migrated private project state/i);
  assert.equal(fs.existsSync(f.state), false);
  const source = new DatabaseSync(oldDbPath, { readOnly: true });
  try { assert.equal(source.prepare('SELECT value FROM legacy_probe').get().value, 'old'); }
  finally { source.close(); }
  const recovery = run(f, ['migrate-state', '--offline', '--yes']);
  assert.equal(recovery.status, 0, recovery.stderr || recovery.stdout);
  const recovered = new DatabaseSync(path.join(f.state, 'mesh.db'), { readOnly: true });
  try { assert.equal(recovered.prepare('SELECT value FROM legacy_probe').get().value, 'old'); }
  finally { recovered.close(); }
});

test('fresh private state remains authoritative after its directory is lost and the root becomes stable', (t) => {
  const f = fixture(t);
  const init = run(f, ['init', '--no-guidance']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const marker = `${f.state}.authority.json`;
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).kind, 'fresh');
  fs.rmSync(f.state, { recursive: true });
  fs.chmodSync(f.root, 0o700);
  const legacy = path.join(f.root, '.hello-cc');
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, 'mesh.db'), 'old-writer-sentinel', { mode: 0o600 });
  const retry = run(f, ['init', '--no-guidance']);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr + retry.stdout, /STATE_AUTHORITY_MISSING|private project state is missing/i);
  assert.equal(fs.readFileSync(path.join(legacy, 'mesh.db'), 'utf8'), 'old-writer-sentinel');
  assert.equal(fs.existsSync(f.state), false);
});

test('purge keeps private authority and permits a fresh init only after legacy data is gone', (t) => {
  const f = fixture(t);
  const legacy = path.join(f.root, '.hello-cc');
  fs.mkdirSync(legacy, { mode: 0o700 });
  const sourceDb = new DatabaseSync(path.join(legacy, 'mesh.db'));
  sourceDb.exec('CREATE TABLE old_data(value TEXT)');
  sourceDb.close();
  const migration = run(f, ['migrate-state', '--offline', '--yes']);
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);
  const purge = run(f, ['uninstall', '--purge', '--yes']);
  assert.equal(purge.status, 0, purge.stderr || purge.stdout);
  assert.equal(fs.existsSync(f.state), false);
  assert.equal(JSON.parse(fs.readFileSync(`${f.state}.authority.json`, 'utf8')).kind, 'reset');
  assert.equal(fs.existsSync(path.join(legacy, 'mesh.db')), true);
  const blocked = run(f, ['init', '--no-guidance']);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr + blocked.stdout, /STATE_MIGRATION_REQUIRED|offline migration/i);
  fs.rmSync(legacy, { recursive: true });
  const fresh = run(f, ['init', '--no-guidance']);
  assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
  assert.equal(fs.existsSync(path.join(f.state, 'mesh.db')), true);
  assert.equal(JSON.parse(fs.readFileSync(`${f.state}.authority.json`, 'utf8')).kind, 'fresh');
});

test('purge explicitly resets an already missing private store', (t) => {
  const f = fixture(t);
  const init = run(f, ['init', '--no-guidance']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  fs.rmSync(f.state, { recursive: true });
  const blocked = run(f, ['init', '--no-guidance']);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr + blocked.stdout, /STATE_AUTHORITY_MISSING|private project state is missing/i);
  const purge = run(f, ['uninstall', '--purge', '--yes']);
  assert.equal(purge.status, 0, purge.stderr || purge.stdout);
  assert.equal(JSON.parse(fs.readFileSync(`${f.state}.authority.json`, 'utf8')).kind, 'reset');
  const fresh = run(f, ['init', '--no-guidance']);
  assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
  assert.equal(fs.existsSync(path.join(f.state, 'mesh.db')), true);
});

test('interrupted purge cannot reactivate partially deleted state and an explicit retry completes it', (t) => {
  const f = fixture(t);
  const init = run(f, ['init', '--no-guidance']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const marker = `${f.state}.authority.json`;
  const authority = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.writeFileSync(marker, JSON.stringify({ ...authority, kind: 'purging' }), { mode: 0o600 });
  fs.rmSync(path.join(f.state, '.project-root.json'));
  const blocked = run(f, ['status']);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr + blocked.stdout, /STATE_PURGE_INCOMPLETE|purge is incomplete/i);
  assert.equal(fs.existsSync(path.join(f.state, 'mesh.db')), true);
  const retry = run(f, ['uninstall', '--purge', '--yes']);
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.equal(fs.existsSync(f.state), false);
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).kind, 'reset');
});

test('a reset marker with leftover private data also requires an explicit purge retry', (t) => {
  const f = fixture(t);
  const init = run(f, ['init', '--no-guidance']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const marker = `${f.state}.authority.json`;
  const authority = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.writeFileSync(marker, JSON.stringify({ ...authority, kind: 'reset' }), { mode: 0o600 });
  const blocked = run(f, ['status']);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr + blocked.stdout, /STATE_PURGE_INCOMPLETE|purge is incomplete/i);
  const retry = run(f, ['uninstall', '--purge', '--yes']);
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.equal(fs.existsSync(f.state), false);
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).kind, 'reset');
});

test('same-path root replacement cannot silently rebind or purge the prior inode state', (t) => {
  const f = fixture(t);
  const init = run(f, ['init', '--no-guidance']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const marker = `${f.state}.authority.json`;
  const original = fs.readFileSync(marker, 'utf8');
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o777 });
  fs.chmodSync(f.root, 0o777);
  const blocked = run(f, ['uninstall', '--purge', '--yes']);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr + blocked.stdout, /PROJECT_PATH_FORBIDDEN|authority marker differs/i);
  assert.equal(fs.readFileSync(marker, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.state, 'mesh.db')), true);
});

test('concurrent private purge waits for migration commit and leaves reset authority', async (t) => {
  const f = fixture(t);
  const legacy = path.join(f.root, '.hello-cc');
  fs.mkdirSync(legacy, { mode: 0o700 });
  const source = new DatabaseSync(path.join(legacy, 'mesh.db'));
  source.exec("CREATE TABLE old_data(value TEXT); INSERT INTO old_data VALUES ('kept');");
  source.close();
  const signal = path.join(f.sandbox, 'migration-before-rename');
  const release = path.join(f.sandbox, 'release-migration');
  const purgeStarted = path.join(f.sandbox, 'purge-started');
  const migrationCode = `
    import fs from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const destinationName = ${JSON.stringify(path.basename(f.state))};
    const signal = ${JSON.stringify(signal)};
    const release = ${JSON.stringify(release)};
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (target.endsWith('/' + destinationName) && source.includes('.migration-')) {
        fs.writeFileSync(signal, 'ready');
        const start = Date.now();
        while (!fs.existsSync(release) && Date.now() - start < 10000) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
        if (!fs.existsSync(release)) throw new Error('migration release timed out');
      }
      return rename(source, target);
    };
    const { migrateLegacyProjectState } = await import(pathToFileURL(${JSON.stringify(migrationModule)}).href);
    migrateLegacyProjectState(${JSON.stringify(f.root)}, {
      confirmedOffline: true, assertOffline: () => true
    });
  `;
  const migrant = spawn(process.execPath, ['--input-type=module', '-e', migrationCode], {
    env: { ...process.env, HOME: f.home, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let migrationError = '';
  let migrationOutput = '';
  migrant.stderr.on('data', (chunk) => { migrationError += chunk; });
  migrant.stdout.on('data', (chunk) => { migrationOutput += chunk; });
  const migrantDone = new Promise((resolve) => migrant.on('close', resolve));
  let purge = null;
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(signal) && migrant.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(signal), true,
      migrationError || migrationOutput || `migration did not reach commit (exit ${migrant.exitCode})`);
    const purgeCode = `
      import fs from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const { purgePrivateProjectState } = await import(pathToFileURL(${JSON.stringify(privateStateModule)}).href);
      fs.writeFileSync(${JSON.stringify(purgeStarted)}, 'ready');
      purgePrivateProjectState(${JSON.stringify(f.root)});
    `;
    purge = spawn(process.execPath, ['--input-type=module', '-e', purgeCode], {
      env: { ...process.env, HOME: f.home, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let purgeOutput = '';
    purge.stdout.on('data', (chunk) => { purgeOutput += chunk; });
    purge.stderr.on('data', (chunk) => { purgeOutput += chunk; });
    const purgeDone = new Promise((resolve) => purge.on('close', resolve));
    const purgeDeadline = Date.now() + 10000;
    while (!fs.existsSync(purgeStarted) && purge.exitCode === null && Date.now() < purgeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(purgeStarted), true, purgeOutput || 'purge did not start');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(purge.exitCode, null, 'purge must still be waiting for migration');
    assert.equal(JSON.parse(fs.readFileSync(`${f.state}.authority.json`, 'utf8')).kind, 'migrated');
    fs.writeFileSync(release, 'go');
    assert.equal(await migrantDone, 0, migrationError);
    assert.equal(await purgeDone, 0, purgeOutput);
    assert.equal(fs.existsSync(f.state), false);
    assert.equal(JSON.parse(fs.readFileSync(`${f.state}.authority.json`, 'utf8')).kind, 'reset');
    assert.equal(fs.existsSync(path.join(legacy, 'mesh.db')), true);
  } finally {
    if (!fs.existsSync(release)) fs.writeFileSync(release, 'go');
    if (migrant.exitCode === null) migrant.kill();
    if (purge && purge.exitCode === null) purge.kill();
  }
});

test('a pending marker with an empty private directory completes initialization after interruption', (t) => {
  const f = fixture(t);
  const projects = path.dirname(f.state);
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  fs.mkdirSync(f.state, { mode: 0o700 });
  const stat = fs.statSync(f.root, { bigint: true });
  fs.writeFileSync(`${f.state}.authority.json`, JSON.stringify({
    version: 2, canonicalRoot: fs.realpathSync(f.root),
    dev: stat.dev.toString(), ino: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(), kind: 'pending'
  }), { mode: 0o600 });
  const init = run(f, ['init', '--no-guidance']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.equal(fs.existsSync(path.join(f.state, '.project-root.json')), true);
  assert.equal(JSON.parse(fs.readFileSync(`${f.state}.authority.json`, 'utf8')).kind, 'fresh');
});

test('an interrupted pending init can be explicitly purged without deleting a later legacy source', (t) => {
  const f = fixture(t);
  const legacy = path.join(f.root, '.hello-cc');
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, 'mesh.db'), 'legacy-sentinel', { mode: 0o600 });
  fs.mkdirSync(f.state, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(f.root, { bigint: true });
  fs.writeFileSync(`${f.state}.authority.json`, JSON.stringify({
    version: 2, canonicalRoot: fs.realpathSync(f.root),
    dev: stat.dev.toString(), ino: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(), kind: 'pending'
  }), { mode: 0o600 });
  const blocked = run(f, ['init', '--no-guidance']);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr + blocked.stdout, /STATE_MIGRATION_REQUIRED|offline migration/i);
  const purge = run(f, ['uninstall', '--purge', '--yes']);
  assert.equal(purge.status, 0, purge.stderr || purge.stdout);
  assert.equal(fs.existsSync(f.state), false);
  assert.equal(JSON.parse(fs.readFileSync(`${f.state}.authority.json`, 'utf8')).kind, 'reset');
  assert.equal(fs.readFileSync(path.join(legacy, 'mesh.db'), 'utf8'), 'legacy-sentinel');
});

test('a pending marker on valid private data is promoted before read-only use', (t) => {
  const f = fixture(t);
  const init = run(f, ['init', '--no-guidance']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const marker = `${f.state}.authority.json`;
  const authority = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.writeFileSync(marker, JSON.stringify({ ...authority, kind: 'pending' }), { mode: 0o600 });
  const status = run(f, ['status']);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).kind, 'fresh');
  fs.rmSync(f.state, { recursive: true });
  const retry = run(f, ['init', '--no-guidance']);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr + retry.stdout, /STATE_AUTHORITY_MISSING|private project state is missing/i);
});
