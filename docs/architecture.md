# hello-cc Architecture

Date: 2026-06-14

This document defines the intended module layout for hello-cc. It is a design
target for future refactors, not a claim that every file already follows this
layout.

The goal is to stop splitting code by helper size and start moving code by
product boundary. A thin CLI, explicit core state model, dedicated runtime
layer, terminal adapters, and Web server boundary make future changes easier to
review and less likely to mix unrelated behavior.

## Reference Shape

The target shape follows the same broad separation used by mature agent CLI
projects:

- entrypoints stay small and delegate to command or server packages;
- core coordination logic is independent from HTTP, tmux, and process launch;
- runtime files and runtime clients live outside the command handlers;
- Web server routes, WebSocket transport, and session lifecycle are explicit
  server modules;
- provider-specific behavior is isolated from generic session and task logic;
- tests are grouped by domain instead of appended to one large script forever.

In particular, Codex-style layouts separate `cli`, `core`, `app-server`,
`protocol` or transport, state stores, hooks, config, and execution adapters.
hello-cc does not need Rust crates or the same scale, but it should use the same
architectural idea: split by boundary, not by convenience.

## Current Pressure Points

The codebase has already extracted many focused modules under `lib/`, including
schema, runtime state, task/message stores, peer identity, provider command
building, tmux helpers, Web HTTP helpers, and render helpers.

The remaining structural pressure is mostly:

- `bin/hcc.mjs` still contains command dispatch, command handlers, Web server
  setup, HTTP routes, WebSocket terminal handling, tmux session management, PTY
  session management, external buffer adoption, and shutdown cleanup.
- `cmdWeb()` is the largest mixed boundary. It should be treated as a Web
  runtime subsystem, not as a normal CLI command body.
- `scripts/regression.mjs` is a valuable full regression gate, but it should
  eventually become a runner over domain-specific regression modules.

## Target Layout

```text
bin/
  hcc.mjs

lib/
  cli/
    dispatch.mjs
    context.mjs
    commands/
      ask.mjs
      broadcast.mjs
      down.mjs
      event.mjs
      gc.mjs
      handoff.mjs
      hooks.mjs
      init.mjs
      inject.mjs
      join.mjs
      lock.mjs
      msg.mjs
      peer.mjs
      prompt.mjs
      run.mjs
      scan.mjs
      setup.mjs
      shim.mjs
      state.mjs
      status.mjs
      task.mjs
      team.mjs
      uninstall.mjs
      update.mjs
      up.mjs
      web.mjs

  core/
    coordination/
      automation.mjs
      handoff.mjs
      locks.mjs
      messages.mjs
      tasks.mjs
      teams.mjs
      timeline.mjs
    peers/
      bindings.mjs
      format.mjs
      identity.mjs
      liveness.mjs
    sessions/
      launch.mjs
      model.mjs
      providers.mjs
      serialization.mjs

  db/
    connection.mjs
    migrations.mjs
    schema.mjs
    stores/
      locks.mjs
      messages.mjs
      peers.mjs
      tasks.mjs

  runtime/
    client.mjs
    paths.mjs
    projects.mjs
    state.mjs

  terminal/
    external-buffer.mjs
    pty.mjs
    tmux-stream.mjs
    tmux.mjs

  web/
    projects.mjs
    routes.mjs
    server.mjs
    session-manager.mjs
    websocket.mjs
    http.mjs
    ui-template.mjs

  integrations/
    hooks/
      claude.mjs
      codex.mjs
    providers/
      claude.mjs
      codex.mjs
      shell.mjs
    shims/
      setup.mjs
      script.mjs

  ui/
    format.mjs
    help.mjs
    state-render.mjs

  release/
    package-meta.mjs
    release-notes.mjs

  shared/
    errors.mjs
    json-file.mjs
    text.mjs

scripts/
  regression.mjs
  regression/
    cli.mjs
    coordination.mjs
    db.mjs
    release.mjs
    runtime.mjs
    sessions.mjs
    web.mjs
```

## Boundary Rules

`bin/hcc.mjs` should become a thin entrypoint. It may parse global arguments,
create the root context, invoke dispatch, and convert top-level errors to CLI
output. It should not own Web routing, DB schema, tmux streaming, provider
command construction, or task state machines.

`lib/cli/` owns command parsing and command handlers. A command handler can
open a database, call stores or core services, and print results. It should not
contain reusable domain logic when that logic can live in `core`, `runtime`,
`terminal`, `web`, or `integrations`.

`lib/core/` owns product semantics. Task lifecycle, takeover readiness, message
threading, lock conflict rules, team planning, peer identity semantics, and
session identity rules belong here. Core modules should not depend on HTTP
request objects, WebSocket objects, tmux commands, or process spawning.

