import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  CLOCK_SAFETY_PUBLIC_MESSAGE,
  clockSafetyUnavailable
} from '../lib/core/coordination/clock-safety.mjs';
import { runOptimisticEvidenceMutation } from '../lib/core/coordination/optimistic-evidence.mjs';
import { tx } from '../lib/db/schema.mjs';
import { aggregateCleanupFailure } from '../lib/shared/cleanup-error.mjs';
import {
  CliError,
  publicCliFailure
} from '../lib/shared/errors.mjs';
import {
  HISTORY_GC_BATCH_SIZE,
  captureGcLockSubjects,
  captureHistoryGcCutoffs,
  captureHistoryGcPlan,
  createHistoryGcSnapshot,
  dropHistoryGcSnapshot,
  finalizeGcLockSubjects,
  finalizeHistoryGcBatches,
  finalizeHistoryGcPlan,
  historyGcCutoffs,
  runWithHistoryGcSnapshotCleanup,
  runWithHistoryGcSnapshotCleanupAsync
} from '../lib/core/coordination/gc-plan.mjs';

function withDropFailure(db, cleanupError, onDrop = () => {}) {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (/^DROP TABLE IF EXISTS temp\."history_gc_/.test(sql)) {
            onDrop(sql);
            throw cleanupError;
          }
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function matchesCleanupAggregate(error, primaryError, cleanupError, context) {
  assert.ok(error instanceof AggregateError);
  assert.strictEqual(error.cause, primaryError);
  assert.deepEqual(error.errors, [primaryError, cleanupError]);
  assert.match(error.message, context);
  assert.match(error.message, /history_gc_[a-f0-9]{24}/);
  return true;
}

function fixtureDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE peers (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      pid INTEGER,
      pid_start_token TEXT,
      pid_command_hash TEXT,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE peer_bindings (
      peer TEXT PRIMARY KEY,
      provider TEXT,
      provider_session_id TEXT,
      transport TEXT,
      runtime_target TEXT,
      updated_at INTEGER
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT,
      status TEXT NOT NULL,
      owner TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE locks (
      resource TEXT PRIMARY KEY,
      base_resource TEXT,
      scope TEXT NOT NULL,
      owner TEXT NOT NULL,
      task_id INTEGER,
      reason TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      ttl_sec INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT,
      task_id INTEGER,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      reply_to INTEGER,
      thread_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE message_reads (
      message_id INTEGER NOT NULL,
      peer TEXT NOT NULL,
      read_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, peer),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE TABLE handoffs (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      from_peer TEXT NOT NULL,
      to_peer TEXT,
      summary TEXT NOT NULL,
      changed_files TEXT,
      tests TEXT,
      risks TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      actor TEXT,
      task_id INTEGER,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

test('GC lock finalization preserves a lock when its owner re-registers after evidence probing', () => {
  const db = fixtureDb();
  db.exec(`
    INSERT INTO peers VALUES ('owner', 'exited', 10, 'old-start', 'old-command', 100);
    INSERT INTO peer_bindings VALUES ('owner', 'shell', NULL, 'process', NULL, 100);
    INSERT INTO locks VALUES ('src/a', 'src/a', '*', 'owner', NULL, 'old', 500, 100, 90);
  `);
  const planned = captureGcLockSubjects(db, 1000);
  const evidenceByOwner = new Map([['owner', { state: 'dead' }]]);

  db.prepare(`
    UPDATE peers
    SET status = 'working', pid = 20, pid_start_token = 'new-start',
        pid_command_hash = 'new-command', last_seen_at = 1000
    WHERE id = 'owner'
  `).run();

  const result = finalizeGcLockSubjects(db, planned, evidenceByOwner);
  assert.deepEqual(result, { deleted: 0, deferred: 1, live: 0 });
  assert.equal(db.prepare("SELECT owner FROM locks WHERE resource = 'src/a'").get().owner, 'owner');
  db.close();
});

test('GC lock finalization binds task authority and deletes only an unchanged dead-owner subject', () => {
  const db = fixtureDb();
  db.exec(`
    INSERT INTO peers VALUES ('owner', 'exited', 10, 'start', 'command', 100);
    INSERT INTO peer_bindings VALUES ('owner', 'shell', NULL, 'process', NULL, 100);
    INSERT INTO tasks VALUES (1, 'task', 'done', 'owner', 100);
    INSERT INTO locks VALUES ('src/a', 'src/a', '*', 'owner', 1, 'old', 500, 100, 90);
  `);
  const stalePlan = captureGcLockSubjects(db, 1000);
  const evidenceByOwner = new Map([['owner', { state: 'dead' }]]);
  db.prepare("UPDATE tasks SET status = 'running', owner = 'new-owner', updated_at = 1000 WHERE id = 1").run();
  assert.deepEqual(finalizeGcLockSubjects(db, stalePlan, evidenceByOwner), {
    deleted: 0,
    deferred: 1,
    live: 0
  });

  const currentPlan = captureGcLockSubjects(db, 1000);
  assert.deepEqual(finalizeGcLockSubjects(db, currentPlan, evidenceByOwner), {
    deleted: 1,
    deferred: 0,
    live: 0
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM locks WHERE resource = 'src/a'").get().n, 0);
  db.close();
});

test('GC lock finalization defers the frozen set when its in-transaction mutation barrier closes', () => {
  const db = fixtureDb();
  db.exec(`
    INSERT INTO peers VALUES ('owner', 'exited', 10, 'start', 'command', 100);
    INSERT INTO peer_bindings VALUES ('owner', 'shell', NULL, 'process', NULL, 100);
    INSERT INTO locks VALUES ('src/a', 'src/a', '*', 'owner', NULL, 'old', 500, 100, 90);
  `);
  const planned = captureGcLockSubjects(db, 1000);
  const result = finalizeGcLockSubjects(
    db,
    planned,
    new Map([['owner', { state: 'dead' }]]),
    {
      beforeMutate: () => {
        assert.equal(db.isTransaction, true);
        return false;
      }
    }
  );

  assert.deepEqual(result, { deleted: 0, deferred: 1, live: 0, blocked: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM locks WHERE resource = 'src/a'").get().n, 1);
  db.close();
});

function seedHistory(db) {
  db.exec(`
    INSERT INTO tasks VALUES (1, 'done', 'done', 'owner', 100);
    INSERT INTO tasks VALUES (2, 'open', 'running', 'owner', 100);
    INSERT INTO messages VALUES (10, 'a', 'b', 1, 'note', 'old', NULL, NULL, 100);
    INSERT INTO message_reads VALUES (10, 'reader', 200);
    INSERT INTO handoffs VALUES (20, 1, 'a', 'b', 'done handoff', NULL, NULL, NULL, 100);
    INSERT INTO handoffs VALUES (21, 2, 'a', 'b', 'open handoff', NULL, NULL, NULL, 100);
    INSERT INTO events VALUES (30, 'note', 'a', 1, '{}', 100);
  `);
}

test('history GC plans exact rows and preserves handoffs linked to open tasks', () => {
  const db = fixtureDb();
  seedHistory(db);
  const plan = captureHistoryGcPlan(db, 500);
  assert.deepEqual(plan.tasks.map((row) => row.id), [1]);
  assert.deepEqual(plan.messages.map(({ message }) => message.id), [10]);
  assert.deepEqual(plan.messages[0].reads.map((row) => row.peer), ['reader']);
  assert.deepEqual(plan.handoffs.map(({ handoff }) => handoff.id), [20]);
  assert.deepEqual(plan.events.map((row) => row.id), [30]);

  const result = finalizeHistoryGcPlan(db, plan);
  assert.deepEqual(result, {
    applied: true,
    old_events: 1,
    old_tasks: 1,
    old_messages: 1,
    old_handoffs: 1,
    deferred: 0
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_reads').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM handoffs WHERE id = 21').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = 2').get().n, 1);
  db.close();
});

test('history GC snapshot separately counts old handoffs protected by open tasks', () => {
  const db = fixtureDb();
  seedHistory(db);
  const snapshot = createHistoryGcSnapshot(db, 500);

  assert.deepEqual(snapshot.eligibleCounts, {
    events: 1,
    tasks: 1,
    messages: 1,
    handoffs: 1
  });
  assert.deepEqual(snapshot.protectedCounts, {
    events: 0,
    tasks: 0,
    messages: 0,
    handoffs: 1
  });

  dropHistoryGcSnapshot(db, snapshot);
  db.close();
});

test('history GC never sweeps a backdated row inserted by a deletion trigger', () => {
  const db = fixtureDb();
  seedHistory(db);
  const plan = captureHistoryGcPlan(db, 500);
  db.exec(`
    CREATE TRIGGER insert_backdated_message_after_event_delete
    AFTER DELETE ON events
    BEGIN
      INSERT INTO messages VALUES (11, 'late', 'reader', NULL, 'note', 'backdated', NULL, NULL, 50);
    END;
  `);

  const result = finalizeHistoryGcPlan(db, plan);
  assert.equal(result.applied, true);
  assert.equal(db.prepare('SELECT body FROM messages WHERE id = 11').get().body, 'backdated');
  db.close();
});

test('history GC rolls back every category when a planned row changes during finalization', () => {
  const db = fixtureDb();
  seedHistory(db);
  const plan = captureHistoryGcPlan(db, 500);
  db.exec(`
    CREATE TRIGGER change_planned_message_after_event_delete
    AFTER DELETE ON events
    BEGIN
      UPDATE messages SET body = 'changed during apply' WHERE id = 10;
    END;
  `);

  const result = finalizeHistoryGcPlan(db, plan);
  assert.equal(result.applied, false);
  assert.equal(result.deferred, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE id = 30').get().n, 1);
  assert.equal(db.prepare('SELECT body FROM messages WHERE id = 10').get().body, 'old');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = 1').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM handoffs WHERE id = 20').get().n, 1);
  db.close();
});

test('history GC cutoff calculation handles plans larger than the JavaScript argument limit', () => {
  const eventCount = 150_000;
  const plan = {
    categories: ['events'],
    events: Array.from({ length: eventCount }, (_, index) => ({ created_at: index })),
    tasks: [],
    messages: [],
    handoffs: []
  };

  assert.deepEqual(historyGcCutoffs(plan, 10), [eventCount - 1 + 10]);
});

test('event-only history plans do not read unrelated history tables', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE peer_bindings (
      peer TEXT PRIMARY KEY,
      transport TEXT,
      runtime_target TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO events VALUES (1, 'note', '{}', 100);
  `);

  const plan = captureHistoryGcPlan(db, 500, { categories: ['events'] });
  assert.deepEqual(plan.categories, ['events']);
  assert.deepEqual(plan.events.map((row) => row.id), [1]);
  assert.deepEqual(plan.tasks, []);
  assert.deepEqual(plan.messages, []);
  assert.deepEqual(plan.handoffs, []);
  db.close();
});

test('history GC cutoff aggregation covers the full selected snapshot, not only its first batch', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE peer_bindings (
      peer TEXT PRIMARY KEY,
      transport TEXT,
      runtime_target TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  const insert = db.prepare("INSERT INTO events VALUES (?, 'note', '{}', ?)");
  db.exec('BEGIN');
  for (let id = 1; id <= HISTORY_GC_BATCH_SIZE + 1; id += 1) {
    insert.run(id, id === HISTORY_GC_BATCH_SIZE + 1 ? 499 : 100);
  }
  db.exec('COMMIT');

  const plan = captureHistoryGcPlan(db, 500, { categories: ['events'] });
  assert.equal(plan.events.length, HISTORY_GC_BATCH_SIZE);
  assert.deepEqual(captureHistoryGcCutoffs(db, 500, 10, {
    categories: ['events'],
    snapshot: plan.snapshot
  }), [509]);
  db.close();
});

test('event-only history finalization ignores unrelated message and handoff churn', () => {
  const db = fixtureDb();
  seedHistory(db);
  const plan = captureHistoryGcPlan(db, 500, { categories: ['events'] });

  const insertMessage = db.prepare(`
    INSERT INTO messages(id, sender, recipient, task_id, kind, body, reply_to, thread_id, created_at)
    VALUES (?, 'churn', NULL, NULL, 'note', 'unrelated', NULL, NULL, 100)
  `);
  const insertHandoff = db.prepare(`
    INSERT INTO handoffs(id, task_id, from_peer, to_peer, summary, changed_files, tests, risks, created_at)
    VALUES (?, NULL, 'churn', NULL, 'unrelated', NULL, NULL, NULL, 100)
  `);
  db.exec('BEGIN');
  for (let id = 1000; id < 3000; id += 1) {
    insertMessage.run(id);
    insertHandoff.run(id);
  }
  db.exec('COMMIT');

  assert.deepEqual(finalizeHistoryGcPlan(db, plan), {
    applied: true,
    old_events: 1,
    old_tasks: 0,
    old_messages: 0,
    old_handoffs: 0,
    deferred: 0
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2001);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM handoffs').get().n, 2002);
  db.close();
});

test('history GC uses deterministic bounded batches and preserves the initial ID snapshot', () => {
  const db = fixtureDb();
  const total = HISTORY_GC_BATCH_SIZE * 2 + 17;
  const insertEvent = db.prepare(`
    INSERT INTO events(id, type, actor, task_id, payload, created_at)
    VALUES (?, 'note', 'seed', NULL, '{}', 100)
  `);
  db.exec('BEGIN');
  for (let id = 1; id <= total; id += 1) insertEvent.run(id);
  db.exec('COMMIT');

  let plan = captureHistoryGcPlan(db, 500, { categories: ['events'] });
  const snapshot = plan.snapshot;
  const batchSizes = [];
  let deleted = 0;
  while (plan.events.length > 0) {
    batchSizes.push(plan.events.length);
    assert.ok(plan.events.length <= HISTORY_GC_BATCH_SIZE);
    const result = finalizeHistoryGcPlan(db, plan);
    assert.equal(result.applied, true);
    deleted += result.old_events;

    if (batchSizes.length === 1) {
      insertEvent.run(total + 1);
    }
    plan = captureHistoryGcPlan(db, 500, {
      categories: ['events'],
      after: plan.nextAfter,
      snapshot
    });
  }

  assert.deepEqual(batchSizes, [HISTORY_GC_BATCH_SIZE, HISTORY_GC_BATCH_SIZE, 17]);
  assert.equal(deleted, total);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  assert.equal(db.prepare('SELECT id FROM events').get().id, total + 1);
  db.close();
});

function seedEvents(db, count) {
  const insertEvent = db.prepare(`
    INSERT INTO events(id, type, actor, task_id, payload, created_at)
    VALUES (?, 'note', 'seed', NULL, '{}', 100)
  `);
  db.exec('BEGIN');
  for (let id = 1; id <= count; id += 1) insertEvent.run(id);
  db.exec('COMMIT');
}

function historySnapshotNames(db) {
  return db.prepare(`
    SELECT name FROM sqlite_temp_master
    WHERE type = 'table' AND name LIKE 'history_gc_%'
    ORDER BY name
  `).all().map(({ name }) => name);
}

test('history GC defers the full 1000-row snapshot when its first batch drifts', () => {
  const db = fixtureDb();
  seedEvents(db, 1000);
  const plan = captureHistoryGcPlan(db, 500, { categories: ['events'] });
  assert.deepEqual(plan.eligibleCounts, { events: 1000 });

  db.prepare("UPDATE events SET payload = '{\"changed\":true}' WHERE id = 1").run();
  const result = finalizeHistoryGcPlan(db, plan);
  assert.deepEqual(result, {
    applied: false,
    old_events: 0,
    old_tasks: 0,
    old_messages: 0,
    old_handoffs: 0,
    deferred: 1000
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1000);
  db.close();
});

test('history GC subtracts a committed batch before deferring a later drift', () => {
  const db = fixtureDb();
  seedEvents(db, 1000);
  const first = captureHistoryGcPlan(db, 500, { categories: ['events'] });
  const firstResult = finalizeHistoryGcPlan(db, first);
  assert.equal(firstResult.applied, true);
  assert.equal(firstResult.old_events, HISTORY_GC_BATCH_SIZE);

  const second = captureHistoryGcPlan(db, 500, {
    categories: first.categories,
    after: first.nextAfter,
    snapshot: first.snapshot,
    processedCounts: { events: firstResult.old_events }
  });
  db.prepare("UPDATE events SET payload = '{\"changed\":true}' WHERE id = ?")
    .run(second.events[0].id);
  const secondResult = finalizeHistoryGcPlan(db, second);

  assert.deepEqual({
    deleted: firstResult.old_events + secondResult.old_events,
    deferred: secondResult.deferred
  }, { deleted: 256, deferred: 744 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 744);
  db.close();
});

test('history GC stops at an in-transaction mutation barrier and defers the exact snapshot remainder', () => {
  const db = fixtureDb();
  seedEvents(db, HISTORY_GC_BATCH_SIZE + 44);
  const plan = captureHistoryGcPlan(db, 500, { categories: ['events'] });
  let barrierCalls = 0;
  const result = finalizeHistoryGcBatches(db, plan, {
    beforeMutate: () => {
      assert.equal(db.isTransaction, true);
      barrierCalls += 1;
      return barrierCalls === 1;
    }
  });

  assert.deepEqual(result, {
    old_events: HISTORY_GC_BATCH_SIZE,
    old_tasks: 0,
    old_messages: 0,
    old_handoffs: 0,
    deferred: 44
  });
  assert.equal(barrierCalls, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 44);
  db.close();
});

test('history GC shares a bounded batch across categories and completes with zero deferred', () => {
  const db = fixtureDb();
  const event = db.prepare(`
    INSERT INTO events(id, type, actor, task_id, payload, created_at)
    VALUES (?, 'note', 'seed', NULL, '{}', 100)
  `);
  const task = db.prepare(`
    INSERT INTO tasks(id, title, status, owner, updated_at)
    VALUES (?, 'done', 'done', NULL, 100)
  `);
  const message = db.prepare(`
    INSERT INTO messages(id, sender, recipient, task_id, kind, body, reply_to, thread_id, created_at)
    VALUES (?, 'seed', NULL, NULL, 'note', 'old', NULL, NULL, 100)
  `);
  const handoff = db.prepare(`
    INSERT INTO handoffs(id, task_id, from_peer, to_peer, summary, changed_files, tests, risks, created_at)
    VALUES (?, NULL, 'seed', NULL, 'old', NULL, NULL, NULL, 100)
  `);
  db.exec('BEGIN');
  for (let id = 1; id <= 65; id += 1) {
    event.run(id);
    task.run(id);
    message.run(id);
    handoff.run(id);
  }
  db.exec(`
    INSERT INTO tasks VALUES (1000, 'open', 'running', NULL, 100);
    INSERT INTO handoffs VALUES (1000, 1000, 'seed', NULL, 'open', NULL, NULL, NULL, 100);
    COMMIT;
  `);

  const plan = captureHistoryGcPlan(db, 500, { batchSize: 8 });
  assert.deepEqual(plan.eligibleCounts, {
    events: 65,
    tasks: 65,
    messages: 65,
    handoffs: 65
  });
  assert.deepEqual({
    events: plan.events.length,
    tasks: plan.tasks.length,
    messages: plan.messages.length,
    handoffs: plan.handoffs.length
  }, { events: 2, tasks: 2, messages: 2, handoffs: 2 });

  assert.deepEqual(finalizeHistoryGcBatches(db, plan), {
    old_events: 65,
    old_tasks: 65,
    old_messages: 65,
    old_handoffs: 65,
    deferred: 0
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM handoffs').get().n, 1);
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('history GC frozen membership cannot be displaced by a newly eligible lower ID', () => {
  const db = fixtureDb();
  db.exec("INSERT INTO tasks VALUES (1000, 'open', 'running', NULL, 100)");
  const handoff = db.prepare(`
    INSERT INTO handoffs(id, task_id, from_peer, to_peer, summary, changed_files, tests, risks, created_at)
    VALUES (?, ?, 'seed', NULL, 'old', NULL, NULL, NULL, 100)
  `);
  db.exec('BEGIN');
  for (let id = 1; id <= 258; id += 1) handoff.run(id, id === 257 ? 1000 : null);
  db.exec('COMMIT');

  const first = captureHistoryGcPlan(db, 500, { categories: ['handoffs'] });
  assert.deepEqual(first.handoffs.map(({ handoff: row }) => row.id),
    Array.from({ length: 256 }, (_, index) => index + 1));
  const firstResult = finalizeHistoryGcPlan(db, first);
  assert.equal(firstResult.old_handoffs, 256);

  db.prepare("UPDATE tasks SET status = 'done' WHERE id = 1000").run();
  const second = captureHistoryGcPlan(db, 500, {
    categories: first.categories,
    after: first.nextAfter,
    snapshot: first.snapshot,
    processedCounts: { handoffs: 256 }
  });
  assert.deepEqual(second.handoffs.map(({ handoff: row }) => row.id), [258]);
  assert.deepEqual(finalizeHistoryGcPlan(db, second), {
    applied: true,
    old_events: 0,
    old_tasks: 0,
    old_messages: 0,
    old_handoffs: 1,
    deferred: 0
  });
  assert.deepEqual(db.prepare('SELECT id FROM handoffs ORDER BY id').all().map(({ id }) => id), [257]);
  db.close();
});

test('history GC defers an initial member that becomes ineligible without losing later members', () => {
  const db = fixtureDb();
  seedEvents(db, 300);
  const first = captureHistoryGcPlan(db, 500, { categories: ['events'] });
  assert.equal(finalizeHistoryGcPlan(db, first).old_events, 256);

  db.prepare('UPDATE events SET created_at = 600 WHERE id = 257').run();
  const second = captureHistoryGcPlan(db, 500, {
    categories: first.categories,
    after: first.nextAfter,
    snapshot: first.snapshot,
    processedCounts: { events: 256 }
  });
  assert.equal(second.events[0].id, 258);
  assert.deepEqual(finalizeHistoryGcBatches(db, second), {
    old_events: 299,
    old_tasks: 0,
    old_messages: 0,
    old_handoffs: 0,
    deferred: 1
  });
  assert.deepEqual(db.prepare('SELECT id FROM events').all().map(({ id }) => id), [257]);
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('history GC materializes a 125000-row membership without expanding the batch', () => {
  const db = fixtureDb();
  db.exec(`
    WITH RECURSIVE sequence(id) AS (
      SELECT 1
      UNION ALL
      SELECT id + 1 FROM sequence WHERE id < 125000
    )
    INSERT INTO events(id, type, actor, task_id, payload, created_at)
    SELECT id, 'note', 'seed', NULL, '{}', 100 FROM sequence;
  `);

  const snapshot = createHistoryGcSnapshot(db, 500, { categories: ['events'] });
  assert.deepEqual(snapshot.eligibleCounts, { events: 125000 });
  const plan = captureHistoryGcPlan(db, 500, { snapshot, categories: ['events'] });
  assert.equal(plan.events.length, HISTORY_GC_BATCH_SIZE);
  assert.equal(historySnapshotNames(db).length, 1);
  dropHistoryGcSnapshot(db, snapshot);
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('history GC snapshots are isolated on one connection and can be dropped independently', () => {
  const db = fixtureDb();
  seedEvents(db, 3);
  const first = createHistoryGcSnapshot(db, 500, { categories: ['events'] });
  const second = createHistoryGcSnapshot(db, 500, { categories: ['events'] });
  assert.equal(db.isTransaction, false);
  assert.notEqual(first.tableName, second.tableName);
  assert.deepEqual(historySnapshotNames(db), [first.tableName, second.tableName].sort());

  dropHistoryGcSnapshot(db, first);
  assert.deepEqual(historySnapshotNames(db), [second.tableName]);
  assert.deepEqual(captureHistoryGcPlan(db, 500, { snapshot: second }).events.map(({ id }) => id), [1, 2, 3]);
  dropHistoryGcSnapshot(db, second);
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('history GC drops its snapshot when batch deletion throws', () => {
  const db = fixtureDb();
  seedEvents(db, 1);
  const plan = captureHistoryGcPlan(db, 500, { categories: ['events'] });
  db.exec(`
    CREATE TRIGGER fail_history_gc_delete
    BEFORE DELETE ON events
    BEGIN
      SELECT RAISE(ABORT, 'forced history GC failure');
    END;
  `);

  assert.throws(() => finalizeHistoryGcBatches(db, plan), /forced history GC failure/);
  assert.deepEqual(historySnapshotNames(db), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  db.close();
});

test('async history GC owner drops its snapshot after an awaited failure', async () => {
  const db = fixtureDb();
  seedEvents(db, 1);
  const snapshot = createHistoryGcSnapshot(db, 500, { categories: ['events'] });
  const primary = new Error('runtime apply failed');

  await assert.rejects(
    runWithHistoryGcSnapshotCleanupAsync(db, snapshot, async () => {
      await Promise.resolve();
      throw primary;
    }),
    (error) => error === primary
  );
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('history GC removes a partially created snapshot when membership capture fails', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE peer_bindings (peer TEXT PRIMARY KEY, transport TEXT, runtime_target TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT, created_at INTEGER);
    INSERT INTO events VALUES (1, 'note', '{}', 100);
  `);

  assert.throws(() => createHistoryGcSnapshot(db, 500), /no such table: tasks/);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('history GC drops an owned snapshot when processed counts are invalid', () => {
  for (const invalid of [-1, 0.5, 2]) {
    const db = fixtureDb();
    seedEvents(db, 1);
    assert.throws(() => captureHistoryGcPlan(db, 500, {
      categories: ['events'],
      processedCounts: { events: invalid }
    }), /Invalid history GC processed count for events/);
    assert.deepEqual(historySnapshotNames(db), []);
    db.close();
  }
});

test('history GC drops an owned snapshot when the first batch relation query fails', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      sender TEXT,
      recipient TEXT,
      task_id INTEGER,
      kind TEXT,
      body TEXT,
      reply_to INTEGER,
      thread_id INTEGER,
      created_at INTEGER
    );
    INSERT INTO messages VALUES (1, 'seed', NULL, NULL, 'note', 'old', NULL, NULL, 100);
  `);

  assert.throws(() => captureHistoryGcPlan(db, 500, { categories: ['messages'] }),
    /no such table: message_reads/);
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('history GC never cleans an externally owned snapshot after plan construction fails', () => {
  const db = fixtureDb();
  seedEvents(db, 1);
  const snapshot = createHistoryGcSnapshot(db, 500, { categories: ['events'] });

  assert.throws(() => captureHistoryGcPlan(db, 500, {
    snapshot,
    processedCounts: { events: -1 }
  }), /Invalid history GC processed count for events/);
  assert.deepEqual(historySnapshotNames(db), [snapshot.tableName]);
  dropHistoryGcSnapshot(db, snapshot);
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('history GC returns ownership of a successfully constructed snapshot to its caller', () => {
  const db = fixtureDb();
  seedEvents(db, 1);
  const plan = captureHistoryGcPlan(db, 500, { categories: ['events'] });
  assert.deepEqual(historySnapshotNames(db), [plan.snapshot.tableName]);
  dropHistoryGcSnapshot(db, plan.snapshot);
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('history GC reports both plan and cleanup failures without hiding the primary error', () => {
  const db = fixtureDb();
  seedEvents(db, 1);
  const wrappedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (/^DROP TABLE IF EXISTS temp\."history_gc_/.test(sql)) {
            throw new Error('forced snapshot cleanup failure');
          }
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  assert.throws(() => captureHistoryGcPlan(wrappedDb, 500, {
    categories: ['events'],
    processedCounts: { events: -1 }
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.cause?.message || '', /Invalid history GC processed count for events/);
    assert.deepEqual(error.errors.map(({ message }) => message), [
      'Invalid history GC processed count for events',
      'forced snapshot cleanup failure'
    ]);
    return true;
  });
  const [tableName] = historySnapshotNames(db);
  assert.ok(tableName);
  dropHistoryGcSnapshot(db, { tableName });
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('history GC snapshot creation reports fill and cleanup failures in order', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE peer_bindings (peer TEXT PRIMARY KEY, transport TEXT, runtime_target TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT, created_at INTEGER);
    INSERT INTO events VALUES (1, 'note', '{}', 100);
  `);
  const cleanupError = new Error('forced creation snapshot cleanup failure');
  let dropSql = null;
  const wrappedDb = withDropFailure(db, cleanupError, (sql) => { dropSql = sql; });

  assert.throws(() => createHistoryGcSnapshot(wrappedDb, 500), (error) => {
    const primaryError = error.cause;
    assert.match(primaryError?.message || '', /no such table: tasks/);
    return matchesCleanupAggregate(
      error,
      primaryError,
      cleanupError,
      /History GC snapshot creation/
    );
  });
  assert.match(dropSql || '', /^DROP TABLE IF EXISTS temp\."history_gc_[a-f0-9]{24}"$/);
  assert.equal(db.isTransaction, false);
  db.close();
});

test('history GC snapshot creation preserves a failed read transaction rollback', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE peer_bindings (peer TEXT PRIMARY KEY, transport TEXT, runtime_target TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT, created_at INTEGER);
    INSERT INTO events VALUES (1, 'note', '{}', 100);
  `);
  const rollbackError = new Error('forced snapshot read rollback failure');
  const wrappedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (String(sql).trim() === 'ROLLBACK;') throw rollbackError;
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  assert.throws(() => createHistoryGcSnapshot(wrappedDb, 500), (error) => {
    const primaryError = error.cause;
    assert.match(primaryError?.message || '', /no such table: tasks/);
    return matchesCleanupAggregate(
      error,
      primaryError,
      rollbackError,
      /History GC snapshot read transaction/
    );
  });
  assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK;');
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('history GC batch processing reports mutation and cleanup failures without a second drop', () => {
  const db = fixtureDb();
  seedEvents(db, 1);
  const plan = captureHistoryGcPlan(db, 500, { categories: ['events'] });
  db.exec(`
    CREATE TRIGGER fail_history_gc_delete
    BEFORE DELETE ON events
    BEGIN
      SELECT RAISE(ABORT, 'forced history GC batch mutation failure');
    END;
  `);
  const cleanupError = new Error('forced batch snapshot cleanup failure');
  let dropCalls = 0;
  const wrappedDb = withDropFailure(db, cleanupError, () => { dropCalls += 1; });

  assert.throws(() => finalizeHistoryGcBatches(wrappedDb, plan), (error) => {
    const primaryError = error.cause;
    assert.match(primaryError?.message || '', /forced history GC batch mutation failure/);
    return matchesCleanupAggregate(
      error,
      primaryError,
      cleanupError,
      /History GC batch processing/
    );
  });
  assert.equal(dropCalls, 1);
  assert.deepEqual(historySnapshotNames(db), [plan.snapshot.tableName]);
  dropHistoryGcSnapshot(db, plan.snapshot);
  db.close();
});

test('runGc snapshot owner reports primary and cleanup failures without retrying cleanup', () => {
  const db = fixtureDb();
  const snapshot = createHistoryGcSnapshot(db, 500, { categories: ['events'] });
  const primaryError = new Error('forced runGc primary failure');
  const cleanupError = new Error('forced runGc snapshot cleanup failure');
  let dropCalls = 0;
  const wrappedDb = withDropFailure(db, cleanupError, () => { dropCalls += 1; });

  assert.throws(() => runWithHistoryGcSnapshotCleanup(
    wrappedDb,
    snapshot,
    () => { throw primaryError; },
    'History GC run'
  ), (error) => matchesCleanupAggregate(
    error,
    primaryError,
    cleanupError,
    /History GC run/
  ));
  assert.equal(dropCalls, 1);
  dropHistoryGcSnapshot(db, snapshot);
  db.close();
});

test('runGc snapshot owner throws a lone cleanup failure directly', () => {
  const db = fixtureDb();
  const snapshot = createHistoryGcSnapshot(db, 500, { categories: ['events'] });
  const cleanupError = new Error('forced lone runGc snapshot cleanup failure');
  let dropCalls = 0;
  const wrappedDb = withDropFailure(db, cleanupError, () => { dropCalls += 1; });

  assert.throws(() => runWithHistoryGcSnapshotCleanup(
    wrappedDb,
    snapshot,
    () => 'completed',
    'History GC run'
  ), (error) => error === cleanupError);
  assert.equal(dropCalls, 1);
  dropHistoryGcSnapshot(db, snapshot);
  db.close();
});

test('runGc snapshot owner returns the result after exactly one successful cleanup', () => {
  const db = fixtureDb();
  seedEvents(db, 1);
  const snapshot = createHistoryGcSnapshot(db, 500, { categories: ['events'] });
  let operationCalls = 0;

  assert.deepEqual(runWithHistoryGcSnapshotCleanup(
    db,
    snapshot,
    () => {
      operationCalls += 1;
      return { old_events: 1 };
    },
    'History GC run'
  ), { old_events: 1 });
  assert.equal(operationCalls, 1);
  assert.deepEqual(historySnapshotNames(db), []);
  db.close();
});

test('public CLI errors preserve clock sanitization when snapshot cleanup also fails', () => {
  const publicError = new CliError(
    'CLOCK_SAFETY_UNAVAILABLE',
    'Clock safety checks are temporarily unavailable; retry without changing ownership.'
  );
  const cleanupError = new Error('SQLITE_IOERR /secret/project/mesh.db');
  const aggregate = aggregateCleanupFailure(
    publicError,
    cleanupError,
    'History GC run and snapshot cleanup failed'
  );

  const failure = publicCliFailure(aggregate);
  assert.strictEqual(failure?.error, publicError);
  assert.equal(failure?.cleanupFailed, true);
  const publicPayload = JSON.stringify({
    code: failure.error.code,
    message: failure.error.message,
    cleanup_failed: failure.cleanupFailed
  });
  assert.match(publicPayload, /CLOCK_SAFETY_UNAVAILABLE/);
  assert.match(publicPayload, /"cleanup_failed":true/);
  assert.doesNotMatch(publicPayload, /secret|SQLITE_IOERR|mesh\.db/);
});

test('public CLI errors do not misclassify an unrelated aggregate as cleanup failure', () => {
  const publicError = new CliError('BAD_ARGS', 'Invalid request');
  const unrelated = new AggregateError(
    [publicError, new Error('unrelated concurrent failure')],
    'Concurrent operations failed',
    { cause: publicError }
  );
  assert.equal(publicCliFailure(unrelated), null);
});

test('write transactions preserve normal success and successful rollback behavior', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE values_for_tx (value INTEGER)');
  assert.equal(tx(db, () => {
    db.prepare('INSERT INTO values_for_tx VALUES (?)').run(1);
    return 'committed';
  }), 'committed');

  const primaryError = new Error('forced ordinary transaction failure');
  assert.throws(() => tx(db, () => {
    db.prepare('INSERT INTO values_for_tx VALUES (?)').run(2);
    throw primaryError;
  }), (error) => error === primaryError);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(
    db.prepare('SELECT value FROM values_for_tx ORDER BY value').all().map(({ value }) => value),
    [1]
  );
  db.close();
});

test('write transactions report mutation and rollback failures with unusable connection metadata', () => {
  const db = new DatabaseSync(':memory:');
  const primaryError = new Error('forced write transaction mutation failure');
  const rollbackError = new Error('forced write transaction rollback failure');
  let rollbackCalls = 0;
  const wrappedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (String(sql).trim() === 'ROLLBACK;') {
            rollbackCalls += 1;
            throw rollbackError;
          }
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  assert.throws(() => tx(wrappedDb, () => { throw primaryError; }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.strictEqual(error.cause, primaryError);
    assert.deepEqual(error.errors, [primaryError, rollbackError]);
    assert.match(error.message, /Write transaction failed and rollback also failed/);
    assert.deepEqual(error.cleanup, {
      context: 'Write transaction rollback',
      transactionActive: true,
      connectionUsable: false
    });
    return true;
  });
  assert.equal(rollbackCalls, 1);
  assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK;');
  assert.equal(db.isTransaction, false);
  db.close();
});

test('write transaction state probing cannot overwrite mutation and rollback failures', () => {
  const db = new DatabaseSync(':memory:');
  const primaryError = new Error('forced mutation before state probe failure');
  const rollbackError = new Error('forced rollback before state probe failure');
  const wrappedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'isTransaction') throw new Error('forced transaction state probe failure');
      if (property === 'exec') {
        return (sql) => {
          if (String(sql).trim() === 'ROLLBACK;') throw rollbackError;
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  assert.throws(() => tx(wrappedDb, () => { throw primaryError; }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.strictEqual(error.cause, primaryError);
    assert.deepEqual(error.errors, [primaryError, rollbackError]);
    assert.deepEqual(error.cleanup, {
      context: 'Write transaction rollback',
      transactionActive: null,
      connectionUsable: false
    });
    return true;
  });
  db.exec('ROLLBACK;');
  db.close();
});

test('history GC exposes mutation, rollback, and drop failures in deterministic nested order', () => {
  const db = fixtureDb();
  seedEvents(db, 1);
  const plan = captureHistoryGcPlan(db, 500, { categories: ['events'] });
  db.exec(`
    CREATE TRIGGER fail_history_gc_delete
    BEFORE DELETE ON events
    BEGIN
      SELECT RAISE(ABORT, 'forced nested history GC mutation failure');
    END;
  `);
  const rollbackError = new Error('forced nested history GC rollback failure');
  const dropError = new Error('forced nested history GC drop failure');
  let rollbackCalls = 0;
  let dropCalls = 0;
  const wrappedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (String(sql).trim() === 'ROLLBACK;') {
            rollbackCalls += 1;
            throw rollbackError;
          }
          if (/^DROP TABLE IF EXISTS temp\."history_gc_/.test(sql)) {
            dropCalls += 1;
            throw dropError;
          }
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  assert.throws(() => finalizeHistoryGcBatches(wrappedDb, plan), (outerError) => {
    const transactionError = outerError.cause;
    const mutationError = transactionError?.cause;
    assert.ok(outerError instanceof AggregateError);
    assert.ok(transactionError instanceof AggregateError);
    assert.match(mutationError?.message || '', /forced nested history GC mutation failure/);
    assert.deepEqual(transactionError.errors, [mutationError, rollbackError]);
    assert.deepEqual(outerError.errors, [transactionError, dropError]);
    assert.strictEqual(transactionError.cause, mutationError);
    assert.strictEqual(outerError.cause, transactionError);
    assert.match(transactionError.message, /Write transaction failed and rollback also failed/);
    assert.match(outerError.message, /History GC batch processing/);
    assert.deepEqual(transactionError.cleanup, {
      context: 'Write transaction rollback',
      transactionActive: true,
      connectionUsable: false
    });
    assert.equal(outerError.cleanup?.context, 'History GC batch processing');
    assert.equal(outerError.cleanup?.snapshotName, plan.snapshot.tableName);
    return true;
  });
  assert.equal(rollbackCalls, 1);
  assert.equal(dropCalls, 1);
  assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK;');
  dropHistoryGcSnapshot(db, plan.snapshot);
  db.close();
});

test('nested cleanup failures expose the root CLOCK error without public internal details', () => {
  const clockError = new CliError(
    'CLOCK_SAFETY_UNAVAILABLE',
    'Clock safety checks are temporarily unavailable; retry without changing ownership.'
  );
  const rollbackError = new Error('SQLITE_IOERR /secret/rollback.db');
  const dropError = new Error('SQLITE_IOERR /secret/drop.db');
  const transactionError = aggregateCleanupFailure(
    clockError,
    rollbackError,
    'Write transaction failed and rollback also failed'
  );
  const outerError = aggregateCleanupFailure(
    transactionError,
    dropError,
    'History GC snapshot cleanup failed'
  );

  const failure = publicCliFailure(outerError);
  assert.strictEqual(failure?.error, clockError);
  assert.equal(failure?.cleanupFailed, true);
  const publicPayload = JSON.stringify({
    code: failure.error.code,
    message: failure.error.message,
    cleanup_failed: failure.cleanupFailed
  });
  assert.match(publicPayload, /CLOCK_SAFETY_UNAVAILABLE/);
  assert.doesNotMatch(publicPayload, /secret|SQLITE_IOERR|rollback\.db|drop\.db/);
});

test('CLI clock re-read preserves a real rollback cleanup chain while sanitizing its root', () => {
  const db = new DatabaseSync(':memory:');
  const primaryError = new Error('SQLITE_SCHEMA /secret/cli-reread.db');
  const rollbackError = new Error('SQLITE_IOERR /secret/cli-rollback.db');
  let captures = 0;
  let rollbackCalls = 0;
  const wrappedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (String(sql).trim() === 'ROLLBACK;') {
            rollbackCalls += 1;
            throw rollbackError;
          }
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  let internalError;
  try {
    runOptimisticEvidenceMutation(wrappedDb, {
      capture: () => {
        captures += 1;
        if (captures === 2) throw primaryError;
        return { version: 1 };
      },
      observe: () => null,
      same: () => true,
      mutate: () => null
    });
  } catch (error) {
    internalError = clockSafetyUnavailable(error);
  }

  assert.ok(internalError instanceof AggregateError);
  assert.ok(internalError.cause instanceof CliError);
  assert.equal(internalError.cause.code, 'CLOCK_SAFETY_UNAVAILABLE');
  assert.equal(internalError.cause.message, CLOCK_SAFETY_PUBLIC_MESSAGE);
  assert.deepEqual(internalError.errors, [internalError.cause, rollbackError]);
  assert.deepEqual(internalError.cleanup, {
    context: 'Write transaction rollback',
    transactionActive: true,
    connectionUsable: false
  });
  assert.equal(rollbackCalls, 1);

  const failure = publicCliFailure(internalError);
  const publicJson = JSON.stringify({
    code: failure.error.code,
    message: failure.error.message,
    cleanup_failed: failure.cleanupFailed
  });
  const publicText = `${failure.error.code}: ${failure.error.message}; cleanup_failed=${failure.cleanupFailed}`;
  assert.equal(failure.cleanupFailed, true);
  assert.doesNotMatch(publicJson, /secret|SQLITE_SCHEMA|SQLITE_IOERR|cli-reread|cli-rollback/);
  assert.doesNotMatch(publicText, /secret|SQLITE_SCHEMA|SQLITE_IOERR|cli-reread|cli-rollback/);
  db.exec('ROLLBACK;');
  db.close();
});

test('clock sanitization does not classify a non-cleanup aggregate as cleanup failure', () => {
  const nonCleanup = new AggregateError(
    [new Error('first internal failure'), new Error('second internal failure')],
    'untrusted aggregate'
  );
  const sanitized = clockSafetyUnavailable(nonCleanup);
  assert.ok(sanitized instanceof CliError);
  assert.equal(sanitized.code, 'CLOCK_SAFETY_UNAVAILABLE');
  assert.equal(sanitized.message, CLOCK_SAFETY_PUBLIC_MESSAGE);
  assert.deepEqual(publicCliFailure(sanitized), {
    error: sanitized,
    cleanupFailed: false
  });
});
