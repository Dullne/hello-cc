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

test('automatic GC still rejects an existing buffer-directory symlink', (t) => {
  const state = fixture(t, 'symlink');
  const outside = path.join(path.dirname(state.root), 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, state.bufs);

  assert.throws(() => runAutomaticGc(state));
  assert.equal(fs.lstatSync(state.bufs).isSymbolicLink(), true);
});
