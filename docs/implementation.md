# hello-cc Implementation Plan

Date: 2026-06-09

## Product Requirement

hello-cc is a project-local peer mesh for coding CLI sessions. It connects
multiple Claude Code and Codex terminals in the same project so they can
communicate, coordinate work, avoid conflicts, hand off progress, and be
operated through a LAN web UI.

Default project identity is the exact current working directory. On first use,
hello-cc creates `<cwd>/.hello-cc/mesh.db`; it does not inherit a parent
directory's mesh automatically. Users who want several paths or worktrees to
share one bus must set `--root`, `HCC_ROOT`, or `HCC_DB` explicitly.

The model is flat:

```text
codex-a  <->  codex-b
   ^            ^
   |            |
claude-a <-> claude-b
```

There is no required `main`, `worker`, or `reviewer`. Every session is a peer.

## Target UX

The default user experience is:

```bash
cd /path/to/project
hcc web
```

Expected output:

```text
hello-cc web started in background
pid: 12345
project: /path/to/project
database: /path/to/project/.hello-cc/mesh.db
runtime: /path/to/project/.hello-cc/runtime.json
log: /path/to/project/.hello-cc/web.log
open: http://<machine-ip>:8787/?token=xxxxx
local: http://127.0.0.1:8787/?token=xxxxx
shims: installed claude, codex
PATH updated in ~/.bashrc; open a new terminal or source it
stop: hcc down
```

`hcc web` is responsible for bootstrap and runtime startup:

- project-local SQLite bus;
- bounded guidance files;
- Claude Code hooks;
- Codex hooks;
- `claude` and `codex` shell shims;
- shell PATH entry for the shims;
- tmux availability;
- background web runtime.

After that, opening a new shell and typing `claude` or `codex` should create or
reuse a tmux-backed local terminal. The user interacts in the local terminal,
and the web console can operate the same tmux pane. `hcc down` stops the web
runtime only and leaves tmux terminals alive.

`hcc up` remains a lower-level local coordination command. Maintenance commands
remain available for tests and manual recovery, but the public product path is
`hcc web`.

## Architecture

hello-cc is session-runtime-first:

```text
hcc CLI
  |
  +-- neutral web runtime
  |     |
  |     +-- peer registry
  |     +-- routing and injection
  |     +-- task / message / lock / handoff services
  |     +-- tmux terminal supervisor
  |
  +-- control plane
  |     |
  |     +-- SQLite WAL
  |     +-- HTTP REST
  |     +-- hook entrypoints
  |
  +-- terminal plane
        |
        +-- tmux adapter
        +-- shell shims
        +-- optional node-pty adapter
        +-- WebSocket terminal stream
        +-- xterm.js web terminal
```

The runtime is not a main peer. It is a neutral router and state machine.

## Core Protocol

Peers:

```text
id          codex-a, claude-a, shell-a
kind        codex | claude | shell | custom
tags        optional routing labels
transport   tmux | hcc-run | detected | optional pty
target      tmux pane id or optional pty session id
status      idle | busy | blocked | stale | exited
```

Messages:

```text
from peer
to peer | all | tag:<tag> | task:<task-id>
kind note | ask | handoff | system
delivery store-only | inject-terminal | both
```

Tasks:

```text
pending -> claimed -> running -> review/block/done|abandoned
owner is dynamic; there is no fixed dispatcher
```

Default task reads are lifecycle-based: all peers see tasks until they are
`done` or `abandoned`. Read/ack state exists only for messages.

Locks:

```text
resource -> owner peer
TTL-based advisory lock
resource can be file, directory, module, test env, GPU, or service port
```

## User-Facing Commands

Primary:

```bash
hcc web
hcc down
```

Coordination:

```bash
hcc peers
hcc status
hcc task create/list/claim/next/update/done
hcc msg send/inbox/ack
hcc lock acquire/renew/release/list
hcc handoff create/list
hcc event tail
hcc ask
hcc broadcast
```

