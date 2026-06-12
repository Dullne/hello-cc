# hello-cc Design

Date: 2026-06-09

## Requirement Boundary

hello-cc targets same-project, cross-session coordination for ordinary local
terminal sessions:

- multiple Claude Code sessions;
- multiple Codex CLI sessions;
- sessions started independently from different terminals;
- durable tasks, messages, locks, handoffs, and events;
- conflict visibility while peers edit the same project;
- LAN web observability and terminal operation.

This is not only "Claude talks to Codex". It is a local coordination layer for
all active coding CLI sessions in one project.

The model is a flat peer mesh, not a CCB-style main/worker topology:

```text
codex-a  <->  codex-b
   ^            ^
   |            |
claude-a <-> claude-b
```

Every session is a named peer. Optional labels such as `reviewer`, `runner`, or
`docs` may help humans route work, but they do not create hierarchy.

## Project Boundary

By default, "same project" means the exact current working directory. On first
use hello-cc creates:

```text
<cwd>/.hello-cc/mesh.db
```

It does not automatically walk to parent directories and inherit their bus. This
keeps project membership predictable: two terminals communicate automatically
when they are started from the same project path.

Cross-path sharing is explicit:

```bash
hcc --root /path/to/project web
export HCC_ROOT=/path/to/project
export HCC_DB=/path/to/project/.hello-cc/mesh.db
```

## Default UX

The default user path is one command:

```bash
cd /path/to/project
hcc web
```

`hcc web` must:

- initialize the project-local SQLite bus;
- install or refresh Claude Code hooks;
- install or refresh Codex hooks;
- install or refresh `claude` and `codex` shell shims;
- add the shim directory to PATH when needed;
- ensure `tmux` is available, with best-effort automatic install and a clear
  install command if it cannot install;
- start the web runtime in the background;
- print URL, PID, runtime path, log path, and stop command;
- return control to the invoking terminal.

Plain `claude` and `codex` commands in a new shell should then become
tmux-backed hello-cc peers automatically. The local terminal attaches to the
same tmux session that the web console can display and operate.

`hcc up` remains a lower-level command for local coordination without Web or
shims. Maintenance commands may exist for tests and manual cleanup, but they are
not the public product path.

## Capability Levels

```text
Level 1: Coordination
  Any Claude/Codex/human terminal can communicate by running hcc commands or by
  firing installed hooks. This covers tasks, messages, locks, handoffs, and
  status.

Level 2: Web-attached local terminals
  hello-cc starts Claude/Codex/shell as local tmux-backed terminals, wraps
  direct claude/codex launches through shims, or attaches an existing tmux pane.
  The web UI displays and operates those terminals through WebSocket.

Level 3: Existing raw terminal takeover
  A terminal already opened outside hello-cc cannot be fully captured or
  controlled unless it is already inside tmux, screen, or another attachable PTY
  layer. It can still participate in coordination.
```

`hcc down` stops only the web runtime. It does not kill tmux-backed terminals.
Running `hcc web` again reattaches live recorded panes.

## Technical Route

Recommended first layer:

```text
Node npm CLI
  + built-in node:sqlite
  + project-local .hello-cc/mesh.db
  + Claude/Codex hooks for prompt-time context
  + tmux as the browser-controllable local terminal backend
  + shell shims for transparent claude/codex launch
```

Why:

- ordinary terminals can join;
- no MCP requirement for local communication;
- no A2A requirement for local terminal/worktree coordination;
- SQLite transactions are enough for low-volume coordination writes;
- Node gives a natural npm CLI packaging path;
- Node 24 has built-in SQLite;
- tmux gives persistent local terminals that survive web runtime restarts.

Rejected as the first layer:

- A2A: useful for remote peer interoperability, not required for local terminal
  coordination.
- MCP-only: useful later as a tool surface, but too indirect for transparent
  cross-session operation.
- tmux-only: good for managed terminals, but hooks and CLI commands are still
  needed for already-open raw sessions.
- shared markdown/jsonl files: simple, but weak for atomic task claims and lock
  acquisition.

## Runtime Framework

```text
Node >= 24
node:sqlite DatabaseSync
SQLite WAL
Node HTTP server
ws WebSocket
xterm.js browser renderer
tmux create/capture/send for terminal control
Claude Code hooks
Codex hooks
shell shim wrappers
```

