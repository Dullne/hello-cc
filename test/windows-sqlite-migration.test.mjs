import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createConnectionHelpers } from '../lib/db/connection.mjs';
import { initSchema, readSchemaVersion } from '../lib/db/schema.mjs';
import { ensureMigrationBackup } from '../lib/db/migration-backup.mjs';
import { ensurePrivateProjectStateDir } from '../lib/runtime/private-state.mjs';
import { writeProjectRegistry } from '../lib/runtime/projects.mjs';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

const windows = { skip: process.platform !== 'win32' };
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-windows-migration-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = path.join(base, 'profile'), root = path.join(base, 'project');
  fs.mkdirSync(home); fs.mkdirSync(root);
  process.env.HOME = process.env.USERPROFILE = home;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const directory = ensurePrivateProjectStateDir(root, { create: true });
  const dbPath = path.join(directory, 'mesh.db');
  const db = new DatabaseSync(dbPath); try { initSchema(db); } finally { db.close(); }
  return { base, root, directory, dbPath, ctx: { root, dbPath } };
}

function legacy(db) {
  db.exec("UPDATE meta SET value='6' WHERE key='schema_version'; DELETE FROM schema_migrations WHERE version>6; PRAGMA user_version=6;");
}

test('registered Windows schema initialization retains its live database parent until SQLite closes', windows, t => {
  const f = fixture(t);
  writeProjectRegistry([{ root: f.root, db: f.dbPath, last_seen_at: 1 }]);
  let called = false, renameError;
  const helpers = createConnectionHelpers({ now: () => 1, redactedLogText: String, dedupePeerBindings(db) {
    called = true; assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    try { fs.renameSync(f.directory, f.directory + '-moved'); fs.renameSync(f.directory + '-moved', f.directory); }
    catch (error) { renameError = error; }
  } });
  helpers.migrateRegisteredProjectDbs({ root: f.root, dbPath: path.join(f.base, 'other.db') });
  assert.equal(called, true);
  assert.ok(['EPERM', 'EBUSY', 'EACCES'].includes(renameError?.code), 'registered migrations must retain their native parent hold');
  assert.equal(fs.existsSync(f.dbPath + '-wal'), false);
  fs.renameSync(f.directory, f.directory + '-moved'); fs.renameSync(f.directory + '-moved', f.directory);
});

test('a Windows private database upgrades an older schema only after a verified durable backup', windows, t => {
  const f = fixture(t), seed = new DatabaseSync(f.dbPath);
  try { seed.exec("INSERT INTO meta(key,value) VALUES('backup-proof','original');"); legacy(seed); }
  finally { seed.close(); }
  const helpers = createConnectionHelpers({ now: () => 1, dedupePeerBindings() {}, redactedLogText: String });
  const db = helpers.connect(f.ctx, { migrateRegistered: false });
  try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7); }
  finally { db.close(); }
  const backups = fs.readdirSync(f.directory).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(f.directory, backups[0]), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 6);
    assert.equal(backup.prepare("SELECT value FROM meta WHERE key='backup-proof'").get().value, 'original');
    assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally { backup.close(); }
});

test('registered Windows migrations reject a hard link introduced while their SQLite connection is live', windows, t => {
  const f = fixture(t), alias = path.join(f.base, 'foreign-db-link');
  writeProjectRegistry([{ root: f.root, db: f.dbPath, last_seen_at: 1 }]);
  const failures = [];
  const helpers = createConnectionHelpers({ now: () => 1, redactedLogText(value) { failures.push(value); return 'Expected rejected migration'; },
    dedupePeerBindings() { fs.linkSync(f.dbPath, alias); } });
  try {
    helpers.migrateRegisteredProjectDbs({ root: f.root, dbPath: path.join(f.base, 'other.db') });
    assert.equal(failures.length, 1, 'an unsafe live database must not be cached as migrated');
    assert.equal(fs.existsSync(f.dbPath + '.migration-failed'), true);
  } finally { fs.unlinkSync(alias); }
  fs.renameSync(f.directory, f.directory + '-moved'); fs.renameSync(f.directory + '-moved', f.directory);
});

