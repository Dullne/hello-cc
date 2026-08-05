import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { decideClockSafety } from '../lib/core/coordination/clock-safety.mjs';
import {
  collectBufferEvidence,
  externalBufferSessionIds,
  externalBufferOwnerKey
} from '../lib/runtime/buffer-evidence.mjs';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-buffer-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const identity = {
  pid: 41,
  startToken: 'boot:started',
  commandHash: 'a'.repeat(64)
};

test('external buffer discovery is read-only when a project directory disappears', (t) => {
  const root = tempRoot(t);
  const missing = path.join(root, 'deleted-project', '.hello-cc', 'bufs');
  assert.deepEqual(externalBufferSessionIds(missing), []);
  assert.equal(fs.existsSync(missing), false);

  const existing = path.join(root, 'existing');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, 'two.out'), '');
  fs.writeFileSync(path.join(existing, 'one.out'), '');
  fs.writeFileSync(path.join(existing, 'ignored.meta'), '');
  assert.deepEqual(externalBufferSessionIds(existing), ['one', 'two']);
});

test('collects live external metadata evidence from every project directory', (t) => {
  const root = tempRoot(t);
  const primary = path.join(root, 'primary');
  const sibling = path.join(root, 'sibling');
  fs.mkdirSync(primary);
  fs.mkdirSync(sibling);
  for (const suffix of ['out', 'in', 'resize']) {
    fs.writeFileSync(path.join(sibling, `external-live.${suffix}`), suffix);
  }
  fs.writeFileSync(path.join(sibling, 'external-live.meta'), JSON.stringify({
    wrapper_pid: identity.pid,
    wrapper_identity: identity
  }));

  const evidence = collectBufferEvidence({
    directories: [primary, sibling],
    inspectProcess: () => ({ state: 'live', identity })
  });
  const canonicalSibling = fs.realpathSync.native(sibling);

  for (const suffix of ['out', 'in', 'resize', 'meta']) {
    assert.equal(evidence.protectedPaths.has(path.resolve(canonicalSibling, `external-live.${suffix}`)), true);
  }
  assert.equal(evidence.unknownPaths.size, 0);
});

test('collects live tmux evidence from sibling project databases', (t) => {
  const root = tempRoot(t);
  const siblingRoot = path.join(root, 'sibling-project');
  const siblingDirectory = path.join(siblingRoot, '.hello-cc', 'bufs');
  fs.mkdirSync(siblingDirectory, { recursive: true });
  const pipe = path.join(siblingDirectory, 'tmux-7-session-a.pipe');
  const mkfifo = spawnSync('mkfifo', [pipe], { encoding: 'utf8' });
  if (mkfifo.status !== 0) {
    t.skip(`mkfifo unavailable: ${mkfifo.stderr || mkfifo.stdout}`);
    return;
  }
  const row = {
    id: 'session-a',
    status: 'running',
    pid: identity.pid,
    pid_start_token: identity.startToken,
    pid_command_hash: identity.commandHash,
    transport: 'tmux',
    runtime_session_id: 'session-a',
    runtime_target: '%7'
  };
  const db = { prepare: () => ({ all: () => [row] }) };

  const evidence = collectBufferEvidence({
    directories: [siblingDirectory],
    projectDbs: [{ ctx: { root: siblingRoot }, db }],
    observePeer: () => ({ state: 'live', reason: 'test' })
  });

  const canonicalPipe = path.resolve(fs.realpathSync.native(siblingDirectory), path.basename(pipe));
  assert.equal(evidence.protectedPaths.has(canonicalPipe), true);
  assert.equal(evidence.unknownPaths.has(canonicalPipe), false);
});

test('dead external metadata does not protect an old group while malformed metadata fails closed', (t) => {
  const directory = tempRoot(t);
  for (const id of ['dead', 'unknown']) {
    for (const suffix of ['out', 'in', 'resize']) {
      fs.writeFileSync(path.join(directory, `${id}.${suffix}`), suffix);
    }
  }
  fs.writeFileSync(path.join(directory, 'dead.meta'), JSON.stringify({
    wrapper_pid: identity.pid,
    wrapper_identity: identity
  }));
  fs.writeFileSync(path.join(directory, 'unknown.meta'), '{');

  const evidence = collectBufferEvidence({
    directories: [directory],
    inspectProcess: () => ({ state: 'dead', identity: null })
  });
  const canonicalDirectory = fs.realpathSync.native(directory);

  assert.equal(evidence.protectedPaths.has(path.resolve(canonicalDirectory, 'dead.out')), false);
  assert.equal(evidence.unknownPaths.has(path.resolve(canonicalDirectory, 'dead.out')), false);
  assert.equal(evidence.unknownPaths.has(path.resolve(canonicalDirectory, 'unknown.out')), true);
  assert.equal(evidence.unknownPaths.has(path.resolve(canonicalDirectory, 'unknown.meta')), true);
});