Control plane:

```text
CLI commands and HTTP JSON APIs read/write SQLite.
```

Terminal plane:

```text
Browser xterm.js sends keyboard bytes over WebSocket.
Server writes bytes into tmux panes.
Server polls/captures tmux pane output and broadcasts it to browsers.
```

## Core Tables

```text
peers         stable terminal identities and heartbeat
peer_bindings provider session binding and runtime transport metadata
tasks         task assignment, ownership, hierarchy, and lifecycle
messages      direct, broadcast, or threaded messages
message_reads per-peer ack state
locks         advisory exclusive locks with TTL
handoffs      durable cross-session handoff summaries
events        audit trail for observability
schema_migrations applied SQLite schema version history
```

## Coordination Semantics

- `task claim`, `task next`, `lock acquire`, `lock release`, and `handoff
  create` use `BEGIN IMMEDIATE`.
- SQLite runs with WAL and `busy_timeout=5000`.
- Tasks are project facts. They remain visible to all peers until status becomes
  `done` or `abandoned`.
- Tasks can form explicit parent/child hierarchies for team splits. Team commands
  create auditable child tasks; they do not silently spawn model processes.
- Messages are addressed mailbox items. Read state is tracked per peer.
- Message replies keep `reply_to` and `thread_id` so peer-visible collaboration
  history can be reconstructed without terminal capture.
- Broadcast messages use per-peer acknowledgement, so one peer cannot consume a
  message for everyone else.
- Locks are advisory and TTL-based. Peers must follow the protocol.
- `hcc state` and `/api/state` expose a derived timeline plus
  `automation.next_action.argv`; the command is advisory and does not execute
  coordination actions itself.

## Hook Path

The primary model-facing path is hook context injection, not project markdown.

`hcc web` installs hooks that register sessions and inject hello-cc snapshots at
session start and before model answers. The injected snapshot contains current
peer identity, active peers, open tasks, unread messages, active locks, the
current task when one exists, and the next auditable coordination action.

`CLAUDE.md`, `AGENTS.md`, and `.hello-cc/HCC.md` are fallback instruction
layers. Existing root files are updated only inside a bounded hello-cc block.

## Provider Session Binding

hello-cc peer IDs are separate from Claude/Codex conversation IDs:

```text
peer:                 codex-a
provider:             codex
provider_session_id:  Codex/Claude resume id or name when known
resume_mode:          new | resume | last | continue | fork | fork-resume
transport:            tmux | hcc-run | detected | optional pty
```

Known resume IDs map to stable peer IDs. Launch modes that do not expose the
real provider session before startup use a terminal-derived peer ID first, then
hooks or discovery record provider metadata after the session starts.

`hcc peer start` records bindings when it launches or reuses a tmux-backed
terminal:

```bash
hcc peer start codex-a --kind codex --resume <session-id-or-name>
hcc peer start codex-b --kind codex --last
hcc peer start claude-a --kind claude --resume <session-id>
hcc peer start claude-b --kind claude --continue
```

`hcc peer attach` records a tmux transport binding when it imports an existing
pane:

```bash
hcc peer attach codex-a --pane %1
```

If a known provider session is already bound to another peer, hello-cc blocks a
second binding unless `--force` is used.

## Applied Lessons

- `claude_codex_bridge` proves tmux-backed mixed-provider workspaces are useful,
  but hello-cc avoids fixed main/worker topology.
- `hcom` proves local SQLite plus hooks is a strong cross-session communication
  model.
- `squad` proves a project-local mailbox/task protocol can stay transparent and
  easy to operate.
- `dmux` proves npm CLI plus worktree/session management is a good outer layer,
  but it is not itself the communication bus.
- `agent-bus` has strong bus semantics, but its primary integration path is MCP.

hello-cc combines hooks + SQLite + tmux first, leaving MCP/A2A/worktree layers
optional.

## Next Iterations

1. Harden hook payloads for lock warnings and handoff reminders.
2. Add a watch command for live inbox/event tailing.
3. Add terminal output snapshot/export commands for runtime-attached sessions.
4. Add screen attach support for already-running attachable sessions.
5. Publish as an npm package with a stable `npx hcc` flow.
6. Add worktree helpers only after the core bus and terminal model are stable.
