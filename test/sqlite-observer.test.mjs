import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readAcceptanceRows } from '../scripts/helpers/sqlite-observer.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-sqlite-observer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = path.join(directory, 'observer.db');
  const db = new DatabaseSync(database);
  try {
    // An exclusive rollback-journal lock deterministically blocks readers.
    // This reproduces a busy observer, without assuming the CI lock owner.
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('ready');");
  } finally { db.close(); }
  return database;
}

async function holdLock(database) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN EXCLUSIVE');
    const deadline = setTimeout(() => process.exit(2), 15000);
    process.once('message', ({ releaseAfterMs }) => setTimeout(() => {
      db.exec('COMMIT'); db.close(); clearTimeout(deadline); process.disconnect();
    }, releaseAfterMs));
    process.send({ locked: true });
  `, database], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message),
      exited.then(status => { throw new Error(`Lock holder exited before readiness: ${JSON.stringify(status)} ${stderr}`); })
    ]);
    assert.deepEqual(ready, { locked: true });
  } catch (error) {
    child.kill(); await exited; throw error;
  }
  return {
    releaseAfter: milliseconds => child.send({ releaseAfterMs: milliseconds }),
    wait: async () => { const status = await exited; assert.equal(status.code, 0, stderr); },
    stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; }
  };
}

const sqliteBusy = error => error?.errcode === 5 && /database is locked/i.test(error.message);

test('acceptance observer waits for a short lock held by an independent process', { timeout: 15000 }, async t => {
  const database = fixture(t);
  const holder = await holdLock(database);
  try {
    const immediate = new DatabaseSync(database, { readOnly: true });
    try { assert.throws(() => immediate.prepare('SELECT value FROM probe').all(), sqliteBusy); }
    finally { immediate.close(); }
    holder.releaseAfter(300);
    const started = Date.now();
    assert.deepEqual(readAcceptanceRows(database, 'SELECT value FROM probe WHERE value=?', 'ready').map(row => ({ ...row })), [{ value: 'ready' }]);
    t.diagnostic(`Reader succeeded after ${Date.now() - started} ms; zero-timeout control failed with SQLITE_BUSY.`);
    await holder.wait();
  } finally { await holder.stop(); }
});

test('acceptance observer fails after its bounded timeout when a lock persists', { timeout: 20000 }, async t => {
  const database = fixture(t);
  const holder = await holdLock(database);
  try {
    const started = Date.now();
    assert.throws(() => readAcceptanceRows(database, 'SELECT value FROM probe'), sqliteBusy);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 4500, `Busy timeout returned too early: ${elapsed} ms`);
    t.diagnostic(`Persistent lock remained an error after ${elapsed} ms.`);
    holder.releaseAfter(0);
    await holder.wait();
  } finally { await holder.stop(); }
});

test('acceptance observer preserves non-busy errors and cannot create a missing database', t => {
  const database = fixture(t);
  assert.throws(() => readAcceptanceRows(database, 'SELECT value FROM missing_table'), /no such table: missing_table/);
  const missing = path.join(path.dirname(database), 'missing.db');
  assert.throws(() => readAcceptanceRows(missing, 'SELECT 1'), /unable to open database file/);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(readAcceptanceRows(database, 'SELECT value FROM probe')[0].value, 'ready');
});