for (const scenario of [
  { ageMs: 119_999, unknown: true },
  { ageMs: 120_000, unknown: false }
]) {
  test(`unknown metadata and DB-unreadable FIFOs are bounded at ${scenario.ageMs}ms`, (t) => {
    const projectRoot = tempRoot(t);
    const directory = path.join(projectRoot, '.hello-cc', 'bufs');
    fs.mkdirSync(directory, { recursive: true });
    const meta = path.join(directory, 'uncertain.meta');
    const out = path.join(directory, 'uncertain.out');
    const pipe = path.join(directory, 'tmux-unreadable.pipe');
    fs.writeFileSync(meta, '{');
    fs.writeFileSync(out, 'old');
    const mkfifo = spawnSync('mkfifo', [pipe], { encoding: 'utf8' });
    if (mkfifo.status !== 0) {
      t.skip(`mkfifo unavailable: ${mkfifo.stderr || mkfifo.stdout}`);
      return;
    }
    const now = 1_000_000;
    const observed = new Date(now - scenario.ageMs);
    fs.utimesSync(meta, observed, observed);
    fs.utimesSync(pipe, observed, observed);
    const db = { prepare: () => { throw new Error('database unavailable'); } };
    const canonicalDirectory = fs.realpathSync.native(directory);
    const unknownTracker = new Map();
    for (const file of [
      path.join(canonicalDirectory, 'uncertain.meta'),
      path.join(canonicalDirectory, 'tmux-unreadable.pipe')
    ]) {
      const stat = fs.lstatSync(file);
      unknownTracker.set(file, {
        state: 'unknown',
        sinceMonotonicMs: 0,
        identity: `${stat.dev}:${stat.ino}`
      });
    }

    const evidence = collectBufferEvidence({
      directories: [directory],
      projectDbs: [{ ctx: { root: projectRoot }, db }],
      nowMs: () => now,
      monotonicNowMs: () => scenario.ageMs,
      unknownGraceMs: 120_000,
      unknownTracker
    });

    assert.equal(
      evidence.unknownPaths.has(path.join(canonicalDirectory, 'uncertain.out')),
      scenario.unknown
    );
    assert.equal(
      evidence.unknownPaths.has(path.join(canonicalDirectory, 'tmux-unreadable.pipe')),
      scenario.unknown
    );
  });
}

test('wall-clock rollback does not extend an unknown observation past 120 seconds', (t) => {
  const directory = tempRoot(t);
  const meta = path.join(directory, 'rollback.meta');
  const out = path.join(directory, 'rollback.out');
  fs.writeFileSync(meta, '{');
  fs.writeFileSync(out, 'old');
  const canonicalDirectory = fs.realpathSync.native(directory);
  const canonicalMeta = path.join(canonicalDirectory, 'rollback.meta');
  const stat = fs.lstatSync(canonicalMeta);
  const unknownTracker = new Map([[
    canonicalMeta,
    { state: 'unknown', sinceMonotonicMs: 1_000, identity: `${stat.dev}:${stat.ino}` }
  ]]);

  const evidence = collectBufferEvidence({
    directories: [directory],
    nowMs: () => 500_000,
    monotonicNowMs: () => 121_000,
    unknownTracker
  });

  assert.equal(evidence.unknownPaths.has(path.join(canonicalDirectory, 'rollback.out')), false);
  assert.equal(unknownTracker.get(canonicalMeta).sinceMonotonicMs, 1_000);
});

