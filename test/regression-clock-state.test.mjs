import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { observeClockSafety } from '../lib/core/coordination/clock-safety.mjs';
import { initSchema } from '../lib/db/schema.mjs';
import { createLivenessReaper } from '../lib/web/liveness-reaper.mjs';
import { assertGcPreviewMetadata } from '../scripts/helpers/gc-clock-observation.mjs';

const hccBin = path.resolve(import.meta.dirname, '../bin/hcc.mjs');
const readMeta = db => db.prepare('SELECT key, value FROM meta ORDER BY key').all();
const rows = values => Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }));
const metadata = {
  clock_last_observed_at: '100',
  clock_pending_gap: JSON.stringify({ from: 50, to: 100, backward: false, first: false }),
  schema_version: '7'
};

test('active-runtime GC preview allows only an in-window monotonic clock observation', () => {
  const before = rows(metadata);
  const window = { startedAtSec: 100, finishedAtSec: 101 };
  assertGcPreviewMetadata(before, before, window);
  assertGcPreviewMetadata(before, rows({ ...metadata, clock_last_observed_at: '101' }), window);
  for (const value of ['99', '102', '-1', '1.5', '0100', 'NaN', '9007199254740992']) {
    assert.throws(() => assertGcPreviewMetadata(before, rows({ ...metadata, clock_last_observed_at: value }), window), undefined, value);
  }
  for (const changed of [
    { ...metadata, clock_pending_gap: JSON.stringify({ from: 51, to: 100, backward: false, first: false }) },
    { ...metadata, clock_grace_until: '221' },
    { ...metadata, schema_version: '8' },
    { ...metadata, unrelated_key: 'new' }
  ]) {
    assert.throws(() => assertGcPreviewMetadata(before, rows(changed), window), /metadata other than/);
  }
  assert.throws(() => assertGcPreviewMetadata(before, rows({ schema_version: '7' }), window));
  assert.throws(() => assertGcPreviewMetadata(before, [...before, { key: 'clock_last_observed_at', value: '101' }], window), /exactly one/);
  assert.throws(() => assertGcPreviewMetadata(before, before, { startedAtSec: 101, finishedAtSec: 102 }), /outside/);
  assert.throws(() => assertGcPreviewMetadata(before, before, { startedAtSec: 101, finishedAtSec: 100 }), /monotonic/);
});

test('an empty real liveness reaper advances the clock watermark without changing pending gap or other metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-reaper-clock-'));
  const ctx = { root: directory, dbPath: path.join(directory, 'mesh.db') };
  const db = new DatabaseSync(ctx.dbPath);
  let reaper;
  try {
    initSchema(db);
    for (const [key, value] of Object.entries(metadata)) {
      db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    }
    const before = readMeta(db);
    const observations = [];
    const unexpected = () => assert.fail('empty reaper must not inspect or mutate peers');
    reaper = createLivenessReaper({
      ctx, projectContexts: new Map(), sessions: new Map(),
      sessionsForProject: () => [],
      connectWebProject: () => new DatabaseSync(ctx.dbPath),
      now: () => 101,
      addEvent: unexpected, peerEvidenceFromDb: unexpected, mutatePeerWithEvidence: unexpected,
      observeClockSafetyOrThrow: (connection, options) => {
        observations.push(options);
        return observeClockSafety(connection, options);
      },
      UNKNOWN_EVIDENCE_GRACE_SEC: 120,
      redactedLogText: String,
      sameResolvedPath: (a, b) => path.resolve(a) === path.resolve(b)
    });
    reaper.runClockAwareReaper();
    assert.equal(observations.length, 1);
    assert.equal(observations[0].operation, 'ownership');
    assert.deepEqual(observations[0].candidates, []);
    assert.equal(observations[0].nowSec, 101);
    const after = readMeta(db);
    // This deterministically reproduces the former whole-meta assertion failure.
    assert.notDeepEqual(after, before);
    assert.deepEqual(after.map(row => ({ ...row })), before.map(row => ({
      ...row,
      value: row.key === 'clock_last_observed_at' ? '101' : row.value
    })));
    assertGcPreviewMetadata(before, after, { startedAtSec: 100, finishedAtSec: 101 });
  } finally {
    clearInterval(reaper?.reaperPoller);
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI-only GC dry-run with the same pending gap keeps the complete meta table and protected data unchanged', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-gc-preview-clock-'));
  const root = path.join(directory, 'project');
  const env = {
    HOME: path.join(directory, 'home'),
    CODEX_HOME: path.join(directory, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(directory, 'claude'),
    TMPDIR: path.join(directory, 'tmp'),
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    NODE_NO_WARNINGS: '1', HCC_RUNTIME_URL: ''
  };
  fs.mkdirSync(root);
  for (const key of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR']) fs.mkdirSync(env[key]);
  const runHcc = args => execFileSync(process.execPath, [hccBin, '--root', root, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 15_000
  });
  let db;
  try {
    runHcc(['init', '--no-guidance']);
    db = new DatabaseSync(path.join(root, '.hello-cc', 'mesh.db'), { timeout: 5000 });
    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = nowSec - 120;
    const buffer = path.join(root, '.hello-cc', 'bufs', 'orphan.out');
    fs.mkdirSync(path.dirname(buffer), { recursive: true });
    fs.writeFileSync(buffer, 'preserved preview buffer');
    fs.utimesSync(buffer, oldSec, oldSec);
    db.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
    for (const [key, value] of Object.entries({
      clock_last_observed_at: String(nowSec - 1),
      clock_pending_gap: JSON.stringify({ from: oldSec - 1, to: nowSec - 1, backward: false, first: false }),
      preview_sentinel: 'must remain unchanged'
    })) {
      db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    }
    db.prepare(`INSERT INTO peers(id, kind, role, worktree, branch, status, capabilities, created_at, last_seen_at)
      VALUES ('preview-dead', 'shell', 'peer', ?, '', 'exited', '', ?, ?)`).run(root, oldSec, oldSec);
    db.prepare(`INSERT INTO locks(resource, base_resource, scope, owner, reason, expires_at, created_at, ttl_sec)
      VALUES ('preview-lock', 'preview-lock', '*', 'preview-dead', 'expired', ?, ?, 90)`).run(oldSec, oldSec);
    db.prepare("INSERT INTO events(type, actor, payload, created_at) VALUES ('preview.clock', 'seed', '{}', ?)").run(oldSec);
    const persisted = () => ({
      meta: readMeta(db),
      peer: db.prepare("SELECT * FROM peers WHERE id = 'preview-dead'").get(),
      lock: db.prepare("SELECT * FROM locks WHERE resource = 'preview-lock'").get(),
      event: db.prepare("SELECT * FROM events WHERE type = 'preview.clock'").get(),
      buffer: { contents: fs.readFileSync(buffer, 'utf8'), mtimeMs: fs.statSync(buffer).mtimeMs }
    });
    const before = persisted();
    const preview = JSON.parse(runHcc(['--json', 'gc', '--older-than', '0', '--history'])).data;
    for (const key of ['deferred_buf_files', 'deferred_old_events', 'deferred_expired_locks', 'deferred_stale_peers']) {
      assert.ok(preview[key] >= 1, `preview must predict ${key}`);
    }
    assert.deepEqual(persisted(), before);
  } finally {
    db?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
