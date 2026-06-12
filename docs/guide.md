# hello-cc User Guide

This guide covers the practical workflow for installing, starting, and using
hello-cc. For a compact command list, use the [Command Reference](commands.md).

## Install, Update, And Uninstall

Install hello-cc globally:

```bash
npm install -g @logicseek/hello-cc
```

Update an existing global install:

```bash
hcc update
```

`hcc update` runs `npm install -g @logicseek/hello-cc@latest`. Use
`hcc update --help` to see the available update options. `hcc task update`
updates a coordination task, not the installed package.

Remove hooks and shims from this machine:

```bash
hcc uninstall
```

Remove the current project's `.hello-cc` data and guidance blocks too:

```bash
hcc uninstall --purge --yes
```

Remove the global npm package:

```bash
npm uninstall -g @logicseek/hello-cc
```

## Default Entry

Run one command in the project directory:

```bash
cd /path/to/project
hcc web
```

`hcc web` automatically:

1. Initializes `.hello-cc/mesh.db` in the current directory
2. Writes bounded guidance blocks: `.hello-cc/HCC.md`, `CLAUDE.md`, `AGENTS.md`
3. Installs or refreshes Claude Code hooks: `~/.claude/settings.json`
4. Installs or refreshes Codex hooks: `~/.codex/hooks.json`
5. Installs `~/.hcc-shims/claude` and `~/.hcc-shims/codex`
6. Adds `~/.hcc-shims` to the shell PATH
7. Ensures `tmux` is available, with best-effort automatic install and a clear
   install command if that fails
8. Starts or reuses the global web console, registers the current project,
   prints URL/PID/runtime/log, then returns the terminal to you

Example output:

```text
hello-cc web started in background
pid: 12345
project: /path/to/project
database: /path/to/project/.hello-cc/mesh.db
runtime: /path/to/project/.hello-cc/runtime.json
log: /path/to/project/.hello-cc/web.log
open: http://<machine-ip>:8787/?project=%2Fpath%2Fto%2Fproject
local: http://127.0.0.1:8787/?project=%2Fpath%2Fto%2Fproject
shims: installed claude, codex
PATH updated in ~/.bashrc; open a new terminal or source it
stop: hcc down
```

`hcc web` uses a single global web runtime. Running `hcc web` again from
another project directory does not open another port; it registers that project
with the same web console. The frontend Project selector switches between
registered roots. Each project still keeps its own `.hello-cc/mesh.db`, so
tasks, messages, locks, and peers stay isolated.

After the first shim install, open a new terminal or run:

```bash
source ~/.bashrc
```

Then direct project-local commands are wrapped automatically:

```bash
claude
codex
claude --resume <session-id>
codex resume <session-id>
```

The wrappers create or reuse local persistent tmux terminals:

- The local terminal attaches to the same tmux session and remains usable.
- The web console controls the same tmux pane, not a temporary browser-only
  terminal.
- `hcc down` stops only the web runtime. It does not kill tmux sessions.
- Running `hcc web` again reattaches live recorded tmux panes.

For local coordination without Web or shims, use:

```bash
hcc up
```

Most users should start with `hcc web`.

## Project Boundary

By default, the project boundary is the current working directory. If the
current directory has no `.hello-cc/mesh.db`, hello-cc creates one on first use:

```text
/repo-a/.hello-cc/mesh.db
/repo-a/subdir/.hello-cc/mesh.db
```

Those are two different projects by default. Sessions communicate naturally
when they start from the same project path.

To share one bus across paths or worktrees, opt in explicitly:

```bash
hcc --root /path/to/project web
export HCC_ROOT=/path/to/project
export HCC_DB=/path/to/project/.hello-cc/mesh.db
```

hello-cc does not automatically inherit a parent directory's bus. That avoids
subdirectory sessions joining a broader project by accident.

## Communication Model

hello-cc is not point-to-point CLI messaging and does not require MCP. The core
is a project-local SQLite WAL bus:

```text
Claude/Codex/plain shell
  -> hooks / hcc commands / web runtime
  -> .hello-cc/mesh.db
  -> peers / tasks / messages / locks / handoffs / events
  -> tmux-backed terminal control
```

Tasks and messages have different read semantics:

- Tasks are project facts. Every peer sees tasks until they become `done` or
  `abandoned`.
- Messages are addressed mailbox items. `hcc msg inbox` defaults to unread
  messages for the current peer, and `hcc msg ack` records per-peer read state.
- `ask` and `broadcast` write durable messages. With `--inject`, they also send
  live input to runtime-attached terminals.
- Locks use SQLite transactions and TTLs. They are coordination locks, not a
  filesystem sandbox.

## How Claude/Codex Knows Other Sessions

The primary path is hook injection, not `CLAUDE.md`.

`hcc web` installs Claude Code and Codex hooks. On session start, user prompt
submit, tool events, and idle events, hooks inject the current hello-cc snapshot
into the model context:

- current peer identity
- active peer list
- open tasks
- unread messages for the current peer
- active locks
- suggested commands such as `hcc status`, `hcc peers`, `hcc task list`,
  `hcc msg inbox`, and `hcc lock list`

When an attached Claude/Codex session is asked what other sessions are doing,
it should answer from the latest hello-cc state instead of generic isolation
knowledge.

If a session still says it cannot know, likely causes are:

