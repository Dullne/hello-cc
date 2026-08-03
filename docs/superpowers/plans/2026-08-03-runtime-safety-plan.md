# Runtime Safety, Clock, GC, and Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make clock, takeover, garbage collection, and project-registry decisions safe under sleep, PID reuse, runtime failure, and concurrent writers.

**Architecture:** A clock-safety module owns persistent observation and grace. A buffer-GC planner is shared by CLI and runtime, while an authenticated runtime endpoint serializes deletion with active sessions. Registry updates use an owner-identified lock directory.

**Tech Stack:** Node.js 24 ESM, `node:test`, `node:sqlite`, filesystem atomics, HTTP runtime API, tmux integration.

---

## File Map

- Create `lib/core/coordination/clock-safety.mjs` and `test/clock-safety.test.mjs`.
- Modify `lib/shared/clock-grace.mjs` to make grace extension atomic and observable.
- Create `lib/runtime/buffer-gc.mjs` and `test/buffer-gc.test.mjs`.
- Create `lib/shared/file-lock.mjs` and `test/file-lock.test.mjs`.
- Modify `bin/hcc.mjs` for clock observation, runtime GC endpoint, safe CLI GC, and history flags.
- Modify `lib/runtime/projects.mjs` for lock-protected registry merging.
- Modify `lib/runtime/client.mjs` for the internal buffer-GC request.
- Modify `lib/coordination-state.mjs`, task/lock paths, and `scripts/regression.mjs` for integration behavior.

### Task 1: Make grace extension atomic and classify observation decisions

**Files:**
- Create: `lib/core/coordination/clock-safety.mjs`
- Create: `test/clock-safety.test.mjs`
- Modify: `lib/shared/clock-grace.mjs:1-46`

- [ ] **Step 1: Write failing pure-decision tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideClockSafety } from '../lib/core/coordination/clock-safety.mjs';

test('live evidence crosses expiry without grace and requests renewal', () => {
  assert.deepEqual(decideClockSafety({ previous: 100, current: 1000, operation: 'ownership', candidates: [{ boundary: 500, evidence: 'live' }] }), {
    enterGrace: false,
    renewOwners: true,
    reason: 'verified-live'
  });
});

test('unknown evidence crossing expiry enters grace', () => {
  assert.equal(decideClockSafety({ previous: 100, current: 1000, operation: 'ownership', candidates: [{ boundary: 500, evidence: 'unknown' }] }).enterGrace, true);
});

test('GC crossing an age cutoff enters grace without owner candidates', () => {
  assert.equal(decideClockSafety({ previous: 100, current: 1000, operation: 'gc', gcCutoffs: [500] }).enterGrace, true);
});

