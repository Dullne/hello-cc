import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { decideClockSafety } from '../lib/core/coordination/clock-safety.mjs';
import {
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
