# hello-cc v1 Data and Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce schema v7, safe pre-migration backups, process fingerprints, and the breaking v1 provider identity contract.

**Architecture:** Put process inspection and migration backup logic in focused modules. Persist opaque process fingerprints on peers and external/tmux session metadata, then route all liveness consumers through one three-state resolver.

**Tech Stack:** Node.js 24 ESM, `node:test`, `node:sqlite`, macOS `ps`, Linux `/proc`, tmux.

---

## File Map

- Create `test/process-identity.test.mjs`: real-process and parser behavior.
- Create `test/schema-v7.test.mjs`: real SQLite backup and migration behavior.
- Create `lib/process/identity.mjs`: inspect and compare process fingerprints.
- Create `lib/db/migration-backup.mjs`: consistent `VACUUM INTO` backup.
- Create `lib/core/peers/evidence.mjs`: `live`/`dead`/`unknown` resolver.
- Modify `package.json`: unit-test scripts and v1 version.
- Modify `lib/db/schema.mjs`: schema v7 process columns and backup hook.
- Modify `bin/hcc.mjs`: migration hook, peer identity persistence, liveness wiring.
- Modify `lib/core/peers/liveness.mjs`: consume evidence rather than age alone.
- Modify `lib/core/coordination/tasks.mjs`: use evidence for takeover.
- Modify `lib/core/peers/session.mjs`: finalize the breaking v1 ID algorithm.
- Modify `lib/integrations/shims/script.mjs`: keep shim hashing byte-identical.
- Modify `scripts/regression.mjs`: real CLI migration and session evidence coverage.

### Task 1: Add the focused unit-test entry point

**Files:**
- Modify: `package.json:24-32`
- Create: `test/process-identity.test.mjs`

- [ ] **Step 1: Write the failing test**

Create the test with the intended module API:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareProcessIdentity,
  inspectProcessIdentity,
  parseLinuxStatStartTicks,
  parsePsStartIdentity
} from '../lib/process/identity.mjs';

test('reads a stable identity for the current process', () => {
  const first = inspectProcessIdentity(process.pid);
  const second = inspectProcessIdentity(process.pid);
  assert.equal(first.state, 'live');
  assert.deepEqual(second.identity, first.identity);
  assert.equal(compareProcessIdentity(first.identity, second.identity), 'live');
});

test('parses Linux stat when command contains spaces and parentheses', () => {
  const fields = Array.from({ length: 30 }, (_, i) => String(i + 1));
  fields[19] = '987654';
  assert.equal(parseLinuxStatStartTicks(`42 (worker (one)) ${fields.join(' ')}`), '987654');
});

test('parses macOS ps start and command identity', () => {
  assert.deepEqual(parsePsStartIdentity('Mon Aug  3 06:10:11 2026\t/usr/bin/node app.mjs\n'), {
    startToken: 'Mon Aug  3 06:10:11 2026',
    command: '/usr/bin/node app.mjs'
  });
});

test('rejects a reused PID fingerprint', () => {
  const stored = { pid: 42, startToken: 'boot-a:100', commandHash: 'aaa' };
  const current = { pid: 42, startToken: 'boot-a:200', commandHash: 'aaa' };
  assert.equal(compareProcessIdentity(stored, current), 'dead');
  assert.equal(compareProcessIdentity(null, current), 'unknown');
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test test/process-identity.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/process/identity.mjs`.

- [ ] **Step 3: Add the unit-test scripts**

Set the scripts to:

```json
"pretest": "npm run test:unit",
"test": "npm run test:regression",
"test:unit": "node --test test/*.test.mjs",
"test:regression": "node ./scripts/regression.mjs"
```

Do not change the production version in this task.

- [ ] **Step 4: Verify the intended failure through npm**

Run: `npm run test:unit`

Expected: the same missing-module failure, proving the new test entry point runs.

- [ ] **Step 5: Commit**

```bash
git add package.json test/process-identity.test.mjs
git commit -m "test: add v1 focused test entry point"
```

### Task 2: Implement cross-platform process fingerprints

**Files:**
- Create: `lib/process/identity.mjs`
- Test: `test/process-identity.test.mjs`

- [ ] **Step 1: Complete the failing boundary tests before implementation**

Append tests that inspect PID `2147483647` as dead, treat a partial stored
fingerprint as unknown, reject a changed command hash, and parse malformed Linux
and macOS fixture rows as unknown/null.

- [ ] **Step 2: Run the complete test to verify RED**

Run: `node --test test/process-identity.test.mjs`

Expected: the module is still missing and every final identity expectation is
already present before production code exists.

- [ ] **Step 3: Implement the minimal identity module**

```js
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function commandHash(command) {
  return createHash('sha256').update(String(command || '').trim()).digest('hex');
}

export function parseLinuxStatStartTicks(text) {
  const close = String(text).lastIndexOf(')');
  if (close < 0) return null;
  const rest = String(text).slice(close + 2).trim().split(/\s+/);
  return rest[19] || null;
}

export function parsePsStartIdentity(text) {
  const line = String(text).trimEnd();
  const tab = line.indexOf('\t');
  if (tab < 0) return null;
  const startToken = line.slice(0, tab).trim();
  const command = line.slice(tab + 1).trim();
  return startToken && command ? { startToken, command } : null;
}

function linuxIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const startTicks = parseLinuxStatStartTicks(stat);
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  if (!startTicks || !bootId) throw new Error('incomplete Linux identity');
  return { pid, startToken: `${bootId}:${startTicks}`, commandHash: commandHash(command) };
}

function psIdentity(pid) {
  const boot = spawnSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
  const started = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (started.status !== 0 || command.status !== 0 || boot.status !== 0) return null;
  const parsed = parsePsStartIdentity(`${started.stdout.trim()}\t${command.stdout.trim()}\n`);
  if (!parsed) throw new Error('incomplete ps identity');
  return {
    pid,
    startToken: `${String(boot.stdout || '').trim()}:${parsed.startToken}`,
    commandHash: commandHash(parsed.command)
  };
}

export function inspectProcessIdentity(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'unknown', identity: null };
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err?.code === 'ESRCH') return { state: 'dead', identity: null };
    if (err?.code !== 'EPERM') return { state: 'unknown', identity: null };
  }
  try {
    const identity = process.platform === 'linux' ? linuxIdentity(pid) : psIdentity(pid);
    return identity ? { state: 'live', identity } : { state: 'dead', identity: null };
  } catch {
    return { state: 'unknown', identity: null };
  }
}

