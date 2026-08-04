import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  decideClockSafety,
  observeClockSafety,
  previewClockSafety
} from '../lib/core/coordination/clock-safety.mjs';
import {
  classifyClockDrift,
  readClockGraceUntil,
  writeClockGraceUntil
} from '../lib/shared/clock-grace.mjs';

test('live evidence crosses expiry without grace and requests renewal', () => {
  assert.deepEqual(decideClockSafety({
    previous: 100,
    current: 1000,
    operation: 'ownership',
    candidates: [{ boundary: 500, evidence: 'live' }]
  }), {
    enterGrace: false,
    renewOwners: true,
    reason: 'verified-live'
  });
});

test('unknown evidence crossing expiry enters grace', () => {
  assert.deepEqual(decideClockSafety({
    previous: 100,
    current: 1000,
    operation: 'ownership',
    candidates: [{ boundary: 500, evidence: 'unknown' }]
  }), {
    enterGrace: true,
    renewOwners: false,
    reason: 'unknown-evidence'
  });
});

test('GC crossing an age cutoff enters grace without owner candidates', () => {
  assert.deepEqual(decideClockSafety({
    previous: 100,
    current: 1000,
    operation: 'gc',
    gcCutoffs: [500]
  }), {
    enterGrace: true,
    renewOwners: false,
    reason: 'gc-cutoff'
  });
});

test('verified dead evidence does not delay ownership', () => {
  assert.deepEqual(decideClockSafety({
    previous: 100,
    current: 1000,
    operation: 'ownership',
    candidates: [{ boundary: 500, evidence: 'dead' }]
  }), {
    enterGrace: false,
    renewOwners: false,
    reason: 'verified-dead'
  });
});

test('backward movement beyond five seconds protects unknown ownership', () => {
  assert.deepEqual(decideClockSafety({
    previous: 100,
    current: 94,
    operation: 'ownership',
    candidates: [{ boundary: 200, evidence: 'unknown' }]
  }), {
    enterGrace: true,
    renewOwners: false,
    reason: 'clock-backward'
  });
});

test('backward movement beyond five seconds protects GC age decisions', () => {
  assert.deepEqual(decideClockSafety({
    previous: 100,
    current: 94,
    operation: 'gc',
    gcCutoffs: []
  }), {
    enterGrace: true,
    renewOwners: false,
    reason: 'clock-backward'
  });
});

test('five-second backward movement does not enter grace', () => {
  assert.equal(decideClockSafety({
    previous: 100,
    current: 95,
    operation: 'ownership',
    candidates: [{ boundary: 200, evidence: 'unknown' }]
  }).enterGrace, false);
});

test('forward movement enters grace only when it crosses a relevant boundary', () => {
  assert.deepEqual(decideClockSafety({
    previous: 100,
    current: 1000,
    operation: 'ownership',
    candidates: [{ boundary: 1200, evidence: 'unknown' }]
  }), {
    enterGrace: false,
    renewOwners: false,
    reason: 'no-boundary-crossing'
  });

  assert.equal(decideClockSafety({
    previous: 100,
    current: 1000,
    operation: 'gc',
    gcCutoffs: [1200]
  }).enterGrace, false);
});

test('first observation protects only ownership candidates at a reached boundary', () => {
  assert.deepEqual(decideClockSafety({
    previous: undefined,
    current: 1000,
    operation: 'ownership',
    candidates: [{ boundary: 500, evidence: 'unknown' }]
  }), {
    enterGrace: true,
    renewOwners: false,
    reason: 'first-observation'
  });

  assert.deepEqual(decideClockSafety({
    previous: undefined,
    current: 1000,
    operation: 'ownership',
    candidates: [{ boundary: 500, evidence: 'live' }]
  }), {
    enterGrace: false,
    renewOwners: true,
    reason: 'verified-live'
  });

  assert.deepEqual(decideClockSafety({
    previous: undefined,
    current: 1000,
    operation: 'ownership',
    candidates: [{ boundary: 500, evidence: 'dead' }]
  }), {
    enterGrace: false,
    renewOwners: false,
    reason: 'verified-dead'
  });

  assert.equal(decideClockSafety({
    previous: undefined,
    current: 1000,
    operation: 'ownership',
    candidates: [{ boundary: 1200, evidence: 'unknown' }]
  }).enterGrace, false);
});

