# Runtime Buffer GC Two-Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual GC use one server-derived timing snapshot, one unified clock decision, a one-shot runtime file apply, and only then an exact database apply.

**Architecture:** The runtime prepares an immutable canonical file plan from a canonical retention period and stores it behind a short-lived root/DB-bound token. The CLI uses the runtime-derived cutoff to capture an exact database plan and merges both plans' would-delete boundaries into one clock observation. Runtime file batches each recheck clock grace under `BEGIN IMMEDIATE`; database rows are finalized only after the runtime reports that every prepared file candidate was processed.

**Tech Stack:** Node.js ESM, `node:sqlite`, synchronous filesystem APIs, built-in test runner, HTTP runtime API.

---

### Task 1: Read-only clock prediction

**Files:**
- Modify: `lib/core/coordination/clock-safety.mjs`
- Test: `test/clock-safety.test.mjs`

- [ ] Write a failing test that seeds a watermark, pending gap, and grace row, calls `previewClockSafety`, verifies the same grace decision expected from apply, and compares the complete `meta` table before/after.
- [ ] Run `node --test test/clock-safety.test.mjs` and verify the missing export fails.
- [ ] Extract the shared pending-gap decision calculation and implement `previewClockSafety(db, options)` without a transaction or write.
- [ ] Re-run the focused test and verify preview and observer decisions match while preview leaves `meta` byte-for-byte unchanged.

### Task 2: One-shot runtime plan tokens and bounded apply barriers

**Files:**
- Create: `lib/runtime/buffer-gc-protocol.mjs`
- Modify: `lib/runtime/buffer-gc.mjs`
- Create: `test/buffer-gc-protocol.test.mjs`

- [ ] Write failing tests for token entropy shape, root/DB binding, replay, expiry, mismatch cleanup, and dry-run plans leaving no token.
- [ ] Write a failing real SQLite/filesystem test with more than 64 frozen candidates; extend grace from a second connection after the first committed batch and assert exactly the first batch is deleted and the remainder deferred.
- [ ] Implement `createBufferGcPlanStore` with a 15-second TTL and destructive take semantics.
- [ ] Implement `applyClockSafeBufferPlan` using batches of 64; each batch opens `BEGIN IMMEDIATE`, runs `observeClockSafetyInTransaction`, checks current grace, and performs only that batch's bounded identity rechecks/unlinks before commit.
- [ ] Re-run the focused protocol tests.

### Task 3: Authenticated prepare/apply API

**Files:**
- Modify: `bin/hcc.mjs`
- Modify: `scripts/regression.mjs`

- [ ] Add failing authenticated endpoint regressions: legacy or forged `cutoffMs`/`observedAt` bodies return `BAD_REQUEST`; prepare accepts only canonical safe `retentionSec`; apply rejects replay, wrong root/DB, and expired tokens.
- [ ] Replace the single-call endpoint with `phase: prepare|apply`. Prepare derives `observedAt` and `cutoffMs` from server time, freezes the full actual-directory plan, and returns counts/cutoffs plus a token only for apply. Apply destructively takes the token and runs the bounded barrier.
- [ ] Add periodic opportunistic expiry cleanup and verify dry-run preparation stores no token.
- [ ] Run the endpoint regression through the multi-project runtime workflow.

### Task 4: Manual CLI unified decision and apply ordering

**Files:**
- Modify: `bin/hcc.mjs`
- Modify: `lib/core/coordination/gc-plan.mjs`
- Modify: `scripts/regression.mjs`
- Test: `test/gc-plan.test.mjs`

- [ ] Add a failing regression with an exact DB history/lock/peer plan plus an actual-directory buffer candidate crossing one pending gap; assert dry-run predicts all would-delete categories deferred without changing `meta`, and apply deletes neither resource.
- [ ] Add a failing regression where grace is extended after prepare and before apply; assert runtime deletes zero and database finalization never starts.
- [ ] Add async snapshot cleanup support so the history temp table is always dropped across runtime awaits while preserving primary/cleanup errors.
- [ ] Split manual GC into prepare, unified preview/observe, runtime/local file apply, and exact DB finalization. Treat runtime unavailability, token failure, incomplete batched apply, subject drift, or clock failure as a barrier that prevents all database deletion.
- [ ] Ensure result counters report only committed deletes, retain verified-live buffer counts as protected, and report all unprocessed would-delete rows/files as deferred.
- [ ] Run `node --test test/gc-plan.test.mjs` and the focused manual/runtime regression.

### Task 5: Full verification and amended commit

**Files:**
- Verify all Task 4 files only.

- [ ] Run `npm run test:unit` and require zero failures.
- [ ] Run `npm run test:regression` and require `FULL_REGRESSION_OK`.
- [ ] Rebuild the Node 24 image and run its full regression.
- [ ] Run `git diff --cached --check`, selectively stage Task 4 files, and amend `f075976` without staging unrelated worktree changes.
