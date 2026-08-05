import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  ensureMigrationBackup,
  initSchemaWithBackup
} from '../lib/db/migration-backup.mjs';
import { initSchema, readSchemaVersion } from '../lib/db/schema.mjs';

const FIXED_TIMESTAMP = '20260803T120000000Z';

function createLegacyDb(dbPath, version) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO meta(key, value) VALUES ('schema_version', '${version}');

    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE peers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      role TEXT,
      worktree TEXT,
      branch TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'idle',
      capabilities TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE locks (
      resource TEXT PRIMARY KEY,
      base_resource TEXT,
      scope TEXT NOT NULL DEFAULT '*',
      owner TEXT NOT NULL,
      task_id INTEGER,
      reason TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL${version >= 6 ? ',\n      ttl_sec INTEGER NOT NULL DEFAULT 900' : ''}
    );

    INSERT INTO peers(
      id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at
    ) VALUES (
      'legacy-peer-v${version}', 'codex', 'peer', '/tmp/legacy', 'main', 1234,
      'idle', 'legacy-row', 100, 200
    );

    INSERT INTO locks(
      resource, base_resource, scope, owner, task_id, reason, expires_at, created_at${version >= 6 ? ', ttl_sec' : ''}
    ) VALUES (
      'legacy-lock-v${version}', 'legacy-lock-v${version}', '*', 'legacy-peer-v${version}',
      NULL, 'preserve me', 1100, 100${version >= 6 ? ', 1000' : ''}
    );

    PRAGMA user_version = ${version};
  `);
  const insertMigration = db.prepare(`
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (?, ?, 1)
  `);
  for (let migration = 1; migration <= version; migration += 1) {
    insertMigration.run(migration, `legacy migration ${migration}`);
  }
  return db;
}

function readBackup(backupPath, expectedVersion) {
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
    assert.equal(
      backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
      String(expectedVersion)
    );
    assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, expectedVersion);
    assert.equal(
      backup.prepare('SELECT capabilities FROM peers WHERE id = ?').get(`legacy-peer-v${expectedVersion}`)?.capabilities,
      'legacy-row'
    );
  } finally {
    backup.close();
  }
}

for (const version of [5, 6]) {
  test(`creates a consistent, version-preserving backup of a v${version} database`, (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-schema-v${version}-`));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const dbPath = path.join(tempDir, 'mesh.db');
    const db = createLegacyDb(dbPath, version);
    t.after(() => db.close());

    const backupPath = ensureMigrationBackup(db, dbPath, version, 7, {
      timestamp: () => FIXED_TIMESTAMP
    });

    assert.match(
      backupPath,
      new RegExp(`mesh\\.db\\.pre-v${version}-to-v7\\.20260803T120000000Z\\.[a-f0-9]{8}\\.bak$`)
    );
    assert.notEqual(backupPath, dbPath);
    readBackup(backupPath, version);
  });
}

test('same-timestamp backups are distinct and never overwrite an existing backup', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-collision-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'mesh.db');
  const db = createLegacyDb(dbPath, 5);
  t.after(() => db.close());
  const options = { timestamp: () => FIXED_TIMESTAMP };

  const first = ensureMigrationBackup(db, dbPath, 5, 7, options);
  const firstBytes = fs.readFileSync(first);
  const second = ensureMigrationBackup(db, dbPath, 5, 7, options);

  assert.notEqual(second, first);
  assert.deepEqual(fs.readFileSync(first), firstBytes);
  readBackup(first, 5);
  readBackup(second, 5);
});

