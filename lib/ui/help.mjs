export function createHelpFunctions(config = {}) {
  const productName = config.productName || 'hello-cc';
  const version = config.version || '';
  const cliName = config.cliName || 'hcc';
  const npmPackageName = config.npmPackageName || '@logicseek/hello-cc';

  return {
    helpMain() {
      console.log(`${productName} ${version}

Project-local coordination bus for multiple Claude Code and Codex CLI sessions.

Usage:
  ${cliName} [--root DIR] [--db FILE] [--json] <command> [args]

Commands:
  web                          Start coordination, shims, tmux, and browser console
  up                           Initialize local coordination only
  down                         Stop the running hello-cc web runtime
  update                       Update the global npm install of hello-cc
  uninstall                    Remove hooks, shims, and optional project data
  init                         Initialize .hello-cc/mesh.db and guidance
  register --peer ID           Register or update a peer session identity
  join --peer ID               Register this shell and print eval-able env
  env --peer ID                Print eval-able HCC_PEER/HCC_ROOT/HCC_DB exports
  heartbeat [--peer ID]        Mark the current peer alive, optionally renew locks
  peers                        List known peers
  status [--peer ID]           Show project coordination state
  state [--peer ID]            Show timeline and next coordination action
  scan [--register]            Detect existing Claude/Codex sessions
  prompt --peer ID             Print copy/paste session instructions
  run --peer ID -- COMMAND     Register a peer and run a command in this terminal
  peer <subcommand>            Start, attach, list, and stop tmux-backed peers
  tmux gc [--yes]              Clean stale DB-proven hcc-managed tmux sessions
  inject PEER TEXT             Write text into an attached terminal
  ask PEER MESSAGE             Send a direct work request to one peer
  broadcast MESSAGE            Send a work request to all peers
  task <subcommand>            Create, list, claim, update, finish tasks
  team <subcommand>            Plan, start, and inspect explicit task teams
  msg <subcommand>             Send, read, and ack messages
  lock <subcommand>            Acquire, renew, release, and list advisory locks
  handoff <subcommand>         Create and list handoffs
  event tail                   Show recent coordination events
  gc [--older-than DAYS] [--yes] Clean up stale peers, events, tasks, and buf files
Internal:
  hook                         Hook entrypoint used by Claude/Codex
  find-root                    Shim helper
  which-real                   Shim helper

Environment:
  HCC_ROOT               Override project root
  HCC_DB                 Override database path
  HCC_PEER               Default peer id; inferred automatically when absent
  HCC_WEB_TOKEN          Replace and save the stable web access token
`);
    },

    helpTask() {
      console.log(`${cliName} task

Usage:
  ${cliName} task create --title TEXT [--body TEXT] [--from ID] [--to ID] [--priority N]
  ${cliName} task create --title TEXT --parent N [--team-role ROLE]
  ${cliName} task list [--status pending|claimed|running|review|blocked|done|abandoned] [--peer ID] [--all]
  ${cliName} task claim [--peer ID] --id N[,N] [--id N] [--ids N,N] [--force]
  ${cliName} task takeover [--peer ID] --id N --reason TEXT [--policy any|blocked|stale|blocked-or-stale] [--stale-after SECONDS]
  ${cliName} task next [--peer ID] [--force] [--count N]
  ${cliName} task update [--peer ID] --id N --status STATUS [--summary TEXT] [--body TEXT] [--to ID]
  ${cliName} task done [--peer ID] --id N --summary TEXT

Default task list shows all project tasks that are not done or abandoned.
--peer is an explicit filter; HCC_PEER does not hide other open tasks.
Messages use per-peer unread ack state; tasks do not.
task next returns your existing claimed/running/review/blocked task before
claiming another pending task. Use --force when intentionally taking additional
pending tasks; combine it with --count N for explicit batch claims.
Use task takeover when explicitly taking over a non-complete task from another
owner; it records the previous owner, requires a reason, and notifies them.
Use --policy blocked, stale, or blocked-or-stale to require an auditable
precondition before takeover. The default policy is any for backward
compatibility.

If --peer/--from and HCC_PEER are absent, hcc auto-joins the current terminal
as a stable project-local peer.
`);
    },

    helpTeam() {
      console.log(`${cliName} team

Usage:
  ${cliName} team plan --from-task N [--item ROLE:TITLE] [--item PEER:ROLE:TITLE] [--workers A,B|codex:2,claude:1]
  ${cliName} team start --from-task N [--item ROLE:TITLE] [--item PEER:ROLE:TITLE] [--workers A,B|codex:2,claude:1] [--force]
  ${cliName} team status --task N

team plan is read-only. team start creates explicit child tasks under the parent
task and optionally assigns them to workers. It does not silently spawn model
processes or override the current-task rule.
workers may be explicit peer ids or kind counts such as codex:2,claude:1.
`);
    },

    helpState() {
      console.log(`${cliName} state

Usage:
  ${cliName} state [--peer ID] [--resource PATH] [--scope SCOPE] [--intent read|review|work|write|stop|finish]

Shows the current collaboration timeline plus a machine-readable coordination
state machine. With --json, the response includes automation.next_action.argv so
agents can execute the suggested hcc command explicitly and leave an audit trail.
automation.current_task shows the peer's active claimed/running/review/blocked
task when one exists.
If a current task looks splittable, automation may suggest hcc team plan; this
is read-only until hcc team start is run explicitly.
With --intent read or --intent review, state treats resources as snapshot
inspection and does not suggest acquiring file locks. With write/work intents,
--scope lets agents coordinate independent regions of the same resource.

State does not execute coordination actions: it does not ack messages, claim
tasks, acquire locks, send messages, create handoffs, or mark tasks done. Opening
state may still perform normal SQLite schema maintenance for known project DBs.
`);
    },

    helpJoin() {
      console.log(`${cliName} join

Usage:
  eval "$(${cliName} join --peer ID [--kind codex|claude|shell|other] [--role ROLE])"

Examples:
  eval "$(${cliName} join --peer codex-current --kind codex)"
  ${cliName} status

This registers the current shell as a peer and prints shell exports for
HCC_PEER, HCC_ROOT, and HCC_DB. A child CLI cannot mutate its parent shell
environment directly, so use eval to apply the exports to the current window.
`);
    },

    helpEnv() {
      console.log(`${cliName} env

Usage:
  eval "$(${cliName} env --peer ID)"

Examples:
  eval "$(${cliName} env --peer codex-current)"

This only prints shell exports. Use hcc join when you also want to register
the peer in the project bus.
`);
    },

    helpMsg() {
      console.log(`${cliName} msg

Usage:
  ${cliName} msg send [--from ID] [--to ID|all] --body TEXT [--task N] [--kind note|task|handoff]
  ${cliName} msg inbox [--peer ID] [--wait SEC] [--all] [--limit N]
  ${cliName} msg ack [--peer ID] --id N
  ${cliName} msg reply [--from ID] --id N --body TEXT [--to ID] [--kind reply]
  ${cliName} msg thread --id N [--limit N]

If --peer/--from and HCC_PEER are absent, hcc auto-joins the current terminal.
Use msg reply when answering a message so the response stays in the same thread.
`);
    },

    helpAsk() {
      console.log(`${cliName} ask

Usage:
  ${cliName} ask PEER MESSAGE [--from ID] [--task N] [--inject]
  ${cliName} ask --to PEER --body TEXT [--from ID] [--task N] [--inject]

Examples:
  ${cliName} ask claude-a "Please review task #3."
  ${cliName} ask --to codex-b --body "Can you run the router tests?" --task 3
  ${cliName} ask claude-a "Please review task #3." --inject
`);
    },

    helpBroadcast() {
      console.log(`${cliName} broadcast

Usage:
  ${cliName} broadcast MESSAGE [--from ID] [--task N] [--inject]
  ${cliName} broadcast --body TEXT [--from ID] [--task N] [--inject]

Example:
  ${cliName} broadcast "Pause edits under src/router until lock clears."
`);
    },

    helpInject() {
      console.log(`${cliName} inject

Usage:
  ${cliName} inject PEER TEXT [--no-enter]
  ${cliName} inject --peer PEER --body TEXT [--no-enter]

Examples:
  ${cliName} inject codex-a "hcc msg inbox --peer codex-a"
  ${cliName} inject claude-a "Please review task #3."

This works for peers attached to the running hcc web runtime, including
tmux-backed local terminals, attached tmux panes, and shim-launched tmux
terminals.
`);
    },

    helpPeer() {
      console.log(`${cliName} peer

Usage:
  ${cliName} peer list
  ${cliName} peer start PEER [--kind codex|claude|shell] [--role ROLE] [--cwd DIR] [--resume ID|NAME]
  ${cliName} peer start PEER --kind codex --last
  ${cliName} peer start PEER --kind claude --continue
  ${cliName} peer start PEER [--kind codex|claude|shell] [--role ROLE] [--cwd DIR] -- COMMAND [ARGS...]
  ${cliName} peer attach PEER [--pane PANE] [--kind codex|claude|shell] [--role ROLE] [--cwd DIR]
  ${cliName} peer stop PEER

Examples:
  ${cliName} peer start codex-a --kind codex -- codex
  ${cliName} peer start codex-a --kind codex --resume 00000000-0000-0000-0000-000000000000
  ${cliName} peer start codex-a --kind codex --last
  ${cliName} peer start claude-a --kind claude -- claude
  ${cliName} peer start claude-a --kind claude --resume 00000000-0000-0000-0000-000000000000
  ${cliName} peer start claude-a --kind claude --continue
  ${cliName} peer attach codex-a --pane %1
  ${cliName} peer stop codex-a

Start hcc web first. peer start creates a local tmux-backed terminal by default.
The web runtime attaches to that terminal; hcc down stops only the web runtime
and leaves the tmux terminal alive. peer attach imports an existing tmux pane.
If --pane is omitted, peer attach uses the current tmux pane when available.
Use --force only when intentionally overriding a provider-session or pane binding.
`);
    },

    helpTmux() {
      console.log(`${cliName} tmux

Usage:
  ${cliName} tmux gc [--peer ID] [--older-than DAYS] [--dry-run] [--yes]

Examples:
  ${cliName} tmux gc
  ${cliName} tmux gc --older-than 14 --yes

tmux gc only considers sessions that are proven by this project's database:
peer_bindings.transport must be tmux, runtime_target must point at a live tmux
pane, and the actual tmux session name must match hello-cc's managed session
name for that peer and project root. It can also remove old sessions recorded by
tmux.session.rebind_cleanup_failed events after a successful provider rebind.

It skips sessions with attached tmux clients, sessions still managed by the
running Web runtime, sessions with a different HCC_ROOT tmux marker,
non-matching session names, and sessions newer than --older-than. The default is
a dry-run; deletion requires --yes.
`);
    },

    helpGc() {
      console.log(`${cliName} gc

Usage:
  ${cliName} gc [--older-than DAYS] [--yes]

Examples:
  ${cliName} gc
  ${cliName} gc --older-than 14 --yes

Clean stale coordination database records and old buffer files for the current
project. By default this is a dry-run; deletion requires --yes.
`);
    },

    helpLock() {
      console.log(`${cliName} lock

Usage:
  ${cliName} lock acquire [--peer ID] --resource PATH [--scope SCOPE] [--task N] [--ttl SEC] [--reason TEXT]
  ${cliName} lock renew [--peer ID] --resource PATH [--scope SCOPE] [--ttl SEC]
  ${cliName} lock release [--peer ID] --resource PATH [--scope SCOPE] [--force]
  ${cliName} lock list [--all]

Omit --scope to lock the whole resource. Different scopes on the same resource
can be held concurrently, but a whole-resource lock conflicts with every scope.
`);
    },

    helpHandoff() {
      console.log(`${cliName} handoff

Usage:
  ${cliName} handoff create [--from ID] --summary TEXT [--task N] [--to ID] [--changed-files JSON_OR_CSV] [--tests TEXT] [--risks TEXT]
  ${cliName} handoff list [--task N] [--limit N]
`);
    },

    helpEvent() {
      console.log(`${cliName} event

Usage:
  ${cliName} event tail [--limit N]
`);
    },

    helpRun() {
      console.log(`${cliName} run

Usage:
  ${cliName} run --peer ID --kind codex|claude|shell --role ROLE -- COMMAND [ARGS...]

Examples:
  ${cliName} run --peer codex-a --kind codex --role peer -- codex
  ${cliName} run --peer claude-a --kind claude --role peer -- claude

This keeps the CLI in your current terminal while injecting HCC_PEER,
HCC_ROOT, and HCC_DB so the session can use the shared bus.
Use hcc peer start, hcc web, or the installed claude/codex shims when the
session should also be browser-controllable.
`);
    },

    helpUp() {
      console.log(`${cliName} up

Usage:
  ${cliName} up [--no-discover] [--no-guidance]

Examples:
  ${cliName} up

This initializes the project-local coordination bus, writes bounded guidance,
installs Claude/Codex hooks when missing, and registers currently detected
sessions. It does not start the browser terminal console.

Run hcc web for the default full experience: local coordination, hooks, shims,
tmux-backed terminal sessions, and browser control.
`);
    },

    helpDown() {
      console.log(`${cliName} down

Usage:
  ${cliName} down

Stops the web runtime started by hcc web for this project.
`);
    },

    helpUpdate() {
      console.log(`${cliName} update

Usage:
  ${cliName} update [--tag TAG] [--registry URL] [--dry-run]

Examples:
  ${cliName} update
  ${cliName} update --tag latest
  ${cliName} update --dry-run

Updates the global npm install by running:
  npm install -g ${npmPackageName}@TAG

The default TAG is latest.
`);
    },

    helpUninstall() {
      console.log(`${cliName} uninstall

Usage:
  ${cliName} uninstall [--purge --yes]

Stops the current project runtime and removes user-level hello-cc integrations:
Claude/Codex hooks and claude/codex shims.

With --purge --yes, also removes current project data:
  .hello-cc/
  hello-cc blocks from CLAUDE.md and AGENTS.md
`);
    },

    helpWeb() {
      console.log(`${cliName} web

Usage:
  ${cliName} web [--host HOST] [--port N] [--token TEXT] [--local] [--no-token] [--no-discover] [--no-guidance]

Examples:
  ${cliName} web
  HCC_WEB_TOKEN='long-token' ${cliName} web --port 8787
  ${cliName} web --local

This is the default one-command entrypoint. It prepares local coordination,
installs Claude/Codex hooks and shims, ensures tmux is available, starts the
browser terminal console as a background runtime, prints the URL, PID, runtime
file, and log file, then returns the terminal to you.

By default, the web runtime listens on 0.0.0.0 and uses a saved token,
generating one on first use. Use HCC_WEB_TOKEN or --token to replace the saved
token, --local to bind only to 127.0.0.1, or --no-token only for a trusted
local/test environment.

After hcc web, plain claude/codex commands started from a new shell are wrapped
as local tmux-backed terminals. Existing ordinary terminals can communicate
through the bus, but cannot be visually attached unless they were started under
tmux/screen or a hello-cc shim.
`);
    }
  };
}
