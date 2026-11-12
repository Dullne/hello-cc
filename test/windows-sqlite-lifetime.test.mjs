import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { loadWindowsNative } from '../lib/platform/windows-native.mjs';
import * as privateState from '../lib/platform/windows-private-state.mjs';
import { captureDirectory } from '../lib/platform/windows-filesystem.mjs';

const windows = process.platform === 'win32';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-sqlite-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const directory = path.join(base, 'private'); loadWindowsNative().createPrivateDirectory(directory);
  const file = path.join(directory, '数据库.db');
  return { base, directory, file };
}

test('Windows SQLite holds prevent file and ancestor rebinding while allowing transactions and WAL cleanup',
  { skip: !windows }, t => {
    const { directory, file } = fixture(t); fs.writeFileSync(file, '');
    const hold = privateState.captureWindowsPrivateDatabase(file);
    let db;
    try {
      db = new DatabaseSync(file);
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES (\'value\');');
      assert.equal(db.prepare('SELECT value FROM sample').get().value, 'value');
      hold.assertUnchanged();
      assert.throws(() => fs.renameSync(directory, directory + '-moved'));
      assert.throws(() => fs.renameSync(file, file + '-moved'));
      db.close(); db = null;
      hold.assertUnchanged();
      assert.equal(fs.existsSync(file + '-wal'), false);
    } finally { db?.close(); hold.close(); hold.close(); }
    fs.renameSync(file, file + '-moved');
    assert.deepEqual(fs.readdirSync(directory), [path.basename(file) + '-moved']);
  });

test('Windows SQLite holds reject hard links and release all pins after failed admission',
  { skip: !windows }, t => {
    const { directory, file } = fixture(t); fs.writeFileSync(file, '');
    const hardlink = file + '-link'; fs.linkSync(file, hardlink);
    assert.throws(() => privateState.captureWindowsPrivateDatabase(file),
      error => ['PROJECT_PATH_FORBIDDEN', 'PROJECT_FILE_FORBIDDEN'].includes(error.code));
    fs.unlinkSync(hardlink);
    assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
    fs.renameSync(directory, directory + '-moved');
  });

test('Windows SQLite holds also refuse native POSIX-style replacement of the selected database',
  { skip: !windows }, t => {
    const { directory, file } = fixture(t); fs.writeFileSync(file, 'original');
    const hold = privateState.captureWindowsPrivateDatabase(file);
    const lease = captureDirectory(directory); const parent = lease.openDirectory('');
    try {
      const reader = parent.openFile(path.basename(file));
      let expectedIdentity;
      try { expectedIdentity = reader.snapshot().identity; } finally { reader.close(); }
      assert.throws(() => parent.publish(path.basename(file), Buffer.from('replacement'), {
        private: true, operation: 'replace', expectedIdentity, expectedBytes: Buffer.from('original')
      }));
      hold.assertUnchanged();
      assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    } finally { parent.close(); lease.close(); hold.close(); }
  });

test('managed Windows connections release their native pins through close and Symbol.dispose',
  { skip: !windows }, t => {
    const { base } = fixture(t);
    const home = path.join(base, 'isolated-profile'); const root = path.join(base, 'project');
    fs.mkdirSync(home); fs.mkdirSync(root);
    const source = `
      import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
      import {createConnectionHelpers} from ${JSON.stringify(new URL('../lib/db/connection.mjs', import.meta.url).href)};
      import {privateProjectStateDir} from ${JSON.stringify(new URL('../lib/runtime/private-state.mjs', import.meta.url).href)};
      const root=process.argv[1], ctx={root,dbPath:path.join(root,'.hello-cc','mesh.db')};
      const helpers=createConnectionHelpers({now:()=>1,dedupePeerBindings:()=>{},redactedLogText:String});
      const db=helpers.connect(ctx,{migrateRegistered:false});
      const directory=privateProjectStateDir(root), file=path.join(directory,'mesh.db');
      assert.throws(()=>fs.renameSync(file,file+'-moved'));
      assert.throws(()=>fs.renameSync(directory,directory+'-moved'));
      db.close(); fs.renameSync(file,file+'-moved'); fs.renameSync(file+'-moved',file);
      const readonly=helpers.connectReadOnly(ctx);
      assert.throws(()=>fs.renameSync(file,file+'-moved'));
      readonly[Symbol.dispose]();
      fs.renameSync(directory,directory+'-moved');
      console.log('confirmed');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, root], {
      env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8', timeout: 20000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.stdout.trim(), 'confirmed');
  });
