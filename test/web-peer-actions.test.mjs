import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import * as clockSafety from '../lib/core/coordination/clock-safety.mjs';
import { createWebPeerActions } from '../lib/web/peer-actions.mjs';
import { tx } from '../lib/db/schema.mjs';
import { CliError, publicCliFailure } from '../lib/shared/errors.mjs';

function createFixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-clock-'));
  const dbPath = path.join(dir, 'mesh.db');
  const setup = new DatabaseSync(dbPath);
  setup.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
      transport TEXT,
      runtime_target TEXT,
      updated_at INTEGER
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      owner TEXT,
      status TEXT
    );
    CREATE TABLE locks (
      resource TEXT PRIMARY KEY,
      base_resource TEXT,
      scope TEXT NOT NULL DEFAULT '*',
      owner TEXT NOT NULL,
      task_id INTEGER,
      reason TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      ttl_sec INTEGER NOT NULL DEFAULT 900
    );
  `);
  setup.close();

  const connect = () => {
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    return typeof options.wrapConnection === 'function' ? options.wrapConnection(db) : db;
  };
  const evidenceFor = (row) => {
    if (!row || row.status === 'exited') return { state: 'dead', reason: 'explicit_exited' };
    if (row.pid_start_token === 'live' && row.pid_command_hash === 'live') {
      return { state: 'live', reason: 'process_identity_match' };
    }
    return { state: 'unknown', reason: 'process_identity_incomplete' };
  };
  const peerEvidenceFromDb = (db, _ctx, peer) => evidenceFor(db.prepare(`
    SELECT id, status, pid, pid_start_token, pid_command_hash, last_seen_at
    FROM peers WHERE id = ?
  `).get(peer));
  const actions = createWebPeerActions({
    addEvent: () => {},
    assertTaskOwnerForMutation: () => {},
    claimNextTasksForPeer: () => ({ current: null, tasks: [] }),
    connect,
    detectBranch: () => '',
    now: () => 1000,
    observeClockSafetyInTransaction: options.observeClockSafetyInTransaction || clockSafety.observeClockSafetyInTransaction,
    observePeerEvidence: (_ctx, row) => evidenceFor(row),
    peerEvidenceFromDb,
    positiveIntOpt: (_input, _key, fallback) => fallback,
    queryInbox: () => [],
    statusSnapshot: () => ({}),
    statusSummary: () => ({ active_peers: 0, stale_peers: 0, active_locks: 0, unread: 0 }),
    takeOverTaskForPeer: () => null,
    touchPeer: (db, peer, status) => db.prepare(`
      UPDATE peers SET last_seen_at = 1000, status = COALESCE(?, status) WHERE id = ?
    `).run(status, peer),
    tx,
    upsertPeer: () => {}
  });

  return {
    actions,
    close() { fs.rmSync(dir, { recursive: true, force: true }); },
    dbPath,
    read(fn) {
      const db = connect();
      try { return fn(db); } finally { db.close(); }
    },
    write(fn) {
      const db = connect();
      try { return fn(db); } finally { db.close(); }
    }
  };
}

function seedOwner(fixture, { peer = 'owner', evidence = 'unknown', resource = 'shared', grace = null } = {}) {
  fixture.write((db) => {
    db.prepare(`
      INSERT INTO peers(id, status, pid, pid_start_token, pid_command_hash, last_seen_at)
      VALUES (?, ?, 123, ?, ?, 100)
    `).run(peer, evidence === 'dead' ? 'exited' : 'working', evidence === 'live' ? 'live' : null, evidence === 'live' ? 'live' : null);
    db.prepare(`
      INSERT INTO locks(resource, base_resource, scope, owner, expires_at, created_at, ttl_sec)
      VALUES (?, ?, '*', ?, 500, 100, 90)
    `).run(resource, resource, peer);
    db.prepare("INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '100')").run();
    if (grace !== null) {
      db.prepare("INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?)").run(String(grace));
    }
  });
}

test('Web lock acquire protects an expired unknown owner after a clock gap', () => {
  const fixture = createFixture();
  try {
    seedOwner(fixture);
    assert.throws(() => fixture.actions.webPeerAction(
      { root: '/repo', cwd: '/repo' },
      'taker',
      'lock-acquire',
      { actorPeer: 'taker', resource: 'shared', ttl: 90 }
    ), (error) => error?.code === 'LOCK_HELD');
    const state = fixture.read((db) => ({
      owner: db.prepare("SELECT owner FROM locks WHERE resource = 'shared'").get().owner,
      grace: Number(db.prepare("SELECT value FROM meta WHERE key = 'clock_grace_until'").get()?.value || 0)
    }));
    assert.equal(state.owner, 'owner');
    assert.equal(state.grace, 1120);
  } finally {
    fixture.close();
  }
});

for (const evidence of ['live', 'dead', 'unknown']) {
  test(`Web heartbeat applies ${evidence} clock evidence without blanket renewal`, () => {
    const fixture = createFixture();
    try {
      seedOwner(fixture, { peer: 'worker', evidence, grace: evidence === 'unknown' ? 1100 : null });
      const result = fixture.actions.webPeerAction(
        { root: '/repo', cwd: '/repo' },
        'worker',
        'heartbeat',
        { actorPeer: 'worker', renew_locks: true }
      );
      const state = fixture.read((db) => ({
        expiresAt: db.prepare("SELECT expires_at FROM locks WHERE resource = 'shared'").get().expires_at,
        grace: Number(db.prepare("SELECT value FROM meta WHERE key = 'clock_grace_until'").get()?.value || 0),
        watermark: db.prepare("SELECT value FROM meta WHERE key = 'clock_last_observed_at'").get()?.value
      }));
      assert.equal(result.data.renewed, evidence === 'live' ? 1 : 0);
      assert.equal(state.expiresAt, evidence === 'live' ? 1090 : 500);
      assert.equal(state.grace, evidence === 'unknown' ? 1120 : 0);
      assert.equal(state.watermark, '1000');
    } finally {
      fixture.close();
    }
  });
}

test('Web heartbeat repairs corrupt grace state and keeps unknown ownership retained', () => {
  const fixture = createFixture();
  try {
    seedOwner(fixture, { peer: 'worker' });
    fixture.write((db) => db.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_grace_until', 'corrupt')
    `).run());
    const result = fixture.actions.webPeerAction(
      { root: '/repo', cwd: '/repo' },
      'worker',
      'heartbeat',
      { actorPeer: 'worker', renew_locks: true }
    );
    assert.equal(result.data.renewed, 0);
    assert.deepEqual(fixture.read((db) => ({
      expiresAt: db.prepare("SELECT expires_at FROM locks WHERE resource = 'shared'").get().expires_at,
      grace: db.prepare("SELECT value FROM meta WHERE key = 'clock_grace_until'").get().value
    })), { expiresAt: 500, grace: '1120' });
  } finally {
    fixture.close();
  }
});