Terminal control:

```bash
hcc peer list
hcc peer start codex-a --kind codex -- codex
hcc peer start codex-a --kind codex --resume <session-id-or-name>
hcc peer start codex-a --kind codex --last
hcc peer start claude-a --kind claude --resume <session-id>
hcc peer start claude-a --kind claude --continue
hcc peer attach codex-a --pane %1
hcc peer stop codex-a
hcc inject codex-a "hcc msg inbox --peer codex-a"
```

Lower-level:

```bash
hcc up
hcc run --peer codex-a --kind codex -- codex
```

`hcc run` registers and runs a command in the current terminal. Browser
control should use `hcc peer start`, the web UI, or the installed shims.

## Technical Stack

Runtime and CLI:

```text
Node.js >= 24
node:sqlite
local option parser
```

State:

```text
SQLite WAL
project-local DB
busy_timeout for concurrent CLI access
BEGIN IMMEDIATE for task claim and lock acquisition
```

Terminal control:

```text
tmux
tmux send-keys
tmux load-buffer / paste-buffer
tmux capture-pane
tmux attach-session / switch-client
node-pty optional internal backend
```

Web:

```text
Node HTTP server
ws WebSocket
xterm.js
token authentication for LAN access
```

Integrations:

```text
Claude Code hooks
Codex hooks
UserPromptSubmit additionalContext
SessionStart additionalContext
shell shim wrappers
```

## Shim Behavior

`hcc web` installs shims into `~/.hcc-shims`. Each shim:

1. Resolves the hello-cc project root from the current directory or `HCC_ROOT`.
2. Parses provider resume/session arguments for a stable peer ID.
3. Exports `HCC_PEER` and `HCC_ROOT`.
4. Ensures the web runtime is running.
5. Calls `hcc peer start <peer> --kind <kind> -- <real-binary> ...`.
6. Attaches the local terminal to the tmux session returned by `peer start`.

If the shim is invoked non-interactively, it prints the `peer start` output and
does not attach.

## Reference Projects

### claude_codex_bridge

Path:

```text
<checkout>/claude_codex_bridge
```

Use for tmux session ownership, pane registry, injection with `send-keys` /
`load-buffer` / `paste-buffer`, output capture, and recoverable visible CLI
workspaces. Do not copy fixed main/worker topology or role-pack assumptions.

### hcom

Use for local SQLite + hooks communication and live cross-session notification
ideas.

### squad

Use for project-local mailbox/task ergonomics.

### dmux

Use for npm CLI UX and optional worktree/session management ideas.

### agent-bus

Use for richer task/message/handoff/review semantics. MCP remains optional.

## Implementation Phases

Phase 1: current protocol

```text
SQLite bus
flat peer identities
task/message/lock/handoff/event
run wrapper
tmux-backed peer start
tmux pane attach
```

Phase 2: default bootstrap

```text
hcc web as the one-command entrypoint
hooks installed by default
shims installed by default
tmux ensured by default
background web runtime
```

Phase 3: terminal hardening

```text
create or reuse tmux-backed local terminal with hcc peer start
attach existing tmux pane with hcc peer attach
record peer -> pane_id
inject via send-keys
capture output via capture-pane
detach without killing user panes
```

Phase 4: direct CLI ergonomics

```text
plain claude/codex auto-start tmux-backed peers
resume/fork/continue-aware peer identity
hooks for prompt-time snapshots, heartbeat, lock reminders, and handoff reminders
```

Phase 5: hardening

```text
stale session recovery
token and access controls
audit log
worktree isolation
merge queue
MCP adapter only if useful
A2A adapter only for remote/server peers
```

## Non-Goals For The Core

- No required MCP setup.
- No required A2A protocol.
- No fixed main/worker hierarchy.
- No attempt to invisibly control a raw existing terminal that was not started
  by hello-cc, tmux, screen, or another attachable PTY layer.
