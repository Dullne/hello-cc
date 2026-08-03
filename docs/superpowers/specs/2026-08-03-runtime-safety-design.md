# Runtime Safety, Clock, GC, and Registry Design

Status: approved in conversation on 2026-08-03.

## Purpose

Close destructive-operation and ownership races without forcing every project
to wait after normal idle time. Verified process evidence is authoritative;
clock grace is reserved for unknown evidence.

## Clock Observation

The meta table stores a last-observed wall-clock watermark and the active grace
deadline. Observation runs before ownership-changing or destructive operations,
including lock acquisition, takeover, hook/heartbeat recovery, reaping, and GC.
Pure read-only commands do not update the watermark, preserving read-only DB
behavior.

A clock observation transaction:

1. reads the previous watermark and current grace deadline;
2. evaluates backward movement and long forward gaps;
3. for ownership operations, checks whether the gap crossed a peer or lock
   expiry boundary whose owner is currently `unknown`;
4. for GC, checks whether suspicious backward/forward movement or a long gap
   crossed the requested age cutoff for any deletion category, independent of
   owner evidence;
5. atomically extends grace to `max(existing, now + 120 seconds)` when needed;
6. writes the new watermark only after the safety decision succeeds.

A verified live owner is renewed immediately from persisted `ttl_sec`. A
verified dead owner may expire immediately. Only unknown evidence is delayed by
grace. Failure to persist a required grace blocks the current destructive or
ownership-changing operation and returns an observable error.

The Web runtime also compares wall-clock movement with its monotonic probe and
uses the same database transaction. Concurrent probes can extend but never
shorten grace.

## Grace Semantics

While grace is active, every age-based deletion is deferred:

- expired or apparently expired locks;
- stale peers and peer bindings;
- events, completed tasks, messages, and handoffs;
- buffer files selected only by mtime.

Explicit `exited` peers and artifacts proven dead by identity may still be
cleaned. Results expose separate `deleted`, `protected`, and `deferred` counts.

## Buffer GC Arbitration

The buffer pruning policy is a shared helper that receives a fixed cutoff,
dry-run flag, project context, and protected absolute paths. It never recomputes
the cutoff during a run.

When a healthy compatible runtime exists, manual GC calls an authenticated
internal API. The runtime computes protection from the actual files referenced
by its session map and performs synchronous pruning in its event loop. Session
creation and replacement cannot interleave with that synchronous decision. New
files created after the fixed cutoff are not eligible.

If a runtime pointer exists but the runtime is unreachable or API-incompatible,
buffer deletion fails closed and reports deferred files. Safe database cleanup
may continue.

Without a runtime, local GC protects:

- external file groups whose wrapper or child identity is live or unknown;
- tmux pipes belonging to verified live or unknown managed panes;
- any legacy artifact whose ownership cannot be proved dead.

Only old artifacts with definitive dead or orphan evidence are deleted.

## GC Command Contract

`--older-than` must be zero or greater. Invalid values fail before opening a
write connection or deleting any file.

`hcc gc` remains dry-run by default. `--yes` removes technical state only.
Business history removal requires both `--history` and `--yes`. Open-task
handoffs, live-owner records, and unknown session artifacts are never removed
only because of age. Dry-run and apply execute the same planner.

A WAL checkpoint runs only after successful applied database cleanup. A busy
checkpoint is reported without converting successful safe cleanup into failure.

## Project Registry Lock

Registry read-modify-write is guarded by an atomic lock directory adjacent to
`projects.json`. Lock owner metadata includes process identity and creation
time. Acquisition uses bounded retry. A lock is reclaimed only when its owner is
definitively dead; unknown ownership times out with an error rather than being
stolen.

After acquiring the lock, the writer re-reads the registry, merges by canonical
real root, and writes with the existing atomic temp-and-rename helper. A changed
DB path updates immediately. The 60-second throttle applies only when root and
DB are both unchanged.

Authenticated Web users may continue registering arbitrary existing server
directories. This is an explicitly accepted product risk, not an isolation
guarantee.

## Acceptance Criteria

- CLI-only wake with a live process renews ownership without a blanket delay.
- CLI-only wake with unknown evidence enters grace before takeover or GC.
- A GC after a suspicious clock gap defers age-based history deletion even when
  no peer or lock candidate exists.
- Grace never shrinks under concurrent writers.
- Manual GC preserves live external and tmux artifacts with old mtimes.
- Unreachable runtime state defers buffer deletion.
- Negative retention is rejected without mutation.
- Grace defers every wall-clock-based history deletion.
- Concurrent registry writers retain both projects and update changed DB paths.