test('Web heartbeat never shortens a longer existing lease', () => {
  const fixture = createFixture();
  try {
    seedOwner(fixture, { peer: 'worker', evidence: 'live' });
    fixture.write((db) => db.prepare(`
      UPDATE locks SET expires_at = 5000, ttl_sec = 3600 WHERE resource = 'shared'
    `).run());
    fixture.actions.webPeerAction(
      { root: '/repo', cwd: '/repo' },
      'worker',
      'heartbeat',
      { actorPeer: 'worker', renew_locks: true, ttl: 75 }
    );
    assert.deepEqual(fixture.read((db) => ({ ...db.prepare(`
      SELECT expires_at, ttl_sec FROM locks WHERE resource = 'shared'
    `).get() })), { expires_at: 5000, ttl_sec: 75 });
  } finally {
    fixture.close();
  }
});

test('Web lock and heartbeat TTL inputs reject malformed or non-positive values', () => {
  const fixture = createFixture();
  try {
    seedOwner(fixture, { peer: 'worker', evidence: 'live' });
    for (const ttl of ['1e30', '12junk', '1.5', 0, -1, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => fixture.actions.webPeerAction(
        { root: '/repo', cwd: '/repo' },
        'worker',
        'heartbeat',
        { actorPeer: 'worker', renew_locks: true, ttl }
      ), (error) => error?.code === 'BAD_ARGS');
      assert.throws(() => fixture.actions.webPeerAction(
        { root: '/repo', cwd: '/repo' },
        'worker',
        'lock-acquire',
        { actorPeer: 'worker', resource: `bad-${String(ttl)}`, ttl }
      ), (error) => error?.code === 'BAD_ARGS');
    }
  } finally {
    fixture.close();
  }
});

test('Web clock safety sanitizes an already classified internal error', () => {
  const fixture = createFixture({
    observeClockSafetyInTransaction: () => {
      throw new CliError(
        'CLOCK_SAFETY_UNAVAILABLE',
        'internal sqlite failure at /secret/mesh.db',
        { cause: 'SQLITE_SCHEMA /secret/mesh.db' }
      );
    }
  });
  try {
    seedOwner(fixture, { peer: 'worker' });
    let error;
    try {
      fixture.actions.webPeerAction(
        { root: '/repo', cwd: '/repo' },
        'worker',
        'heartbeat',
        { actorPeer: 'worker', renew_locks: true }
      );
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 'CLOCK_SAFETY_UNAVAILABLE');
    assert.equal(error.message, 'Clock safety state could not be persisted; ownership was left unchanged');
    assert.deepEqual(error.extra, {});
  } finally {
    fixture.close();
  }
});

test('Web heartbeat preserves rollback cleanup while exposing only fixed CLOCK details', () => {
  const primaryError = new Error('SQLITE_SCHEMA /secret/web-heartbeat.db');
  const rollbackError = new Error('SQLITE_IOERR /secret/web-rollback.db');
  let rollbackCalls = 0;
  const fixture = createFixture({
    observeClockSafetyInTransaction: () => { throw primaryError; },
    wrapConnection: (db) => new Proxy(db, {
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
    })
  });
  try {
    seedOwner(fixture, { peer: 'worker' });
    let error;
    try {
      fixture.actions.webPeerAction(
        { root: '/repo', cwd: '/repo' },
        'worker',
        'heartbeat',
        { actorPeer: 'worker', renew_locks: true }
      );
    } catch (caught) {
      error = caught;
    }

    assert.ok(error instanceof AggregateError);
    assert.ok(error.cause instanceof CliError);
    assert.equal(error.cause.code, 'CLOCK_SAFETY_UNAVAILABLE');
    assert.equal(error.cause.message, 'Clock safety state could not be persisted; ownership was left unchanged');
    assert.deepEqual(error.errors, [error.cause, rollbackError]);
    assert.deepEqual(error.cleanup, {
      context: 'Write transaction rollback',
      transactionActive: true,
      connectionUsable: false
    });
    assert.equal(rollbackCalls, 1);

    const failure = publicCliFailure(error);
    const publicJson = JSON.stringify({
      code: failure.error.code,
      message: failure.error.message,
      cleanup_failed: failure.cleanupFailed
    });
    assert.equal(failure.cleanupFailed, true);
    assert.doesNotMatch(publicJson, /secret|SQLITE_SCHEMA|SQLITE_IOERR|web-heartbeat|web-rollback/);
  } finally {
    fixture.close();
  }
});