test('rotation is deterministic at equal mtimes and never deletes the published backup', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-rotation-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'mesh.db');
  const db = createLegacyDb(dbPath, 5);
  t.after(() => db.close());
  const existing = [
    '20260801T120000000Z.00000001',
    '20260801T120000000Z.00000002',
    '20260802T120000000Z.00000003',
    '20260802T120000000Z.00000004',
    '20260803T120000000Z.ffffffff'
  ].map((stamp) => `mesh.db.pre-v5-to-v7.${stamp}.bak`);
  const publishedName = 'mesh.db.pre-v5-to-v7.20260701T120000000Z.00000000.bak';
  for (const name of existing) fs.copyFileSync(dbPath, path.join(tempDir, name));
  fs.writeFileSync(path.join(tempDir, 'mesh.db.pre-v-not-a-backup.bak'), 'unrelated');

  const realReadDirSync = fs.readdirSync.bind(fs);
  const realStatSync = fs.statSync.bind(fs);
  t.mock.method(fs, 'readdirSync', (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(tempDir)) {
      return [...existing, publishedName, 'mesh.db.pre-v-not-a-backup.bak'];
    }
    return realReadDirSync(target, ...args);
  });
  t.mock.method(fs, 'statSync', (target, ...args) => {
    const result = realStatSync(target, ...args);
    if (String(target).endsWith('.bak')) {
      return new Proxy(result, {
        get(object, property) {
          if (property === 'mtimeMs') return 1;
          const value = Reflect.get(object, property, object);
          return typeof value === 'function' ? value.bind(object) : value;
        }
      });
    }
    return result;
  });

  const published = ensureMigrationBackup(db, dbPath, 5, 7, {
    timestamp: () => '20260701T120000000Z',
    suffix: () => '00000000'
  });

  assert.equal(fs.existsSync(published), true);
  assert.equal(fs.existsSync(path.join(tempDir, existing[0])), false);
  assert.equal(fs.existsSync(path.join(tempDir, existing[4])), true);
  assert.equal(fs.readFileSync(path.join(tempDir, 'mesh.db.pre-v-not-a-backup.bak'), 'utf8'), 'unrelated');
});

test('exclusive publication preserves an empty file and dangling symlink collision', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-exclusive-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'mesh.db');
  const db = createLegacyDb(dbPath, 5);
  t.after(() => db.close());
  const emptyCollision = path.join(tempDir, `mesh.db.pre-v5-to-v7.${FIXED_TIMESTAMP}.deadbeef.bak`);
  const symlinkCollision = path.join(tempDir, `mesh.db.pre-v5-to-v7.${FIXED_TIMESTAMP}.cafebabe.bak`);
  const danglingTarget = path.join(tempDir, 'missing-target');
  fs.writeFileSync(emptyCollision, '');
  fs.symlinkSync(danglingTarget, symlinkCollision);
  const suffixes = ['deadbeef', 'cafebabe', 'feedface'];

  const backupPath = ensureMigrationBackup(db, dbPath, 5, 7, {
    timestamp: () => FIXED_TIMESTAMP,
    suffix: () => suffixes.shift()
  });

  assert.equal(backupPath, path.join(tempDir, `mesh.db.pre-v5-to-v7.${FIXED_TIMESTAMP}.feedface.bak`));
  assert.equal(fs.statSync(emptyCollision).size, 0);
  assert.equal(fs.lstatSync(symlinkCollision).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(symlinkCollision), danglingTarget);
  readBackup(backupPath, 5);
});

test('published backup is private under a permissive umask', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-mode-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'mesh.db');
  const db = createLegacyDb(dbPath, 6);
  t.after(() => db.close());
  fs.chmodSync(dbPath, 0o600);
  const previousUmask = process.umask(0o022);
  let backupPath;
  try {
    backupPath = ensureMigrationBackup(db, dbPath, 6, 7, {
      timestamp: () => FIXED_TIMESTAMP,
      suffix: () => 'deadbeef'
    });
  } finally {
    process.umask(previousUmask);
  }

  assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
});

test('verification failure removes the unpublished snapshot and private directory', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-cleanup-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'mesh.db');
  const db = createLegacyDb(dbPath, 5);
  t.after(() => db.close());
  const finalPath = path.join(tempDir, `mesh.db.pre-v5-to-v7.${FIXED_TIMESTAMP}.deadbeef.bak`);

  assert.throws(() => ensureMigrationBackup(db, dbPath, 5, 7, {
    timestamp: () => FIXED_TIMESTAMP,
    suffix: () => 'deadbeef',
    verifySnapshot() {
      throw new Error('injected verification failure');
    }
  }), /injected verification failure/);

  assert.equal(fs.existsSync(finalPath), false);
  assert.deepEqual(
    fs.readdirSync(tempDir).filter((name) => name.startsWith('.mesh.db.migration-backup-')),
    []
  );
});

