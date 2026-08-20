# File Lock Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make socket-backed file-lock release deterministic in the presence of half-open probe clients, prepare an untagged `1.0.1` release candidate, and prove the candidate with fresh macOS Node 24 and local Linux-container evidence.

**Architecture:** The worker remains the sole owner of lock listeners and the synchronous parent protocol remains unchanged. The worker additionally owns a set of accepted inbound sockets; every shutdown path first stops listeners and then destroys those sockets so `server.close()` completion no longer depends on peer behavior. Release metadata and the existing release-contract test move to `1.0.1`, while the published `v1.0.0` contract remains immutable.

**Tech Stack:** Node.js 24 ESM, `node:test`, worker threads, loopback `net.Server`, npm packaging, Docker/Colima, tmux, SQLite, HTTP/WebSocket regression tests.

---

## File Map

- Modify `test/socket-file-lock.test.mjs`: add a real-worker regression whose child keeps an accepted identity-probe connection half-open.
- Modify `lib/shared/socket-lock-worker.mjs`: track accepted inbound sockets and destroy them during every listener shutdown.
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

Add this helper after `startHolder`. It retries until the lock worker appears, verifies the exact identity banner, deliberately leaves its writable half open after the server ends its half, and exits only when the server destroys the connection or the test writes the stop file.

```js
function startHalfOpenProbe(t, endpoint, expectedBanner, root) {
  const ready = path.join(root, 'half-open-probe-ready');
  const stop = path.join(root, 'half-open-probe-stop');
  const source = String.raw`
    import fs from 'node:fs';
    import net from 'node:net';
    const [host, portText, expectedBanner, ready, stop] = process.argv.slice(1);
    const port = Number(portText);
    let connected = false;
    let socket = null;
    let retryTimer = null;

    const finish = (code) => {
      if (retryTimer) clearTimeout(retryTimer);
      try { socket?.destroy(); } catch {}
      process.exit(code);
    };
    const stopTimer = setInterval(() => {
      if (fs.existsSync(stop)) finish(0);
    }, 10);
    const retry = () => {
      if (connected || retryTimer || fs.existsSync(stop)) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, 5);
    };
    const connect = () => {
      let received = '';
      socket = net.createConnection({ host, port, allowHalfOpen: true });
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { received += chunk; });
      socket.once('end', () => {
        if (received !== expectedBanner) return finish(2);
        connected = true;
        fs.writeFileSync(ready, 'ready');
      });
      socket.once('error', () => retry());
      socket.once('close', () => {
        if (connected) {
          clearInterval(stopTimer);
          process.exit(0);
        }
        retry();
      });
    };
    connect();
  `;
  const child = spawn(process.execPath, [
    '--input-type=module', '-e', source,
    endpoint.host, String(endpoint.port), expectedBanner, ready, stop
  ], {
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

Place this test next to the other real socket-lock lifecycle cases. It waits inside the synchronous callback, starts the release timer only after the child has confirmed the banner, requires completion well below the existing five-second failure bound, and proves immediate reacquisition.

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
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let releaseStartedAt = null;

  try {
    const result = withFileLock(target, () => {
      const deadline = performance.now() + 5000;
      while (!fs.existsSync(probe.ready)) {
        if (performance.now() >= deadline) {
          throw new Error('timed out waiting for half-open identity probe');
        }
        Atomics.wait(wait, 0, 0, 10);
      }
      releaseStartedAt = performance.now();
      return 'released';
    });

    assert.equal(result, 'released');
    const releaseElapsedMs = performance.now() - releaseStartedAt;
    assert.ok(releaseElapsedMs < 2500, `release took ${releaseElapsedMs}ms`);
    await waitForExit(probe.child);
    assert.equal(
      withFileLock(target, () => 'reacquired', { nonblocking: true }),
      'reacquired'
    );
  } finally {
    fs.writeFileSync(probe.stop, 'stop');
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

Expected: FAIL after approximately five seconds. The error graph must contain `ERR_FILE_LOCK_RELEASE_FAILED` and `ERR_FILE_LOCK_WORKER_TERMINATION_UNCONFIRMED`; a syntax error, child timeout, or banner mismatch is not the required RED result.

- [ ] **Step 4: Retain the demonstrated regression after recording the RED output**

Do not commit production code in this step. Keep the failing test in the working tree so the next task begins from the observed failure.

### Task 2: Destroy accepted sockets during every worker shutdown

**Files:**
- Modify: `lib/shared/socket-lock-worker.mjs`
- Test: `test/socket-file-lock.test.mjs`
- Review: `lib/shared/file-lock.mjs`

- [ ] **Step 1: Add accepted-socket ownership beside the listener state**

Inside `runSocketLockWorker`, add one worker-local set. Do not include the outgoing sockets created by `probeOccupant`.

```js
const acceptedSockets = new Set();
```

- [ ] **Step 2: Add idempotent connection registration and cleanup helpers**

Place these helpers after `finish`. `destroyAcceptedSockets` intentionally does not clear the set; each socket removes itself on its real `close` event, preserving accurate ownership until the handle is closed.

```js
function serveLockBanner(socket, identity) {
  acceptedSockets.add(socket);
  socket.once('close', () => acceptedSockets.delete(socket));
  socket.end(lockBanner(identity));
}

