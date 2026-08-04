import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { refreshHookOwnerIdentity } from '../lib/core/peers/hook-owner.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE peers (
      id TEXT PRIMARY KEY,
      status TEXT,
      pid INTEGER,
      pid_start_token TEXT,
      pid_command_hash TEXT,
      last_seen_at INTEGER NOT NULL
    );
    INSERT INTO peers VALUES ('provider', 'working', 10, 'old-start', '${'a'.repeat(64)}', 100);
  `);
  return db;
}

test('hook heartbeat clears stale owner identity when ancestry cannot be confirmed', () => {
  const db = fixture();
  try {
    assert.equal(refreshHookOwnerIdentity(db, {
      peerId: 'provider',
      status: 'idle',
      observedAt: 200,
      processIdentity: null
    }), 1);
    assert.deepEqual({ ...db.prepare('SELECT status, pid, pid_start_token, pid_command_hash, last_seen_at FROM peers').get() }, {
      status: 'idle',
      pid: null,
      pid_start_token: null,
      pid_command_hash: null,
      last_seen_at: 200
    });
  } finally {
    db.close();
  }
});

test('hook heartbeat persists a newly confirmed provider identity', () => {
  const db = fixture();
  try {
    const identity = { pid: 20, startToken: 'new-start', commandHash: 'b'.repeat(64) };
    assert.equal(refreshHookOwnerIdentity(db, {
      peerId: 'provider',
      status: 'working',
      observedAt: 300,
      processIdentity: identity
    }), 1);
    assert.deepEqual({ ...db.prepare('SELECT pid, pid_start_token, pid_command_hash, last_seen_at FROM peers').get() }, {
      pid: 20,
      pid_start_token: 'new-start',
      pid_command_hash: 'b'.repeat(64),
      last_seen_at: 300
    });
  } finally {
    db.close();
  }
});
