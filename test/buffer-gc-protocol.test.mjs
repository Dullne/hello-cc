import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { planBufferFiles } from '../lib/runtime/buffer-gc.mjs';
import { collectBufferEvidence } from '../lib/runtime/buffer-evidence.mjs';
import {
  BUFFER_GC_APPLY_BATCH_SIZE,
  applyClockSafeBufferPlan,
  createBufferGcPlanStore
} from '../lib/runtime/buffer-gc-protocol.mjs';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-buffer-protocol-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function clockDb(file) {
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS locks (
      resource TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      ttl_sec INTEGER NOT NULL
    );
  `);
  return db;
}

test('buffer GC tokens are one-shot, bound to root and DB, and expire with cleanup', () => {
  let nowMs = 1000;
  const store = createBufferGcPlanStore({ nowMs: () => nowMs, ttlMs: 100 });
  const record = {
    root: '/project/a',
    dbPath: '/project/a/.hello-cc/mesh.db',
    observedAt: 1,
    retentionSec: 0,
    plan: { cutoffMs: 1000, protectedEntries: [], unknownEntries: [], deleteEntries: [] }
  };

  const token = store.prepare(record);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.pendingCount(), 1);
  assert.deepEqual(store.take({ token, root: record.root, dbPath: record.dbPath }).plan, record.plan);
  assert.equal(store.pendingCount(), 0);
  assert.throws(() => store.take({ token, root: record.root, dbPath: record.dbPath }), /token/i);

  const mismatched = store.prepare(record);
  assert.throws(() => store.take({ token: mismatched, root: '/project/b', dbPath: record.dbPath }), /binding/i);
  assert.equal(store.pendingCount(), 0);

  const expired = store.prepare(record);
  nowMs += 101;
  assert.throws(() => store.take({ token: expired, root: record.root, dbPath: record.dbPath }), /expired/i);
  assert.equal(store.pendingCount(), 0);
});

test('buffer GC tokens are removed by their TTL even without another request', async () => {
  const store = createBufferGcPlanStore({ nowMs: () => 1000, ttlMs: 10 });
  store.prepare({
    root: '/project/a',
    dbPath: '/project/a/.hello-cc/mesh.db',
    observedAt: 1,
    retentionSec: 0,
    plan: { cutoffMs: 1000, protectedEntries: [], unknownEntries: [], deleteEntries: [] }
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.pendingCount(), 0);
});

test('buffer GC applies fixed batches and defers the remainder when grace is extended between batches', (t) => {
  const root = tempRoot(t);
  const directory = path.join(root, 'bufs');
  const dbPath = path.join(root, 'mesh.db');
  fs.mkdirSync(directory);
  for (let index = 0; index < BUFFER_GC_APPLY_BATCH_SIZE * 2 + 2; index += 1) {
    const file = path.join(directory, `candidate-${String(index).padStart(3, '0')}.out`);
    fs.writeFileSync(file, String(index));
    fs.utimesSync(file, new Date(100_000), new Date(100_000));
  }
  const plan = planBufferFiles({ directories: [directory], cutoffMs: 500_000 });
  const db = clockDb(dbPath);
  db.prepare("INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '1000')").run();
  let batches = 0;

  const result = applyClockSafeBufferPlan({
    db,
    plan,
    retentionSec: 0,
    nowSec: () => 1000,
    afterBatch: () => {
      batches += 1;
      if (batches !== 1) return;
      const other = clockDb(dbPath);
      try {
        other.prepare("INSERT INTO meta(key, value) VALUES ('clock_grace_until', '2000')").run();
      } finally {
        other.close();
      }
    }
  });

  assert.deepEqual(result, {
    deleted: BUFFER_GC_APPLY_BATCH_SIZE,
    protected: 0,
    deferred: BUFFER_GC_APPLY_BATCH_SIZE + 2,
    complete: false,
    graceActive: true
  });
  assert.equal(fs.readdirSync(directory).length, BUFFER_GC_APPLY_BATCH_SIZE + 2);
  db.close();
});

test('buffer GC marks a drifted would-delete entry incomplete so database apply stays blocked', (t) => {
  const root = tempRoot(t);
  const directory = path.join(root, 'bufs');
  const dbPath = path.join(root, 'mesh.db');
  fs.mkdirSync(directory);
  const candidate = path.join(directory, 'candidate.out');
  fs.writeFileSync(candidate, 'planned');
  fs.utimesSync(candidate, new Date(100_000), new Date(100_000));
  const plan = planBufferFiles({ directories: [directory], cutoffMs: 500_000 });
  fs.writeFileSync(candidate, 'changed after prepare');
  const db = clockDb(dbPath);
  db.prepare("INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '1000')").run();

  const result = applyClockSafeBufferPlan({
    db,
    plan,
    retentionSec: 0,
    nowSec: () => 1000
  });

  assert.deepEqual(result, {
    deleted: 0,
    protected: 0,
    deferred: 1,
    complete: false,
    graceActive: false
  });
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'changed after prepare');
  db.close();
});

test('buffer GC refreshes owner evidence inside every apply batch', (t) => {
  const root = tempRoot(t);
  const directory = path.join(root, 'bufs');
  const dbPath = path.join(root, 'mesh.db');
  fs.mkdirSync(directory);
  for (let index = 0; index < BUFFER_GC_APPLY_BATCH_SIZE + 1; index += 1) {
    const file = path.join(directory, `candidate-${String(index).padStart(3, '0')}.out`);
    fs.writeFileSync(file, String(index));
    fs.utimesSync(file, new Date(100_000), new Date(100_000));
  }
  const plan = planBufferFiles({ directories: [directory], cutoffMs: 500_000 });
  const liveCandidate = plan.deleteEntries.at(-1).path;
  const liveId = path.basename(liveCandidate, '.out');
  const identity = {
    pid: 91,
    startToken: 'boot:started',
    commandHash: 'c'.repeat(64)
  };
  const db = clockDb(dbPath);
  db.prepare("INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '1000')").run();
  let evidenceCollections = 0;

  const result = applyClockSafeBufferPlan({
    db,
    plan,
    retentionSec: 0,
    nowSec: () => 1000,
    collectEvidence: () => {
      evidenceCollections += 1;
      return collectBufferEvidence({
        directories: [directory],
        inspectProcess: () => ({ state: 'live', identity })
      });
    },
    afterBatch: () => {
      if (evidenceCollections !== 1) return;
      fs.writeFileSync(path.join(directory, `${liveId}.meta`), JSON.stringify({
        wrapper_pid: identity.pid,
        wrapper_identity: identity
      }));
    }
  });

  assert.equal(evidenceCollections, 2);
  assert.deepEqual(result, {
    deleted: BUFFER_GC_APPLY_BATCH_SIZE,
    protected: 1,
    deferred: 0,
    complete: true,
    graceActive: false
  });
  assert.equal(fs.existsSync(liveCandidate), true);
  db.close();
});

test('buffer GC counts an apply-time unknown entry exactly once', (t) => {
  const root = tempRoot(t);
  const directory = path.join(root, 'bufs');
  const dbPath = path.join(root, 'mesh.db');
  fs.mkdirSync(directory);
  const candidate = path.join(directory, 'candidate.out');
  fs.writeFileSync(candidate, 'planned');
  fs.utimesSync(candidate, new Date(100_000), new Date(100_000));
  const plan = planBufferFiles({ directories: [directory], cutoffMs: 500_000 });
  const db = clockDb(dbPath);
  db.prepare("INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '1000')").run();

  const result = applyClockSafeBufferPlan({
    db,
    plan,
    retentionSec: 0,
    nowSec: () => 1000,
    collectEvidence: () => ({
      protectedPaths: new Set(),
      unknownPaths: new Set([candidate])
    })
  });

  assert.deepEqual(result, {
    deleted: 0,
    protected: 0,
    deferred: 1,
    complete: false,
    graceActive: false
  });
  assert.equal(fs.existsSync(candidate), true);
  db.close();
});

test('clock grace preserves refreshed protected counts and defers only non-protected entries', (t) => {
  const root = tempRoot(t);
  const directory = path.join(root, 'bufs');
  const dbPath = path.join(root, 'mesh.db');
  fs.mkdirSync(directory);
  const protectedFile = path.join(directory, 'protected.out');
  const unknownFile = path.join(directory, 'unknown.out');
  for (const file of [protectedFile, unknownFile]) {
    fs.writeFileSync(file, 'planned');
    fs.utimesSync(file, new Date(100_000), new Date(100_000));
  }
  const plan = planBufferFiles({ directories: [directory], cutoffMs: 500_000 });
  const db = clockDb(dbPath);
  db.prepare("INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '1000')").run();
  db.prepare("INSERT INTO meta(key, value) VALUES ('clock_grace_until', '2000')").run();

  const result = applyClockSafeBufferPlan({
    db,
    plan,
    retentionSec: 0,
    nowSec: () => 1000,
    collectEvidence: () => ({
      protectedPaths: new Set([protectedFile]),
      unknownPaths: new Set([unknownFile])
    })
  });

  assert.deepEqual(result, {
    deleted: 0,
    protected: 1,
    deferred: 1,
    complete: false,
    graceActive: true
  });
  assert.equal(fs.existsSync(protectedFile), true);
  assert.equal(fs.existsSync(unknownFile), true);
  db.close();
});

test('apply-time unknown expiry cutoff opens clock grace after a forward jump', (t) => {
  const root = tempRoot(t);
  const directory = path.join(root, 'bufs');
  const dbPath = path.join(root, 'mesh.db');
  fs.mkdirSync(directory);
  const candidate = path.join(directory, 'candidate.out');
  fs.writeFileSync(candidate, 'planned');
  fs.utimesSync(candidate, new Date(100_000), new Date(100_000));
  const plan = planBufferFiles({ directories: [directory], cutoffMs: 500_000 });
  const db = clockDb(dbPath);
  db.prepare("INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '100')").run();

  const result = applyClockSafeBufferPlan({
    db,
    plan,
    retentionSec: 0,
    nowSec: () => 1_000,
    collectEvidence: () => ({
      protectedPaths: new Set(),
      unknownPaths: new Set(),
      gcCutoffs: [220]
    })
  });

  assert.deepEqual(result, {
    deleted: 0,
    protected: 0,
    deferred: 1,
    complete: false,
    graceActive: true
  });
  assert.equal(fs.existsSync(candidate), true);
  db.close();
});

test('prepared unknown expiry cutoff survives when its metadata disappears before apply', (t) => {
  const root = tempRoot(t);
  const directory = path.join(root, 'bufs');
  const dbPath = path.join(root, 'mesh.db');
  fs.mkdirSync(directory);
  const candidate = path.join(directory, 'candidate.out');
  fs.writeFileSync(candidate, 'planned');
  fs.utimesSync(candidate, new Date(100_000), new Date(100_000));
  const plan = planBufferFiles({
    directories: [directory],
    cutoffMs: 500_000,
    evidenceGcCutoffs: [220]
  });
  const db = clockDb(dbPath);
  db.prepare("INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', '100')").run();

  const result = applyClockSafeBufferPlan({
    db,
    plan,
    retentionSec: 0,
    nowSec: () => 1_000,
    collectEvidence: () => ({
      protectedPaths: new Set(),
      unknownPaths: new Set(),
      gcCutoffs: []
    })
  });

  assert.equal(result.deleted, 0);
  assert.equal(result.graceActive, true);
  assert.equal(fs.existsSync(candidate), true);
  db.close();
});
