import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrateLegacyProjectState } from '../lib/runtime/state-migration.mjs';
import { privateProjectStateDir, ensurePrivateProjectStateDir, inspectPrivateProjectAuthority, provisionPrivateProjectGeneration } from '../lib/runtime/private-state.mjs';
import { createWindowsPrivateDirectory } from '../lib/platform/windows-private-state.mjs';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

const windows = { skip: process.platform !== 'win32' };
const offline = { confirmedOffline: true, assertOffline: () => true };
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-win-state-migration-'));
  const previous = Object.fromEntries(['HOME', 'USERPROFILE', 'HCC_SKIP_SHIM_INSTALL'].map(k => [k, process.env[k]]));
  const home = path.join(base, 'home'), root = path.join(base, 'project');
  fs.mkdirSync(home); fs.mkdirSync(root);
  process.env.HOME = process.env.USERPROFILE = home; process.env.HCC_SKIP_SHIM_INSTALL = '1';
  const source = path.join(root, '.hello-cc'); createWindowsPrivateDirectory(source);
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, home, root, source, destination: () => privateProjectStateDir(root) };
}
function seed(file, sql) { const db = new DatabaseSync(file); try { db.exec(sql); } finally { db.close(); } }
function query(file, sql) { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } }
function inventory(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name); return [name, fs.statSync(file).isDirectory() ? inventory(file) : fs.readFileSync(file).toString('base64')];
  }));
}

