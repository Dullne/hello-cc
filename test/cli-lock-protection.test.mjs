import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createLockCommands } from '../lib/cli/commands/lock.mjs';
import { createTaskCommands } from '../lib/cli/commands/task.mjs';
import { createTaskStore } from '../lib/core/coordination/tasks.mjs';
import { annotateTasksWithLiveness } from '../lib/core/peers/liveness.mjs';
import { initSchema, tx } from '../lib/db/schema.mjs';
import { createEventHelpers } from '../lib/db/events.mjs';
import * as args from '../lib/cli-args.mjs';
import * as locks from '../lib/core/coordination/locks.mjs';
import * as evidence from '../lib/core/coordination/lock-evidence.mjs';
import { leaseDeadline } from '../lib/core/coordination/lease-renewal.mjs';
import { runOptimisticEvidenceMutation } from '../lib/core/coordination/optimistic-evidence.mjs';
import { observeClockSafetyInTransaction, clockSafetyUnavailable } from '../lib/core/coordination/clock-safety.mjs';
import { clockGraceSuppressed, readClockGraceUntil } from '../lib/shared/clock-grace.mjs';
import { CliError } from '../lib/shared/errors.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  db.prepare("INSERT INTO meta(key,value) VALUES('clock_last_observed_at','1000')").run();
  t.after(() => db.close());
  let output;
  const now = () => 1000;
  const events = createEventHelpers({ now });
  const observePeerEvidence = (_ctx, row) => ({ state: row?.pid_start_token || 'unknown' });
  const common = {
    ...args, ...locks, ...evidence, ...events,
    connect: () => db, now, iso: String, tx, touchCurrentPeer() {},
    resolveCurrentPeer: (_ctx, opts) => ({ id: opts.peer }),
    printResult: (_ctx, value) => { output = value; }, table() {}, CliError,
    DEFAULT_LOCK_TTL: 900, ACTIVE_PEER_TTL: 600,
    leaseDeadline, clockGraceSuppressed, readClockGraceUntil, clockSafetyUnavailable, observePeerEvidence,
    prepareLockClockObservation: (_db, subject, byOwner) => observeClockSafetyInTransaction(db, {
      operation: 'ownership', candidates: evidence.clockCandidatesFromLocks(subject, byOwner), nowSec: subject.observedAt
    }),
    runOptimisticEvidenceMutation, assertTaskOwnerForMutation() {}, notifyTaskOwnerConflict() {}, helpLock() {}
  };
  const lockCommands = createLockCommands(common);
  const taskCommands = createTaskCommands({
    ...common, ...createTaskStore({ now }), annotateTasksWithLiveness, taskOwnerStateText() {}, helpTask() {}
  });
  const peer = (id, state) => db.prepare(`
    INSERT INTO peers(id,kind,status,pid_start_token,created_at,last_seen_at) VALUES(?,'shell','working',?,100,100)
  `).run(id, state);
  const insert = (resource, owner, expiresAt, taskId = null) => db.prepare(`
    INSERT INTO locks(resource,base_resource,scope,owner,task_id,expires_at,created_at,ttl_sec)
    VALUES(?,?,'*',?,?,?,100,900)
  `).run(resource, resource, owner, taskId, expiresAt);
  return { db, lockCommands, taskCommands, peer, insert, output: () => output };
}

test('default lock list shows expired live locks, preserves grace, and performs no clock renewal', async (t) => {
  const f = fixture(t);
  f.peer('alive', 'live'); f.peer('dead', 'dead'); f.peer('unknown', 'unknown');
  f.insert('live-expired', 'alive', 999); f.insert('dead-expired', 'dead', 999);
  f.insert('unknown-expired', 'unknown', 999); f.insert('fresh', 'unknown', 2000);
  const before = {
    locks: f.db.prepare('SELECT * FROM locks ORDER BY resource').all(),
    meta: f.db.prepare('SELECT * FROM meta ORDER BY key').all(),
    eventCount: f.db.prepare('SELECT COUNT(*) AS n FROM events').get().n
  };
  await f.lockCommands.cmdLock({}, ['list']);
  assert.deepEqual(f.output().map((lock) => lock.resource), ['fresh', 'live-expired']);
  assert.deepEqual({
    locks: f.db.prepare('SELECT * FROM locks ORDER BY resource').all(),
    meta: f.db.prepare('SELECT * FROM meta ORDER BY key').all(),
    eventCount: f.db.prepare('SELECT COUNT(*) AS n FROM events').get().n
  }, before);
  await f.lockCommands.cmdLock({}, ['list', '--all']);
  assert.equal(f.output().length, 4);
  f.db.prepare("INSERT INTO meta(key,value) VALUES('clock_grace_until','1100')").run();
  await f.lockCommands.cmdLock({}, ['list']);
  assert.equal(f.output().length, 4);
});

