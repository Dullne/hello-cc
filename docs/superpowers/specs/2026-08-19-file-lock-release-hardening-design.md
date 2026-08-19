# File Lock Release Hardening Design

## Context

hello-cc uses a worker thread that owns loopback `net.Server` instances as a
cross-process file lock. The synchronous caller posts a `release` message and
waits up to five seconds for the worker to publish `RELEASED`.

On macOS under concurrent unit-test load, accepted probe connections can keep a
server's `close` callback pending. The caller then reports
`ERR_FILE_LOCK_RELEASE_FAILED` and, because `Worker.terminate()` is asynchronous,
adds `ERR_FILE_LOCK_WORKER_TERMINATION_UNCONFIRMED`. This reproduced in both
project-registry and schema-migration concurrency tests.

## Goals

- Make successful lock release independent of whether a probing client keeps an
  accepted socket open.
- Preserve the synchronous `withFileLock` API and its fail-closed behavior.
- Keep the five-second release bound as a genuine failure detector.
- Add a deterministic regression that fails on the current implementation.
- Release the correction as `1.0.1` after macOS and Linux verification.

## Non-Goals

- Do not rewrite published Git history or move the `v1.0.0` tag.
- Do not redesign file locking as an asynchronous API.
- Do not hide the defect by only increasing `RELEASE_GRACE_MS`.
- Do not weaken cleanup errors or treat an unconfirmed worker exit as success.

## Considered Approaches

### 1. Increase the release timeout

This is the smallest change, but it only moves the failure threshold. A client
can hold a socket indefinitely, so a larger timeout cannot make release
deterministic. Rejected.

### 2. Track and destroy accepted sockets during release

Each lock server records accepted sockets in a worker-local set and removes them
on `close`. Release first stops every listener, then destroys the recorded
accepted sockets. The existing server-close callbacks publish `RELEASED` only
after all listeners have closed. This preserves the current API and protocol
while removing the unbounded dependency on peer behavior. Selected.

### 3. Convert locking and cleanup to an asynchronous API

Awaiting `server.close()` and `worker.terminate()` would provide a natural
completion model, but it would require changing every synchronous database and
registry caller. This is broader than the release defect and is deferred.

## Detailed Design

`socket-lock-worker.mjs` will maintain a `Set` of inbound sockets accepted by
all candidate lock servers. The connection handler will register each socket,
remove it after the socket closes, and continue sending the existing identity
banner.

`closeServers` will snapshot and clear the current server list, call `close` on
each listener so no new connections are accepted, and then destroy every
currently tracked inbound socket. Because worker JavaScript is single-threaded,
no connection callback can interleave between initiating listener shutdown and
destroying the socket snapshot. Socket `close` events remove their entries from
the set.

The existing state protocol remains unchanged:

- Successful listener shutdown publishes `RELEASED`.
- A listener-close error publishes `RELEASE_FAILED`.
- The parent continues to wait at most five seconds.
- If release is not confirmed, the parent retains its existing fail-closed
  termination and aggregate-error behavior.

The same shutdown helper is used when retrying after contention or handling a
worker failure, so those paths also cannot retain accepted probe sockets.

## Regression Coverage

A real-worker test will:

1. Resolve the primary endpoint for a unique temporary lock target.
2. Start a child process that retries the endpoint until the worker acquires it.
3. Keep the accepted connection open after receiving the identity banner.
4. Return from the synchronous lock callback while the child still holds the
   connection.
5. Assert that lock release succeeds promptly and that the endpoint can be
   acquired again.

The test must fail with `ERR_FILE_LOCK_RELEASE_FAILED` before the production
change and pass afterward. Existing injected-worker cleanup tests continue to
cover explicit release and termination failures.

Verification will include repeated macOS Node 24 unit runs, the targeted file
lock and schema migration tests, full macOS regression, and the Docker Node 24
Linux suite.

## Release And Attribution

The package, lockfile, release contract, and changelog will advance to `1.0.1`.
The existing `v1.0.0` release remains immutable. Repository-local Git author
settings will use `Dullne` and the verified GitHub noreply address for future
commits. Existing history will not be rewritten, and future commits will omit
Claude co-author trailers.
