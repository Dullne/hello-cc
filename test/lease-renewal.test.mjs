import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { renewOwnedLocks } from '../lib/core/coordination/lease-renewal.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE locks (
      resource TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      ttl_sec INTEGER NOT NULL
    );
    INSERT INTO locks VALUES ('long', 'owner', 5000, 3600);
    INSERT INTO locks VALUES ('short', 'owner', 1010, 60);
    INSERT INTO locks VALUES ('expired', 'owner', 900, 60);
  `);
  return db;
}

test('heartbeat TTL override updates future TTL without shortening an existing lease', () => {
  const db = fixture();
  try {
    assert.equal(renewOwnedLocks(db, {
      owner: 'owner',
      nowSec: 1000,
      ttlOverride: 75,
      includeExpired: true
    }), 3);
    assert.deepEqual({ ...db.prepare("SELECT expires_at, ttl_sec FROM locks WHERE resource = 'long'").get() }, {
      expires_at: 5000,
      ttl_sec: 75
    });
    assert.deepEqual({ ...db.prepare("SELECT expires_at, ttl_sec FROM locks WHERE resource = 'short'").get() }, {
      expires_at: 1075,
      ttl_sec: 75
    });
  } finally {
    db.close();
  }
});

test('hook renewal caps its target but never shortens a longer lease', () => {
  const db = fixture();
  try {
    assert.equal(renewOwnedLocks(db, {
      owner: 'owner',
      nowSec: 1000,
      ttlCap: 3600,
      includeExpired: false
    }), 2);
    assert.equal(db.prepare("SELECT expires_at FROM locks WHERE resource = 'long'").get().expires_at, 5000);
    assert.equal(db.prepare("SELECT expires_at FROM locks WHERE resource = 'short'").get().expires_at, 1060);
    assert.equal(db.prepare("SELECT expires_at FROM locks WHERE resource = 'expired'").get().expires_at, 900);
  } finally {
    db.close();
  }
});

test('active hook renewal recovers expired locks without changing persisted TTL', () => {
  const db = fixture();
  try {
    assert.equal(renewOwnedLocks(db, {
      owner: 'owner',
      nowSec: 1000,
      ttlCap: 3600,
      includeExpired: true
    }), 3);
    assert.deepEqual({ ...db.prepare("SELECT expires_at, ttl_sec FROM locks WHERE resource = 'expired'").get() }, {
      expires_at: 1060,
      ttl_sec: 60
    });
  } finally {
    db.close();
  }
});

test('renewal rejects a safe TTL whose derived deadline is unsafe', () => {
  const db = fixture();
  try {
    assert.throws(() => renewOwnedLocks(db, {
      owner: 'owner',
      nowSec: 1000,
      ttlOverride: Number.MAX_SAFE_INTEGER,
      includeExpired: true
    }), (error) => error?.code === 'BAD_ARGS' && /deadline/.test(error.message));
    assert.equal(db.prepare("SELECT expires_at FROM locks WHERE resource = 'long'").get().expires_at, 5000);
  } finally {
    db.close();
  }
});

test('renewal accepts the largest TTL whose derived deadline is still safe', () => {
  const db = fixture();
  try {
    const nowSec = 1000;
    const ttl = Number.MAX_SAFE_INTEGER - nowSec;
    assert.equal(renewOwnedLocks(db, {
      owner: 'owner',
      nowSec,
      ttlOverride: ttl,
      includeExpired: true
    }), 3);
    assert.deepEqual({ ...db.prepare("SELECT expires_at, ttl_sec FROM locks WHERE resource = 'short'").get() }, {
      expires_at: Number.MAX_SAFE_INTEGER,
      ttl_sec: ttl
    });
  } finally {
    db.close();
  }
});

test('renewal fails closed on an unsafe persisted TTL', () => {
  const db = fixture();
  try {
    db.prepare("UPDATE locks SET ttl_sec = ? WHERE resource = 'long'").run(Number.MAX_SAFE_INTEGER);
    assert.throws(() => renewOwnedLocks(db, {
      owner: 'owner',
      nowSec: 1000,
      includeExpired: true
    }), (error) => error?.code === 'BAD_STATE' && /persisted TTL/.test(error.message));
    assert.equal(db.prepare("SELECT expires_at FROM locks WHERE resource = 'short'").get().expires_at, 1010);
  } finally {
    db.close();
  }
});