function destroyAcceptedSockets() {
  for (const socket of acceptedSockets) {
    try { socket.destroy(); } catch {}
  }
}
```

- [ ] **Step 3: Stop listeners before destroying all accepted sockets**

Replace `closeServers` with the following implementation. It preserves the existing first-error aggregation and callback completion rule, including the zero-listener path.

```js
function closeServers(callback) {
  const closing = servers;
  servers = [];
  if (closing.length === 0) {
    destroyAcceptedSockets();
    callback(null);
    return;
  }
  let remaining = closing.length;
  let firstError = null;
  const closed = (error = null) => {
    if (error && !firstError) firstError = error;
    remaining -= 1;
    if (remaining === 0) callback(firstError);
  };
  for (const server of closing) {
    try {
      server.close(closed);
    } catch (error) {
      closed(error);
    }
  }
  destroyAcceptedSockets();
}
```

- [ ] **Step 4: Route inbound lock connections through the ownership helper**

Replace the server constructor inside `bindCandidate`:

```js
candidate = net.createServer((socket) => serveLockBanner(socket, target.identity));
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the same command as Task 1 Step 3.

Expected: PASS; release completes in under 2.5 seconds, the half-open child exits because its socket is destroyed, and the same target is reacquired nonblocking.

- [ ] **Step 6: Run adjacent Node 24 lock and migration coverage**

Run:

```bash
/opt/homebrew/opt/node@24/bin/node --check lib/shared/socket-lock-worker.mjs
/opt/homebrew/opt/node@24/bin/node --test test/socket-file-lock.test.mjs
/opt/homebrew/opt/node@24/bin/node \
  --test \
  --test-name-pattern='concurrent real-root and symlink-alias registration|concurrent migrations publish one correctly labelled pre-v7 backup' \
  test/file-lock.test.mjs test/schema-v7.test.mjs
```

Expected: every command exits 0. The complete socket-lock file passes, both historical macOS symptoms pass, and the existing injected release/termination failure tests remain unchanged.

- [ ] **Step 7: Confirm fail-closed invariants are untouched**

Review `git diff -- lib/shared/file-lock.mjs lib/shared/socket-lock-worker.mjs` and verify:

```text
lib/shared/file-lock.mjs has no diff
RELEASE_GRACE_MS remains 5000
RELEASED and RELEASE_FAILED numeric states are unchanged
terminateWorker and cleanup-error aggregation are unchanged
withFileLock remains synchronous
```

- [ ] **Step 8: Commit the RED-GREEN fix**

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

- File-lock workers now close every accepted identity-probe socket before
  publishing `RELEASED`, so a half-open local client cannot hold release open
  until the five-second failure bound.
- Added a real-worker regression that holds the client write direction open,
  proves prompt release, and immediately reacquires the same lock endpoint.

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

Expected: 20/20 commands exit 0 without a five-second release delay or a leftover child process.

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