test('Windows offline migration preserves WAL rows, large database history and source bytes with a private v3 binding', windows, t => {
  const f = fixture(t), seedPath = path.join(f.base, 'seed.db');
  const db = new DatabaseSync(seedPath);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES('wal message');");
    fs.copyFileSync(seedPath, path.join(f.source, 'mesh.db'));
    fs.copyFileSync(seedPath + '-wal', path.join(f.source, 'mesh.db-wal'));
  } finally { db.close(); }
  fs.mkdirSync(path.join(f.source, 'native'));
  seed(path.join(f.source, 'native', 'state.db'), "CREATE TABLE tasks(id INTEGER, bytes BLOB); INSERT INTO tasks VALUES(1, zeroblob(12582912));");
  fs.writeFileSync(path.join(f.source, 'runtime.json'), JSON.stringify({ pid: 2147483647 }));
  fs.writeFileSync(path.join(f.source, 'HCC.md'), 'saved guidance');
  const before = inventory(f.source);
  const result = migrateLegacyProjectState(f.root, offline);
  assert.equal(result.stateDir, f.destination()); assert.equal(result.databases, 2); assert.equal(result.omittedPointers, 1);
  assert.equal(query(path.join(result.stateDir, 'mesh.db'), 'SELECT body FROM messages')[0].body, 'wal message');
  assert.equal(query(path.join(result.stateDir, 'native', 'state.db'), 'SELECT length(bytes) AS n FROM tasks')[0].n, 12582912);
  assert.equal(fs.existsSync(path.join(result.stateDir, 'mesh.db-wal')), false);
  assert.equal(fs.existsSync(path.join(result.stateDir, 'runtime.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.stateDir, '.project-root.json'))).version, 3);
  assert.equal(inspectPrivateProjectAuthority(f.root), 'migrated');
  assert.equal(ensurePrivateProjectStateDir(f.root), result.stateDir);
  assert.equal(loadWindowsNative().inspectPathSecurity(path.join(result.stateDir, 'mesh.db')).private, true);
  assert.deepEqual(inventory(f.source), before);
  assert.throws(() => migrateLegacyProjectState(f.root, offline), { code: 'STATE_MIGRATION_EXISTS' });
});

test('Windows offline migration preserves SQLite state when scratch and destination paths exceed MAX_PATH', windows, t => {
  const f = fixture(t);
  const home = path.join(f.home, 'p'.repeat(Math.max(16, 190 - f.home.length - 1)));
  fs.mkdirSync(home);
  process.env.HOME = process.env.USERPROFILE = home;
  const source = path.join(f.source, 'mesh.db');
  seed(source, "CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES('long-path history');");
  const before = inventory(f.source);
  assert.ok(path.join(f.destination(), 'mesh.db').length > 260);
  const result = migrateLegacyProjectState(f.root, offline);
  assert.equal(result.stateDir, f.destination());
  assert.equal(result.databases, 1);
  const target = path.join(result.stateDir, 'mesh.db');
  const db = new DatabaseSync(path.toNamespacedPath(target), { readOnly: true });
  try { assert.equal(db.prepare('SELECT body FROM messages').get().body, 'long-path history'); }
  finally { db.close(); }
  assert.equal(loadWindowsNative().inspectPathSecurity(target).private, true);
  assert.equal(inspectPrivateProjectAuthority(f.root), 'migrated');
  assert.equal(result.stateDir.startsWith('\\\\?\\'), false, 'stored state paths keep their canonical ordinary spelling');
  assert.deepEqual(inventory(f.source), before);
});

test('Windows migration requires explicit confirmation and refuses a live source writer or process pointer', windows, t => {
  const f = fixture(t), file = path.join(f.source, 'log'); fs.writeFileSync(file, 'original');
  assert.throws(() => migrateLegacyProjectState(f.root), { code: 'STATE_MIGRATION_OFFLINE_REQUIRED' });
  const writer = fs.openSync(file, 'r+');
  try { assert.throws(() => migrateLegacyProjectState(f.root, offline)); } finally { fs.closeSync(writer); }
  fs.writeFileSync(path.join(f.source, 'runtime.json'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => migrateLegacyProjectState(f.root, offline), /live|offline/i);
  assert.equal(fs.existsSync(path.join(f.destination(), '.project-root.json')), false);
  fs.unlinkSync(path.join(f.source, 'runtime.json'));
  assert.equal(migrateLegacyProjectState(f.root, offline).files, 1);
});

test('Windows migration refuses source junctions, hard links and public ACLs without modifying their contents', windows, t => {
  const f = fixture(t), outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
  const link = path.join(f.source, 'junction'); fs.symlinkSync(outside, link, 'junction');
  assert.throws(() => migrateLegacyProjectState(f.root, offline)); fs.unlinkSync(link);
  const original = path.join(f.source, 'original'); fs.writeFileSync(original, 'keep');
  const alias = path.join(f.base, 'alias'); fs.linkSync(original, alias);
  assert.throws(() => migrateLegacyProjectState(f.root, offline)); fs.unlinkSync(alias);
  const result = spawnSync('icacls.exe', [original, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => migrateLegacyProjectState(f.root, offline));
  assert.equal(fs.readFileSync(original, 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(f.destination(), '.project-root.json')), false);
  assert.equal(spawnSync('icacls.exe', [original, '/remove:g', '*S-1-1-0'], { windowsHide: true }).status, 0);
  assert.equal(migrateLegacyProjectState(f.root, offline).files, 1);
});

test('Windows interrupted migration remains inaccessible and retries only its identity-bound unpublished copy', windows, t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'history'), 'original');
  assert.throws(() => migrateLegacyProjectState(f.root, { confirmedOffline: true, assertOffline: ({ phase }) => phase === 'before' }),
    { code: 'STATE_MIGRATION_OFFLINE_REQUIRED' });
  assert.equal(fs.existsSync(path.join(f.destination(), '.project-root.json')), false);
  assert.throws(() => ensurePrivateProjectStateDir(f.root, { create: true }));
  assert.equal(fs.readFileSync(path.join(f.source, 'history'), 'utf8'), 'original');
  const result = migrateLegacyProjectState(f.root, offline);
  assert.equal(fs.readFileSync(path.join(result.stateDir, 'history'), 'utf8'), 'original');
});

test('Windows migration preserves unrelated destination collisions and refuses forged retry receipts', windows, t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'history'), 'original');
  assert.throws(() => migrateLegacyProjectState(f.root, { confirmedOffline: true, assertOffline: ({ phase }) => phase === 'before' }));
  const receipt = path.join(f.destination(), '.migration-in-progress.json');
  assert.equal(fs.existsSync(receipt), true);
  const stored = JSON.parse(fs.readFileSync(receipt)); stored.sourceIdentity.fileId = '0'.repeat(32); fs.writeFileSync(receipt, JSON.stringify(stored));
  const before = inventory(f.destination());
  assert.throws(() => migrateLegacyProjectState(f.root, offline), { code: 'STATE_MIGRATION_EXISTS' });
  assert.deepEqual(inventory(f.destination()), before);
});

