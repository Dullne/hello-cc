# File Lock Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make socket-backed file-lock release deterministic in the presence of half-open probe clients, prepare an untagged `1.0.1` release candidate, and prove the candidate with fresh macOS Node 24 and local Linux-container evidence.

**Architecture:** The worker remains the sole owner of lock listeners and the synchronous parent protocol remains unchanged. The worker additionally owns a set of accepted inbound sockets and one shared in-flight close operation; concurrent shutdown callers join that operation instead of observing an already-cleared listener array. Every shutdown first stops listeners and then destroys local socket handles, while a terminal listener, bind, or top-level failure always outranks a concurrent normal release. Destroying the worker handle does not require an `allowHalfOpen` peer to close its still-writable half after it has already received the worker's FIN. Release metadata and the existing release-contract test move to `1.0.1`, while the published `v1.0.0` contract remains immutable.

**Tech Stack:** Node.js 24 ESM, `node:test`, worker threads, loopback `net.Server`, npm packaging, Docker/Colima, tmux, SQLite, HTTP/WebSocket regression tests.

---

## File Map

- Modify `test/socket-file-lock.test.mjs`: add a real-worker regression whose child keeps an accepted identity-probe connection half-open.
- Modify `lib/shared/socket-lock-worker.mjs`: track accepted inbound sockets, coalesce concurrent listener shutdowns, and preserve terminal-failure priority over release.
- Review only `lib/shared/file-lock.mjs`: confirm the synchronous API, five-second release bound, state protocol, and fail-closed cleanup errors are unchanged.
- Modify `test/release-contract.test.mjs`: move only the current release metadata assertions to `1.0.1` and require the new changelog section.
- Modify `package.json` and `package-lock.json`: set the release-candidate version to `1.0.1` without creating a tag.
- Modify `CHANGELOG.md`: add the `1.0.1` patch release contract and exact validation boundary.
- Review only `README.md`, `README.zh-CN.md`, `docs/`, and `lib/ui/help.mjs`: preserve their historical `1.0.0` compatibility statements.
- Review only `Dockerfile`, `.dockerignore`, and `scripts/regression.mjs`: use the existing Node 24 image and 13-stage acceptance suite without weakening it.

### Task 1: Add a deterministic half-open-client regression

**Files:**
- Modify: `test/socket-file-lock.test.mjs`

- [ ] **Step 1: Add a real half-open probe child helper**

Add this helper after `startHolder`. It derives the same four unique candidate ports from `endpoint.key`, probes them serially until the lock worker appears, and verifies the exact identity banner. An unconfirmed attempt is destroyed and retried after a banner timeout, socket error, banner mismatch, or close; after confirmation the child deliberately leaves its writable half open. The stop file is the deterministic exit signal used by the test cleanup, because destroying the worker's local socket after its FIN does not require the remote `allowHalfOpen` side to close.