test('first GC observation protects reached cutoffs but not future cutoffs', () => {
  assert.deepEqual(decideClockSafety({
    previous: undefined,
    current: 1000,
    operation: 'gc',
    gcCutoffs: [500]
  }), {
    enterGrace: true,
    renewOwners: false,
    reason: 'first-observation'
  });

  assert.equal(decideClockSafety({
    previous: undefined,
    current: 1000,
    operation: 'gc',
    gcCutoffs: [1200]
  }).enterGrace, false);
});

test('clock observations reject invalid scalar fields instead of failing open', () => {
  const valid = {
    previous: 100,
    current: 1000,
    operation: 'ownership',
    candidates: [{ boundary: 500, evidence: 'unknown' }]
  };

  for (const current of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => decideClockSafety({ ...valid, current }), /current/);
  }
  for (const previous of [Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => decideClockSafety({ ...valid, previous }), /previous/);
  }
  for (const operation of [undefined, 'status']) {
    assert.throws(() => decideClockSafety({ ...valid, operation }), /operation/);
  }
});

test('clock observations reject malformed evidence and boundaries', () => {
  const valid = { previous: 100, current: 1000, operation: 'ownership' };

  assert.throws(() => decideClockSafety({ ...valid, candidates: null }), /candidates/);
  assert.throws(() => decideClockSafety({ ...valid, gcCutoffs: null }), /gcCutoffs/);

  for (const candidate of [
    { boundary: undefined, evidence: 'unknown' },
    { boundary: Number.NaN, evidence: 'unknown' },
    { boundary: Number.POSITIVE_INFINITY, evidence: 'unknown' },
    { boundary: 500, evidence: undefined },
    { boundary: 500, evidence: 'maybe' }
  ]) {
    assert.throws(() => decideClockSafety({ ...valid, candidates: [candidate] }), /candidate/);
  }

  for (const cutoff of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => decideClockSafety({
      previous: 100,
      current: 1000,
      operation: 'gc',
      gcCutoffs: [cutoff]
    }), /gcCutoff/);
  }
});

test('grace writes preserve the maximum deadline regardless of writer order', () => {
  const runOrder = (deadlines) => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const persisted = deadlines.map((deadline) => writeClockGraceUntil(db, deadline));
    const finalDeadline = readClockGraceUntil(db);
    db.close();
    return { persisted, finalDeadline };
  };

  assert.deepEqual(runOrder([120, 300]), {
    persisted: [120, 300],
    finalDeadline: 300
  });
  assert.deepEqual(runOrder([300, 120]), {
    persisted: [300, 300],
    finalDeadline: 300
  });
});

test('grace persistence failures are observable', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(() => writeClockGraceUntil(db, 120), /meta/i);
  db.close();
});

test('grace writes reject invalid deadlines without changing persisted state', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  assert.equal(writeClockGraceUntil(db, 300), 300);

  for (const deadline of [
    undefined,
    null,
    '120',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1
  ]) {
    assert.throws(() => writeClockGraceUntil(db, deadline), /deadline/);
    assert.equal(readClockGraceUntil(db), 300);
  }
  db.close();
});

test('grace writes reject corrupt persisted deadlines without reporting success', () => {
  for (const corrupt of ['not-a-number', '-1', '1.5', '9007199254740992', '012']) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare("INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?)").run(corrupt);

    assert.throws(() => writeClockGraceUntil(db, 300), /persisted deadline/);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'clock_grace_until'").get().value, corrupt);
    db.close();
  }
});

test('grace reads accept a missing row and canonical non-negative integer text', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  assert.equal(readClockGraceUntil(db), 0);

  db.prepare("INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?)").run('0');
  assert.equal(readClockGraceUntil(db), 0);

  db.prepare("UPDATE meta SET value = ? WHERE key = 'clock_grace_until'").run('300');
  assert.equal(readClockGraceUntil(db), 300);
  db.close();
});

