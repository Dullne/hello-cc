import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RUNTIME_POINTER_UNKNOWN_GRACE_MS,
  classifyRuntimePointer,
  readRuntime,
  reclaimRuntimePointerFiles,
  runtimeProcessIdentity,
  writeRuntime
} from '../lib/runtime/state.mjs';

const stored = {
  pid: 73,
  startToken: 'boot:start',
  commandHash: 'b'.repeat(64)
};

function tempPointer(t, runtime) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-runtime-pointer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'runtime.json');
  fs.writeFileSync(file, JSON.stringify(runtime));
  const stat = fs.lstatSync(file);
  return { file, timestampMs: Math.max(stat.mtimeMs, stat.ctimeMs) };
}

test('matching runtime fingerprint is live and a missing process is confirmed dead', () => {
  const runtime = { pid: stored.pid, process_identity: stored };
  assert.deepEqual(classifyRuntimePointer(runtime, {
    inspect: () => ({ state: 'live', identity: stored }),
    ageMs: 1_000
  }), { state: 'alive', reclaimable: false });
  assert.deepEqual(classifyRuntimePointer(runtime, {
    inspect: () => ({ state: 'dead', identity: null }),
    ageMs: 1_000
  }), { state: 'dead', reclaimable: true });
});

test('alive and recent unknown runtime pointers fail closed, while unknown is bounded to 120 seconds', () => {
  const runtime = { pid: stored.pid };
  assert.deepEqual(classifyRuntimePointer(runtime, {
    inspect: () => ({ state: 'unknown', identity: null }),
    ageMs: RUNTIME_POINTER_UNKNOWN_GRACE_MS - 1
  }), { state: 'unknown', reclaimable: false });
  assert.deepEqual(classifyRuntimePointer(runtime, {
    inspect: () => ({ state: 'unknown', identity: null }),
    ageMs: RUNTIME_POINTER_UNKNOWN_GRACE_MS
  }), { state: 'unknown', reclaimable: true });
  assert.deepEqual(classifyRuntimePointer({ pid: stored.pid, process_identity: stored }, {
    inspect: () => ({ state: 'live', identity: { ...stored, startToken: 'other' } }),
    ageMs: RUNTIME_POINTER_UNKNOWN_GRACE_MS * 2
  }), { state: 'dead', reclaimable: true });
});

test('runtime process identity is published only when it is complete and live', () => {
  assert.deepEqual(runtimeProcessIdentity({
    inspect: () => ({ state: 'live', identity: stored })
  }), stored);
  assert.equal(runtimeProcessIdentity({
    inspect: () => ({ state: 'unknown', identity: null })
  }), null);
});

test('readRuntime rejects a reused pid when the stored process identity is complete', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-runtime-read-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = { root };
  writeRuntime(ctx, {
    pid: process.pid,
    process_identity: {
      pid: process.pid,
      startToken: 'definitely-not-the-current-process',
      commandHash: 'c'.repeat(64)
    },
    base_url: 'http://127.0.0.1:1'
  });

  assert.throws(
    () => readRuntime(ctx, { localOnly: true }),
    (error) => error?.code === 'RUNTIME_NOT_RUNNING'
  );
});

for (const scenario of [
  { ageMs: 119_999, blocked: true, reclaimed: 0 },
  { ageMs: 120_000, blocked: false, reclaimed: 1 }
]) {
  test(`runtime pointer file unknown window is bounded at ${scenario.ageMs}ms`, (t) => {
    const pointer = tempPointer(t, { pid: 73, base_url: 'http://127.0.0.1:1' });
    const result = reclaimRuntimePointerFiles([pointer.file], {
      nowMs: () => pointer.timestampMs + scenario.ageMs,
      inspect: () => ({ state: 'unknown', identity: null })
    });

    assert.equal(result.blocked, scenario.blocked);
    assert.equal(result.reclaimed, scenario.reclaimed);
    assert.deepEqual(result.outcomes.map(({ state, action }) => ({ state, action })), [{
      state: 'unknown',
      action: scenario.blocked ? 'blocked' : 'reclaimed'
    }]);
    assert.equal(fs.existsSync(pointer.file), scenario.blocked);
  });
}

test('wall-clock rollback preserves an unknown runtime pointer grace window', (t) => {
  const pointer = tempPointer(t, { pid: 73, base_url: 'http://127.0.0.1:1' });
  const result = reclaimRuntimePointerFiles([pointer.file], {
    nowMs: () => pointer.timestampMs - 1,
    inspect: () => ({ state: 'unknown', identity: null })
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reclaimed, 0);
  assert.deepEqual(result.outcomes.map(({ state, action }) => ({ state, action })), [
    { state: 'unknown', action: 'blocked' }
  ]);
  assert.equal(fs.existsSync(pointer.file), true);
});

test('a live matching runtime fingerprint remains fail closed during wall-clock rollback', (t) => {
  const pointer = tempPointer(t, {
    pid: stored.pid,
    process_identity: stored,
    base_url: 'http://127.0.0.1:1'
  });
  const result = reclaimRuntimePointerFiles([pointer.file], {
    nowMs: () => pointer.timestampMs - 1,
    inspect: () => ({ state: 'live', identity: stored })
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reclaimed, 0);
  assert.deepEqual(result.outcomes.map(({ state, action }) => ({ state, action })), [
    { state: 'alive', action: 'blocked' }
  ]);
  assert.equal(fs.existsSync(pointer.file), true);
});

test('runtime pointer dry-run reports a reclaimable unknown pointer without unlinking it', (t) => {
  const pointer = tempPointer(t, { pid: 73, base_url: 'http://127.0.0.1:1' });
  const cutoffs = [];
  const result = reclaimRuntimePointerFiles([pointer.file], {
    nowMs: () => pointer.timestampMs + RUNTIME_POINTER_UNKNOWN_GRACE_MS,
    inspect: () => ({ state: 'unknown', identity: null }),
    dryRun: true,
    onReclaim: ({ gcCutoff }) => cutoffs.push(gcCutoff)
  });

  assert.equal(result.blocked, false);
  assert.equal(result.reclaimed, 1);
  assert.deepEqual(result.outcomes.map(({ state, action }) => ({ state, action })), [
    { state: 'unknown', action: 'would-reclaim' }
  ]);
  assert.equal(fs.existsSync(pointer.file), true);
  assert.equal(cutoffs.length, 1);
  assert.equal(Number.isSafeInteger(cutoffs[0]), true);
});

test('strict pointer reclamation distinguishes confirmed dead from old unknown evidence', (t) => {
  const dead = tempPointer(t, { pid: stored.pid, process_identity: stored });
  const unknown = tempPointer(t, { pid: stored.pid });
  const now = Math.max(dead.timestampMs, unknown.timestampMs) + RUNTIME_POINTER_UNKNOWN_GRACE_MS;

  const result = reclaimRuntimePointerFiles([dead.file, unknown.file], {
    nowMs: () => now,
    inspect: (pid) => pid === stored.pid
      ? { state: 'dead', identity: null }
      : { state: 'unknown', identity: null },
    reclaimUnknown: false
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reclaimed, 1);
  assert.deepEqual(result.outcomes.map(({ state, action }) => ({ state, action })), [
    { state: 'dead', action: 'reclaimed' },
    { state: 'unknown', action: 'blocked' }
  ]);
  assert.equal(fs.existsSync(dead.file), false);
  assert.equal(fs.existsSync(unknown.file), true);
});
