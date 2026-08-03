import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');
const driftLoader = path.join(repoRoot, 'test', 'fixtures', 'buffer-gc-drift-loader.mjs');
const graceRaceLoader = path.join(repoRoot, 'test', 'fixtures', 'gc-grace-race-loader.mjs');

function runHcc(root, home, args, extraEnv = {}) {
  return execFileSync(process.execPath, [hccBin, '--root', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      HCC_RUNTIME_URL: '',
      ...extraEnv
    }
  });
}

function seedAgeBasedRows(root, ids, oldSec) {
  const dbPath = path.join(root, '.hello-cc', 'mesh.db');
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    db.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
    db.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(Math.floor(Date.now() / 1000)));
    db.prepare(`
      INSERT INTO peers(id, kind, role, worktree, branch, status, capabilities, created_at, last_seen_at)
      VALUES (?, 'shell', 'peer', ?, '', 'exited', '', ?, ?)
    `).run(ids.peer, root, oldSec, oldSec);
    db.prepare(`
      INSERT INTO locks(resource, base_resource, scope, owner, reason, expires_at, created_at, ttl_sec)
      VALUES (?, ?, '*', ?, 'expired', ?, ?, 90)
    `).run(ids.lock, ids.lock, ids.peer, oldSec, oldSec);
    db.prepare(`
      INSERT INTO events(type, actor, payload, created_at)
      VALUES (?, 'seed', '{}', ?)
    `).run(ids.event, oldSec);
  } finally {
    db.close();
  }
  return dbPath;
}

function assertRows(dbPath, ids, expected) {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    assert.equal(Boolean(db.prepare('SELECT 1 FROM peers WHERE id = ?').get(ids.peer)), expected);
    assert.equal(Boolean(db.prepare('SELECT 1 FROM locks WHERE resource = ?').get(ids.lock)), expected);
    assert.equal(Boolean(db.prepare('SELECT 1 FROM events WHERE type = ?').get(ids.event)), expected);
  } finally {
    db.close();
  }
}