test('verified dead evidence does not delay ownership', () => {
  assert.equal(decideClockSafety({ previous: 100, current: 1000, operation: 'ownership', candidates: [{ boundary: 500, evidence: 'dead' }] }).enterGrace, false);
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/clock-safety.test.mjs`

Expected: FAIL because the decision module is missing.

- [ ] **Step 3: Implement the pure decision and atomic SQL extension**

`decideClockSafety` must return deterministic `{ enterGrace, renewOwners, reason }` from the supplied observation. Backward movement beyond five seconds always enters grace for unknown and GC age decisions. Long forward gaps enter grace only when they cross the relevant boundary.

Replace grace overwrite SQL with:

```sql
INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?)
ON CONFLICT(key) DO UPDATE SET value = CAST(
  MAX(CAST(meta.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT
)
```

`writeClockGraceUntil` returns the persisted deadline and throws on write failure; it must not swallow exceptions.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/clock-safety.test.mjs`.

Add a real in-memory SQLite test with two shorter/longer writes and assert the final value is the maximum. Run again and require PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/core/coordination/clock-safety.mjs lib/shared/clock-grace.mjs test/clock-safety.test.mjs
git commit -m "fix: make clock grace monotonic"
```

### Task 2: Observe clock safety before destructive ownership decisions

**Files:**
- Modify: `bin/hcc.mjs:413-471,728-751,1053-1120,1752-1810,2926-3005,5709-5725,6426-6538`
- Modify: `lib/core/coordination/clock-safety.mjs`
- Modify: `lib/coordination-state.mjs:37-105,191-220`
- Modify: `lib/core/coordination/tasks.mjs:73-90`
- Modify: `scripts/regression.mjs:2616-2820`

- [ ] **Step 1: Add the CLI-only failing integration fixture**

Create an isolated project with no local or global runtime pointer. Register a peer using the regression process PID and stored fingerprint, acquire a lock, move only wall-clock DB timestamps one day into the past, remove `clock_grace_until`, and attempt acquisition from another peer.

Write the final expected assertion from the start:

```js
if (attempt.status === 0 || !attempt.stderr.includes('LOCK_HELD')) {
  fail(`live owner was not protected after a CLI-only clock gap:\n${attempt.stderr}`);
}
```

From the same initial test, require an unchanged owner, renewed `expires_at`, and
no blanket grace for the verified live owner. Add unknown-evidence and
verified-dead variants before running RED.

- [ ] **Step 2: Run to verify RED**

Run: `npm run test:regression`.

Expected: live-owner fixture demonstrates takeover/replacement under the current code.

- [ ] **Step 3: Add the observation transaction**

Export `observeClockSafety(db, { operation, candidates, gcCutoffs, nowSec })`. In one immediate transaction, read `clock_last_observed_at`, call `decideClockSafety`, extend grace to `nowSec + 120` only when `enterGrace` is true, and write the new watermark. Persist the maximum of the existing and proposed deadline. Return the decision and persisted grace. Verified-live evidence renews immediately without grace, verified-dead evidence proceeds without grace, and only unknown evidence receives the 120-second delay.

Call it before lock acquire, task takeover, heartbeat/hook recovery, reaper, and GC. Do not call it from pure status/list/doctor paths. When it reports verified live owners, renew retained locks from `ttl_sec`. When grace persistence throws, abort the destructive command with `CLOCK_SAFETY_UNAVAILABLE`.

The Web poller passes its wall/monotonic jump signal into the same observer and no longer maintains a separate grace algorithm.

- [ ] **Step 4: Verify GREEN and nearby behavior**

Run: `node --test test/clock-safety.test.mjs`.

Run: `npm run test:regression`.

Expected: live evidence renews immediately, dead evidence expires, unknown evidence enters grace, status/doctor remain read-only.

- [ ] **Step 5: Commit**

```bash
git add bin/hcc.mjs lib/core/coordination/clock-safety.mjs lib/coordination-state.mjs lib/core/coordination/tasks.mjs scripts/regression.mjs
git commit -m "fix: protect CLI-only ownership after clock gaps"
```

### Task 3: Extract a buffer-GC planner and runtime arbitration endpoint

**Files:**
- Create: `lib/runtime/buffer-gc.mjs`
- Create: `test/buffer-gc.test.mjs`
- Modify: `bin/hcc.mjs:3005-3063,6426-6538,4675-5050`
- Modify: `lib/runtime/client.mjs:7-35`
- Modify: `scripts/regression.mjs:1841-1880,2866-3300,7019-7070`

- [ ] **Step 1: Write failing planner tests with real files**

In a temporary `bufs` directory create old protected, old dead, old unknown, and new files. Call:

```js
const result = pruneBufferFiles({
  directories: [bufsDir],
  cutoffMs,
  protectedPaths: new Set([protectedFile]),
  unknownPaths: new Set([unknownFile]),
  dryRun: false
});
```

Assert protected/unknown/new remain, dead old is deleted, and counts are `{ deleted: 1, protected: 1, deferred: 1 }`.

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/buffer-gc.test.mjs`.

Expected: missing-module failure.

- [ ] **Step 3: Implement the planner and endpoint**

Implement `pruneBufferFiles` with absolute resolved paths, `lstat` regular-file/FIFO checks, one supplied cutoff, and identical dry-run/apply planning. It must not follow symlinks.

Add authenticated `POST /api/runtime/gc-buffers`. The handler snapshots actual `outFile`, `inFile`, `resizeFile`, `pipeFile`, and external meta paths from every running session, groups them by actual directory, and calls the synchronous planner before returning counts.

Manual CLI GC fixes `cutoffMs` before the request. If a runtime pointer exists and the endpoint returns unreachable/404/426, mark eligible buffers deferred and do not fall back to blind local deletion. With no runtime pointer, build live/unknown protection from external metadata fingerprints and verified tmux panes.

- [ ] **Step 4: Verify RED-GREEN at the real boundary**

Run planner tests. Then add runtime integration cases for active external files, active tmux FIFO, sibling-project actual directories, unreachable runtime, legacy metadata, and orphan old files.

Run: `npm run test:regression`.

Expected: active/unknown files remain, only proven old orphans are removed, and runtime failure reports deferred counts.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/buffer-gc.mjs test/buffer-gc.test.mjs lib/runtime/client.mjs bin/hcc.mjs scripts/regression.mjs
git commit -m "fix: arbitrate buffer cleanup through runtime"
```

### Task 4: Make GC retention explicit and clock-safe

**Files:**
- Modify: `bin/hcc.mjs:6420-6557`
- Modify: `lib/ui/help.mjs:40-50,285-305`
- Modify: `scripts/regression.mjs:3689-3776,7019-7070`

- [ ] **Step 1: Add failing CLI cases**

Add fixtures proving:

```text
hcc gc --older-than -1 --yes -> BAD_ARGS, no row/file changes
hcc gc --older-than 0 --yes -> technical cleanup only
hcc gc --older-than 0 --history -> dry-run only
hcc gc --older-than 0 --history --yes -> eligible history removed
clock grace + any form -> every age-based category deferred
```

Keep an open-task handoff and assert it survives even with `--history --yes`.

- [ ] **Step 2: Run to verify RED**

Run: `npm run test:regression`.

Expected: negative retention mutates/plans broadly, and ordinary `--yes` currently removes history.

- [ ] **Step 3: Implement the command contract**

Reject `olderThanDays < 0` before `connect()`. Parse a `history` boolean. Split the planner into technical and history SQL. During grace, produce deferred counts for all age-based categories and execute no age-based delete. Always preserve handoffs linked to tasks outside `done`/`abandoned`.

Keep WAL checkpoint only after an applied safe plan. Update text and JSON output with `deleted`, `protected`, and `deferred` category counts.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:regression`.

Run: `node ./bin/hcc.mjs gc --help`.

Expected: every CLI contract case passes and help documents `--history`.

- [ ] **Step 5: Commit**

```bash
git add bin/hcc.mjs lib/ui/help.mjs scripts/regression.mjs
git commit -m "fix: make GC retention explicit and safe"
```

### Task 5: Serialize project-registry writers

**Files:**
- Create: `lib/shared/file-lock.mjs`
- Create: `test/file-lock.test.mjs`
- Modify: `lib/runtime/projects.mjs:1-86`
- Modify: `scripts/regression.mjs:1813-1840,4500-4700`

- [ ] **Step 1: Write failing real-filesystem tests**

Spawn two Node child processes that wait on a barrier file, then concurrently call `registerProject` for different roots under one isolated `HOME`. Assert both records remain. Add a same-root/different-DB update inside 60 seconds and assert the DB changes immediately.

Add a stale-lock fixture with a dead owner fingerprint and an unknown-owner fixture. Dead lock must be reclaimed; unknown lock must time out without deletion.

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/file-lock.test.mjs`.

Expected: missing-module failure, then the concurrent registry assertion fails before integration.

- [ ] **Step 3: Implement atomic lock-directory ownership**

Implement:

```js
export function withFileLock(target, fn, { timeoutMs = 5000, retryMs = 25 } = {})
```

Acquire `${target}.lock` with `mkdirSync`. Write owner metadata atomically with the current process fingerprint. On `EEXIST`, inspect the owner: reclaim only `dead`, retry `live`, and time out `unknown`. Always remove only the lock whose owner token still matches the current holder.

Wrap the entire registry re-read, merge, throttle decision, and atomic write. Compare both canonical root and resolved DB before throttling.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/file-lock.test.mjs`.

Run: `npm run test:regression`.

Expected: concurrent writers retain both records; changed DB updates immediately; unknown locks are not stolen.

- [ ] **Step 5: Commit**

```bash
git add lib/shared/file-lock.mjs test/file-lock.test.mjs lib/runtime/projects.mjs scripts/regression.mjs
git commit -m "fix: serialize project registry updates"
```
