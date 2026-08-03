# hello-cc v1 Data and Identity Design

Status: approved in conversation on 2026-08-03.

## Purpose

Define the breaking v1 data contract, schema migration, process identity model,
and provider peer identity semantics. This specification intentionally does not
provide downgrade compatibility or map pre-v1 provider peer IDs to v1 IDs.

## Product Decisions

- Release the result as package version `1.0.0`.
- Use database schema version 7.
- A schema v7 database is not supported by pre-v1 binaries.
- Provider peer IDs use the v1 full-value hash algorithm for every provider ID,
  including UUIDs and user-defined session names.
- Pre-v1 peer IDs, tasks, locks, messages, and bindings are not merged into the
  new v1 identity automatically.
- Migration must create a consistent database backup before the first v7 write.

## Migration Contract

Before migrating a v5 or v6 database, hello-cc must create a SQLite-consistent
snapshot next to the source database. The backup name includes the source
schema version and a collision-resistant timestamp suffix. It must never
overwrite an existing file.

The backup is produced through the open SQLite connection with `VACUUM INTO`,
not by copying `mesh.db` while WAL frames may still be pending. Migration stops
without changing the source database if backup creation or backup integrity
validation fails. A successful backup is opened read-only and must pass
`PRAGMA quick_check` before schema migration begins.

Registered sibling projects follow the same contract independently. A failed
sibling backup or migration is reported and isolated; it must not partially
migrate that sibling or fail the active project's command.

## Schema v7

Schema v7 adds process identity fields to `peers`:

- `pid_start_token TEXT`: opaque platform-derived process start identity.
- `pid_command_hash TEXT`: hash of the normalized executable/command identity.

Both fields are nullable. Missing or unreadable identity evidence means
`unknown`; it never means live or dead.

Existing v6 `locks.ttl_sec` remains required. Invalid or absent historical TTL
values are repaired to the documented default, capped at one hour when derived
from historical timestamps.

The schema migration history records v7 exactly once. `doctor` reports the
current schema, supported schema, backup location when known, and the explicit
no-downgrade contract.

## Process Identity

A shared process identity helper returns one of:

- a verified identity `{ pid, startToken, commandHash }`;
- `null` when the process does not exist;
- `unknown` when the process cannot be inspected safely.

Linux identity combines boot ID, `/proc/<pid>/stat` start ticks, and normalized
executable identity. macOS identity combines boot time, `ps` process start time,
PID, and normalized command identity. Inspection failures, permission errors,
or malformed output return `unknown`.

A stored identity is live only when the current identity matches every stored
component. A missing PID is dead only when the OS definitively reports that the
PID does not exist. A reused PID with a different start token or command hash is
dead for the stored peer.

External session metadata stores separate wrapper and child identities. New
metadata is written atomically. Legacy metadata without fingerprints is treated
as unknown unless both referenced PIDs are definitively absent.

tmux identity requires all of the following:

- the managed session name matches the hello-cc naming contract;
- the pane still exists;
- `HCC_ROOT` resolves to the expected project root;
- the pane process identity matches the stored identity when one is available.

## Liveness Precedence

All ownership, lock, reaper, and GC decisions consume one shared resolver with
the result `live`, `dead`, or `unknown`.

1. Explicit administrative `exited` status is dead.
2. Verified tmux or process identity is live.
3. `detached` is not dead by itself; a detached tmux session may still be live.
4. Definitive process absence plus definitive tmux absence is dead.
5. Conflicting, missing, legacy, or unreadable evidence is unknown.

Wall-clock age never overrides verified live or dead evidence.

## Provider Peer IDs

JavaScript and generated shims derive the same first eight lowercase SHA-1 hex
characters from the complete provider ID. Hash output is accepted only when it
is exactly 40 lowercase hexadecimal characters. When no supported hash command
can produce a valid digest, a shim starts the real provider without hello-cc
coordination rather than creating an ambiguous ID.

The v1 release notes must show examples of old and new IDs and explain that old
coordination history remains queryable in the backup but is not attached to the
new peer automatically.

## Acceptance Criteria

- A v5 and a development v6 fixture each produce a validated backup and migrate
  once to v7.
- A forced backup failure leaves the source schema and data unchanged.
- A pre-v1 binary rejects v7 with the documented error.
- PID reuse is classified as dead for the stored identity.
- A live tmux pane remains live across sleep-sized wall-clock gaps.
- A detached but live tmux session is not made takeover-ready.
- JavaScript and every generated shim produce identical v1 peer IDs.