`lib/db/` owns SQLite connection, schema, migrations, and data stores. Store
modules should expose explicit operations and transaction boundaries. Schema
migrations must be safe to run for every registered project database, not just
the current project.

`lib/runtime/` owns runtime files, runtime discovery, runtime client requests,
and project registry state. It should not know how Web routes render UI or how
terminal bytes are transported.

`lib/terminal/` owns terminal adapters. tmux pane inspection, tmux stream setup,
tmux input, PTY spawning, and external buffer adoption belong here. Terminal
adapters can emit session events, but they should not decide task ownership or
message behavior.

`lib/web/` owns the Web runtime. It should assemble project context, session
manager, HTTP routes, WebSocket terminal upgrade, and shutdown cleanup. Route
handlers should be small and delegate to stores, core services, runtime
modules, or terminal/session manager methods.

`lib/integrations/` owns provider-specific behavior. Claude, Codex, and shell
command construction, hook installation details, and shim scripts should stay
out of generic session and coordination modules.

`lib/ui/` owns CLI-facing text output and help. It can format already-computed
state, but it should not read or mutate project state.

`lib/release/` owns release metadata and release notes helpers. Release scripts
and GitHub release tooling should share these helpers.

`lib/shared/` is only for small, dependency-light utilities used across several
boundaries. It should not become a dumping ground.

## Dependency Direction

The intended dependency direction is:

```text
bin -> cli -> web/runtime/db/core/terminal/integrations/ui
web -> runtime/db/core/terminal/ui
terminal -> shared/core sessions only when needed
core -> shared
db -> shared
ui -> shared
release -> shared
```

Avoid these dependencies:

- `core` importing `web`, `terminal`, `cli`, or `integrations`;
- `db` importing `cli` or `web`;
- `terminal` importing Web route modules;
- provider integrations importing command handlers;
- `shared` importing product-specific modules.

This keeps most behavior testable without a Web runtime or tmux process.

## Migration Plan

Refactor in small, reviewable phases. Each phase should keep public behavior and
npm package contents stable unless the task explicitly says otherwise.

1. Document the target architecture.
   This document is the contract for future splits.

2. Move existing flat modules into target directories.
   Start with low-risk moves such as `runtime-*`, `web-*`, `task-store`,
   `messages`, `help`, `state-render`, and release helpers. Keep compatibility
   re-export files temporarily if the import churn becomes too large.

3. Split the Web runtime by subsystem.
   Extract project selection, session manager, Web routes, WebSocket terminal
   handling, tmux stream, PTY session, and external buffer adoption from
   `cmdWeb()` in separate commits.

4. Make `bin/hcc.mjs` a thin entrypoint.
   Move dispatch and command groups under `lib/cli/commands/`.

5. Split regression tests by domain.
   Keep `npm test` as the single full regression command, but make it call
   focused domain modules under `scripts/regression/`.

## Web Runtime Target

The highest-value runtime split is:

```text
lib/web/server.mjs
  createWebRuntime(ctx, opts, deps)
  start/stop lifecycle

lib/web/projects.mjs
  rememberProject()
  knownProjects()
  projectFromRequest()

lib/web/session-manager.mjs
  sessions map
  getSession()
  serializeSession()
  startSession()
  stopSession()
  restoreManagedSessions()

lib/web/routes.mjs
  routeHttpRequest(req, res, env)

lib/web/websocket.mjs
  handleTerminalUpgrade(req, socket, head, env)

lib/terminal/tmux-stream.mjs
  startTmuxStream()
  stopTmuxStream()
  refreshTmuxSnapshot()

lib/terminal/external-buffer.mjs
  adoptExternalSession()
  scanExternalSessions()
```

This split makes Web blank-screen, stale session, tmux stream, and provider
binding bugs easier to isolate.

## Testing Expectations

Every structural migration should run:

```bash
git diff --check
node --check bin/hcc.mjs
node --check <changed modules>
npm test
```

Release-facing changes should also run:

```bash
npm run release:check
npm run release:github:dry-run
npm pack --dry-run --json
```

When new modules are added under `lib/`, verify that `npm pack --dry-run --json`
includes them.

## Non-Goals

Do not introduce TypeScript, Rust, a bundler, or a build step as part of this
layout migration. Those are separate product decisions with release and install
costs.

Do not rewrite working behavior while moving files. Directory migration commits
should be boring: imports change, module paths change, regression guards
change, behavior stays the same.

Do not move UI template assets into a framework until there is a separate Web UI
build plan. The current npm package should remain directly runnable after
install.