```js
function startHalfOpenProbe(t, endpoint, expectedBanner, root) {
  const ready = path.join(root, 'half-open-probe-ready');
  const stop = path.join(root, 'half-open-probe-stop');
  const ports = [];
  for (let index = 0; ports.length < 4; index += 1) {
    const digest = index === 0
      ? createHash('sha256').update(endpoint.key).digest()
      : createHash('sha256')
        .update(`hcc-file-lock-port-v1\0${index}\0${endpoint.key}`)
        .digest();
    const port = 20_000 + digest.readUInt32BE(0) % 40_000;
    if (!ports.includes(port)) ports.push(port);
  }
  assert.equal(ports[0], endpoint.port);
  const source = String.raw`
    import fs from 'node:fs';
    import net from 'node:net';
    const [host, encodedPorts, expectedBanner, ready, stop] = process.argv.slice(1);
    const ports = JSON.parse(encodedPorts);
    let socket = null;
    let retryTimer = null;
    let nextPortIndex = 0;
    const stopTimer = setInterval(() => {
      if (!fs.existsSync(stop)) return;
      clearTimeout(retryTimer);
      try { socket?.destroy(); } finally { process.exit(0); }
    }, 10);
    const retry = () => {
      if (retryTimer !== null) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, 10);
    };
    const connect = () => {
      if (fs.existsSync(stop)) {
        clearInterval(stopTimer);
        process.exit(0);
      }
      if (socket !== null) return;
      let bannerConfirmed = false;
      let received = '';
      const port = ports[nextPortIndex];
      nextPortIndex = (nextPortIndex + 1) % ports.length;
      const candidate = net.createConnection({
        host,
        port,
        allowHalfOpen: true
      });
      socket = candidate;
      let bannerTimer = setTimeout(() => {
        bannerTimer = null;
        if (!bannerConfirmed) candidate.destroy();
      }, 250);
      const clearBannerTimer = () => {
        clearTimeout(bannerTimer);
        bannerTimer = null;
      };
      candidate.setEncoding('utf8');
      candidate.on('data', (chunk) => { received += chunk; });
      candidate.once('end', () => {
        clearBannerTimer();
        if (received !== expectedBanner) {
          candidate.destroy();
          return;
        }
        fs.writeFileSync(ready, 'ready');
        bannerConfirmed = true;
      });
      candidate.once('error', () => {
        if (!bannerConfirmed) {
          clearBannerTimer();
          candidate.destroy();
        }
      });
      candidate.once('close', () => {
        clearBannerTimer();
        if (socket === candidate) socket = null;
        if (bannerConfirmed) {
          clearInterval(stopTimer);
          process.exit(0);
        }
        retry();
      });
    };
    connect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source,
    endpoint.host, JSON.stringify(ports), expectedBanner, ready, stop], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
  });
  return { child, ready, stop };
}
```

- [ ] **Step 2: Add the real-worker behavior test**

Place this test next to the other real socket-lock lifecycle cases. It waits inside the synchronous callback, starts the release timer only after the child has confirmed the banner, requires completion well below the existing five-second failure bound, and proves immediate nonblocking reacquisition while the remote child remains alive with its write half open. Bind both exit and close observation before running the lock. Keep the early `probeExit` promise's normal 30-second safety timer so setup and release time do not consume the cleanup budget; only after writing the stop file, race that promise against a separate five-second cleanup timer. On a stop or exit-wait failure, fall back to `SIGKILL`, then wait for the child's close/reap event with a second bounded timeout so the test hook can still perform final cleanup. Clear both cleanup timers. Preserve a primary test or release failure as the first `AggregateError` entry and `cause` when cleanup also fails; cleanup-only failures remain visible instead of being swallowed.

```js
test('release closes a half-open identity probe before publishing RELEASED', async (t) => {
  const root = sandbox(t);
  const target = path.join(root, 'registry.json');
  const endpoint = lockModule.fileLockEndpoint(target);
  const identity = createHash('sha256')
    .update(`hcc-file-lock-v1\0${endpoint.key}`)
    .digest('hex');
  const expectedBanner = `HCC_FILE_LOCK_V1 ${identity}\n`;
  const probe = startHalfOpenProbe(t, endpoint, expectedBanner, root);
  const probeExit = waitForExit(probe.child);
  probeExit.catch(() => {});
  const probeClosed = new Promise((resolve) => probe.child.once('close', resolve));
  let releaseStarted;
  let hasPrimaryError = false;
  let primaryError;

  try {
    const result = withFileLock(target, () => {
      const wait = new Int32Array(new SharedArrayBuffer(4));
      const deadline = performance.now() + 5000;
      while (!fs.existsSync(probe.ready)) {
        const remaining = deadline - performance.now();
        assert.ok(remaining > 0, 'timed out waiting for the half-open identity probe');
        Atomics.wait(wait, 0, 0, Math.min(10, remaining));
      }
      releaseStarted = performance.now();
      return 'released';
    });
    const releaseElapsed = performance.now() - releaseStarted;
    assert.equal(result, 'released');
    assert.ok(releaseElapsed < 2500, `release took ${releaseElapsed}ms`);
    assert.equal(
      withFileLock(target, () => 'reacquired', { nonblocking: true }),
      'reacquired'
    );
    assert.equal(probe.child.exitCode, null);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  const cleanupErrors = [];
  const killProbe = () => {
    if (probe.child.exitCode !== null || probe.child.signalCode !== null) return;
    try {
      if (!probe.child.kill('SIGKILL')) {
        const error = new Error('failed to kill the half-open identity probe');
        error.code = 'ERR_HALF_OPEN_PROBE_KILL_FAILED';
        cleanupErrors.push(error);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  try {
    fs.writeFileSync(probe.stop, 'stop');
  } catch (error) {
    cleanupErrors.push(error);
    killProbe();
  }
  let exitTimer;
  try {
    await Promise.race([
      probeExit,
      new Promise((_, reject) => {
        exitTimer = setTimeout(() => {
          const error = new Error('timed out waiting for the half-open identity probe to exit');
          error.code = 'ERR_HALF_OPEN_PROBE_EXIT_TIMEOUT';
          reject(error);
        }, 5000);
      })
    ]);
  } catch (error) {
    cleanupErrors.push(error);
    killProbe();
  } finally {
    clearTimeout(exitTimer);
  }
  let closeTimer;
  try {
    await Promise.race([
      probeClosed,
      new Promise((_, reject) => {
        closeTimer = setTimeout(() => {
          const error = new Error('timed out waiting to reap the half-open identity probe');
          error.code = 'ERR_HALF_OPEN_PROBE_REAP_TIMEOUT';
          reject(error);
        }, 5000);
      })
    ]);
  } catch (error) {
    cleanupErrors.push(error);
    killProbe();
  } finally {
    clearTimeout(closeTimer);
  }

  const failures = hasPrimaryError ? [primaryError, ...cleanupErrors] : cleanupErrors;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'half-open probe test and cleanup failed', {
      cause: failures[0]
    });
  }
});
```

- [ ] **Step 3: Run the new test and verify RED**

Run:

```bash
/opt/homebrew/opt/node@24/bin/node \
  --test \
  --test-name-pattern='release closes a half-open identity probe before publishing RELEASED' \
  test/socket-file-lock.test.mjs
```

Expected: FAIL from `withFileLock` release after approximately five seconds. The error graph must contain `ERR_FILE_LOCK_RELEASE_FAILED` and `ERR_FILE_LOCK_WORKER_TERMINATION_UNCONFIRMED`; cleanup explicitly stops and reaps the child, and any cleanup failure is aggregated after rather than replacing that primary error. A syntax error, child timeout, or banner mismatch is not the required RED result.

- [ ] **Step 4: Retain the demonstrated regression after recording the RED output**

Do not commit production code in this step. Keep the failing test in the working tree so the next task begins from the observed failure.

### Task 2: Destroy accepted sockets during every worker shutdown

**Files:**
- Modify: `lib/shared/socket-lock-worker.mjs`
- Test: `test/socket-file-lock.test.mjs`
- Review: `lib/shared/file-lock.mjs`

- [ ] **Step 1: Add accepted-socket ownership and shutdown state beside the listeners**

Inside `runSocketLockWorker`, add the worker-local accepted-socket set, one shared in-flight close operation, and a terminal-failure priority flag. Do not include the outgoing sockets created by `probeOccupant`.

```js
const acceptedSockets = new Set();
let servers = [];
let closeOperation = null;
let contentionDeadline = null;
let releasing = false;
let terminalFailureRequested = false;
```

- [ ] **Step 2: Add idempotent connection registration and cleanup helpers**

Place these helpers after `lockBanner`. `destroyAcceptedSockets` intentionally does not clear the set; each socket removes itself on its real local `close` event, preserving accurate ownership until the worker handle is closed. Consume accepted-socket errors so a reset or forced local destroy cannot become an unhandled event; listener errors continue through the existing server handlers.

```js
function serveLock(socket, identity) {
  acceptedSockets.add(socket);
  socket.once('close', () => acceptedSockets.delete(socket));
  socket.on('error', () => {});
  socket.end(lockBanner(identity));
}

function destroyAcceptedSockets() {
  for (const socket of acceptedSockets) {
    try { socket.destroy(); } catch {}
  }
}
```

- [ ] **Step 3: Add a deterministic RED test for release joining terminal cleanup**

Place this regression beside the half-open lifecycle case. It patches only the
test worker's `net.Server`: after acquisition it emits one bound-listener error,
holds the resulting `server.close` callback until the parent sends `release`,
and therefore forces release to join cleanup that is already in flight.

```js
test('terminal listener failure wins when release joins an in-flight close', async (t) => {
  const root = sandbox(t);
  const closeStartedBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const closeStarted = new Int32Array(closeStartedBuffer);
  let worker = null;
  let workerExit = null;
  let callbackRan = false;
  const lock = lockModule.createFileLock({
    workerFactory({ workerSource, workerData }) {
      const injectedSource = String.raw`
        const net = require('node:net');
        const { parentPort, workerData } = require('node:worker_threads');
        const state = new Int32Array(workerData.stateBuffer);
        const closeStarted = new Int32Array(workerData.testCloseStartedBuffer);
        const originalListen = net.Server.prototype.listen;
        const originalClose = net.Server.prototype.close;
        const pendingCloseCallbacks = [];
        let releaseObserved = false;
        let injectFailure = true;
        let delayCloseCallbacks = false;

        parentPort.on('message', (message) => {
          if (message?.type !== 'release') return;
          releaseObserved = true;
          setImmediate(() => {
            for (const callback of pendingCloseCallbacks.splice(0)) callback();
          });
        });

        net.Server.prototype.listen = function(...args) {
          const callbackIndex = args.length - 1;
          const callback = args[callbackIndex];
          if (typeof callback !== 'function') return originalListen.apply(this, args);
          const server = this;
          args[callbackIndex] = function(...callbackArgs) {
            callback.apply(this, callbackArgs);
            if (injectFailure &&
                Atomics.load(state, 0) === workerData.states.ACQUIRED) {
              injectFailure = false;
              delayCloseCallbacks = true;
              const error = new Error('injected bound listener failure');
              error.code = 'ERR_TEST_LISTENER_FAILURE';
              server.emit('error', error);
            }
          };
          return originalListen.apply(this, args);
        };

        net.Server.prototype.close = function(callback) {
          if (!delayCloseCallbacks || typeof callback !== 'function') {
            return originalClose.call(this, callback);
          }
          if (Atomics.compareExchange(closeStarted, 0, 0, 1) === 0) {
            Atomics.notify(closeStarted, 0);
          }
          return originalClose.call(this, (error) => {
            const deliver = () => callback(error);
            if (releaseObserved) setImmediate(deliver);
            else pendingCloseCallbacks.push(deliver);
          });
        };
      ` + workerSource;
      worker = new Worker(injectedSource, {
        eval: true,
        workerData: { ...workerData, testCloseStartedBuffer: closeStartedBuffer },
        execArgv: []
      });
      workerExit = new Promise((resolve, reject) => {
        worker.once('exit', resolve);
        worker.once('error', reject);
      });
      workerExit.catch(() => {});
      return worker;
    }
  });
  t.after(async () => {
    if (worker === null) return;
    try { await worker.terminate(); } catch {}
  });

  const error = captureThrown(() => lock(path.join(root, 'registry.json'), () => {
    callbackRan = true;
    assert.notEqual(
      Atomics.wait(closeStarted, 0, 0, 5000),
      'timed-out',
      'timed out waiting for the injected listener close'
    );
    return 'callback completed';
  }, { nonblocking: true }));

  assert.equal(callbackRan, true);
  assert.equal(error?.code, 'ERR_FILE_LOCK_RELEASE_FAILED');
  assert.equal(await workerExit, 0);
});
```

Run:

```bash
/opt/homebrew/opt/node@24/bin/node \
  --test \
  --test-name-pattern='terminal listener failure wins when release joins an in-flight close' \
  test/socket-file-lock.test.mjs
```

Expected before the production change: FAIL because the second `closeServers`
call sees the already-cleared listener array, publishes `RELEASED`, and lets
`captureThrown` observe no release error. Keep this focused RED in the working
tree.

- [ ] **Step 4: Stop listeners before destroying all accepted sockets**

Replace `closeServers` with the following implementation. The first caller creates and owns the operation; later callers append waiters to that operation. A joiner destroys the current accepted-socket set again only after `cleanupStarted`; a reentrant join during the initial listener loop must let that loop call `close` on every listener before the first socket destruction. The implementation preserves first-error aggregation, and its completion gate prevents a synchronous `server.close` callback or throw from publishing status before every listener has received `close` and accepted-handle destruction has started. Operation state is cleared once, before its copied waiter list runs; every waiter is invoked once with the same result.

```js
function closeServers(callback) {
  if (closeOperation !== null) {
    closeOperation.callbacks.push(callback);
    if (closeOperation.cleanupStarted) destroyAcceptedSockets();
    return;
  }
  const closing = servers;
  servers = [];
  const operation = {
    callbacks: [callback],
    cleanupStarted: false,
    closing,
    completed: false,
    firstError: null,
    remaining: closing.length
  };
  closeOperation = operation;
  const complete = () => {
    if (operation.completed || !operation.cleanupStarted || operation.remaining !== 0) return;
    operation.completed = true;
    closeOperation = null;
    const callbacks = operation.callbacks;
    operation.callbacks = [];
    operation.closing = [];
    for (const waiting of callbacks) waiting(operation.firstError);
  };
  const closed = (error = null) => {
    if (error && !operation.firstError) operation.firstError = error;
    operation.remaining -= 1;
    complete();
  };
  for (const server of operation.closing) {
    let settled = false;
    const serverClosed = (error = null) => {
      if (settled) return;
      settled = true;
      closed(error);
    };
    try {
      server.close(serverClosed);
    } catch (error) {
      serverClosed(error);
    }
  }
  destroyAcceptedSockets();
  operation.cleanupStarted = true;
  complete();
}
```

- [ ] **Step 5: Give terminal failure priority over concurrent release**

Add one helper for listener, non-`EADDRINUSE` bind, synchronous bind, and top-level failures. Route those terminal paths through it instead of directly calling `finish(states.FAILED, 1)`. `retryCleanly` remains a normal contention cleanup: only its own close error requests terminal failure, while an already-requested concurrent failure suppresses the retry. Make `finish` enforce the flag as a final guard, and make the release waiter preserve normal `RELEASE_FAILED` behavior for a standalone `server.close` error while publishing `FAILED` when a terminal failure was requested.

```js
function finish(status, detail = 0) {
  if (finished) return;
  if (terminalFailureRequested) {
    status = states.FAILED;
    detail = 1;
  }
  finished = true;
  publish(status, detail);
  parentPort.close();
}

function requestTerminalFailure() {
  if (finished) return;
  terminalFailureRequested = true;
  generation += 1;
  closeServers(() => finish(states.FAILED, 1));
}

function retryCleanly(attemptGeneration) {
  if (finished || attemptGeneration !== generation) return;
  generation += 1;
  closeServers((error) => {
    if (error) requestTerminalFailure();
    else if (!terminalFailureRequested) retryAfterContention();
  });
}

closeServers((error) => {
  if (terminalFailureRequested) finish(states.FAILED, 1);
  else finish(error ? states.RELEASE_FAILED : states.RELEASED, error ? 1 : 0);
});
```

- [ ] **Step 6: Route inbound lock connections through the ownership helper**

Replace the server constructor inside `bindCandidate`:

```js
candidate = net.createServer((socket) => serveLock(socket, target.identity));
```

- [ ] **Step 7: Run the half-open test and verify GREEN**

Run the same command as Task 1 Step 3.

Expected: PASS; release completes in under 2.5 seconds and the same target is immediately reacquired nonblocking while the `allowHalfOpen` child is still alive. The test then writes the stop file, gives the already-bound `probeExit` promise a fresh five-second cleanup window, and performs a separately bounded close/reap wait, so setup and release latency do not consume the cleanup budget, normal cleanup leaves no child, and abnormal cleanup cannot hang the test indefinitely. Worker-side `socket.destroy()` closes the local handle needed by `server.close`; after the worker has already sent FIN with the banner, TCP still permits the remote peer's write half to remain open until that peer explicitly closes it.

- [ ] **Step 8: Run the terminal-cleanup reentry test and verify GREEN**

Run the focused command from Step 3 again.

Expected: PASS; the release request joins the shared `closeOperation`, the
terminal failure retains priority over concurrent release, the caller receives
`ERR_FILE_LOCK_RELEASE_FAILED`, and the worker exits normally after publishing
the failure state.

- [ ] **Step 9: Run adjacent Node 24 lock and migration coverage**

Run:

```bash
/opt/homebrew/opt/node@24/bin/node --check lib/shared/socket-lock-worker.mjs
/opt/homebrew/opt/node@24/bin/node --test test/socket-file-lock.test.mjs
/opt/homebrew/opt/node@24/bin/node \
  --test \
  --test-name-pattern='concurrent real-root and symlink-alias registration|concurrent migrations publish one correctly labelled pre-v7 backup' \
  test/file-lock.test.mjs test/schema-v7.test.mjs
```

Expected: every command exits 0. The complete socket-lock file reports 21 tests, 21 passes, and 0 failures; both historical macOS symptoms pass, the terminal-cleanup reentry regression passes, and the existing injected release/termination failure tests remain unchanged.

- [ ] **Step 10: Confirm fail-closed invariants are untouched**

Review `git diff -- lib/shared/file-lock.mjs lib/shared/socket-lock-worker.mjs` and verify:

```text
lib/shared/file-lock.mjs has no diff
RELEASE_GRACE_MS remains 5000
RELEASED and RELEASE_FAILED numeric states are unchanged
terminateWorker and cleanup-error aggregation are unchanged
withFileLock remains synchronous
```

- [ ] **Step 11: Commit the RED-GREEN fix**

```bash
git add test/socket-file-lock.test.mjs lib/shared/socket-lock-worker.mjs
git commit -m "fix: close accepted sockets before releasing file locks"
```

### Task 3: Advance the untagged release candidate to 1.0.1

**Files:**
- Modify: `test/release-contract.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Review: `README.md`, `README.zh-CN.md`, `docs/`, `lib/ui/help.mjs`

- [ ] **Step 1: Move the release-contract expectations first**

Add the current-release constant near the test fixtures, use it for the three package/lock assertions, rename the metadata test, and require the new changelog section while keeping all historical v1 boundary assertions intact.

```js
const currentRelease = '1.0.1';

test('current release metadata and Docker verification contract stay pinned', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const dockerfile = read('Dockerfile');
  assert.equal(pkg.version, currentRelease);
  assert.equal(lock.version, currentRelease);
  assert.equal(lock.packages[''].version, currentRelease);
  assert.match(dockerfile, /RUN npm ci --no-audit --no-fund/);
  assert.match(dockerfile, /node --version && tmux -V/);
  assert.doesNotMatch(dockerfile, /RUN npm install /);
});
```

Add this assertion in the existing CLI/changelog test without replacing its `1.0.0` compatibility assertions:

```js
assert.match(changelog, /## 1\.0\.1/);
```

- [ ] **Step 2: Run the release contract and verify RED**

Run:

```bash
/opt/homebrew/opt/node@24/bin/node \
  --test \
  --test-name-pattern='current release metadata|CLI help and changelog' \
  test/release-contract.test.mjs
```

Expected: FAIL because `package.json`, both lockfile version fields, and `CHANGELOG.md` still describe the published `1.0.0` release.

- [ ] **Step 3: Update package and lockfile versions without tagging**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm version 1.0.1 --no-git-tag-version
```

Expected: `package.json`, `package-lock.json.version`, and `package-lock.json.packages[''].version` become `1.0.1`; no Git tag or commit is created by npm.

- [ ] **Step 4: Add the 1.0.1 changelog section**

Insert this section immediately before `## 1.0.0`:

```markdown
## 1.0.1

### Summary

hello-cc 1.0.1 is a reliability patch for deterministic cross-process file-lock
release. It keeps the 1.0.0 CLI, schema v7, Runtime API v2, and accepted-risk
boundaries unchanged.

### Highlights

- File-lock workers now destroy every local accepted identity-probe handle before
  publishing `RELEASED`, so listener completion no longer waits for a peer's
  still-open write half until the five-second failure bound.
- Added a real-worker regression that keeps the remote client write direction
  open through prompt release, immediately reacquires the same lock endpoint,
  and then explicitly stops and awaits the probe child.

### Compatibility Notes

- No CLI, database schema, Runtime API, or browser project-root behavior changes
  are introduced by this patch.
- The five-second fail-closed release detector and cleanup-error reporting remain
  intact; the fix removes the unbounded peer dependency instead of increasing
  the timeout.

### Validation

The release gate requires repeated macOS Node 24 unit and regression checks, a
fresh no-cache Linux Node 24/tmux image with three consecutive full `npm test`
runs ending in `FULL_REGRESSION_OK`, and installation plus PTY/database/Web
smoke tests from the exact generated npm tarball in a fourth clean container.
```

- [ ] **Step 5: Run the release-contract checks and verify GREEN**

Run:

```bash
/opt/homebrew/opt/node@24/bin/node --test test/release-contract.test.mjs
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run release:check
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run release:notes
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run release:github:dry-run -- --version 1.0.1
/opt/homebrew/opt/node@24/bin/node ./bin/hcc.mjs --version
```

Expected: all commands exit 0; release notes resolve `1.0.1`, the dry-run tag is `v1.0.1`, and CLI version output is exactly `1.0.1`.

- [ ] **Step 6: Preserve historical 1.0.0 documentation**

Run:

```bash
git diff -- \
  README.md README.zh-CN.md \
  docs/README.md docs/README.zh-CN.md \
  docs/commands.md docs/commands.zh-CN.md \
  docs/guide.md docs/guide.zh-CN.md \
  lib/ui/help.mjs
```

Expected: no diff. The `1.0.0` references in those files describe the existing schema/API compatibility boundary and must not be mechanically rewritten.

- [ ] **Step 7: Commit release metadata**

```bash
git add test/release-contract.test.mjs package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): prepare 1.0.1"
```

### Task 4: Run fresh macOS Node 24 verification

**Files:**
- Verify: all production and test modules
- Modify only if a command exposes a distinct defect; demonstrate that defect with a focused RED test before changing its subsystem.

- [ ] **Step 1: Confirm the declared runtime and toolchain**

Run:

```bash
/opt/homebrew/opt/node@24/bin/node --version
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm --version
tmux -V
```

Expected: Node reports `v24.x`, npm runs through that Node 24 installation, and tmux is available.

- [ ] **Step 2: Run the deterministic release case 20 consecutive times**

Run:

```bash
for run in {1..20}; do
  /opt/homebrew/opt/node@24/bin/node \
    --test \
    --test-name-pattern='release closes a half-open identity probe before publishing RELEASED' \
    test/socket-file-lock.test.mjs || exit 1
done
```

Expected: 20/20 commands exit 0 without a five-second release delay. Each iteration proves immediate reacquisition while the probe child remains half-open, then explicitly writes its stop file and awaits exit, leaving no child process behind.

- [ ] **Step 3: Run three complete unit-suite passes under Node 24**

Run this command three times, sequentially:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:unit
```

Expected for every pass: zero failures. Record the pass, fail, and documented platform-skip counts from each fresh output.

- [ ] **Step 4: Run the full 13-stage macOS regression**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:regression
```

Expected: stages `[1/13]` through `[13/13]` appear, the process exits 0, and the final marker is `FULL_REGRESSION_OK` after runtime and tmux cleanup assertions.

- [ ] **Step 5: Run syntax, package, and release dry-runs**

Run:

```bash
/opt/homebrew/opt/node@24/bin/node --check bin/hcc.mjs
find lib -name '*.mjs' -print0 | xargs -0 -n1 /opt/homebrew/opt/node@24/bin/node --check
/opt/homebrew/opt/node@24/bin/node --check scripts/regression.mjs
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run release:check
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run release:github:dry-run -- --version 1.0.1
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm pack --dry-run --json
git diff --check
```

Expected: every command exits 0; the package dry-run lists the production closure and reports version `1.0.1`; no whitespace errors are reported.

- [ ] **Step 6: Keep platform-specific failures explicit**

The Linux container gate in Task 5 cannot establish macOS `node-pty` helper permissions or Intel macOS behavior. If the real PTY identity test or a fresh macOS install reports `posix_spawnp failed`, leave the candidate unpublished and handle that dependency defect as its own written design and RED-GREEN plan; do not classify Linux container success as a substitute.

### Task 5: Run the full local Linux-container acceptance gate

**Files:**
- Verify: `Dockerfile`, `.dockerignore`, the complete source tree, and the exact `1.0.1` npm tarball
- Artifacts: one unique directory beneath `/Users/xf02163/Desktop/project/wjj/.hello-cc-release-artifacts/`, created and recorded by the exact commands below.
- Do not modify source during this task unless a failing gate first yields a focused RED test.

- [ ] **Step 1: Build one fresh immutable Node 24 candidate image**

Run:

```bash
docker build --pull --no-cache \
  --label 'org.logicseek.hello-cc.gate=v1.0.1' \
  -t 'hello-cc-v1.0.1-verify:node24' .
docker image inspect --format '{{.Id}}' \
  'hello-cc-v1.0.1-verify:node24' > /tmp/hello-cc-v101-candidate-image-id
candidate_image_id="$(sed -n '1p' /tmp/hello-cc-v101-candidate-image-id)"
test -n "$candidate_image_id"
docker image inspect --format 'candidate={{.Id}} os={{.Os}} arch={{.Architecture}}' \
  "$candidate_image_id"
```

Expected: a nonempty immutable image ID, Linux OS, Node 24 base, and a successful no-cache build from the current source snapshot.

- [ ] **Step 2: Run source acceptance pass 1**

```bash
candidate_image_id="$(sed -n '1p' /tmp/hello-cc-v101-candidate-image-id)"
test "$candidate_image_id" = "$(docker image inspect --format '{{.Id}}' 'hello-cc-v1.0.1-verify:node24')"
docker run --rm --init \
  --name hello-cc-v101-full-1 \
  --label 'org.logicseek.hello-cc.gate=v1.0.1' \
  "$candidate_image_id" \
  sh -lc 'set -eu; node --version | grep -Eq "^v24\\."; tmux -V; test "$(node ./bin/hcc.mjs --version)" = 1.0.1; node ./bin/hcc.mjs --help >/dev/null; exec npm test'
```

Expected: exit 0, identifier audit success, unit `fail 0`, all 13 regression stages, and `FULL_REGRESSION_OK`.

- [ ] **Step 3: Run source acceptance pass 2 from the same image ID**

```bash
candidate_image_id="$(sed -n '1p' /tmp/hello-cc-v101-candidate-image-id)"
test "$candidate_image_id" = "$(docker image inspect --format '{{.Id}}' 'hello-cc-v1.0.1-verify:node24')"
docker run --rm --init \
  --name hello-cc-v101-full-2 \
  --label 'org.logicseek.hello-cc.gate=v1.0.1' \
  "$candidate_image_id" \
  sh -lc 'set -eu; node --version | grep -Eq "^v24\\."; tmux -V; test "$(node ./bin/hcc.mjs --version)" = 1.0.1; node ./bin/hcc.mjs --help >/dev/null; exec npm test'
```

Expected: the same complete success evidence as pass 1; no image rebuild occurs between passes.

- [ ] **Step 4: Run source acceptance pass 3 from the same image ID**

```bash
candidate_image_id="$(sed -n '1p' /tmp/hello-cc-v101-candidate-image-id)"
test "$candidate_image_id" = "$(docker image inspect --format '{{.Id}}' 'hello-cc-v1.0.1-verify:node24')"
candidate_commit="$(git rev-parse --short=12 HEAD)"
artifact_parent='/Users/xf02163/Desktop/project/wjj/.hello-cc-release-artifacts'
mkdir -p "$artifact_parent"
artifact_dir="$(mktemp -d "$artifact_parent/v1.0.1-$candidate_commit.XXXXXX")"
printf '%s\n' "$artifact_dir" > /tmp/hello-cc-v101-artifact-dir
docker run --rm --init \
  --name hello-cc-v101-full-3 \
  --label 'org.logicseek.hello-cc.gate=v1.0.1' \
  --mount "type=bind,src=$artifact_dir,dst=/artifact" \
  "$candidate_image_id" \
  sh -lc 'set -eu; node --version | grep -Eq "^v24\\."; tmux -V; test "$(node ./bin/hcc.mjs --version)" = 1.0.1; node ./bin/hcc.mjs --help >/dev/null; npm test; npm pack --json --pack-destination /artifact'
```

Expected: the same complete success evidence as passes 1 and 2, followed by successful creation of the real npm tarball from that already tested image.

- [ ] **Step 5: Verify the three source containers were removed**

Run:

```bash
docker ps -a \
  --filter 'label=org.logicseek.hello-cc.gate=v1.0.1' \
  --format '{{.ID}} {{.Names}} {{.Status}}'
```

Expected at this point: no containers. The regression marker is emitted only after its internal runtime/tmux cleanup and leak assertions, and `--rm` removes each container namespace.

- [ ] **Step 6: Verify and fingerprint the exact artifact from pass 3**

Run:

```bash
artifact_dir="$(sed -n '1p' /tmp/hello-cc-v101-artifact-dir)"
test -d "$artifact_dir"
tarball="$artifact_dir/logicseek-hello-cc-1.0.1.tgz"
test -s "$tarball"
shasum -a 256 "$tarball"
```

Expected: one nonempty `logicseek-hello-cc-1.0.1.tgz` created from the same verified source image, plus a recorded SHA-256 digest. The tarball is outside the repository build context.

- [ ] **Step 7: Start the fourth clean Node 24 container without source or credentials**

Run:

```bash
artifact_dir="$(sed -n '1p' /tmp/hello-cc-v101-artifact-dir)"
test -d "$artifact_dir"
tarball="$artifact_dir/logicseek-hello-cc-1.0.1.tgz"
node24_image_id="$(docker image inspect --format '{{.Id}}' node:24)"
test -s "$tarball"
test -n "$node24_image_id"
docker run -d --init \
  --name 'hello-cc-v101-artifact-smoke' \
  --label 'org.logicseek.hello-cc.gate=v1.0.1' \
  "$node24_image_id" \
  sleep infinity
docker cp "$tarball" 'hello-cc-v101-artifact-smoke:/tmp/logicseek-hello-cc-1.0.1.tgz'
```

Expected: the container has only the clean Node 24 base and the exact tarball. It has no source-tree mount, published port, npm token, Git credential, or host runtime state.

- [ ] **Step 8: Install the actual tarball and verify package metadata and CLI**

Run:

```bash
docker exec 'hello-cc-v101-artifact-smoke' bash -lc 'apt-get update && apt-get install -y --no-install-recommends tmux build-essential && rm -rf /var/lib/apt/lists/*'
docker exec 'hello-cc-v101-artifact-smoke' npm install -g /tmp/logicseek-hello-cc-1.0.1.tgz --no-audit --no-fund
docker exec 'hello-cc-v101-artifact-smoke' node -e 'const cp=require("node:child_process"),p=require("node:path");const r=cp.execFileSync("npm",["root","-g"],{encoding:"utf8"}).trim();const m=require(p.join(r,"@logicseek/hello-cc/package.json"));if(m.name!=="@logicseek/hello-cc"||m.version!=="1.0.1"||m.engines.node!==">=24.0.0")throw new Error(JSON.stringify(m));console.log("HCC_METADATA_OK")'
docker exec 'hello-cc-v101-artifact-smoke' hcc --version
docker exec 'hello-cc-v101-artifact-smoke' hcc --help
```

Expected: `HCC_METADATA_OK`, version `1.0.1`, and complete CLI help from the globally installed artifact.

- [ ] **Step 9: Launch a real PTY from the installed dependency**

Run:

```bash
docker exec 'hello-cc-v101-artifact-smoke' node --input-type=module -e 'import{createRequire}from"node:module";import{execFileSync}from"node:child_process";import path from"node:path";const r=execFileSync("npm",["root","-g"],{encoding:"utf8"}).trim();const hccRoot=path.join(r,"@logicseek/hello-cc");const require=createRequire(path.join(hccRoot,"package.json"));const pty=require("node-pty");const c=pty.spawn("/bin/bash",["--noprofile","--norc","-lc","printf HCC_PTY_OK"],{name:"xterm-256color",cols:80,rows:24,cwd:"/tmp",env:{...process.env,TERM:"xterm-256color"}});let o="";const t=setTimeout(()=>{try{c.kill("SIGKILL")}catch{};throw new Error("PTY timeout")},5000);c.onData(d=>o+=d);c.onExit(({exitCode})=>{clearTimeout(t);if(exitCode!==0||!o.includes("HCC_PTY_OK")){console.error(JSON.stringify({exitCode,o}));process.exit(1)}console.log("HCC_PTY_OK")})'
```

Expected: `HCC_PTY_OK` and exit 0 from a real `node-pty` process, not a mocked import.

- [ ] **Step 10: Initialize and inspect a temporary project database**

Run:

```bash
docker exec 'hello-cc-v101-artifact-smoke' mkdir -p /tmp/hcc-smoke-project
docker exec 'hello-cc-v101-artifact-smoke' hcc --root /tmp/hcc-smoke-project up --no-discover --no-guidance
docker exec 'hello-cc-v101-artifact-smoke' test -s /tmp/hcc-smoke-project/.hello-cc/mesh.db
docker exec 'hello-cc-v101-artifact-smoke' node -e 'const{execFileSync}=require("node:child_process");const p=JSON.parse(execFileSync("hcc",["--root","/tmp/hcc-smoke-project","--json","doctor"],{encoding:"utf8"}));if(!p.ok||p.data?.schema_version!==7)throw new Error(JSON.stringify(p));console.log("HCC_DB_OK")'
```

Expected: project initialization succeeds, the SQLite database exists, doctor reports `ok`, and schema version is 7.

- [ ] **Step 11: Start, probe, and stop the installed Web runtime**

Run:

```bash
docker exec 'hello-cc-v101-artifact-smoke' hcc --root /tmp/hcc-smoke-project web --local --port 18787 --no-token --no-discover --no-guidance
docker exec 'hello-cc-v101-artifact-smoke' node --input-type=module -e 'const end=Date.now()+15000;let last="";while(Date.now()<end){try{const r=await fetch("http://127.0.0.1:18787/api/runtime",{headers:{"X-HCC-API-Version":"2"}});if(r.status===200){const p=await r.json();if(p.api_version!==2)throw new Error(JSON.stringify(p));console.log("HCC_WEB_OK");process.exit(0)}last=`status ${r.status}`}catch(e){last=e.message}await new Promise(r=>setTimeout(r,100))}throw new Error(`runtime health timeout: ${last}`)'
docker exec 'hello-cc-v101-artifact-smoke' hcc --root /tmp/hcc-smoke-project down
docker exec 'hello-cc-v101-artifact-smoke' test ! -e /tmp/hcc-smoke-project/.hello-cc/runtime.json
docker exec 'hello-cc-v101-artifact-smoke' bash -lc 'if tmux list-sessions -F "#{session_name}" 2>/dev/null | grep -q "^hcc-"; then tmux list-sessions; exit 1; fi'
```

Expected: Web startup returns only after health, the Runtime API v2 request returns 200, `down` removes the runtime pointer, and no HCC tmux session remains.

- [ ] **Step 12: Remove only the exact smoke container and audit residue**

Run:

```bash
docker stop -t 5 'hello-cc-v101-artifact-smoke'
docker rm 'hello-cc-v101-artifact-smoke'
docker ps -a \
  --filter 'label=org.logicseek.hello-cc.gate=v1.0.1' \
  --format '{{.ID}} {{.Names}} {{.Status}}'
```

Expected: the final filtered container list is empty. Do not run `docker prune`, do not kill the host tmux server, and do not remove unrelated long-lived containers or images.

### Task 6: Perform the final evidence and publication-boundary review

**Files:**
- Review: the complete local stack relative to `origin/master`
- Do not create tags, GitHub Releases, or npm publications in this plan.

- [ ] **Step 1: Re-read the approved design against the implementation**

For every goal and non-goal in `docs/superpowers/specs/2026-08-19-file-lock-release-hardening-design.md`, point to the implementing diff and fresh verification output. Confirm there is no unimplemented requirement and no broadened API behavior.

- [ ] **Step 2: Inspect the complete local delta and authorship**

Run:

```bash
git status --short --branch
git diff --check origin/master
git diff --stat origin/master
git diff --name-status origin/master
git log --format='%h %an <%ae> %s' origin/master..HEAD
git tag --points-at HEAD
```

Expected: only planned files and committed design/plan documents differ; all new commits use `Dullne <141425656+Dullne@users.noreply.github.com>`; `git diff --check` is empty; no tag points at the candidate commit.

- [ ] **Step 3: State the verified boundary without publishing**

Report separately:

```text
deterministic RED-GREEN file-lock evidence
macOS Node 24 unit/regression results
three immutable-image Linux source runs
artifact SHA-256
fourth-container metadata/CLI/PTY/DB/Web results
any platform-specific blocker that the Linux container cannot cover
exact commits ahead of origin/master
```

Do not push, tag, create a GitHub Release, or run `npm publish`. Those external actions require a subsequent explicit authorization after every listed gate is green.
