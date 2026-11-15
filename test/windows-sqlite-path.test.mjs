import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteDatabasePath } from '../lib/db/sqlite-path.mjs';
import { createConnectionHelpers } from '../lib/db/connection.mjs';
import { ensurePrivateProjectStateDir } from '../lib/runtime/private-state.mjs';
import { createNativeStore, nativePaths } from '../lib/runtime/native/store.mjs';
import { readNativeWorkerHistory } from '../lib/runtime/native/history.mjs';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';

test('SQLite filename adaptation preserves memory databases, URI options and other input types', () => {
  const db = new DatabaseSync(sqliteDatabasePath(':memory:'));
  try {
    db.exec('CREATE TABLE memory(value); INSERT INTO memory VALUES(42)');
    assert.equal(db.prepare('SELECT value FROM memory').get().value, 42);
    assert.equal(db.prepare('PRAGMA database_list').get().file, '');
  } finally { db.close(); }
  for (const value of ['', 'file:shared?mode=memory&cache=shared', new URL('file:///tmp/sqlite.db'), Buffer.from('sqlite.db')]) {
    assert.equal(sqliteDatabasePath(value), value);
  }
  if (process.platform !== 'win32') assert.equal(sqliteDatabasePath('/tmp/sqlite.db'), '/tmp/sqlite.db');
});

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-sqlite-long-'));
  let home = path.join(base, 'profile');
  while (home.length < 230) home = path.join(home, 'p'.repeat(Math.min(180, Math.max(1, 229 - home.length))));
  const root = path.join(base, 'project');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(root);
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const directory = ensurePrivateProjectStateDir(root, { create: true });
  const ctx = { root, dbPath: path.join(directory, 'mesh.db') };
  assert.ok(ctx.dbPath.length > 280, 'the real database must exceed MAX_PATH');
  return { directory, ctx };
}

test('managed Windows databases support long paths, WAL readers and retained native identity',
  { skip: process.platform !== 'win32' }, t => {
    const { directory, ctx } = fixture(t);
    const helpers = createConnectionHelpers({ now: () => 1, dedupePeerBindings() {}, redactedLogText: String });
    let writer, reader;
    try {
      writer = helpers.connect(ctx, { migrateRegistered: false });
      writer.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE long_path(value TEXT); INSERT INTO long_path VALUES('retained WAL data');");
      assert.ok(fs.statSync(ctx.dbPath + '-wal').size > 0);
      reader = helpers.connectReadOnly(ctx);
      assert.equal(reader.prepare('SELECT value FROM long_path').get().value, 'retained WAL data');
      for (const file of [ctx.dbPath, ctx.dbPath + '-wal', ctx.dbPath + '-shm']) {
        assert.equal(loadWindowsNative().inspectPathSecurity(file).private, true);
      }
      assert.throws(() => fs.renameSync(directory, directory + '-moved'));
    } finally { reader?.close(); writer?.close(); }
    assert.equal(fs.existsSync(ctx.dbPath + '-wal'), false);
    fs.renameSync(directory, directory + '-moved');
  });

test('Windows native stores and history readers share committed WAL data beyond MAX_PATH',
  { skip: process.platform !== 'win32' }, t => {
    const { ctx } = fixture(t);
    let store;
    try {
      store = createNativeStore(ctx);
      const paths = nativePaths(ctx);
      assert.ok(paths.db.length > 280);
      store.db.exec('PRAGMA wal_autocheckpoint=0');
      store.saveWorker({ peer: 'worker', provider: 'codex', sessionId: 'long-path-session', cwd: ctx.root, status: 'closed' });
      store.event('worker', { text: 'committed long-path event' });
      assert.ok(fs.statSync(paths.db + '-wal').size > 0);
      const history = readNativeWorkerHistory(ctx, 'worker');
      assert.equal(history.worker.session_id, 'long-path-session');
      assert.equal(history.events[0].payload.text, 'committed long-path event');
      assert.throws(() => fs.renameSync(paths.dir, paths.dir + '-moved'));
    } finally { store?.close(); }
  });
