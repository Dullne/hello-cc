# hello-cc v1 Release and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the completed hardening into a coherent 1.0.0 release with controlled fatal shutdown, complete packaging, accurate documentation, stable tests, and fresh cross-platform evidence.

**Architecture:** A focused fatal-shutdown helper owns process-level failure behavior. Release metadata and documentation declare breaking changes and accepted risks. Verification audits the entire local delta against `origin/master`, not only the last patch.

**Tech Stack:** Node.js 24 ESM, npm packaging, Docker/BuildKit, tmux, SQLite, HTTP/HTTPS/WebSocket regression suite.

---

## File Map

- Create `lib/runtime/fatal-shutdown.mjs` and `test/fatal-shutdown.test.mjs`.
- Modify `bin/hcc.mjs` fatal handlers and shutdown orchestration.
- Modify `package.json`, `package-lock.json`, `CHANGELOG.md`.
- Modify root and `docs/` English/Chinese README, commands, and guide files.
- Modify `docs/defect-review-2026-07.md` status evidence.
- Track/modify `.dockerignore`, `Dockerfile`, `lib/shared/clock-grace.mjs`, `lib/web/tls.mjs`.
- Modify `scripts/regression.mjs` for deterministic TTL evidence and package audits.

### Task 1: Replace unknown-error survival with idempotent fatal shutdown

**Files:**
- Create: `lib/runtime/fatal-shutdown.mjs`
- Create: `test/fatal-shutdown.test.mjs`
- Modify: `bin/hcc.mjs:5190-5335`

- [ ] **Step 1: Write failing fatal-state tests**

Use a real `EventEmitter` as the process signal source and real promises for asynchronous cleanup. Do not mock cleanup behavior; provide complete callbacks that append observable events.

```js
const events = [];
const controller = createFatalShutdownController({
  cleanup: async (reason) => { events.push(`cleanup:${reason}`); },
  exit: (code) => { events.push(`exit:${code}`); },
  forceExit: (code) => { events.push(`force:${code}`); },
  log: (value) => { events.push(`log:${value.code}`); }
});

await controller.fatal(new Error('first'));
await controller.fatal(new Error('second'));
assert.deepEqual(events, ['log:FATAL_RUNTIME_ERROR', 'cleanup:first', 'exit:1', 'force:1']);
```

Also assert cleanup failure still exits nonzero and its log is redacted.

- [ ] **Step 2: Run to verify RED**

Run: `node --test test/fatal-shutdown.test.mjs`.

Expected: missing-module failure.

- [ ] **Step 3: Implement the controller and wire Web shutdown**

```js
export function createFatalShutdownController({ cleanup, exit, forceExit, log }) {
  let state = 'idle';
  return {
    async fatal(error) {
      if (state !== 'idle') {
        forceExit(1);
        return;
      }
      state = 'stopping';
      log({ code: 'FATAL_RUNTIME_ERROR', error });
      try { await cleanup(error?.message || 'fatal runtime error'); }
      catch (cleanupError) { log({ code: 'FATAL_CLEANUP_ERROR', error: cleanupError }); }
      state = 'stopped';
      exit(1);
    }
  };
}
```

In `cmdWeb`, create one controller after all owned resources exist. `uncaughtException` and `unhandledRejection` call it. Cleanup clears timers/watchers, closes WebSockets/server, detaches or exits sessions by existing semantics, closes DB resources, and clears only runtime pointers matching the current process identity. Remove the log-and-continue handlers.

- [ ] **Step 4: Verify GREEN at unit and child-process boundaries**

Run unit tests. Add a child-process fixture that imports the helper, opens a temporary server/resource, triggers an unhandled rejection, and asserts cleanup marker, closed listener, and exit status 1.

Run: `npm run test:unit`.

Run: `npm run test:regression`.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/fatal-shutdown.mjs test/fatal-shutdown.test.mjs bin/hcc.mjs scripts/regression.mjs
git commit -m "fix: terminate cleanly after fatal runtime errors"
```

### Task 2: Publish the breaking 1.0.0 contract in metadata and docs

**Files:**
- Modify: `package.json:3,24-32`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`, `README.zh-CN.md`
- Modify: `docs/README.md`, `docs/README.zh-CN.md`
- Modify: `docs/commands.md`, `docs/commands.zh-CN.md`
- Modify: `docs/guide.md`, `docs/guide.zh-CN.md`
- Modify: `docs/defect-review-2026-07.md`
- Modify: `lib/ui/help.mjs`

- [ ] **Step 1: Add failing release-document assertions**

Extend `syntaxAndHelp` and release checks to require all of these concepts in
`README.md`, `README.zh-CN.md`, `docs/commands.md`,
`docs/commands.zh-CN.md`, `docs/guide.md`, `docs/guide.zh-CN.md`, the changelog,
and CLI help:

```text
1.0.0
schema v7 / no downgrade
pre-migration backup
Runtime API v2
provider peer IDs changed
gc --history
process evidence / unknown-only grace
--tls and --trust-proxy
plaintext LAN accepted risk
arbitrary authenticated project root accepted risk
```

Assert the defect report uses the actual current branch dynamically or avoids naming a branch, and that fixed/partial/deferred counts add up to the listed findings.

- [ ] **Step 2: Run to verify RED**

Run: `npm run test:regression`.

Run: `npm run release:check`.

Expected: FAIL on version and missing release/help documentation.

- [ ] **Step 3: Update release metadata and documentation**