test('Windows migration backups preserve databases larger than the project-file Buffer limit', windows, t => {
  const f = fixture(t), seed = new DatabaseSync(f.dbPath);
  try { seed.exec('CREATE TABLE large_payload(bytes BLOB); INSERT INTO large_payload VALUES(zeroblob(12582912));'); legacy(seed); }
  finally { seed.close(); }
  const helpers = createConnectionHelpers({ now: () => 1, dedupePeerBindings() {}, redactedLogText: String });
  const upgraded = helpers.connect(f.ctx, { migrateRegistered: false });
  try { assert.equal(readSchemaVersion(upgraded), 7); } finally { upgraded.close(); }
  const name = fs.readdirSync(f.directory).find(value => value.endsWith('.bak'));
  const file = path.join(f.directory, name);
  assert.ok(fs.statSync(file).size > 10 * 1024 * 1024);
  assert.equal(loadWindowsNative().inspectPathSecurity(file).private, true);
  const backup = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(backup.prepare('SELECT length(bytes) AS n FROM large_payload').get().n, 12582912); }
  finally { backup.close(); }
});

test('Windows backup publication preserves collisions and rotates only checked old backup objects', windows, t => {
  const f = fixture(t), db = new DatabaseSync(f.dbPath); legacy(db);
  const stamp = '20261112T120000000Z';
  const collision = path.join(f.directory, `mesh.db.pre-v6-to-v7.${stamp}.00000000.bak`);
  fs.writeFileSync(collision, 'preserve existing backup');
  try {
    const suffixes = ['00000000', '00000001'];
    const backup = ensureMigrationBackup(db, f.dbPath, 6, 7, { timestamp: () => stamp, suffix: () => suffixes.shift() });
    assert.match(backup, /00000001\.bak$/);
    assert.equal(fs.readFileSync(collision, 'utf8'), 'preserve existing backup');
    const unrelated = path.join(f.directory, 'mesh.db.pre-v-not-a-backup.bak'); fs.writeFileSync(unrelated, 'keep');
    for (let i = 2; i <= 6; i++) ensureMigrationBackup(db, f.dbPath, 6, 7, {
      timestamp: () => stamp, suffix: () => String(i).padStart(8, '0')
    });
    assert.equal(fs.readdirSync(f.directory).filter(name => /pre-v6-to-v7.*\.bak$/.test(name)).length, 5);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  } finally { db.close(); }
});

test('Windows backup verification holds immutable bytes and its parent, then removes only the failed snapshot', windows, t => {
  const f = fixture(t), db = new DatabaseSync(f.dbPath); legacy(db);
  try {
    assert.throws(() => ensureMigrationBackup(db, f.dbPath, 6, 7, { verifySnapshot(file) {
      for (const target of [file, f.directory]) assert.throws(() => fs.renameSync(target, target + '-moved'),
        error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
      assert.throws(() => fs.writeFileSync(file, 'tamper'), error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
      throw new Error('Injected snapshot verification failure');
    } }), /Injected snapshot verification failure/);
    assert.equal(readSchemaVersion(db), 6);
    assert.deepEqual(fs.readdirSync(f.directory).filter(name => name.endsWith('.tmp') || name.endsWith('.bak')), []);
  } finally { db.close(); }
});

test('Windows snapshot flush failure prevents schema upgrade and releases retained staging handles', windows, t => {
  const f = fixture(t), seed = new DatabaseSync(f.dbPath); legacy(seed); seed.close();
  const helpers = createConnectionHelpers({ now: () => 1, dedupePeerBindings() {}, redactedLogText: String });
  t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(new Error('Injected snapshot flush failure'), { code: 'TEST_FLUSH' }); });
  assert.throws(() => helpers.connect(f.ctx, { migrateRegistered: false }), { code: 'TEST_FLUSH' });
  t.mock.restoreAll();
  assert.deepEqual(fs.readdirSync(f.directory).filter(name => name.endsWith('.tmp') || name.endsWith('.bak')), []);
  const current = new DatabaseSync(f.dbPath);
  try { assert.equal(readSchemaVersion(current), 6); } finally { current.close(); }
  fs.renameSync(f.directory, f.directory + '-moved'); fs.renameSync(f.directory + '-moved', f.directory);
});

test('Windows backup publication rejects a replaced staging object without deleting the replacement', windows, t => {
  const f = fixture(t), db = new DatabaseSync(f.dbPath); legacy(db);
  let staged;
  try {
    assert.throws(() => ensureMigrationBackup(db, f.dbPath, 6, 7, {
      verifySnapshot(file) { staged = file; },
      suffix() {
        fs.renameSync(staged, staged + '-original');
        fs.writeFileSync(staged, 'foreign replacement');
        return '12345678';
      }
    }), error => error instanceof AggregateError && error.errors[0]?.code === 'PROJECT_FILE_CHANGED' &&
      error.errors[1]?.code === 'PROJECT_FILE_CONFLICT');
    assert.equal(fs.readFileSync(staged, 'utf8'), 'foreign replacement');
    assert.equal(fs.existsSync(staged + '-original'), true);
    assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.bak')), false);
  } finally { db.close(); }
});