test('Windows migration detects source additions and prevents root replacement before publication', windows, t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'history'), 'original');
  let blocked = false;
  assert.throws(() => migrateLegacyProjectState(f.root, { confirmedOffline: true, assertOffline: ({ phase }) => {
    if (phase === 'after') {
      try { fs.renameSync(f.root, f.root + '-moved'); } catch { blocked = true; }
      fs.writeFileSync(path.join(f.source, 'new-file'), 'late write');
    }
    return true;
  } }), /changed/i);
  assert.equal(blocked, true);
  assert.equal(fs.existsSync(path.join(f.destination(), '.project-root.json')), false);
});

test('Windows migration validates SQLite and rejects live native owners, orphan sidecars and reserved markers', windows, t => {
  const f = fixture(t), db = path.join(f.source, 'mesh.db'); fs.writeFileSync(db, 'corrupted database');
  assert.throws(() => migrateLegacyProjectState(f.root, offline)); fs.unlinkSync(db);
  fs.mkdirSync(path.join(f.source, 'native'));
  const native = path.join(f.source, 'native', 'state.db');
  seed(native, `CREATE TABLE native_owner(singleton INTEGER,pid INTEGER,start_token TEXT,command_hash TEXT,state TEXT); INSERT INTO native_owner VALUES(1,${process.pid},NULL,NULL,'active');`);
  assert.throws(() => migrateLegacyProjectState(f.root, offline), /live|offline/i); fs.unlinkSync(native);
  fs.writeFileSync(db + '-wal', 'orphan'); assert.throws(() => migrateLegacyProjectState(f.root, offline), /sidecar/i); fs.unlinkSync(db + '-wal');
  fs.writeFileSync(path.join(f.source, '.project-root.json'), '{}'); assert.throws(() => migrateLegacyProjectState(f.root, offline), /reserved/i);
  fs.unlinkSync(path.join(f.source, '.project-root.json')); assert.equal(migrateLegacyProjectState(f.root, offline).files, 0);
});

test('Windows empty unclaimed migration directories stay fenced even if the legacy source disappears', windows, t => {
  const f = fixture(t);
  assert.throws(() => migrateLegacyProjectState(f.root, { confirmedOffline: true, assertOffline: ({ phase }) => phase === 'before' }));
  const destination = f.destination();
  for (const name of fs.readdirSync(destination)) { assert.equal(fs.statSync(path.join(destination, name)).isFile(), true); fs.unlinkSync(path.join(destination, name)); }
  fs.renameSync(f.source, f.source + '-preserved');
  assert.throws(() => ensurePrivateProjectStateDir(f.root, { create: true }), { code: 'STATE_MIGRATION_INCOMPLETE' });
  assert.deepEqual(fs.readdirSync(destination), []);
});

