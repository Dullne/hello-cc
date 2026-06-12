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
hcc web [--host HOST] [--port N] [--token TEXT] [--local] [--no-discover] [--no-guidance]
hcc down
hcc up [--no-discover] [--no-guidance]
```

`hcc web` is the default entry. It initializes coordination, installs hooks and
shims, starts or reuses the Web console, and returns the terminal to you. Use
`hcc up` only when you want coordination without the Web console or shims.

## Peers And Status

```text
hcc peers
hcc status [--peer ID]
hcc scan [--register]
hcc prompt --peer ID [--kind codex|claude|shell|other] [--role ROLE]
hcc join --peer ID [--kind codex|claude|shell|other] [--role ROLE]
hcc env --peer ID
hcc heartbeat [--peer ID] [--renew-locks --ttl 900]
hcc run --peer ID --kind codex|claude|shell --role ROLE -- COMMAND [ARGS...]
```

Use these commands to inspect live project state, register terminals, and run a
CLI with `HCC_PEER`, `HCC_ROOT`, and `HCC_DB` set.

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
hcc ask PEER MESSAGE [--from ID] [--task N] [--inject]
hcc broadcast MESSAGE [--from ID] [--task N] [--inject]
```

Messages are addressed mailbox items. `ask` and `broadcast` also support live
terminal injection with `--inject`.

## Tasks

```text
hcc task create --title TEXT [--body TEXT] [--from ID] [--to ID] [--priority N]
hcc task list [--status S] [--peer ID] [--all]
hcc task claim [--peer ID] --id N
hcc task next [--peer ID]
hcc task update [--peer ID] --id N --status running|review|blocked|done|abandoned [--summary TEXT] [--body TEXT] [--to ID]
hcc task done [--peer ID] --id N --summary TEXT
```

Tasks are shared project facts. They remain visible until marked `done` or
`abandoned`.

## Locks, Handoffs, And Events

```text
hcc lock acquire [--peer ID] --resource PATH [--task N] [--ttl SEC] [--reason TEXT]
hcc lock renew [--peer ID] --resource PATH [--ttl SEC]
hcc lock release [--peer ID] --resource PATH [--force]
hcc lock list [--all]
hcc handoff create [--from ID] --summary TEXT [--task N] [--to ID] [--changed-files JSON_OR_CSV] [--tests TEXT] [--risks TEXT]
hcc handoff list [--task N] [--limit N]
hcc event tail [--limit N]
hcc gc [--older-than DAYS] [--yes]
```

Locks are advisory coordination locks with TTLs. Handoffs preserve the result,
tests, changed files, and remaining risks when work moves between peers.
