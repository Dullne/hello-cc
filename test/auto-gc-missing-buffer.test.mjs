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
import { resolveProjectDatabase } from '../lib/runtime/project-path.mjs';
import { initSchema } from '../lib/db/schema.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');
const nowSec = 2_000_000_000;

function unusedPeerDependency() {
  throw new Error('peer dependency should not be used for an empty auto-GC subject');
}

function createTestRunGc(now = () => nowSec, overrides = {}) {
  return createGcCommands({
    now,
    UNKNOWN_EVIDENCE_GRACE_SEC: 120,
    BUFS_DIR_NAME: 'bufs',
    peerMutationSubject: unusedPeerDependency,
    mutatePeerWithEvidence: unusedPeerDependency,
    observeClockSafetyInTransactionOrThrow: observeClockSafetyInTransaction,
    observePeerEvidence: unusedPeerDependency,
    ...overrides
  }).runGc;
}

const runGc = createTestRunGc();

function fixture(t, name) {
  const sandbox = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.homedir() : os.tmpdir(), `hcc-auto-gc-${name}-`));
  const originalHome = process.env.HOME, originalProfile = process.env.USERPROFILE;
  let db = null;
  t.after(() => {
    try { db?.close(); fs.rmSync(sandbox, { recursive: true, force: true }); }
    finally {
      if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
      if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
    }
  });
  const root = path.join(sandbox, 'project');
  const testHome = path.join(sandbox, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(testHome);
  execFileSync(process.execPath, [hccBin, '--root', root, 'init', '--no-guidance'], {
    cwd: root,
    env: { ...process.env, HOME: testHome, USERPROFILE: testHome, HCC_RUNTIME_URL: '' }
  });

  process.env.HOME = testHome; process.env.USERPROFILE = testHome;
  const selected = resolveProjectDatabase({ root });
  const bufs = path.join(selected.stateDir, 'bufs');
  fs.rmSync(bufs, { recursive: true, force: true });
  // Windows SQLite itself prevents renaming its open database directory.
  // A memory database lets these path-guard fault injections exercise GC's
  // own checks; actual file-backed database protection is tested separately.
  db = new DatabaseSync(process.platform === 'win32' ? ':memory:' : selected.db, { timeout: 5000 });
  if (process.platform === 'win32') initSchema(db);
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

function emptyBufferEvidence() {
  return {
    protectedPaths: new Set(),
    unknownPaths: new Set(),
    gcCutoffs: []
  };
}

function runAutomaticGc({ root, db }, overrides = {}, command = runGc) {
  return command({ root }, db, {
    olderThanDays: 14,
    scope: 'auto',
    collectBufferEvidenceNow: emptyBufferEvidence,
    ...overrides
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
  fs.symlinkSync(state.root, alias, process.platform === 'win32' ? 'junction' : 'dir');

  const result = runAutomaticGc({ ...state, root: alias });

  assert.equal(result.buf_files, process.platform === 'win32' ? 0 : 1);
  if (process.platform === 'win32') assert.equal(result.deferred_buf_files, 1);
  assert.equal(result.old_events, 1);
  assert.equal(fs.existsSync(victim), process.platform === 'win32');
});

test('automatic GC still rejects an existing buffer-directory symlink', (t) => {
  const state = fixture(t, 'symlink');
  const outside = path.join(path.dirname(state.root), 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, state.bufs, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(() => runAutomaticGc(state));
  assert.equal(fs.lstatSync(state.bufs).isSymbolicLink(), true);
});

test('automatic GC rejects a buffer directory replaced by a symlink after preflight', (t) => {
  const state = fixture(t, 'preflight-symlink-race');
  const canonicalBufs = state.bufs;
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
      fs.symlinkSync(outside, state.bufs, process.platform === 'win32' ? 'junction' : 'dir');
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
  fs.symlinkSync(outsideStateDirectory, stateDirectory, process.platform === 'win32' ? 'junction' : 'dir');

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
      if (process.platform === 'win32') fs.renameSync(stateDirectory, stateDirectory + '.removed');
      else fs.rmSync(stateDirectory, { recursive: true, force: true });
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
  const canonicalStateDirectory = path.dirname(state.bufs);

  const originalLstatSync = fs.lstatSync;
  let stateRemoved = false;
  fs.lstatSync = function interceptedLstat(value, ...args) {
    const stat = originalLstatSync.call(this, value, ...args);
    if (!stateRemoved && path.resolve(String(value)) === canonicalStateDirectory) {
      stateRemoved = true;
      if (process.platform === 'win32') fs.renameSync(stateDirectory, stateDirectory + '.removed');
      else fs.rmSync(stateDirectory, { recursive: true, force: true });
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
      fs.symlinkSync(outsideStateDirectory, stateDirectory, process.platform === 'win32' ? 'junction' : 'dir');
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

test('automatic GC rejects a project-root alias retargeted by initial evidence collection', (t) => {
  const state = fixture(t, 'root-alias-retarget');
  const alias = path.join(path.dirname(state.root), 'project-alias');
  const outsideRoot = path.join(path.dirname(state.root), 'outside-project');
  const outsideBufs = path.join(outsideRoot, '.hello-cc', 'bufs');
  const victim = path.join(outsideBufs, 'victim.out');
  fs.mkdirSync(outsideBufs, { recursive: true });
  fs.writeFileSync(victim, 'external');
  const oldTime = new Date((nowSec - 15 * 86400) * 1000);
  fs.utimesSync(victim, oldTime, oldTime);
  fs.symlinkSync(state.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const expectedDirectory = state.bufs;
  let evidenceDirectory;

  assert.throws(
    () => runAutomaticGc({ ...state, root: alias }, {
      collectBufferEvidenceNow(directory) {
        evidenceDirectory = directory;
        fs.unlinkSync(alias);
        fs.symlinkSync(outsideRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
        return emptyBufferEvidence();
      }
    }),
    (error) => error?.code === 'PROJECT_PATH_FORBIDDEN'
  );
  assert.equal(evidenceDirectory, expectedDirectory);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'external');
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
});

test('automatic GC guards paths until database history mutation begins', (t) => {
  const state = fixture(t, 'guard-lifetime');
  const stateDirectory = path.dirname(state.bufs);
  const movedStateDirectory = `${stateDirectory}.moved`;
  const outsideStateDirectory = path.join(path.dirname(state.root), 'outside-lifetime-state');
  const outsideBufs = path.join(outsideStateDirectory, 'bufs');
  fs.mkdirSync(state.bufs);
  fs.mkdirSync(outsideBufs, { recursive: true });
  const canonicalBufs = fs.realpathSync.native(state.bufs);

  const originalRealpathNative = fs.realpathSync.native;
  let evidenceCalls = 0;
  let armed = false;
  let guardedBufferResolutions = 0;
  let replaced = false;
  fs.realpathSync.native = function interceptedRealpath(value, ...args) {
    const resolved = originalRealpathNative.call(this, value, ...args);
    if (armed && path.resolve(String(value)) === canonicalBufs) {
      guardedBufferResolutions += 1;
      if (guardedBufferResolutions === 2) {
        replaced = true;
        fs.renameSync(stateDirectory, movedStateDirectory);
        fs.symlinkSync(outsideStateDirectory, stateDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
    return resolved;
  };
  try {
    assert.throws(
      () => runAutomaticGc(state, {
        collectBufferEvidenceNow() {
          evidenceCalls += 1;
          if (evidenceCalls === 2) armed = true;
          return emptyBufferEvidence();
        }
      }),
      (error) => error?.code === 'PROJECT_PATH_FORBIDDEN'
    );
  } finally {
    fs.realpathSync.native = originalRealpathNative;
  }

  assert.equal(replaced, true);
  assert.equal(fs.lstatSync(stateDirectory).isSymbolicLink(), true);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
});

test('automatic GC rechecks paths after the final clock read before history mutation', (t) => {
  const state = fixture(t, 'guard-after-clock-read');
  const stateDirectory = path.dirname(state.bufs);
  const movedStateDirectory = `${stateDirectory}.moved`;
  const outsideStateDirectory = path.join(path.dirname(state.root), 'outside-clock-state');
  fs.mkdirSync(state.bufs);
  fs.mkdirSync(path.join(outsideStateDirectory, 'bufs'), { recursive: true });

  let nowCalls = 0;
  let replaced = false;
  const raceRunGc = createTestRunGc(() => {
    nowCalls += 1;
    if (nowCalls === 4) {
      replaced = true;
      fs.renameSync(stateDirectory, movedStateDirectory);
      fs.symlinkSync(outsideStateDirectory, stateDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return nowSec;
  });

  assert.throws(
    () => runAutomaticGc(state, {}, raceRunGc),
    (error) => error?.code === 'PROJECT_PATH_FORBIDDEN'
  );
  assert.equal(nowCalls, 4);
  assert.equal(replaced, true);
  assert.equal(fs.lstatSync(stateDirectory).isSymbolicLink(), true);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
});

test('automatic GC guards the optimistic clock write after history snapshot creation', (t) => {
  const state = fixture(t, 'guard-before-optimistic-clock');
  const movedBufs = `${state.bufs}.moved`;
  fs.mkdirSync(state.bufs);
  state.db.prepare(`
    INSERT INTO peers(id, kind, status, created_at, last_seen_at)
    VALUES ('live-owner', 'shell', 'idle', ?, ?)
  `).run(nowSec - 100, nowSec - 100);
  state.db.prepare(`
    INSERT INTO locks(resource, base_resource, scope, owner, expires_at, created_at, ttl_sec)
    VALUES ('src/live', 'src/live', '*', 'live-owner', ?, ?, 90)
  `).run(nowSec - 1, nowSec - 100);
  state.db.prepare(`
    UPDATE meta SET value = ? WHERE key = 'clock_last_observed_at'
  `).run(String(nowSec - 1));
  const initialLease = state.db.prepare(`
    SELECT expires_at, ttl_sec FROM locks WHERE resource = 'src/live'
  `).get();

  let snapshotOpen = false;
  let replaced = false;
  const hookedDb = new Proxy(state.db, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          const statement = String(sql).trim();
          if (statement === 'BEGIN;') snapshotOpen = true;
          const result = target.exec(sql);
          if (snapshotOpen && statement === 'COMMIT;' && !replaced) {
            snapshotOpen = false;
            replaced = true;
            fs.renameSync(state.bufs, movedBufs);
            fs.mkdirSync(state.bufs);
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const raceRunGc = createTestRunGc(() => nowSec, {
    peerMutationSubject(db, peerId) {
      return {
        peer: db.prepare(`
          SELECT id, status, pid, pid_start_token, pid_command_hash, last_seen_at
          FROM peers WHERE id = ?
        `).get(peerId) || null,
        binding: null
      };
    },
    observePeerEvidence: () => ({ state: 'live' })
  });

  assert.throws(
    () => runAutomaticGc({ ...state, db: hookedDb }, {}, raceRunGc),
    (error) => error?.code === 'PROJECT_PATH_FORBIDDEN'
  );
  assert.equal(replaced, true);
  assert.equal(
    state.db.prepare("SELECT value FROM meta WHERE key = 'clock_last_observed_at'").get().value,
    String(nowSec - 1)
  );
  assert.deepEqual(state.db.prepare(`
    SELECT expires_at, ttl_sec FROM locks WHERE resource = 'src/live'
  `).get(), initialLease);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
});

test('automatic GC guards the in-buffer clock write after its current-time read', (t) => {
  const state = fixture(t, 'guard-before-buffer-clock');
  const stateDirectory = path.dirname(state.bufs);
  const movedStateDirectory = `${stateDirectory}.moved`;
  const outsideStateDirectory = path.join(path.dirname(state.root), 'outside-buffer-clock-state');
  fs.mkdirSync(state.bufs);
  fs.mkdirSync(path.join(outsideStateDirectory, 'bufs'), { recursive: true });
  state.db.prepare(`
    UPDATE meta SET value = ? WHERE key = 'clock_last_observed_at'
  `).run(String(nowSec - 2));

  let nowCalls = 0;
  let replaced = false;
  const raceRunGc = createTestRunGc(() => {
    nowCalls += 1;
    if (nowCalls === 2) {
      replaced = true;
      fs.renameSync(stateDirectory, movedStateDirectory);
      fs.symlinkSync(outsideStateDirectory, stateDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      return nowSec;
    }
    return nowSec - 1;
  });

  assert.throws(
    () => runAutomaticGc(state, {}, raceRunGc),
    (error) => error?.code === 'PROJECT_PATH_FORBIDDEN'
  );
  assert.equal(nowCalls, 2);
  assert.equal(replaced, true);
  assert.equal(
    state.db.prepare("SELECT value FROM meta WHERE key = 'clock_last_observed_at'").get().value,
    String(nowSec - 1)
  );
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
});