test('live and dead evidence reset the bounded window before a later unknown transition', (t) => {
  const directory = tempRoot(t);
  const meta = path.join(directory, 'transition.meta');
  const out = path.join(directory, 'transition.out');
  fs.writeFileSync(meta, JSON.stringify({
    wrapper_pid: identity.pid,
    wrapper_identity: identity
  }));
  fs.writeFileSync(out, 'old');
  const canonicalDirectory = fs.realpathSync.native(directory);
  const canonicalMeta = path.join(canonicalDirectory, 'transition.meta');
  const canonicalOut = path.join(canonicalDirectory, 'transition.out');
  const wallBase = Math.ceil(Math.max(
    fs.lstatSync(canonicalMeta).mtimeMs,
    fs.lstatSync(canonicalMeta).ctimeMs
  ));
  const unknownTracker = new Map();
  let now = wallBase;
  let monotonicNow = 1_000;
  let state = 'unknown';
  const collect = () => collectBufferEvidence({
    directories: [directory],
    nowMs: () => now,
    monotonicNowMs: () => monotonicNow,
    unknownTracker,
    inspectProcess: () => state === 'live'
      ? { state: 'live', identity }
      : { state, identity: null }
  });

  assert.equal(collect().unknownPaths.has(canonicalOut), true);
  assert.equal(unknownTracker.has(canonicalMeta), true);
  now = wallBase + 200_000;
  monotonicNow = 200_000;
  state = 'live';
  assert.equal(collect().protectedPaths.has(canonicalOut), true);
  assert.equal(unknownTracker.get(canonicalMeta).state, 'live');
  state = 'dead';
  assert.equal(collect().protectedPaths.has(canonicalOut), false);
  state = 'unknown';
  assert.equal(collect().unknownPaths.has(canonicalOut), true);
  assert.equal(unknownTracker.get(canonicalMeta).sinceMonotonicMs, monotonicNow);
});

test('fresh unknown evidence publishes its 120 second expiry as a clock-safety cutoff', (t) => {
  const directory = tempRoot(t);
  const meta = path.join(directory, 'jump.meta');
  const out = path.join(directory, 'jump.out');
  fs.writeFileSync(meta, '{');
  fs.writeFileSync(out, 'old');
  const timestampMs = Math.floor(Math.max(
    fs.lstatSync(meta).mtimeMs,
    fs.lstatSync(meta).ctimeMs
  ));
  const previous = Math.floor(timestampMs / 1000);
  const current = previous + 1_000;

  const evidence = collectBufferEvidence({
    directories: [directory],
    nowMs: () => current * 1000,
    monotonicNowMs: () => 10,
    unknownTracker: new Map()
  });
  const cutoff = Math.ceil((timestampMs + 120_000) / 1000);

  assert.equal(evidence.unknownPaths.size, 0);
  assert.equal(evidence.gcCutoffs.includes(cutoff), true);
  assert.deepEqual(decideClockSafety({
    previous,
    current,
    operation: 'gc',
    gcCutoffs: evidence.gcCutoffs
  }), {
    enterGrace: true,
    renewOwners: false,
    reason: 'gc-cutoff'
  });
});

test('a malformed external session snapshot cannot permanently protect its group', (t) => {
  const directory = tempRoot(t);
  const meta = path.join(directory, 'malformed.meta');
  const out = path.join(directory, 'malformed.out');
  fs.writeFileSync(meta, '{');
  fs.writeFileSync(out, 'old');
  const timestampMs = Math.floor(Math.max(
    fs.lstatSync(meta).mtimeMs,
    fs.lstatSync(meta).ctimeMs
  ));

  const evidence = collectBufferEvidence({
    directories: [directory],
    sessions: [{ type: 'external', status: 'running', outFile: out, metaFile: meta }],
    nowMs: () => timestampMs + 120_000,
    monotonicNowMs: () => 120_000,
    unknownTracker: new Map()
  });

  assert.equal(evidence.protectedPaths.has(path.resolve(out)), false);
  assert.equal(evidence.unknownPaths.has(path.resolve(out)), false);
});

test('external producer generations distinguish same-id replacements', () => {
  assert.equal(externalBufferOwnerKey({ generation: 'first', pid: 7 }), 'generation:first');
  assert.equal(externalBufferOwnerKey({ generation: 'second', pid: 7 }), 'generation:second');
  assert.notEqual(
    externalBufferOwnerKey({ generation: 'first', pid: 7 }),
    externalBufferOwnerKey({ generation: 'second', pid: 7 })
  );
});

test('batch candidate filtering probes only the related external group', (t) => {
  const directory = tempRoot(t);
  for (const id of ['target', 'unrelated']) {
    fs.writeFileSync(path.join(directory, `${id}.out`), id);
    fs.writeFileSync(path.join(directory, `${id}.meta`), JSON.stringify({
      generation: id,
      wrapper_pid: id === 'target' ? 41 : 42,
      wrapper_identity: { ...identity, pid: id === 'target' ? 41 : 42 }
    }));
  }
  const inspected = [];
  const target = path.join(fs.realpathSync.native(directory), 'target.out');
  const evidence = collectBufferEvidence({
    directories: [directory],
    candidatePaths: [target],
    inspectProcess: (pid) => {
      inspected.push(pid);
      return { state: 'live', identity: { ...identity, pid } };
    }
  });

  assert.deepEqual(inspected, [41]);
  assert.equal(evidence.protectedPaths.has(target), true);
  assert.equal(evidence.protectedPaths.has(path.join(directory, 'unrelated.out')), false);
});