- `hcc web` has not been run in the project directory
- the terminal has not loaded `~/.hcc-shims` into PATH
- Codex hooks are not enabled or the installed hook has not been trusted in
  Codex's hook review flow
- the CLI was started in a different project directory
- the session was an already-open raw terminal before hello-cc was installed
- the provider CLI version did not fire the expected hook

To verify Claude Code hook injection directly, run a one-shot debug call from
the same project:

```bash
claude -p 'Do you see hello-cc open tasks?' --debug hooks --debug-file /tmp/hcc-claude-hooks.log
```

The debug log should contain `Hook UserPromptSubmit ... provided
additionalContext` and the `hello-cc coordination` block.

## Web Console

Start local and LAN-visible control:

```bash
hcc web
```

Use a token only when you want one:

```bash
HCC_WEB_TOKEN='choose-a-long-token' hcc web --host 0.0.0.0 --port 8787
```

Open from another machine on the same network:

```text
http://<machine-ip>:8787/
```

The web console can:

- switch between multiple registered project roots on one port
- register another project path from the browser
- show project state: peers, tasks, messages, locks, handoffs, events
- operate local terminals: start Claude/Codex/shell, send keyboard input, view
  output, detach runtime control

Browser-controlled sessions are local tmux terminals:

- sessions started by the web form
- sessions started by `hcc peer start`
- direct `claude` / `codex` sessions started through shims
- existing tmux panes attached with `hcc peer attach`

Already-open raw terminals cannot be captured or controlled unconditionally
unless they started under tmux, screen, or a hello-cc shim. They can still
participate in tasks, messages, and locks through hooks and `hcc` commands.

## Command Reference

Use `hcc --help` for the command list and `hcc <command> --help` for a specific
command. The maintained summary lives in the [Command Reference](commands.md).

## Stable Peer Identity

hello-cc tries to keep peer IDs stable across resumed sessions:

| Launch pattern | Peer ID |
|---|---|
| `claude --resume abc12345...` | `claude-abc12345` |
| `claude --session-id abc12345...` | `claude-abc12345` |
| `claude --continue` | terminal-derived ID first, then hooks record real session metadata |
| `claude --fork-session --resume abc12345...` | terminal-derived ID first, then hooks record new session metadata |
| `codex resume abc12345...` | `codex-abc12345` |
| `codex resume --last` | terminal-derived ID first, then discovery records real session metadata |
| plain shell | `shell-<terminal>` |
| manual `HCC_PEER=xxx` | uses `xxx` |

Known resume IDs keep the same peer ID after restart. Launch modes that do not
expose the real provider session ID before startup use a terminal-derived ID
first, then record provider metadata after hooks or discovery run.

## Typical Workflow

Create a task:

```bash
hcc task create --title "Refactor router diagnostics" \
  --body "Keep changes scoped." --priority 20
```

Claim and lock:

```bash
hcc task next
hcc lock acquire --resource vllm/router --ttl 900 --reason "implement diagnostics"
```

Message or inject:

```bash
hcc msg send --to claude-a --body "Implementation is ready for review."
hcc ask claude-a "Please review the current implementation." --inject
hcc broadcast "Pause edits under vllm/router until this task finishes." --inject
```

Finish with a handoff:

```bash
hcc handoff create --to claude-a \
  --summary "Implemented router diagnostics changes." \
  --tests "pytest tests/router" \
  --risks "Full benchmark not run"

hcc task done --id 1 --summary "Done and handed off."
hcc lock release --resource vllm/router
```

## Environment Variables

| Variable | Purpose |
|---|---|
| `HCC_PEER` | default peer identity |
| `HCC_ROOT` | override project root |
| `HCC_DB` | override database path |
| `HCC_WEB_TOKEN` | optional token for web access |
| `HCC_RUNTIME_URL` | direct runtime URL |
| `HCC_NO_AUTO_INSTALL_TMUX=1` | disable tmux auto-install, mainly for tests |

The `claude` / `codex` shims and `hcc peer start` create tmux-backed sessions
from the environment of the local terminal that launched them, not from the
older environment of the background web runtime. This lets you open a new
terminal, export provider variables such as `ANTHROPIC_*` or
`CLAUDE_CODE_*`, then run `claude` / `codex`.

An already-running CLI process cannot have its environment changed in place by
the operating system. The `claude` / `codex` shims call `hcc peer start` with
`--restart-env`, so hello-cc records a launch environment fingerprint for the
same resume/session peer. If you start that peer again from a new terminal and
the environment changed, hello-cc automatically restarts the tmux session with
the new environment when there are no attached tmux clients or Web clients. If
the session is actively attached, hello-cc asks you to detach/close Web clients
or run `hcc peer stop <peer>` before starting it again.

When you call `hcc peer start` directly, add `--restart-env` if you want the
same restart-on-environment-change behavior.

The shims only manage interactive terminal sessions. Metadata and maintenance
commands pass through to the real provider CLI, including `claude --help`,
`claude --version`, `claude --print`, `claude --bare`, `claude --safe-mode`,
`codex --help`, `codex --version`, and non-interactive Codex subcommands such as
`codex exec`, `codex review`, `codex doctor`, and `codex mcp`. Interactive
`claude`, `claude --resume ...`, `codex`, `codex resume ...`, and `codex fork
...` are tmux-backed and visible in the Web console.