test('grace reads reject corrupt persisted deadline text without truncation', () => {
  for (const corrupt of [
    '12junk',
    '1.5',
    '-1',
    'Infinity',
    'NaN',
    '9007199254740992',
    '',
    '012'
  ]) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare("INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?)").run(corrupt);

    assert.throws(() => readClockGraceUntil(db), /persisted deadline/);
    db.close();
  }
});

test('observer atomically renews verified-live retained locks and advances watermark', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE locks (
      resource TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      ttl_sec INTEGER NOT NULL
    );
    INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '100');
    INSERT INTO locks(resource, owner, expires_at, ttl_sec)
    VALUES ('src/live', 'live-owner', 500, 90);
  `);

  const result = observeClockSafety(db, {
    operation: 'ownership',
    nowSec: 1000,
    candidates: [{
      boundary: 500,
      evidence: 'live',
      owner: 'live-owner',
      resource: 'src/live'
    }]
  });

  assert.deepEqual(result, {
    decision: { enterGrace: false, renewOwners: true, reason: 'verified-live' },
    graceUntil: 0,
    renewed: 1
  });
  assert.equal(
    db.prepare("SELECT value FROM meta WHERE key = 'clock_last_observed_at'").get().value,
    '1000'
  );
  const lock = db.prepare('SELECT expires_at, ttl_sec FROM locks WHERE resource = ?').get('src/live');
  assert.equal(lock.expires_at, 1090);
  assert.equal(lock.ttl_sec, 90);
  assert.equal(readClockGraceUntil(db), 0);
  db.close();
});

test('observer grants unknown evidence exactly one grace window and dead evidence none', () => {
  const run = (evidence) => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '100');
    `);
    const result = observeClockSafety(db, {
      operation: 'ownership',
      nowSec: 1000,
      candidates: [{ boundary: 500, evidence }]
    });
    const watermark = db.prepare("SELECT value FROM meta WHERE key = 'clock_last_observed_at'").get().value;
    db.close();
    return { result, watermark };
  };

  assert.deepEqual(run('unknown'), {
    result: {
      decision: { enterGrace: true, renewOwners: false, reason: 'unknown-evidence' },
      graceUntil: 1120,
      renewed: 0
    },
    watermark: '1000'
  });
  assert.deepEqual(run('dead'), {
    result: {
      decision: { enterGrace: false, renewOwners: false, reason: 'verified-dead' },
      graceUntil: 0,
      renewed: 0
    },
    watermark: '1000'
  });
});

test('observer rolls back grace and watermark together when persistence fails', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '100');
    INSERT INTO meta(key, value) VALUES ('clock_grace_until', 'corrupt');
  `);

  assert.throws(() => observeClockSafety(db, {
    operation: 'ownership',
    nowSec: 1000,
    candidates: [{ boundary: 500, evidence: 'unknown' }]
  }), /persisted deadline/);
  assert.equal(
    db.prepare("SELECT value FROM meta WHERE key = 'clock_last_observed_at'").get().value,
    '100'
  );
  db.close();
});

test('observer honors a poller jump signal even when another writer refreshed the watermark', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '1000');
  `);

  const result = observeClockSafety(db, {
    operation: 'ownership',
    nowSec: 1000,
    clockJump: { kind: 'forward', deltaMs: 86400000 },
    candidates: [{ boundary: 500, evidence: 'unknown' }]
  });
  assert.equal(result.decision.enterGrace, true);
  assert.equal(result.graceUntil, 1120);
  db.close();
});

test('wall versus monotonic drift ignores event-loop stalls and detects clock steps', () => {
  assert.equal(classifyClockDrift({ wallDeltaMs: 120000, monotonicDeltaMs: 120000 }), null);
  assert.deepEqual(
    classifyClockDrift({ wallDeltaMs: 120000, monotonicDeltaMs: 30000 }),
    { kind: 'forward', driftMs: 90000, wallDeltaMs: 120000, monotonicDeltaMs: 30000 }
  );
  assert.deepEqual(
    classifyClockDrift({ wallDeltaMs: 18000, monotonicDeltaMs: 30000 }),
    { kind: 'backward', driftMs: -12000, wallDeltaMs: 18000, monotonicDeltaMs: 30000 }
  );
});