Set `package.json` version to `1.0.0`, then run:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
```

Add one coherent 1.0.0 changelog section with Breaking, Security, Reliability, GC, and Upgrade headings. Document exact backup naming and recovery inspection, no downgrade, old/new peer ID examples, API v2 negotiation, safe GC flags, supported transport modes, and the two accepted risks.

Update help text without claiming plaintext confidentiality or project isolation. Correct defect statuses from current tests and code evidence.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:regression`.

Run: `npm run release:check`.

Run: `node ./bin/hcc.mjs --help`.

Expected: all release assertions PASS and version/help output is 1.0.0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md README.md README.zh-CN.md docs/README.md docs/README.zh-CN.md docs/commands.md docs/commands.zh-CN.md docs/guide.md docs/guide.zh-CN.md docs/defect-review-2026-07.md lib/ui/help.mjs scripts/regression.mjs
git commit -m "docs: publish hello-cc 1.0.0 contract"
```

### Task 3: Make packaging complete and TTL regression deterministic

**Files:**
- Track/modify: `.dockerignore`
- Track/modify: `Dockerfile`
- Track: `lib/shared/clock-grace.mjs`
- Track: `lib/web/tls.mjs`
- Modify: `scripts/regression.mjs:164-185,2730-2820,7072-7115`
- Modify: `package.json:10-22`

- [ ] **Step 1: Add failing package-completeness and TTL tests**

Add a package audit that runs `npm pack --dry-run --json`, parses the file list, resolves every relative import reachable from `bin/hcc.mjs`, and asserts every production dependency is tracked and included in the package.

Change hook renewal event payload assertions to require a `renewed_at` timestamp. Seed a fixture where parent `before` is one second greater than child `renewed_at` and assert expiration equals `renewed_at + renewalSec`, not a cross-process before/after window.

- [ ] **Step 2: Run to verify RED**

Run: `npm run test:regression`.

Expected: FAIL because renewal events lack `renewed_at` and current package audit sees untracked production modules.

- [ ] **Step 3: Record operation time and complete packaging**

Include `renewed_at: hookNow` in `lock.renewed_by_hook` payload and assert exact TTL from that value. Keep created time and `ttl_sec` invariants.

Track all imported production modules. Ensure package `files` includes every `lib/` module. Change Docker dependency install to:

```dockerfile
RUN npm ci --no-audit --no-fund
```

At test startup print `node --version` and `tmux -V`. Keep `.git`, runtime state, tokens, DBs, WAL files, logs, and local buffers out of the build context; do not exclude production source.

- [ ] **Step 4: Verify GREEN and repeatability**

Run: `npm run test:regression` twice locally.

Run: `npm pack --dry-run --json` and inspect the parsed audit result.

Build and run the container twice at this task boundary. Both runs must reach `FULL_REGRESSION_OK`.

- [ ] **Step 5: Commit**

```bash
git add .dockerignore Dockerfile lib/shared/clock-grace.mjs lib/web/tls.mjs scripts/regression.mjs package.json
git commit -m "test: make v1 package and regression deterministic"
```

### Task 4: Execute the final ordered verification gates

**Files:**
- Review: every path in `git diff --name-only origin/master`
- Modify only when a failed gate identifies a defect, using a new RED-GREEN cycle.

- [ ] **Step 1: Audit final scope and production imports**

Run:

```bash
git status --short
git diff --check origin/master
git diff --stat origin/master
git diff --name-status origin/master
npm pack --dry-run --json
```

Expected: no untracked production dependency; no whitespace errors; package audit lists every reachable module.

- [ ] **Step 2: Run syntax, unit, and focused security checks**

Run:

```bash
node --check bin/hcc.mjs
node --check scripts/regression.mjs
npm run test:unit
npm run smoke
npm run release:check
```

Expected: exit 0 for every command with zero test failures.

- [ ] **Step 3: Re-run original vulnerable paths and bypass controls**

Run focused selectors or fixtures for negative GC, live-buffer manual GC, CLI-only clock gap, concurrent registry writers, PID reuse, API v1/missing version, cross-session tokens, symlink escape, secret log scanning, and fatal shutdown.

Expected: original unsafe behavior no longer reproduces; legitimate live/dead/admin/arbitrary-root/plaintext-LAN controls remain intact.

- [ ] **Step 4: Run complete local regression**

Run: `npm test`.

Expected: unit tests PASS and regression ends with `FULL_REGRESSION_OK`.

- [ ] **Step 5: Build the exact current Node 24/Linux image**

Run:

```bash
docker build --no-cache -t hello-cc-v1-verify:node24 .
```

Expected: successful build using `npm ci`, with all current source copied.

- [ ] **Step 6: Run three consecutive container regressions**

Run `docker run --rm hello-cc-v1-verify:node24` three separate times. Do not combine them in a shell loop; preserve each output independently.

Expected for each run: `FULL_REGRESSION_OK`, no TTL clock-window failure, no leaked tmux session, exit 0.

- [ ] **Step 7: Review the complete delta and requirements**

Read all four design specs and map every acceptance criterion to a passing command or test. Review `git diff origin/master` for alternate unsafe branches, duplicated policy logic, accidental user-change loss, secrets, stale documentation, and unrelated churn.

- [ ] **Step 8: Commit only evidence-required final corrections**

If every gate passed without a correction, do not create an empty commit. If a gate required a fix, use a focused commit containing its failing test and minimal production correction.
