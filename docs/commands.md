# hello-cc Command Reference

Use `hcc --help` for the current top-level command list. Most subcommands also
accept `--help`, for example `hcc update --help`, `hcc peer --help`, and
`hcc task --help`.

## Install Maintenance

```text
hcc update [--tag TAG] [--registry URL] [--dry-run]
hcc uninstall [--purge --yes]
```

`hcc update` updates the global npm install. `hcc uninstall` removes local
hooks and shims; add `--purge --yes` only when you also want to remove the
current project's `.hello-cc` data and guidance blocks.

## Start And Stop

```text
hcc web [--host HOST] [--port N] [--token TEXT] [--local] [--no-token] [--no-discover] [--no-guidance]
hcc down
hcc up [--no-discover] [--no-guidance]
```

`hcc web` is the default entry. It initializes coordination, installs hooks and
shims, starts or reuses the Web console, and returns the terminal to you. Bare
`hcc web` listens on `0.0.0.0` and uses a saved URL token, generating one on
first use. Use `--local` to bind only `127.0.0.1`, `--token` or `HCC_WEB_TOKEN`
to replace the saved token, and
`--no-token` only in trusted local/test environments. Use `hcc up` only when you
want coordination without the Web console or shims.

## Peers And Status

```text
hcc peers
hcc status [--peer ID]
hcc state [--peer ID] [--resource PATH] [--scope SCOPE] [--intent read|review|work|write|stop|finish]
hcc scan [--register]
hcc prompt --peer ID [--kind codex|claude|shell|other] [--role ROLE]
hcc join --peer ID [--kind codex|claude|shell|other] [--role ROLE]
hcc env --peer ID
hcc heartbeat [--peer ID] [--renew-locks --ttl 900]
hcc run --peer ID --kind codex|claude|shell --role ROLE -- COMMAND [ARGS...]
```

Use these commands to inspect live project state, register terminals, and run a
CLI with `HCC_PEER`, `HCC_ROOT`, and `HCC_DB` set. `hcc state` does not execute
coordination actions such as acking messages, claiming tasks, acquiring locks, or
creating handoffs. It adds a unified collaboration timeline plus
`automation.next_action.argv`, a machine-readable next coordination command for
agents to execute explicitly. `automation.current_task` records the peer's active
task when one exists. Use `--intent read` or `--intent review` for snapshot
inspection that should not acquire locks; use `--scope` with write/work intents
to coordinate one region of a larger shared resource.

## Browser-Controllable Terminals

```text
hcc peer list
hcc peer start PEER [--kind K] [--role R] [--cwd DIR] [--restart-env] -- COMMAND [ARGS...]
hcc peer start PEER --kind codex --resume SESSION_ID [--restart-env]
hcc peer start PEER --kind codex --last
hcc peer start PEER --kind claude --resume SESSION_ID [--restart-env]
hcc peer start PEER --kind claude --continue
hcc peer attach PEER [--pane PANE] [--kind K] [--role R] [--cwd DIR]
hcc peer stop PEER
hcc inject PEER TEXT [--no-enter]
```

These commands create or attach tmux-backed terminals that can be viewed and
controlled from the Web console.

## Messages

```text
hcc msg send [--from ID] [--to ID|all] --body TEXT [--task N] [--kind note|task|handoff]
hcc msg inbox [--peer ID] [--wait SEC] [--all] [--limit N]
hcc msg ack [--peer ID] --id N
hcc msg reply [--from ID] --id N --body TEXT [--to ID] [--kind reply]
hcc msg thread --id N [--limit N]
hcc ask PEER MESSAGE [--from ID] [--task N] [--inject]
hcc broadcast MESSAGE [--from ID] [--task N] [--inject]
```

Messages are addressed mailbox items. `ask` and `broadcast` also support live
terminal injection with `--inject`. Use `msg reply` when answering a specific
message; the reply stays in the same thread and is sent back to the original
sender by default. Use `msg thread` to inspect the full thread for one message.

## Tasks

```text
hcc task create --title TEXT [--body TEXT] [--from ID] [--to ID] [--priority N]
hcc task dispatch --to ID --title TEXT [--body TEXT] [--from ID] [--message TEXT] [--no-inject] [--force]
hcc task dispatch --to ID --id N [--from ID] [--message TEXT] [--no-inject] [--force]
hcc task list [--status S] [--peer ID] [--all]
hcc task claim [--peer ID] --id N[,N] [--id N] [--ids N,N] [--force]
hcc task takeover [--peer ID] --id N --reason TEXT [--policy any|blocked|stale|blocked-or-stale] [--stale-after SECONDS]
hcc task next [--peer ID] [--force] [--count N]
hcc task create --title TEXT --parent N [--team-role ROLE]
hcc task update [--peer ID] --id N --status running|review|blocked|done|abandoned [--summary TEXT] [--body TEXT] [--to ID]
hcc task done [--peer ID] --id N --summary TEXT
```

Tasks are shared project facts. They remain visible until marked `done` or
`abandoned`. `task next` returns your existing claimed/running/review/blocked
task before claiming a new pending task; use `--force` only when intentionally
taking additional pending tasks, and combine it with `--count N` for explicit
batch claims. `task claim` also accepts repeated `--id` values and comma-separated
`--id` or `--ids` lists. `task dispatch` is the explicit one-step form for
assigning a new or existing task to one peer, sending the durable task message,
and injecting the startup prompt only when that peer has a running managed
Claude/Codex terminal. Use `--no-inject` for message-only dispatch, and use
`--force` only when intentionally injecting while the target already owns another
active task. Use `task takeover` when explicitly taking a non-complete task from
another owner; it records the previous owner, requires a reason, and notifies
them. Add `--policy blocked`, `stale`, or `blocked-or-stale` when takeover
should only proceed under that auditable precondition. The default policy is
`any` for compatibility.

## Teams

```text
hcc team plan --from-task N [--item ROLE:TITLE] [--item PEER:ROLE:TITLE] [--workers A,B|codex:2,claude:1]
hcc team start --from-task N [--item ROLE:TITLE] [--item PEER:ROLE:TITLE] [--workers A,B|codex:2,claude:1] [--force]
hcc team status --task N
```

Teams are explicit parent-task splits. `team plan` is read-only and shows the
subtasks that would be created. `team start` creates child tasks under the
parent and optionally assigns them to worker peer IDs. It does not silently
spawn model processes or override the current-task rule. `--workers` accepts
explicit peer IDs or kind counts such as `codex:2,claude:1`.

## Locks, Handoffs, And Events

```text
hcc lock acquire [--peer ID] --resource PATH [--scope SCOPE] [--task N] [--ttl SEC] [--reason TEXT]
hcc lock renew [--peer ID] --resource PATH [--scope SCOPE] [--ttl SEC]
hcc lock release [--peer ID] --resource PATH [--scope SCOPE] [--force]
hcc lock list [--all]
hcc handoff create [--from ID] --summary TEXT [--task N] [--to ID] [--changed-files JSON_OR_CSV] [--tests TEXT] [--risks TEXT]
hcc handoff list [--task N] [--limit N]
hcc event tail [--limit N]
hcc gc [--older-than DAYS] [--yes]
```

Locks are advisory coordination locks with TTLs. Omitting `--scope` locks the
whole resource. Different scopes on the same resource can be held concurrently,
for example `--resource bin/hcc.mjs --scope db-schema` and `--scope web-ui`, but
a whole-resource lock conflicts with every scope. Handoffs preserve the result,
tests, changed files, and remaining risks when work moves between peers.