test('Windows migration survives process exit before publication and CLI retries with explicit offline consent', windows, t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'history'), 'preserve');
  const module = new URL('../lib/runtime/state-migration.mjs', import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {migrateLegacyProjectState} from ${JSON.stringify(module)}; migrateLegacyProjectState(process.argv[1], {confirmedOffline:true, assertOffline:({phase})=>{ if(phase==='after') process.exit(73); return true; }});`, f.root],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(interrupted.status, 73, interrupted.stderr);
  assert.equal(fs.existsSync(path.join(f.destination(), '.project-root.json')), false);
  const cli = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
  const absentConsent = spawnSync(process.execPath, [cli, '--root', f.root, '--json', 'migrate-state', '--offline'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.notEqual(absentConsent.status, 0); assert.match(absentConsent.stdout + absentConsent.stderr, /STATE_MIGRATION_OFFLINE_REQUIRED/);
  const retry = spawnSync(process.execPath, [cli, '--root', f.root, '--json', 'migrate-state', '--offline', '--yes'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.equal(fs.readFileSync(path.join(ensurePrivateProjectStateDir(f.root), 'history'), 'utf8'), 'preserve');
});

test('Windows migration preserves an old root generation and archives verified path-bound DSH artifacts', windows, t => {
  const f = fixture(t); fs.rmdirSync(f.source);
  const previous = ensurePrivateProjectStateDir(f.root, { create: true }); fs.writeFileSync(path.join(previous, 'old-state'), 'retained');
  fs.renameSync(f.root, f.root + '-old'); fs.mkdirSync(f.root); createWindowsPrivateDirectory(f.source);
  provisionPrivateProjectGeneration(f.root);
  const directory = path.join(f.source, 'dsh'); fs.mkdirSync(directory);
  const hooks = Buffer.from(JSON.stringify({ _helloCc: { managedBy: 'hello-cc/dsh', schema: 1 } }));
  fs.writeFileSync(path.join(directory, 'hooks.json'), hooks);
  fs.writeFileSync(path.join(directory, 'managed.json'), JSON.stringify({ managedBy: 'hello-cc/dsh', schema: 1,
    root: loadWindowsNative().inspectDirectory(f.root).canonical, mode: 'hooks', hccBin: process.execPath, nodeBin: process.execPath,
    files: { 'hooks.json': createHash('sha256').update(hooks).digest('hex') } }));
  const result = migrateLegacyProjectState(f.root, offline);
  assert.match(result.stateDir, /\.generations[\\/][a-f0-9]{32}$/);
  assert.equal(fs.readFileSync(path.join(previous, 'old-state'), 'utf8'), 'retained');
  assert.equal(ensurePrivateProjectStateDir(f.root), result.stateDir);
  assert.equal(fs.existsSync(path.join(result.stateDir, 'dsh', 'hooks.json')), false);
  assert.deepEqual(fs.readFileSync(path.join(result.dsh.archivePath, 'hooks.json')), hooks);
  assert.equal(result.dsh.rebuildCommand, 'hcc dsh setup --mode hooks');
});

test('Windows migration treats runtime evidence names case-insensitively', windows, t => {
  const f = fixture(t), pointer = path.join(f.source, 'Runtime.JSON');
  fs.writeFileSync(pointer, JSON.stringify({ pid: process.pid }));
  assert.throws(() => migrateLegacyProjectState(f.root, offline), /live|offline/i);
  fs.writeFileSync(pointer, JSON.stringify({ pid: 2147483647 }));
  const result = migrateLegacyProjectState(f.root, offline);
  assert.equal(result.omittedPointers, 1);
  assert.equal(fs.existsSync(path.join(result.stateDir, 'runtime.json')), false);
});

test('Windows migration checks peers in case-varied mesh database names', windows, t => {
  const f = fixture(t), db = path.join(f.source, 'Mesh.DB');
  seed(db, `CREATE TABLE peers(pid INTEGER); INSERT INTO peers VALUES(${process.pid});`);
  assert.throws(() => migrateLegacyProjectState(f.root, offline), /live|offline/i);
  seed(db, 'DELETE FROM peers;');
  assert.equal(migrateLegacyProjectState(f.root, offline).databases, 1);
});

test('Windows migration never mistakes a completed store with a lost binding for an interrupted copy', windows, t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'old-history'), 'source');
  const result = migrateLegacyProjectState(f.root, offline);
  fs.writeFileSync(path.join(result.stateDir, 'new-history'), 'post-migration user data');
  fs.unlinkSync(path.join(result.stateDir, '.project-root.json'));
  assert.throws(() => migrateLegacyProjectState(f.root, offline), { code: 'STATE_MIGRATION_EXISTS' });
  assert.equal(fs.readFileSync(path.join(result.stateDir, 'new-history'), 'utf8'), 'post-migration user data');
});

test('Windows migration refuses a live native owner with unknown NULL state', windows, t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.source, 'native'));
  const db = path.join(f.source, 'native', 'state.db');
  seed(db, `CREATE TABLE native_owner(singleton INTEGER,pid INTEGER,start_token TEXT,command_hash TEXT,state TEXT); INSERT INTO native_owner VALUES(1,${process.pid},NULL,NULL,NULL);`);
  assert.throws(() => migrateLegacyProjectState(f.root, offline), /live|offline/i);
  assert.equal(fs.existsSync(path.join(f.destination(), '.project-root.json')), false);
});

test('Windows migration honors case-insensitive SQLite process table and column identifiers', windows, t => {
  const f = fixture(t), mesh = path.join(f.source, 'mesh.db');
  seed(mesh, `CREATE TABLE Peers(PID INTEGER); INSERT INTO Peers VALUES(${process.pid});`);
  assert.throws(() => migrateLegacyProjectState(f.root, offline), /live|offline/i);
  seed(mesh, 'DELETE FROM Peers'); fs.mkdirSync(path.join(f.source, 'native'));
  const native = path.join(f.source, 'native', 'state.db');
  seed(native, `CREATE TABLE Native_Owner(SINGLETON INTEGER,PID INTEGER,START_TOKEN TEXT,COMMAND_HASH TEXT,STATE TEXT); INSERT INTO Native_Owner VALUES(1,${process.pid},NULL,NULL,'active');`);
  assert.throws(() => migrateLegacyProjectState(f.root, offline), /live|offline/i);
  seed(native, "UPDATE Native_Owner SET STATE='released'");
  assert.equal(migrateLegacyProjectState(f.root, offline).databases, 2);
});

test('Windows migration retains immutable destination files through final publication', windows, t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'history'), 'source');
  const alias = path.join(f.base, 'external'); fs.writeFileSync(alias, 'replacement');
  let blocked = false;
  const result = migrateLegacyProjectState(f.root, { confirmedOffline: true, assertOffline: ({ phase }) => {
    if (phase === 'after') {
      try { fs.unlinkSync(path.join(f.destination(), 'history')); fs.linkSync(alias, path.join(f.destination(), 'history')); }
      catch { blocked = true; }
    }
    return true;
  } });
  assert.equal(blocked, true);
  assert.equal(fs.readFileSync(path.join(result.stateDir, 'history'), 'utf8'), 'source');
  assert.equal(fs.statSync(path.join(result.stateDir, 'history')).nlink, 1);
});

test('Windows migration rejects destination additions before committing', windows, t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'history'), 'source');
  assert.throws(() => migrateLegacyProjectState(f.root, { confirmedOffline: true, assertOffline: ({ phase }) => {
    if (phase === 'after') fs.writeFileSync(path.join(f.destination(), 'unexpected'), 'foreign');
    return true;
  } }), /changed|unexpected/i);
  assert.equal(fs.existsSync(path.join(f.destination(), '.project-root.json')), false);
});

test('Windows migration rejects a destination file whose ACL becomes public before commit', windows, t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'history'), 'source');
  assert.throws(() => migrateLegacyProjectState(f.root, { confirmedOffline: true, assertOffline: ({ phase }) => {
    if (phase === 'after') {
      const changed = spawnSync('icacls.exe', [path.join(f.destination(), 'history'), '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
      assert.equal(changed.status, 0, changed.stderr);
    }
    return true;
  } }), /ACL|changed/i);
  assert.equal(fs.existsSync(path.join(f.destination(), '.project-root.json')), false);
});

test('Windows migration holds verified SQLite bytes and nested parents until publication', windows, t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.source, 'native'));
  seed(path.join(f.source, 'native', 'state.db'), "CREATE TABLE tasks(body TEXT); INSERT INTO tasks VALUES('retained');");
  let writeBlocked = false, renameBlocked = false;
  const result = migrateLegacyProjectState(f.root, { confirmedOffline: true, assertOffline: ({ phase }) => {
    if (phase === 'after') {
      const nested = path.join(f.destination(), 'native');
      try { const fd = fs.openSync(path.join(nested, 'state.db'), 'r+'); fs.closeSync(fd); } catch { writeBlocked = true; }
      try { fs.renameSync(nested, nested + '-moved'); } catch { renameBlocked = true; }
    }
    return true;
  } });
  assert.equal(writeBlocked, true); assert.equal(renameBlocked, true);
  assert.equal(query(path.join(result.stateDir, 'native', 'state.db'), 'SELECT body FROM tasks')[0].body, 'retained');
});

test('Windows migration rejects a copied owned-sentinel name in another destination directory', windows, t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.source, 'nested'));
  assert.throws(() => migrateLegacyProjectState(f.root, { confirmedOffline: true, assertOffline: ({ phase }) => {
    if (phase === 'after') {
      const name = fs.readdirSync(f.destination()).find(n => n.startsWith('.hcc-cwd-pin-'));
      assert.ok(name); fs.writeFileSync(path.join(f.destination(), 'nested', name), 'unexpected');
    }
    return true;
  } }), /changed|unexpected/i);
  assert.equal(fs.existsSync(path.join(f.destination(), '.project-root.json')), false);
});