test('syncs snapshot and parent directory in crash-durable publication order', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-sync-order-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'mesh.db');
  const db = createLegacyDb(dbPath, 5);
  t.after(() => db.close());
  const events = [];
  const fdPaths = new Map();
  const realOpenSync = fs.openSync.bind(fs);
  const realCloseSync = fs.closeSync.bind(fs);
  const realFsyncSync = fs.fsyncSync.bind(fs);
  const realChmodSync = fs.chmodSync.bind(fs);
  const realLinkSync = fs.linkSync.bind(fs);
  const realRmSync = fs.rmSync.bind(fs);
  t.mock.method(fs, 'openSync', (target, ...args) => {
    const fd = realOpenSync(target, ...args);
    fdPaths.set(fd, path.resolve(String(target)));
    return fd;
  });
  t.mock.method(fs, 'closeSync', (fd) => {
    fdPaths.delete(fd);
    return realCloseSync(fd);
  });
  t.mock.method(fs, 'fsyncSync', (fd) => {
    const target = fdPaths.get(fd);
    if (path.basename(target || '') === 'snapshot.db') events.push('fsync-snapshot');
    if (target === path.resolve(tempDir)) events.push('fsync-parent');
    return realFsyncSync(fd);
  });
  t.mock.method(fs, 'chmodSync', (target, mode) => {
    if (path.basename(String(target)) === 'snapshot.db' && mode === 0o600) events.push('chmod-snapshot');
    return realChmodSync(target, mode);
  });
  t.mock.method(fs, 'linkSync', (...args) => {
    events.push('link');
    return realLinkSync(...args);
  });
  t.mock.method(fs, 'rmSync', (target, ...args) => {
    if (path.basename(String(target)).startsWith('.mesh.db.migration-backup-')) events.push('cleanup');
    return realRmSync(target, ...args);
  });

  ensureMigrationBackup(db, dbPath, 5, 7, {
    timestamp: () => FIXED_TIMESTAMP,
    suffix: () => 'deadbeef',
    verifySnapshot() {
      events.push('verify');
    }
  });

  assert.deepEqual(events, [
    'chmod-snapshot',
    'fsync-snapshot',
    'verify',
    'link',
    'cleanup',
    'fsync-parent'
  ]);
});

test('cleanup failure aborts success after one retry and retains its cause', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-cleanup-error-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'mesh.db');
  const db = createLegacyDb(dbPath, 5);
  t.after(() => db.close());
  const realRmSync = fs.rmSync.bind(fs);
  let cleanupAttempts = 0;
  t.mock.method(fs, 'rmSync', (target, ...args) => {
    if (path.basename(String(target)).startsWith('.mesh.db.migration-backup-') && cleanupAttempts < 2) {
      cleanupAttempts += 1;
      throw Object.assign(new Error('injected cleanup failure'), { code: 'EBUSY' });
    }
    return realRmSync(target, ...args);
  });

  assert.throws(() => ensureMigrationBackup(db, dbPath, 5, 7, {
    timestamp: () => FIXED_TIMESTAMP,
    suffix: () => 'deadbeef'
  }), (err) => {
    assert.match(err.message, /Failed to remove migration backup staging directory/);
    assert.match(err.cause?.message || '', /injected cleanup failure/);
    return true;
  });
  assert.equal(cleanupAttempts, 2);
});

test('preserves migration and cleanup errors when staging cleanup also fails', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-cleanup-aggregate-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'mesh.db');
  const db = createLegacyDb(dbPath, 6);
  t.after(() => db.close());
  const realRmSync = fs.rmSync.bind(fs);
  let cleanupAttempts = 0;
  t.mock.method(fs, 'rmSync', (target, ...args) => {
    if (path.basename(String(target)).startsWith('.mesh.db.migration-backup-') && cleanupAttempts < 2) {
      cleanupAttempts += 1;
      throw Object.assign(new Error('injected cleanup failure'), { code: 'EBUSY' });
    }
    return realRmSync(target, ...args);
  });

  assert.throws(() => ensureMigrationBackup(db, dbPath, 6, 7, {
    timestamp: () => FIXED_TIMESTAMP,
    suffix: () => 'deadbeef',
    verifySnapshot() {
      throw new Error('injected verification failure');
    }
  }), (err) => {
    assert.equal(err instanceof AggregateError, true);
    assert.equal(err.errors.length, 2);
    assert.equal(err.errors[0]?.message, 'injected verification failure');
    assert.match(err.errors[1]?.message || '', /Failed to remove migration backup staging directory/);
    return true;
  });
  assert.equal(cleanupAttempts, 2);
});