function pendingGap(db) {
  const value = db.prepare("SELECT value FROM meta WHERE key = 'clock_pending_gap'").get()?.value;
  return value ? JSON.parse(value) : null;
}

function sequenceDb({ withLock = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE locks (
      resource TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      ttl_sec INTEGER NOT NULL
    );
    INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '100');
    ${withLock ? "INSERT INTO locks(resource, owner, expires_at, ttl_sec) VALUES ('src/live', 'live-owner', 500, 90);" : ''}
  `);
  return db;
}

test('clock preview predicts pending-gap grace without changing persisted metadata', () => {
  const db = sequenceDb();
  db.prepare(`
    INSERT INTO meta(key, value) VALUES ('clock_pending_gap', ?)
  `).run(JSON.stringify({ from: 100, to: 1000, backward: false, first: false }));
  const before = db.prepare('SELECT key, value FROM meta ORDER BY key').all();

  const preview = previewClockSafety(db, {
    operation: 'gc',
    nowSec: 1001,
    gcCutoffs: [500]
  });

  assert.deepEqual(preview, {
    decision: { enterGrace: true, renewOwners: false, reason: 'gc-cutoff' },
    graceUntil: 1121
  });
  assert.deepEqual(db.prepare('SELECT key, value FROM meta ORDER BY key').all(), before);
  db.close();
});

test('empty observation preserves a gap for a later unknown boundary', () => {
  const db = sequenceDb();
  const empty = observeClockSafety(db, { operation: 'ownership', nowSec: 1000 });
  assert.equal(empty.graceUntil, 0);
  assert.deepEqual(pendingGap(db), { from: 100, to: 1000, backward: false, first: false });

  const unknown = observeClockSafety(db, {
    operation: 'ownership',
    nowSec: 1001,
    candidates: [{ boundary: 500, evidence: 'unknown' }]
  });
  assert.equal(unknown.decision.enterGrace, true);
  assert.equal(unknown.graceUntil, 1121);
  assert.equal(pendingGap(db), null);
  db.close();
});

for (const evidence of ['live', 'dead']) {
  test(`${evidence} observation cannot consume a gap needed by a later unknown owner`, () => {
    const db = sequenceDb({ withLock: evidence === 'live' });
    const first = observeClockSafety(db, {
      operation: 'ownership',
      nowSec: 1000,
      candidates: [{
        boundary: 400,
        evidence,
        ...(evidence === 'live' ? { owner: 'live-owner', resource: 'src/live' } : {})
      }]
    });
    assert.equal(first.decision.enterGrace, false);
    assert.deepEqual(pendingGap(db), { from: 100, to: 1000, backward: false, first: false });

    const unknown = observeClockSafety(db, {
      operation: 'ownership',
      nowSec: 1001,
      candidates: [{ boundary: 500, evidence: 'unknown' }]
    });
    assert.equal(unknown.decision.enterGrace, true);
    assert.equal(unknown.graceUntil, 1121);
    assert.equal(pendingGap(db), null);
    db.close();
  });
}

test('pending and newly observed gaps merge until an unknown boundary consumes them', () => {
  const db = sequenceDb();
  observeClockSafety(db, { operation: 'ownership', nowSec: 500 });
  observeClockSafety(db, { operation: 'ownership', nowSec: 1000 });
  assert.deepEqual(pendingGap(db), { from: 100, to: 1000, backward: false, first: false });

  const unknown = observeClockSafety(db, {
    operation: 'ownership',
    nowSec: 1001,
    candidates: [{ boundary: 750, evidence: 'unknown' }]
  });
  assert.equal(unknown.graceUntil, 1121);
  assert.equal(pendingGap(db), null);
  db.close();
});

test('unknown consumption creates shared grace and live renewal does not repeat without a new crossing', () => {
  const db = sequenceDb({ withLock: true });
  const live = observeClockSafety(db, {
    operation: 'ownership',
    nowSec: 1000,
    candidates: [{ boundary: 500, evidence: 'live', owner: 'live-owner', resource: 'src/live' }]
  });
  assert.equal(live.renewed, 1);
  assert.equal(db.prepare("SELECT expires_at FROM locks WHERE resource = 'src/live'").get().expires_at, 1090);

  const noRepeat = observeClockSafety(db, {
    operation: 'ownership',
    nowSec: 1001,
    candidates: [{ boundary: 1090, evidence: 'live', owner: 'live-owner', resource: 'src/live' }]
  });
  assert.equal(noRepeat.renewed, 0);

  const unknown = observeClockSafety(db, {
    operation: 'ownership',
    nowSec: 1002,
    candidates: [{ boundary: 750, evidence: 'unknown' }]
  });
  assert.equal(unknown.graceUntil, 1122);
  assert.equal(pendingGap(db), null);

  const shared = observeClockSafety(db, { operation: 'ownership', nowSec: 1003 });
  assert.equal(shared.graceUntil, 1122);
  db.close();
});

test('backward pending gap renews a verified-live expired lock once and remains for unknown evidence', () => {
  const db = sequenceDb({ withLock: true });
  db.prepare("UPDATE locks SET expires_at = 85 WHERE resource = 'src/live'").run();
  observeClockSafety(db, { operation: 'ownership', nowSec: 90 });
  assert.deepEqual(pendingGap(db), { from: 90, to: 100, backward: true, first: false });

  const live = observeClockSafety(db, {
    operation: 'ownership',
    nowSec: 91,
    candidates: [{ boundary: 85, evidence: 'live', owner: 'live-owner', resource: 'src/live' }]
  });
  assert.equal(live.renewed, 1);
  assert.equal(db.prepare("SELECT expires_at FROM locks WHERE resource = 'src/live'").get().expires_at, 181);
  assert.equal(pendingGap(db)?.backward, true);

  const unknown = observeClockSafety(db, {
    operation: 'ownership',
    nowSec: 92,
    candidates: [{ boundary: 500, evidence: 'unknown' }]
  });
  assert.equal(unknown.graceUntil, 212);
  assert.equal(pendingGap(db), null);
  db.close();
});

// CS-01: ordinary forward progress must not create or extend a gap. A
// jump-induced gap is finite; after it is consumed by grace, steady-state
// observations converge (no new gap, no spurious grace), so age-based GC is
// not deferred forever.
test('steady state converges: small forward steps create no gap and no grace', () => {
  const db = sequenceDb();
  // Jump: a 900s forward step from the seeded baseline (100) creates a gap.
  const jump = observeClockSafety(db, { operation: 'gc', nowSec: 1000 });
  assert.deepEqual(pendingGap(db), { from: 100, to: 1000, backward: false, first: false });
  assert.equal(jump.decision.enterGrace, false);

  // Ordinary 30s ticks: no gap growth, no new grace. GC cutoffs in the
  // normal range (far outside the recent jump window) must not defer.
  for (let tick = 1030; tick <= 1150; tick += 30) {
    const obs = observeClockSafety(db, { operation: 'gc', nowSec: tick, gcCutoffs: [50] });
    assert.equal(obs.decision.enterGrace, false);
  }
  // The persisted gap is unchanged (not extended by ordinary ticks).
  assert.deepEqual(pendingGap(db), { from: 100, to: 1000, backward: false, first: false });

  // Consume it with an unknown candidate inside the window → grace, gap cleared.
  const unknown = observeClockSafety(db, {
    operation: 'ownership',
    nowSec: 1151,
    candidates: [{ boundary: 500, evidence: 'unknown' }]
  });
  assert.equal(unknown.decision.enterGrace, true);
  assert.equal(pendingGap(db), null);

  // After the grace window, ordinary GC observations no longer defer.
  const afterGrace = observeClockSafety(db, { operation: 'gc', nowSec: 1260, gcCutoffs: [50] });
  assert.equal(afterGrace.decision.enterGrace, false);
  assert.equal(pendingGap(db), null);
  db.close();
});

test('small forward steps below the gap threshold never create a gap', () => {
  const db = sequenceDb();
  const obs = observeClockSafety(db, { operation: 'ownership', nowSec: 130 });
  assert.equal(obs.graceUntil, 0);
  assert.equal(pendingGap(db), null);
  db.close();
});
