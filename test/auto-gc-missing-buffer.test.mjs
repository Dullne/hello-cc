import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createGcCommands } from '../lib/cli/commands/gc.mjs';
import { observeClockSafetyInTransaction } from '../lib/core/coordination/clock-safety.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');
const nowSec = 2_000_000_000;

function unusedPeerDependency() {
  throw new Error('peer dependency should not be used for an empty auto-GC subject');
}

const { runGc } = createGcCommands({
  now: () => nowSec,
  UNKNOWN_EVIDENCE_GRACE_SEC: 120,
  BUFS_DIR_NAME: 'bufs',
  peerMutationSubject: unusedPeerDependency,
  mutatePeerWithEvidence: unusedPeerDependency,
  observeClockSafetyInTransactionOrThrow: observeClockSafetyInTransaction,
  observePeerEvidence: unusedPeerDependency
});

function fixture(t, name) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `hcc-auto-gc-${name}-`));
  let db = null;
  t.after(() => {
    db?.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const root = path.join(sandbox, 'project');
  const testHome = path.join(sandbox, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(testHome);
  execFileSync(process.execPath, [hccBin, '--root', root, 'init', '--no-guidance'], {
    cwd: root,
    env: { ...process.env, HOME: testHome, HCC_RUNTIME_URL: '' }
  });

  const bufs = path.join(root, '.hello-cc', 'bufs');
  fs.rmSync(bufs, { recursive: true, force: true });
  db = new DatabaseSync(path.join(root, '.hello-cc', 'mesh.db'), { timeout: 5000 });
  db.prepare("DELETE FROM meta WHERE key IN ('clock_grace_until', 'clock_pending_gap')").run();
  db.prepare(`
    INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(nowSec));
  db.prepare('DELETE FROM events').run();
  db.prepare(`
    INSERT INTO events(type, actor, payload, created_at)
    VALUES ('auto.gc.old', 'test', '{}', ?)
  `).run(nowSec - 15 * 86400);

  return { root, bufs, db };
}

function runAutomaticGc({ root, db }) {
  return runGc({ root }, db, {
    olderThanDays: 14,
    scope: 'auto',
    collectBufferEvidenceNow: () => ({
      protectedPaths: new Set(),
      unknownPaths: new Set(),
      gcCutoffs: []
    })
  });
}

test('automatic GC treats an absent buffer directory as empty without recreating it', (t) => {
  const state = fixture(t, 'missing');

  const result = runAutomaticGc(state);

  assert.equal(result.buf_files, 0);
  assert.equal(result.protected_buf_files, 0);
  assert.equal(result.deferred_buf_files, 0);
  assert.equal(result.old_events, 1);
  assert.equal(fs.existsSync(state.bufs), false);
});

test('automatic GC accepts a project-root alias with real state directories', (t) => {
  const state = fixture(t, 'root-alias');
  const alias = path.join(path.dirname(state.root), 'project-alias');
  const victim = path.join(state.bufs, 'victim.out');
  fs.mkdirSync(state.bufs);
  fs.writeFileSync(victim, 'old');
  const oldTime = new Date((nowSec - 15 * 86400) * 1000);
  fs.utimesSync(victim, oldTime, oldTime);
  fs.symlinkSync(state.root, alias);

  const result = runAutomaticGc({ ...state, root: alias });

  assert.equal(result.buf_files, 1);
  assert.equal(result.old_events, 1);
  assert.equal(fs.existsSync(victim), false);
});

test('automatic GC still rejects an existing buffer-directory symlink', (t) => {
  const state = fixture(t, 'symlink');
  const outside = path.join(path.dirname(state.root), 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, state.bufs);

  assert.throws(() => runAutomaticGc(state));
  assert.equal(fs.lstatSync(state.bufs).isSymbolicLink(), true);
});

test('automatic GC rejects a buffer directory replaced by a symlink after preflight', (t) => {
  const state = fixture(t, 'preflight-symlink-race');
  const canonicalBufs = path.join(fs.realpathSync.native(state.root), '.hello-cc', 'bufs');
  const moved = `${state.bufs}.moved`;
  const outside = path.join(path.dirname(state.root), 'outside');
  fs.mkdirSync(state.bufs);
  fs.mkdirSync(outside);

  const originalLstatSync = fs.lstatSync;
  let replaced = false;
  fs.lstatSync = function interceptedLstat(value, ...args) {
    const stat = originalLstatSync.call(this, value, ...args);
    if (!replaced && path.resolve(String(value)) === canonicalBufs) {
      replaced = true;
      fs.renameSync(state.bufs, moved);
      fs.symlinkSync(outside, state.bufs);
    }
    return stat;
  };
  try {
    assert.throws(
      () => runAutomaticGc(state),
      (error) => error?.code === 'PROJECT_PATH_FORBIDDEN'
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  assert.equal(replaced, true);
  assert.equal(fs.lstatSync(state.bufs).isSymbolicLink(), true);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
});

test('automatic GC rejects a state-directory symlink without touching external buffers or history', (t) => {
  const state = fixture(t, 'state-symlink');
  const stateDirectory = path.dirname(state.bufs);
  const movedStateDirectory = `${stateDirectory}.moved`;
  const outsideStateDirectory = path.join(path.dirname(state.root), 'outside-state');
  const outsideBufs = path.join(outsideStateDirectory, 'bufs');
  const victim = path.join(outsideBufs, 'victim.out');
  fs.mkdirSync(outsideBufs, { recursive: true });
  fs.writeFileSync(victim, 'external');
  const oldTime = new Date((nowSec - 15 * 86400) * 1000);
  fs.utimesSync(victim, oldTime, oldTime);
  fs.renameSync(stateDirectory, movedStateDirectory);
  fs.symlinkSync(outsideStateDirectory, stateDirectory);

  assert.throws(
    () => runAutomaticGc(state),
    (error) => error?.code === 'PROJECT_PATH_FORBIDDEN'
  );
  assert.equal(fs.readFileSync(victim, 'utf8'), 'external');
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
});

test('automatic GC never recreates state removed after buffer lease canonicalization', (t) => {
  const state = fixture(t, 'lease-disappearance');
  const stateDirectory = path.dirname(state.bufs);
  fs.mkdirSync(state.bufs);
  const canonicalBufs = fs.realpathSync.native(state.bufs);

  const originalStatSync = fs.statSync;
  let stateRemoved = false;
  fs.statSync = function interceptedStat(value, ...args) {
    const stat = originalStatSync.call(this, value, ...args);
    if (!stateRemoved && path.resolve(String(value)) === canonicalBufs) {
      stateRemoved = true;
      fs.rmSync(stateDirectory, { recursive: true, force: true });
    }
    return stat;
  };
  try {
    assert.throws(() => runAutomaticGc(state));
  } finally {
    fs.statSync = originalStatSync;
  }

  assert.equal(stateRemoved, true);
  assert.equal(fs.existsSync(stateDirectory), false);
  assert.equal(fs.existsSync(state.bufs), false);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
});

test('automatic GC distinguishes a vanished state directory from an absent buffer leaf', (t) => {
  const state = fixture(t, 'state-vanishes-before-leaf');
  const stateDirectory = path.dirname(state.bufs);
  const canonicalStateDirectory = path.join(fs.realpathSync.native(state.root), '.hello-cc');

  const originalLstatSync = fs.lstatSync;
  let stateRemoved = false;
  fs.lstatSync = function interceptedLstat(value, ...args) {
    const stat = originalLstatSync.call(this, value, ...args);
    if (!stateRemoved && path.resolve(String(value)) === canonicalStateDirectory) {
      stateRemoved = true;
      fs.rmSync(stateDirectory, { recursive: true, force: true });
    }
    return stat;
  };
  try {
    assert.throws(() => runAutomaticGc(state));
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  assert.equal(stateRemoved, true);
  assert.equal(fs.existsSync(stateDirectory), false);
  assert.equal(fs.existsSync(state.bufs), false);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
});

test('automatic GC rejects an ancestor replacement during buffer planning', (t) => {
  const state = fixture(t, 'state-changes-during-plan');
  const stateDirectory = path.dirname(state.bufs);
  const movedStateDirectory = `${stateDirectory}.moved`;
  const outsideStateDirectory = path.join(path.dirname(state.root), 'outside-plan-state');
  const outsideBufs = path.join(outsideStateDirectory, 'bufs');
  const externalVictim = path.join(outsideBufs, 'victim.out');
  const internalVictim = path.join(state.bufs, 'victim.out');
  fs.mkdirSync(state.bufs);
  fs.mkdirSync(outsideBufs, { recursive: true });
  fs.writeFileSync(internalVictim, 'internal');
  fs.writeFileSync(externalVictim, 'external');
  const oldTime = new Date((nowSec - 15 * 86400) * 1000);
  fs.utimesSync(internalVictim, oldTime, oldTime);
  fs.utimesSync(externalVictim, oldTime, oldTime);
  const canonicalBufs = fs.realpathSync.native(state.bufs);

  const originalReaddirSync = fs.readdirSync;
  let replaced = false;
  fs.readdirSync = function interceptedReaddir(value, ...args) {
    const names = originalReaddirSync.call(this, value, ...args);
    if (!replaced && path.resolve(String(value)) === canonicalBufs) {
      replaced = true;
      fs.renameSync(stateDirectory, movedStateDirectory);
      fs.symlinkSync(outsideStateDirectory, stateDirectory);
    }
    return names;
  };
  try {
    assert.throws(
      () => runAutomaticGc(state),
      (error) => error?.code === 'PROJECT_PATH_FORBIDDEN'
    );
  } finally {
    fs.readdirSync = originalReaddirSync;
  }

  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(externalVictim, 'utf8'), 'external');
  assert.equal(fs.readFileSync(path.join(movedStateDirectory, 'bufs', 'victim.out'), 'utf8'), 'internal');
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
});