test('bounds staging and backup names for a database basename near NAME_MAX', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-long-name-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, `${'m'.repeat(240)}.db`);
  const db = createLegacyDb(dbPath, 5);
  t.after(() => db.close());

  const backupPath = ensureMigrationBackup(db, dbPath, 5, 7, {
    timestamp: () => FIXED_TIMESTAMP,
    suffix: () => 'deadbeef'
  });

  assert.match(path.basename(backupPath), /^db-[a-f0-9]{16}\.pre-v5-to-v7\.20260803T120000000Z\.deadbeef\.bak$/);
  assert.ok(Buffer.byteLength(path.basename(backupPath)) < 255);
  assert.deepEqual(
    fs.readdirSync(tempDir).filter((name) => name.includes('.migration-backup-')),
    []
  );
  readBackup(backupPath, 5);
});

test('backup failure aborts before migration changes the source schema version', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-unwritable-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'mesh.db');
  const db = createLegacyDb(dbPath, 6);
  t.after(() => db.close());
  const blockedParent = path.join(tempDir, 'not-a-directory');
  fs.writeFileSync(blockedParent, 'block adjacent backup creation');

  assert.throws(() => initSchema(db, {
    beforeMigration: ({ fromVersion, toVersion }) =>
      ensureMigrationBackup(db, path.join(blockedParent, 'mesh.db'), fromVersion, toVersion, {
        timestamp: () => FIXED_TIMESTAMP
      })
  }));
  assert.equal(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
    '6'
  );
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 6);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('peers') WHERE name IN ('pid_start_token', 'pid_command_hash')").get()?.count,
    0
  );
});

test('a brand-new empty database migrates without requesting a backup', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-empty-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(tempDir, 'mesh.db'));
  t.after(() => db.close());
  let backupCalls = 0;

  initSchema(db, {
    beforeMigration() {
      backupCalls += 1;
    }
  });

  assert.equal(backupCalls, 0);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 7);
});

test('migration lock rechecks the schema before backup after a competing migration', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-lock-recheck-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'mesh.db');
  const db = createLegacyDb(dbPath, 6);
  t.after(() => db.close());
  let backupCalls = 0;

  initSchemaWithBackup(db, dbPath, {
    withLock(_target, migrate) {
      db.exec(`
        UPDATE meta SET value = '7' WHERE key = 'schema_version';
        PRAGMA user_version = 7;
      `);
      return migrate();
    },
    ensureBackup() {
      backupCalls += 1;
    }
  });

  assert.equal(backupCalls, 0);
  assert.equal(readSchemaVersion(db), 7);
});

test('concurrent migrations publish one correctly labelled pre-v7 backup', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-schema-lock-processes-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'mesh.db');
  createLegacyDb(dbPath, 6).close();
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'db', 'migration-backup.mjs')).href;
  const childSource = `
    import { DatabaseSync } from 'node:sqlite';
    const [moduleUrl, dbPath] = process.argv.slice(1);
    const { initSchemaWithBackup } = await import(moduleUrl);
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    db.exec('PRAGMA busy_timeout = 5000;');
    try { initSchemaWithBackup(db, dbPath); } finally { db.close(); }
  `;
  const migrate = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', childSource, moduleUrl, dbPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`migration child exited ${code ?? signal}: ${stderr}`));
    });
  });

  await Promise.all([migrate(), migrate(), migrate(), migrate()]);

  const backups = fs.readdirSync(tempDir)
    .filter((name) => /^mesh\.db\.pre-v6-to-v7\..+\.bak$/.test(name));
  assert.equal(backups.length, 1);
  readBackup(path.join(tempDir, backups[0]), 6);
  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(readSchemaVersion(migrated), 7);
  } finally {
    migrated.close();
  }
});