test('Windows backup keeps verified bytes immutable until publication while allowing the final rename', windows, t => {
  const f = fixture(t), db = new DatabaseSync(f.dbPath); legacy(db);
  let staged, blocked;
  try {
    const backupPath = ensureMigrationBackup(db, f.dbPath, 6, 7, {
      verifySnapshot(file) {
        staged = file;
        const snapshot = new DatabaseSync(file, { readOnly: true });
        try { assert.equal(snapshot.prepare('PRAGMA quick_check').get().quick_check, 'ok'); }
        finally { snapshot.close(); }
      },
      suffix() {
        try { fs.writeFileSync(staged, 'CORRUPTED AFTER VERIFICATION'); } catch (error) { blocked = error; }
        return 'deadbeef';
      }
    });
    assert.ok(['EBUSY', 'EPERM', 'EACCES'].includes(blocked?.code), 'in-place writes must stay blocked after verification');
    const snapshot = new DatabaseSync(backupPath, { readOnly: true });
    try { assert.equal(snapshot.prepare('PRAGMA quick_check').get().quick_check, 'ok'); }
    finally { snapshot.close(); }
  } finally { db.close(); }
});

test('Windows backup refuses a staging ACL that becomes public after verification', windows, t => {
  const f = fixture(t), db = new DatabaseSync(f.dbPath); legacy(db);
  let staged;
  try {
    assert.throws(() => ensureMigrationBackup(db, f.dbPath, 6, 7, {
      verifySnapshot(file) { staged = file; },
      suffix() {
        const grant = spawnSync('icacls.exe', [staged, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
        assert.equal(grant.status, 0, grant.stderr || grant.stdout);
        assert.equal(loadWindowsNative().inspectPathSecurity(staged).private, false);
        return 'abcdef01';
      }
    }), error => ['PROJECT_PATH_FORBIDDEN', 'PROJECT_FILE_CHANGED'].includes(error.code));
    assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.bak')), false);
    assert.equal(readSchemaVersion(db), 6);
  } finally { db.close(); }
});

test('Windows backup does not adopt an empty private replacement immediately after staging creation', windows, t => {
  const f = fixture(t), seed = new DatabaseSync(f.dbPath); legacy(seed); seed.close();
  const filesystemUrl = new URL('../lib/platform/windows-filesystem.mjs', import.meta.url).href;
  const backupUrl = new URL('../lib/db/migration-backup.mjs', import.meta.url).href;
  const source = `
    import fs from 'node:fs'; import path from 'node:path';
    import { registerHooks } from 'node:module'; import { DatabaseSync } from 'node:sqlite';
    const filesystemUrl = ${JSON.stringify(filesystemUrl)};
    registerHooks({ load(url, context, next) {
      if (url !== filesystemUrl) return next(url, context);
      return { format: 'module', shortCircuit: true, source:
        'import * as actual from ' + JSON.stringify(filesystemUrl + '?original') + ';' +
        'export const inspectDirectory = actual.inspectDirectory;' +
        'function wrap(value) { const result={}; for(const key of Object.getOwnPropertyNames(value)) {' +
        'const entry=value[key]; if(typeof entry!=="function") { result[key]=entry; continue; }' +
        'result[key]=(...args)=>{ const output=entry.apply(value,args);' +
        'if(key==="publish") globalThis.afterStagingPublish?.(...args);' +
        'return key==="openDirectory" ? wrap(output) : output; }; } return result; }' +
        'export function captureDirectory(...args) { return wrap(actual.captureDirectory(...args)); }' };
    } });
    const file=process.argv[1], directory=path.dirname(file);
    let staged, replaced=false;
    globalThis.afterStagingPublish = name => {
      if(replaced || !name.includes('.migration-backup-')) return;
      replaced=true; staged=path.join(directory,name);
      fs.renameSync(staged,staged+'-original'); fs.writeFileSync(staged,'');
    };
    const {ensureMigrationBackup}=await import(${JSON.stringify(backupUrl)});
    const db=new DatabaseSync(file); let error;
    try { ensureMigrationBackup(db,file,6,7); } catch(value) { error=value; } finally { db.close(); }
    console.log(JSON.stringify({replaced,rejected:Boolean(error),originalEmpty:fs.statSync(staged+'-original').size===0,
      replacementEmpty:fs.existsSync(staged)&&fs.statSync(staged).size===0,
      backups:fs.readdirSync(directory).filter(name=>name.endsWith('.bak')).length}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, f.dbPath], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, HCC_SKIP_SHIM_INSTALL: '1' }
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), {
    replaced: true, rejected: true, originalEmpty: true, replacementEmpty: true, backups: 0
  });
});
