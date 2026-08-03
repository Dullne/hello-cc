# hello-cc v1 Release and Verification Design

Status: approved in conversation on 2026-08-03.

## Purpose

Define code ownership boundaries, fatal error behavior, packaging, documentation,
and evidence required before the remaining hardening work can be called complete.

## Module Boundaries

New focused modules own these policies:

- process identity inspection and comparison;
- clock observation and liveness resolution;
- project registry locking;
- buffer GC planning and arbitration;
- Runtime API version negotiation;
- secret redaction.

`bin/hcc.mjs` remains the command and runtime orchestrator. It calls these
modules but does not duplicate their decision logic. Existing repository
patterns are retained; unrelated restructuring is out of scope.

Every imported production module must be tracked and included by the package
`files` contract. Docker test files are tracked but remain outside the npm
package.

## Fatal Error Behavior

Expected poller, watcher, sibling-project, and transient runtime failures are
caught at their ownership boundary, logged with redaction, and isolated.

An uncaught exception or unhandled rejection initiates one idempotent fatal
shutdown. Shutdown stops timers and watchers, closes sessions and sockets using
the documented detach/exit semantics, clears only runtime pointers owned by the
current process identity, closes the server and database resources, then exits
nonzero. The runtime must not continue after an unknown exception.

A second fatal signal during shutdown forces termination without attempting a
second cleanup pass.

## Release Contract

The package version becomes `1.0.0`. Changelog, README files, bilingual command
documentation, help output, and the defect review describe:

- schema v7 and no downgrade support;
- the pre-migration backup;
- provider peer ID changes;
- Runtime API v2 and session token delivery changes;
- safe GC defaults and `--history`;
- process-evidence-first liveness and unknown-only grace;
- optional TLS and trusted proxy usage;
- accepted plaintext LAN and arbitrary-root risks.

The defect report uses evidence-backed status counts and the actual branch. It
must not label accepted risks or partial controls as completely fixed.

The Dockerfile uses `npm ci`, records Node and tmux versions in test output, and
builds from the complete current source tree. `.dockerignore` excludes host
runtime state and secrets without excluding production source.

## Test Architecture

Pure policies use Node's built-in test runner in focused test files. Real CLI,
SQLite, tmux, HTTP, HTTPS, and WebSocket boundaries remain integration tests.
Tests do not add production-only backdoors or test-only public APIs.

Each behavior change follows red-green-refactor:

1. add the smallest regression that demonstrates the missing invariant;
2. run it and record the expected failure;
3. implement the minimum production change;
4. rerun the focused test and relevant neighboring tests;
5. refactor only while green.

Required regressions cover:

- v5/v6 backup and migration failure atomicity;
- PID reuse and platform process inspection;
- live, dead, and unknown tmux/external peers;
- CLI-only sleep-sized gaps and concurrent grace writers;
- manual/automatic GC, negative retention, history opt-in, and runtime failure;
- concurrent registry writers and same-root DB changes;
- API v2, cookie lifecycle, action-token scope, CSP, and redaction;
- realpath and symlink containment;
- fatal shutdown cleanup;
- package content and tracked-file completeness.

TTL renewal tests use the renewal operation's recorded timestamp rather than
assuming wall-clock readings in separate processes are monotonic. This retains
strict TTL inflation checks without the observed one-second container flake.

## Verification Gates

Completion requires fresh evidence, in this order:

1. final diff and tracked production import audit;
2. syntax/import/package-content checks;
3. focused unit and security regression tests;
4. original vulnerable-path reproductions and alternate bypass inputs;
5. preserved legitimate behavior tests;
6. complete local regression;
7. a freshly built Node 24/Linux image;
8. three consecutive complete container regressions;
9. final `origin/master..worktree` review and documentation consistency check.

A failed gate blocks a completion claim. Accepted risks are reported separately
and are not represented as test gaps or fixed findings.

## Definition of Done

The work is complete only when every approved non-accepted-risk requirement in
the four v1 design specifications has a passing test or a documented reason the
check is inapplicable, all required verification gates pass, and the final
working tree contains no untracked production dependency.