function isCompleteIdentity(value) {
  return Number.isInteger(Number(value?.pid)) && Number(value.pid) > 0 &&
    typeof value?.startToken === 'string' && value.startToken.length > 0 &&
    typeof value?.commandHash === 'string' && /^[a-f0-9]{64}$/.test(value.commandHash);
}

export function compareProcessIdentity(stored, current) {
  if (!isCompleteIdentity(stored) || !isCompleteIdentity(current)) return 'unknown';
  return Number(stored.pid) === Number(current.pid) &&
    stored.startToken === current.startToken &&
    stored.commandHash === current.commandHash ? 'live' : 'dead';
}
```

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `node --test test/process-identity.test.mjs`

Expected: all boundary tests PASS on macOS and Linux. If the macOS parser fixture exposes a spacing mismatch, fix the parser, not the assertions.

- [ ] **Step 5: Commit**

```bash
git add lib/process/identity.mjs test/process-identity.test.mjs
git commit -m "feat: add process identity fingerprints"
```

### Task 3: Add schema v7 and consistent migration backups

**Files:**
- Create: `lib/db/migration-backup.mjs`
- Create: `test/schema-v7.test.mjs`
- Modify: `lib/db/schema.mjs:3,76-88,169-179,318-355`
- Modify: `bin/hcc.mjs:413-466`

- [ ] **Step 1: Write real SQLite failing tests**

Create temporary v5 and v6 databases using `DatabaseSync`. Assert that `ensureMigrationBackup(db, dbPath, 5, 7)` returns a new path, the backup passes `quick_check`, contains the original row, and a second call returns a different non-overwriting path. Add a failure case with an unwritable destination and assert the source `schema_version` remains unchanged.

Use this call shape:

```js
const backup = ensureMigrationBackup(db, dbPath, 5, 7, { timestamp: () => '20260803T120000000Z' });
assert.match(backup, /mesh\.db\.pre-v5-to-v7\.20260803T120000000Z\.[a-f0-9]{8}\.bak$/);
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/schema-v7.test.mjs`

Expected: FAIL because `lib/db/migration-backup.mjs` does not exist.

- [ ] **Step 3: Implement backup and migration hook**

Implement `ensureMigrationBackup` with a SQL-string quoting helper, `VACUUM INTO`, an exclusive new filename, read-only `quick_check`, and cleanup of an invalid backup. Export `initSchema(db, { beforeMigration, ... })`; call `beforeMigration({ fromVersion, toVersion })` before the migration transaction when `fromVersion < 7`.

Set:

```js
export const DB_SCHEMA_VERSION = 7;
```

Add to `peers` and migration 7:

```sql
pid_start_token TEXT,
pid_command_hash TEXT
```

In every production connection path, pass:

```js
beforeMigration: ({ fromVersion, toVersion }) =>
  ensureMigrationBackup(db, dbPath, fromVersion, toVersion)