for (const mode of ['replace', 'missing']) {
  test(`CLI-only GC defers all database age deletion when a planned buffer becomes ${mode}`, () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-local-gc-${mode}-`));
    const root = path.join(sandbox, 'project');
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(root);
    fs.mkdirSync(home);
    try {
      runHcc(root, home, ['init', '--no-guidance']);
      const directory = path.join(root, '.hello-cc', 'bufs');
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'planned-orphan.out');
      const oldSec = Math.floor(Date.now() / 1000) - 120;
      const oldTime = new Date(oldSec * 1000);
      fs.writeFileSync(file, 'planned');
      fs.utimesSync(file, oldTime, oldTime);
      const ids = {
        peer: `local-drift-peer-${mode}`,
        lock: `local-drift-lock-${mode}`,
        event: `local.drift.event.${mode}`
      };
      const dbPath = seedAgeBasedRows(root, ids, oldSec);

      const driftOutput = runHcc(
        root,
        home,
        ['--json', 'gc', '--older-than', '0', '--history', '--yes'],
        {
          NODE_OPTIONS: `--experimental-loader=${pathToFileURL(driftLoader).href}`,
          HCC_TEST_GC_DRIFT_FILE: file,
          HCC_TEST_GC_DRIFT_MODE: mode
        }
      );
      const drift = JSON.parse(driftOutput).data;
      assert.equal(drift.buf_files, 0);
      assert.equal(drift.old_events, 0);
      assert.equal(drift.expired_locks, 0);
      assert.equal(drift.stale_peers, 0);
      assert.equal(Object.hasOwn(drift, 'wal_checkpoint'), false);
      assert.ok(drift.deferred_buf_files >= 1);
      assert.ok(drift.deferred_old_events >= 1);
      assert.ok(drift.deferred_expired_locks >= 1);
      assert.ok(drift.deferred_stale_peers >= 1);
      assertRows(dbPath, ids, true);
      if (mode === 'replace') assert.ok(fs.existsSync(file));
      else assert.ok(!fs.existsSync(file));

      fs.rmSync(`${file}.planned`, { force: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, 'normal');
      fs.utimesSync(file, oldTime, oldTime);
      const normal = JSON.parse(runHcc(
        root,
        home,
        ['--json', 'gc', '--older-than', '0', '--history', '--yes']
      )).data;
      assert.equal(normal.buf_files, 1);
      assert.equal(normal.deferred_buf_files, 0);
      assert.ok(normal.old_events >= 1);
      assert.ok(normal.expired_locks >= 1);
      assert.ok(normal.stale_peers >= 1);
      assert.equal(Object.hasOwn(normal, 'wal_checkpoint'), true);
      assert.ok(!fs.existsSync(file));
      assertRows(dbPath, ids, false);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { phase: 'before-first-buffer-batch', deleted: 0, deferred: 130 },
  { phase: 'after-first-buffer-batch', deleted: 64, deferred: 66 }
]) {
  test(`CLI-only GC stops frozen buffer batches when grace is extended ${scenario.phase}`, () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-local-gc-${scenario.phase}-`));
    const root = path.join(sandbox, 'project');
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(root);
    fs.mkdirSync(home);
    try {
      runHcc(root, home, ['init', '--no-guidance']);
      const directory = path.join(root, '.hello-cc', 'bufs');
      fs.mkdirSync(directory, { recursive: true });
      const oldSec = Math.floor(Date.now() / 1000) - 120;
      const oldTime = new Date(oldSec * 1000);
      for (let index = 0; index < 130; index += 1) {
        const file = path.join(directory, `planned-${String(index).padStart(3, '0')}.out`);
        fs.writeFileSync(file, 'planned');
        fs.utimesSync(file, oldTime, oldTime);
      }
      const ids = {
        peer: `local-grace-peer-${scenario.phase}`,
        lock: `local-grace-lock-${scenario.phase}`,
        event: `local.grace.event.${scenario.phase}`
      };
      const dbPath = seedAgeBasedRows(root, ids, oldSec);
      const output = runHcc(
        root,
        home,
        ['--json', 'gc', '--older-than', '0', '--history', '--yes'],
        {
          NODE_OPTIONS: `--experimental-loader=${pathToFileURL(graceRaceLoader).href}`,
          HCC_TEST_GC_GRACE_DB: dbPath,
          HCC_TEST_GC_GRACE_PHASE: scenario.phase
        }
      );
      const result = JSON.parse(output).data;
      assert.equal(result.buf_files, scenario.deleted);
      assert.equal(result.deferred_buf_files, scenario.deferred);
      assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.out')).length, scenario.deferred);
      assert.equal(result.expired_locks, 0);
      assert.equal(result.stale_peers, 0);
      assert.equal(result.old_events, 0);
      assert.equal(Object.hasOwn(result, 'wal_checkpoint'), false);
      assertRows(dbPath, ids, true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { phase: 'before-locks', lockDeleted: 0 },
  { phase: 'after-locks', lockDeleted: 1 }
]) {
  test(`manual GC rechecks grace inside DB transactions for ${scenario.phase}`, () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-db-gc-${scenario.phase}-`));
    const root = path.join(sandbox, 'project');
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(root);
    fs.mkdirSync(home);
    try {
      runHcc(root, home, ['init', '--no-guidance']);
      const directory = path.join(root, '.hello-cc', 'bufs');
      fs.mkdirSync(directory, { recursive: true });
      const oldSec = Math.floor(Date.now() / 1000) - 120;
      const oldTime = new Date(oldSec * 1000);
      const file = path.join(directory, 'planned-orphan.out');
      fs.writeFileSync(file, 'planned');
      fs.utimesSync(file, oldTime, oldTime);
      const ids = {
        peer: `db-grace-peer-${scenario.phase}`,
        lock: `db-grace-lock-${scenario.phase}`,
        event: `db.grace.event.${scenario.phase}`
      };
      const dbPath = seedAgeBasedRows(root, ids, oldSec);
      const output = runHcc(
        root,
        home,
        ['--json', 'gc', '--older-than', '0', '--history', '--yes'],
        {
          NODE_OPTIONS: `--experimental-loader=${pathToFileURL(graceRaceLoader).href}`,
          HCC_TEST_GC_GRACE_DB: dbPath,
          HCC_TEST_GC_GRACE_PHASE: scenario.phase
        }
      );
      const result = JSON.parse(output).data;
      assert.equal(result.buf_files, 1);
      assert.equal(result.expired_locks, scenario.lockDeleted);
      assert.equal(result.stale_peers, 0);
      assert.equal(result.old_events, 0);
      assert.ok(result.deferred_stale_peers >= 1);
      assert.ok(result.deferred_old_events >= 1);
      assert.equal(Object.hasOwn(result, 'wal_checkpoint'), scenario.lockDeleted > 0);

      const db = new DatabaseSync(dbPath, { timeout: 5000 });
      try {
        assert.equal(Boolean(db.prepare('SELECT 1 FROM locks WHERE resource = ?').get(ids.lock)), !scenario.lockDeleted);
        assert.ok(db.prepare('SELECT 1 FROM peers WHERE id = ?').get(ids.peer));
        assert.ok(db.prepare('SELECT 1 FROM events WHERE type = ?').get(ids.event));
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
}

test('manual GC stops history after a committed batch when grace is extended between batches', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-db-gc-history-grace-'));
  const root = path.join(sandbox, 'project');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  try {
    runHcc(root, home, ['init', '--no-guidance']);
    const dbPath = path.join(root, '.hello-cc', 'mesh.db');
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const oldSec = nowSec - 120;
      db.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
      db.prepare(`
        INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(nowSec));
      db.prepare('DELETE FROM events').run();
      db.exec('BEGIN');
      const insertEvent = db.prepare(`
        INSERT INTO events(type, actor, payload, created_at) VALUES (?, 'seed', '{}', ?)
      `);
      for (let index = 0; index < 300; index += 1) insertEvent.run(`history.grace.${index}`, oldSec);
      db.prepare(`
        INSERT INTO tasks(title, status, owner, created_at, updated_at)
        VALUES ('open', 'running', NULL, ?, ?)
      `).run(oldSec, oldSec);
      const openTask = Number(db.prepare("SELECT id FROM tasks WHERE title = 'open'").get().id);
      db.prepare(`
        INSERT INTO handoffs(task_id, from_peer, summary, created_at)
        VALUES (?, 'seed', 'protected open handoff', ?)
      `).run(openTask, oldSec);
      db.exec('COMMIT');
    } finally {
      db.close();
    }

    const output = runHcc(
      root,
      home,
      ['--json', 'gc', '--older-than', '0', '--history', '--yes'],
      {
        NODE_OPTIONS: `--experimental-loader=${pathToFileURL(graceRaceLoader).href}`,
        HCC_TEST_GC_GRACE_DB: dbPath,
        HCC_TEST_GC_GRACE_PHASE: 'after-first-history-batch'
      }
    );
    const result = JSON.parse(output).data;
    assert.equal(result.old_events, 256);
    assert.equal(result.deferred_old_events, 44);
    assert.equal(result.old_handoffs, 0);
    assert.equal(result.protected_old_handoffs, 1);
    assert.equal(Object.hasOwn(result, 'wal_checkpoint'), true);

    const after = new DatabaseSync(dbPath, { timeout: 5000 });
    try {
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'history.grace.%'").get().n, 44);
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE summary = 'protected open handoff'").get().n, 1);
    } finally {
      after.close();
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