test('task list counts an expired live lock linked to a stale task owner', async (t) => {
  const f = fixture(t);
  f.peer('task-owner', 'dead'); f.peer('lock-owner', 'live');
  const info = f.db.prepare(`
    INSERT INTO tasks(title,status,owner,created_at,updated_at) VALUES('protected task','running','task-owner',100,100)
  `).run();
  const id = Number(info.lastInsertRowid);
  f.insert('retained', 'lock-owner', 999, id);
  await f.taskCommands.cmdTask({}, ['list']);
  assert.equal(f.output()[0].owner_stale, true);
  assert.equal(f.output()[0].related_lock_count, 1);
  assert.equal(f.output()[0].takeover_ready, false);
});

for (const firstIsScoped of [true, false]) {
  test(`colliding lock keys cannot overwrite or release the other resource (${firstIsScoped ? 'scoped first' : 'literal first'})`, async (t) => {
    const f = fixture(t);
    const encoded = locks.scopedLockResource('a', 'b').resource;
    const scoped = ['--resource', 'a', '--scope', 'b'];
    const literal = ['--resource', encoded];
    const first = firstIsScoped ? scoped : literal;
    const second = firstIsScoped ? literal : scoped;
    await f.lockCommands.cmdLock({}, ['acquire', '--peer', 'alice', ...first]);
    const before = f.db.prepare('SELECT * FROM locks').get();
    await assert.rejects(f.lockCommands.cmdLock({}, ['acquire', '--peer', 'bob', ...second]), {
      code: 'LOCK_RESOURCE_COLLISION'
    });
    assert.deepEqual(f.db.prepare('SELECT * FROM locks').get(), before);
    await f.lockCommands.cmdLock({}, ['release', '--peer', 'alice', ...second, '--force']);
    assert.equal(f.output().released, false);
    assert.deepEqual(f.db.prepare('SELECT * FROM locks').get(), before);
    await assert.rejects(f.lockCommands.cmdLock({}, ['renew', '--peer', 'alice', ...second]), { code: 'NOT_FOUND' });
    assert.deepEqual(f.db.prepare('SELECT * FROM locks').get(), before);
    await f.lockCommands.cmdLock({}, ['renew', '--peer', 'alice', ...first, '--ttl', '1200']);
    assert.equal(f.db.prepare('SELECT expires_at FROM locks').get().expires_at, 2200);
    await f.lockCommands.cmdLock({}, ['release', '--peer', 'alice', ...first]);
    assert.equal(f.output().released, true);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM locks').get().n, 0);
  });
}

test('existing unscoped keys with a legacy null base_resource remain renewable and releasable', async (t) => {
  const f = fixture(t);
  f.db.prepare(`
    INSERT INTO locks(resource,base_resource,scope,owner,expires_at,created_at,ttl_sec)
    VALUES('scoped:legacy-resource',NULL,'*','alice',2000,100,900)
  `).run();
  await f.lockCommands.cmdLock({}, ['acquire', '--peer', 'alice', '--resource', 'scoped:legacy-resource']);
  assert.equal(f.output().base_resource, 'scoped:legacy-resource');
  await f.lockCommands.cmdLock({}, ['renew', '--peer', 'alice', '--resource', 'scoped:legacy-resource']);
  await f.lockCommands.cmdLock({}, ['release', '--peer', 'alice', '--resource', 'scoped:legacy-resource']);
  assert.equal(f.output().released, true);
});