```

The sibling-project migration catch remains isolated and logs the backup failure.

- [ ] **Step 4: Verify GREEN and migration integration**

Run: `node --test test/schema-v7.test.mjs`

Then add v7 expectations to `createLegacySchemaDb`, `assertLegacySchemaMigration`, `assertRegisteredProjectDbMigration`, and the future-schema rejection workflow in `scripts/regression.mjs`.

Run: `npm run test:regression`

Expected: `FULL_REGRESSION_OK` with v5 and v6 fixtures backed up before v7.

- [ ] **Step 5: Commit**

```bash
git add lib/db/migration-backup.mjs lib/db/schema.mjs bin/hcc.mjs test/schema-v7.test.mjs scripts/regression.mjs
git commit -m "feat: back up databases before schema v7"
```

### Task 4: Persist identities and unify liveness evidence

**Files:**
- Create: `lib/core/peers/evidence.mjs`
- Create: `test/peer-evidence.test.mjs`
- Modify: `bin/hcc.mjs:524-575,2610-2720,4369-4515,5620-5735`
- Modify: `lib/core/peers/liveness.mjs:1-65`
- Modify: `lib/core/coordination/tasks.mjs:65-90`
- Modify: `scripts/regression.mjs:2616-2820,6834-6918`

- [ ] **Step 1: Write failing evidence tests**

Use complete peer/session fixtures and assert:

```js
assert.equal(resolvePeerEvidence({ peer: { status: 'exited' } }).state, 'dead');
assert.equal(resolvePeerEvidence({ peer: detachedPeer, process: matchingProcess, tmuxManaged: false }).state, 'live');
assert.equal(resolvePeerEvidence({ peer: detachedPeer, tmux: matchingPane, tmuxManaged: true }).state, 'live');
assert.equal(resolvePeerEvidence({ peer: workingPeer, process: reusedPid, tmuxManaged: false }).state, 'dead');
assert.equal(resolvePeerEvidence({ peer: legacyPeer, process: { state: 'live', identity: null }, tmuxManaged: false }).state, 'unknown');
```

Run: `node --test test/peer-evidence.test.mjs`

Expected: FAIL because the resolver module is missing.

- [ ] **Step 2: Implement the resolver**

```js
export function resolvePeerEvidence({ peer, process: processEvidence, tmux = null, tmuxManaged = false } = {}) {
  if (peer?.status === 'exited') return { state: 'dead', reason: 'explicit-exit' };
  if (tmux?.state === 'live') return { state: 'live', reason: 'tmux-identity' };
  if (processEvidence?.state === 'live' && processEvidence.identityMatched) {
    return { state: 'live', reason: 'process-identity' };
  }
  const processDead = processEvidence?.state === 'dead' ||
    (processEvidence?.state === 'live' && processEvidence.identityMatched === false);
  if (tmux?.state === 'unknown' || processEvidence?.state === 'unknown') {
    return { state: 'unknown', reason: 'incomplete-evidence' };
  }
  if (tmuxManaged && tmux?.state === 'dead' && processDead) {
    return { state: 'dead', reason: 'process-and-tmux-dead' };
  }
  if (!tmuxManaged && processDead) return { state: 'dead', reason: 'process-dead' };
  return { state: 'unknown', reason: 'insufficient-evidence' };
}
```

- [ ] **Step 3: Persist and consume fingerprints**

When registering/upserting a peer, inspect its PID and persist `pid_start_token` and `pid_command_hash` only for verified identity. Store full wrapper/child identity objects in external `.meta`. Store pane identity when adopting or starting tmux.

Replace age-only decisions in task annotations, takeover, reaper, lock recovery, and GC peer selection with the shared evidence result. `detached` must no longer be included in a hard-coded dead-status set.

- [ ] **Step 4: Verify real behavior**

Run: `node --test test/peer-evidence.test.mjs`

Add integration fixtures for a detached live tmux pane, live non-tmux child, reused PID fingerprint, and legacy unknown metadata. Run: `npm run test:regression`.

Expected: live evidence blocks takeover; reused/dead evidence permits it; legacy evidence is unknown.

- [ ] **Step 5: Commit**

```bash
git add lib/core/peers/evidence.mjs test/peer-evidence.test.mjs lib/core/peers/liveness.mjs lib/core/coordination/tasks.mjs bin/hcc.mjs scripts/regression.mjs
git commit -m "fix: resolve ownership from process evidence"
```

### Task 5: Prove and freeze the v1 provider identity break

**Files:**
- Modify: `lib/core/peers/session.mjs:1-12`
- Modify: `lib/integrations/shims/script.mjs:60-149,335-415`
- Modify: `scripts/regression.mjs:1385-1584,5660-5745`

- [ ] **Step 1: Add failing upgrade-contract assertions**

Assert exact new IDs for a UUID and two same-prefix names, assert they differ from the remote v0.1.9 prefix algorithm, and assert every generated shim returns the JavaScript ID. Add an invalid hash-command fixture and assert transparent provider passthrough.

- [ ] **Step 2: Run the identity contract**

Run: `npm run test:regression`

Expected: if the current worktree already satisfies every final identity
assertion, record this item as `no_change` and do not modify production code. If
any assertion fails, the failure becomes the RED proof for Step 3.

- [ ] **Step 3: Correct only a demonstrated algorithm mismatch**

When Step 2 is RED, keep `providerSessionPeerId(kind, providerId)` as full-input
SHA-1 first-eight hex and make the failing shim path byte-identical. Keep strict
40-hex validation and passthrough on failure. When Step 2 is already green, skip
this production step.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:unit`.

Run: `npm run test:regression`.

Expected: all identity fixtures PASS and no old-name scan regression.

- [ ] **Step 5: Commit**

```bash
git add scripts/regression.mjs
# Add the two production files only when Step 2 proved a mismatch.
git commit -m "feat: finalize v1 provider identities"
```
