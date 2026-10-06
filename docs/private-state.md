# Project directory identity and private state

English | [中文](private-state.zh-CN.md)

Use a build containing the commands below; an older global installation may not
include them. These instructions describe state handling, not a receipt for an
installation, model call or production migration.

## Directory selection and state location

HCC binds a selected project to its canonical directory and filesystem identity
(`dev`, `ino`, and `birthtimeNs`). It checks that identity again before opening
state, launching a session and admitting managed mutations. A replacement at
the same pathname is a different project directory. `PROJECT_PATH_CHANGED`
requires selecting the current directory again; retained sessions keep their
original binding.

Stable trusted projects may keep state under `<project>/.hello-cc`. Projects that
need private state use `~/.hello-cc/projects/<SHA256-of-canonical-root>/`. Once a
private binding is established, it remains authoritative even if permissions
change or its directory disappears. HCC refuses to silently fall back to an
old project-local database.

Private binding format v2 records the full directory identity and requires a
positive filesystem birth time; an unavailable or zero value is rejected. If original A
has a valid v2 binding and the same path is later occupied by B, explicit Web
selection can provision B under
`~/.hello-cc/projects/<hash>.generations/<generation>/`. A's state directory and
root manifest are retained; the original authority marker is fenced against
older readers. B receives separate state and a separate managed tmux namespace.
Missing, conflicting or unbound generation records require recovery rather
than automatic reuse. This binding version is separate from the mesh database
schema version.

## Migrating project-local state

When HCC reports `STATE_MIGRATION_REQUIRED`, stop every writer before moving
the retained project-local store into private state. Include Web and Native
runtimes, PTY/tmux sessions, hooks, Harness processes and external database
clients. Back up the project-local store and any existing private state,
authority markers and generation records.

```sh
hcc --root /absolute/path/to/project migrate-state --offline --yes
```

The migrator checks known runtime/PTY/mesh process evidence, snapshots SQLite
including WAL, validates the snapshot and leaves the source directory intact.
`--offline` is the operator's assertion that all writers have stopped; observed
process records cannot establish the absence of unregistered writers. Managed
DSH artifacts are verified and archived, then rebuilt for the private path.
Edited managed DSH artifacts, unsafe filesystem entries or a source changing
during the snapshot fail closed.

## Upgrading a historical private v1 binding

`STATE_BINDING_UPGRADE_REQUIRED` means an existing private store lacks v2's
birth-time binding. Matching pathname, device and inode alone cannot identify
historical A. Independently verify A and cold-drain its writers before upgrade.
If the path now holds B, restore and verify A at that path first; selecting B
cannot upgrade A's historical v1 metadata automatically.

Inspect without changing the binding:

```sh
hcc --root /absolute/path/to/project --json migrate-state --inspect-private-binding
```

The result reports `status` and, when required or pending, a SHA256 `receipt`.
The receipt describes the currently observed metadata; it does not prove that
the current directory is historical A. After independent verification, backup
and cold drain, copy the exact receipt into:

```sh
hcc --root /absolute/path/to/project migrate-state \
  --upgrade-private-binding --offline --yes --assert-historical-root \
  --expect-receipt=COPY_THE_INSPECTION_SHA256
```

Upgrade checks known writers both before and after publication, durably fences
v1 readers first, then writes the v2 root manifest and removes the pending
fence. It updates binding metadata without copying the store. A publication or
second offline-check failure leaves access fenced. Inspect again and retry
with the same verified root and a matching receipt; preserve all evidence if
manual recovery is reported. Do not fabricate markers or purge a historical
store to make an upgrade pass. Older readers can reject v2 state, so drain old
builds before switching execution.

## Pausing new launches

`HCC_PINNED_LAUNCH_MODE` accepts `pinned` (also the default when unset) or `hold`.
`hold` rejects new guarded session launches with `PINNED_LAUNCH_PAUSED`; it does
not terminate existing processes or revoke a launch already prepared. Invalid
values are rejected. A provider environment that strips HCC variables cannot
clear the parent process's hold. Maintenance workers used for pinned file and
guidance operations remain available.

Set this environment on the invoking HCC process. Changing a later shell's
environment does not update a running Web or Native runtime. A hold is not a
substitute for stopping every writer before migration.

## Codex terminal history

HCC's Codex history controls require a persisted thread-to-root identity receipt.
Built-in new/fork launches record the resulting thread's original directory;
resume and fork verify both that identity and the explicit thread ID. The Web
history list omits unverified or conflicting entries and reports their count.
An old cwd string, imported peer row or manually assembled command does not
establish a verified root. `CODEX_HISTORY_UNVERIFIED` and conflicting bindings
require manual review; HCC provides no automatic historical association command.

Terminal `codex resume --last` and `codex fork --last` cannot establish an exact
thread and are rejected by these managed controls. Select an explicit verified
thread ID. [Native workers](native.md) retain their separate saved-worker resume
and ownership rules, including `native start --resume last`.
