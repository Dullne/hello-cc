# Changelog

This project keeps one changelog file. Add one section per release, with the
newest version first. Do not create a new changelog file for every release.

Before publishing, run:

```bash
npm run release:check
npm run release:notes
npm run release:github:dry-run
```

Pushing a `v*` tag runs the GitHub Release workflow, which creates or updates
the release description from the current changelog section. Use
`npm run release:github` with `GH_TOKEN` or `GITHUB_TOKEN` only for local
backfills.

## 0.1.9

### Summary

hello-cc 0.1.9 publishes the post-0.1.8 Web runtime and provider shim
hardening work. It tightens Web peer action identity, makes runtime cleanup
safer, and keeps Claude/Codex shims from attaching unrelated projects to a
global Web runtime.

### Highlights

- Hardened Web runtime cleanup so starting `hcc web` from a wrapper shell does
  not terminate the current parent process chain while still removing stale
  orphan runtimes for the same project.
- Returned structured `BAD_REQUEST` JSON for malformed Web API request bodies
  instead of surfacing raw JSON parse failures.
- Replaced Web-runtime-token reuse for mutating peer actions with independent
  per-session action tokens.
- Changed provider shims to fall back to the real Claude/Codex CLI when no
  current-project Web runtime is available.
- Made provider shims use only the current project's `.hello-cc/runtime.json`
  during managed launches, avoiding accidental attachment through a global Web
  runtime from another project.
- Kept shim-only environment variables out of restarted provider sessions.

### Compatibility Notes

- No breaking CLI command changes are intended in this release.
- `hcc web --local` is still Web mode; use `hcc up` when you only want local
  coordination commands without the Web console or shims.
- Starting `claude` or `codex` in a directory without a local
  `.hello-cc/runtime.json` now runs the real provider CLI instead of implicitly
  using a global hello-cc Web runtime.

### Validation

The 0.1.9 release should be validated with:

```bash
git diff --check
node --check bin/hcc.mjs
find lib -name '*.mjs' -print0 | xargs -0 -n1 node --check
node --check scripts/github-release.mjs
node --check scripts/regression.mjs
node --check scripts/release-notes.mjs
npm run release:check
npm run release:github:dry-run -- --version 0.1.9
npm pack --dry-run --json
npm publish --dry-run --registry=https://registry.npmjs.org/ --access public
npm test
```

The expected full regression marker is:

```text
FULL_REGRESSION_OK
```

## 0.1.8

### Summary

hello-cc 0.1.8 is a targeted patch release for Claude/Codex shim
self-repair. It fixes generated shims that could stay pinned to a removed
provider binary after Claude or Codex was reinstalled.

### Highlights

- Fixed `hcc shim ensure` so it only reuses an existing `# Real binary:` path
  when that binary still exists.
- Preserved the existing fast path for valid generated shims while falling back
  to the requested binary or rediscovering the provider from `PATH` when the
  recorded path is stale.
- Added regression coverage for the reinstall case where a generated shim
  points at a deleted provider binary but a working provider is available on
  `PATH`.

### Compatibility Notes

- No CLI command or package surface changes are intended in this release.
- Existing generated shims will self-heal on the next `hcc shim ensure` or shim
  launch when their recorded provider binary has disappeared.

### Validation

The 0.1.8 release should be validated with:

```bash
git diff --check
node --check bin/hcc.mjs
find lib -name '*.mjs' -print0 | xargs -0 -n1 node --check
node --check scripts/github-release.mjs
node --check scripts/regression.mjs
node --check scripts/release-notes.mjs
npm run release:check
npm run release:github:dry-run -- --version 0.1.8
npm pack --dry-run --json
npm publish --dry-run --registry=https://registry.npmjs.org/ --access public
npm test
```

The expected full regression marker is:

```text
FULL_REGRESSION_OK
```

## 0.1.7

### Summary

hello-cc 0.1.7 publishes the post-0.1.6 Web and coordination hardening work
alongside the README product screenshot. It keeps the 0.1.6 package surface and
adds stricter peer identity behavior, audited Web peer actions, cleaner tmux
test isolation, and clearer first-run documentation for the Web console.

### Highlights

- Enforced system-peer identity handling so internal coordination actions stay
  attributable and do not accidentally inherit a user peer identity.
- Audited Web peer action flows and expanded regression coverage around task,
  message, lock, and tmux cleanup paths used by the browser console.
- Cleaned tmux-focused regression tests so runtime cleanup and test isolation
  stay stable across repeated local runs.
- Added a sanitized Web console screenshot to both English and Chinese README
  files, showing sessions, terminal output, project state, messages, peers,
  tasks, and locks.
- Documented that `hcc web` defaults to a LAN-facing `0.0.0.0` bind, requests
  port `8787`, prints both `open:` and `local:` token URLs, and auto-tries later
  ports when `--port` is not explicit.

### Compatibility Notes

- No breaking CLI command changes are intended in this release.
- The Web access model remains token-in-URL based; use `--local` when the Web
  console should bind only to `127.0.0.1`.
- This release does not change the public package surface introduced in 0.1.6.

### Validation

The 0.1.7 release should be validated with:

```bash
git diff --check
node --check bin/hcc.mjs
find lib -name '*.mjs' -print0 | xargs -0 -n1 node --check
node --check scripts/github-release.mjs
node --check scripts/regression.mjs
node --check scripts/release-notes.mjs
npm run release:check
npm run release:github:dry-run -- --version 0.1.7
npm pack --dry-run --json
npm publish --dry-run --registry=https://registry.npmjs.org/ --access public
npm test
```

The expected full regression marker is:

```text
FULL_REGRESSION_OK
```

## 0.1.6

### Summary

hello-cc 0.1.6 publishes the current architecture-layout cleanup that followed
0.1.5 and records the split-stack audit that reviewed it. The installed CLI
behavior remains the public API, while internal helpers now live closer to their
product boundaries under `core/`, `runtime/`, `web/`, `terminal/`,
`integrations/`, `ui/`, `release/`, and `shared/`. This release keeps the
current master history as the publish path; teams that want cleaner refactor
history should use the documented rebuild-branch option instead.

### Highlights

- Added architecture guidance for the target module layout and documented the
  package-surface policy: `hcc` and `hello-cc` are the supported public
  interfaces; deep `lib/` imports are compatibility paths, not user workflows.
- Added `docs/layout-split-stack-audit.md`, which classifies the local
  `origin/master..HEAD` stack, calls out the early flat-helper extraction phase,
  and records the package-surface and follow-up cleanup decisions before
  publish.
- Moved peer, task, lock, message, team, timeline, automation, and session
  helpers into `core/`, `db/`, `runtime/`, `terminal/`, and `integrations/`
  boundaries while keeping compatibility entrypoints for already-exposed paths.
- Moved Web runtime, HTTP, UI template, and peer action helpers into `lib/web/`
  while preserving existing Web console behavior.
- Moved provider command helpers and Claude/Codex hook and shim setup helpers
  into `lib/integrations/`, including shim script generation under
  `lib/integrations/shims/`.
- Moved JSON and CLI error helpers into `lib/shared/`, release metadata helpers
  into `lib/release/`, and CLI-facing state/help rendering into `lib/ui/`.
- Expanded regression guards so module moves verify both the new primary
  boundary and the compatibility re-export identity.

### Compatibility Notes

- `@logicseek/hello-cc@0.1.5` was already published from git head `4969100`.
  This release uses a new package version and does not republish `0.1.5`.
- Top-level `lib/*.mjs` files that were already published in `0.1.5` remain
  available for this release cycle to avoid breaking deep imports exposed by the
  package's `files` list.
- New top-level re-export-only helper paths introduced during the local layout
  migration are treated as compatibility-only deep-import paths for this
  release, not as target architecture. New code should prefer the
  product-boundary modules documented in `docs/architecture.md`.
- The audit records remaining cleanup items for later focused work, including
  moving SQL-heavy task store operations out of pure core, removing core/runtime
  reverse dependencies on top-level formatting or Web helpers, and continuing to
  split `cmdWeb()` by subsystem instead of by incidental helper names.
- No breaking CLI command changes are intended in this release.

### Validation

The 0.1.6 release should be validated with:

```bash
git diff --check
node --check bin/hcc.mjs
find lib -name '*.mjs' -print0 | xargs -0 -n1 node --check
node --check scripts/github-release.mjs
node --check scripts/regression.mjs
node --check scripts/release-notes.mjs
npm run release:check
npm run release:github:dry-run -- --version 0.1.6
npm pack --dry-run --json
npm publish --dry-run --registry=https://registry.npmjs.org/ --access public
npm test
```

The expected full regression marker is:

```text
FULL_REGRESSION_OK
```

## 0.1.5

### Summary

hello-cc 0.1.5 publishes the Web runtime split that landed after 0.1.4. The
CLI keeps the same user-facing Web behavior, while runtime URLs, request
parsing, HTTP response helpers, and the browser UI template now live in focused
`lib/` modules. This release also includes the latest coordination automation
improvements for stale task owners, batch task claims, and takeover-ready task
state.

### Highlights

- Added batch task claiming and takeover policy support for blocked or stale
  work, including owner liveness details in task/state output.
- Fixed detected-peer Web controls so active `working` or `idle` peers show the
  correct stop action instead of being treated as restart-only peers.
- Kept stop-dialog labels tied into Web i18n so language changes update the
  dialog controls consistently.
- Extracted Web runtime URL/token helpers into `lib/web-runtime.mjs`.
- Extracted the browser UI template into `lib/web-ui-template.mjs`.
- Extracted low-level Web HTTP helpers into `lib/web-http.mjs`.
- Expanded regression coverage for the new helper modules, packaged module
  contents, Web display guards, and release/package checks.

### Validation

The 0.1.5 release should be validated with:

```bash
git diff --check
node --check bin/hcc.mjs
node --check lib/web-http.mjs
node --check lib/web-runtime.mjs
node --check lib/web-ui-template.mjs
node --check scripts/github-release.mjs
node --check scripts/regression.mjs
node --check scripts/release-notes.mjs
npm run release:check
npm run release:github:dry-run -- --version 0.1.5
npm pack --dry-run --json
npm publish --dry-run --registry=https://registry.npmjs.org/ --access public
npm test
```

The expected full regression marker is:

```text
FULL_REGRESSION_OK
```

## 0.1.4

### Summary

hello-cc 0.1.4 publishes the latest Web coordination fixes and a small internal
module split. The Web console now uses structured peer action APIs instead of
injecting routine action commands into the terminal, keeps Project State card
scroll positions stable through refreshes, and refreshes restored tmux panes
after browser input. Release and guidance helpers are now shared from `lib/`,
so CLI metadata, release-note parsing, GitHub release publishing, and generated
coordination guidance have one source of truth.

### Highlights

- Added `/api/peers/:peer/actions/:action` for Web status, state, inbox,
  task-claim, heartbeat, and registration actions, with an action-result panel
  in the browser UI.
- Kept explicit terminal command injection available only for the advanced
  terminal status action, so normal Web toolbar actions no longer modify the
  selected session's terminal input.
- Added collapsible Project State cards for automation, timeline, messages,
  peers, tasks, and locks, with persisted collapsed state and restored per-card
  scroll positions after polling refreshes.
- Refreshed tmux snapshots shortly after WebSocket input so restored tmux
  sessions show typed input promptly without unsafe browser-side local echo.
- Disabled stale tmux `pipe-pane` writers before restoring FIFO streaming, so
  restarted Web runtimes can attach to existing panes reliably.
- Moved package metadata, changelog release helpers, and generated coordination
  guidance into reusable `lib/` modules used by the CLI and release scripts.
- Expanded regression coverage for Web peer actions, state-card behavior,
  tmux input visibility, packaged helper modules, v-prefixed release-note
  versions, and CLI/package version consistency.

### Validation

The 0.1.4 release should be validated with:

```bash
git diff --check
node --check bin/hcc.mjs
node --check lib/guidance.mjs
node --check lib/package-meta.mjs
node --check lib/release-notes.mjs
node --check scripts/github-release.mjs
node --check scripts/regression.mjs
node --check scripts/release-notes.mjs
npm run release:check
npm run release:github:dry-run -- --version 0.1.4
npm pack --dry-run --json
npm publish --dry-run --registry=https://registry.npmjs.org/ --access public
npm test
```

The expected full regression marker is:

```text
FULL_REGRESSION_OK
```

## 0.1.3

### Summary

hello-cc 0.1.3 improves the Web console for day-to-day remote operation and
hardens the release workflow. The Web UI now supports English/Chinese labels,
resizable left and right sidebars, remote token defaults, and a cleaner
resume/session experience. Release notes can now be published automatically from
the changelog through GitHub Actions, so tag-based releases and manual backfills
use the same checked release body.

### Highlights

- Added a Web language selector with English and Chinese labels for the main
  project/session controls, action menu, state panel, detected-session view, and
  status text.
- Added full-height draggable left and right sidebar dividers while preserving
  the compact collapse buttons and persisted sidebar widths.
- Reapplied sidebar width clamps after collapse/expand transitions so restored
  panels cannot squeeze the center terminal below its usable width.
- Kept bare `hcc web` remote-friendly by default with a saved token, while
  preserving `--local` and explicit token/no-token controls.
- Added provider resume controls and resumable-session selection in the Web
  start form so Claude/Codex resume flows are available from the browser.
- Added `scripts/github-release.mjs` plus `release:github` and
  `release:github:dry-run` npm scripts to create or update GitHub Releases from
  `CHANGELOG.md`.
- Added `.github/workflows/github-release.yml` so pushing `v*` tags publishes
  the GitHub Release description with the repository `GITHUB_TOKEN`, and
  `workflow_dispatch` can backfill older releases without a personal token.
- Tightened generated coordination guidance so read-only reviews do not take
  advisory locks and mutating work remains explicitly locked.
- Expanded regression coverage for Web i18n, sidebar resizing, release notes,
  GitHub Release automation, and generated coordination guidance.

### Validation

The 0.1.3 release should be validated with:

```bash
git diff --check
node --check bin/hcc.mjs
node --check scripts/regression.mjs
node --check scripts/github-release.mjs
node --check scripts/release-notes.mjs
npm run release:check
npm run release:github:dry-run -- --version 0.1.3
npm pack --dry-run --json
npm publish --dry-run --registry=https://registry.npmjs.org/ --access public
npm test
```

The expected full regression marker is:

```text
FULL_REGRESSION_OK
```

## 0.1.2

### Summary

hello-cc 0.1.2 tightens the public release surface after the first scoped npm
publish. It adds a first-class update command, makes uninstall discoverable in
top-level help, and reorganizes the documentation so the npm package page and
GitHub release notes have a clear, detailed description of what changed. It also
adds explicit team task orchestration and makes schema migrations cover
registered project databases.

### Highlights

- Added `hcc update`, which updates the global npm install by running
  `npm install -g @logicseek/hello-cc@latest`.
- Added `hcc update --tag`, `hcc update --registry`, and `hcc update --dry-run`
  for controlled upgrades and release verification.
- Made `hcc uninstall` visible in top-level `hcc --help`, matching the README
  and command reference.
- Kept uninstall behavior conservative: `hcc uninstall` removes hooks and
  shims, while `hcc uninstall --purge --yes` is required to remove project data.
- Split documentation into a short README, a user guide, command reference, and
  documentation index in both English and Chinese.
- Added `hcc team plan`, `hcc team start`, and `hcc team status` for explicit
  parent-task splits into auditable child tasks.
- Added task hierarchy metadata so team subtasks remain visible through the
  normal task/state/timeline surfaces.
- Extended schema migration startup so registered project databases are migrated
  alongside the current project database when the CLI opens state.
- Changed bare `hcc web` to listen on `0.0.0.0` with a saved URL token by
  default. The token is generated on first use and reused across restarts; use
  `--local` for loopback-only access or `--no-token` only in trusted local/test
  environments.
- Restored the Star History chart at the bottom of both README files.
- Included README-linked package assets in the npm tarball so the package page
  renders the project logo correctly.

### Documentation

- `README.md` and `README.zh-CN.md` now focus on product positioning, install
  and maintenance commands, quick start, a basic workflow, and links to docs.
- `docs/guide.md` and `docs/guide.zh-CN.md` describe practical usage and avoid
  embedding the full command list.
- `docs/commands.md` and `docs/commands.zh-CN.md` provide the compact command
  reference.
- `docs/README.md` and `docs/README.zh-CN.md` provide the documentation index.
- English documentation links now point to English user docs, and Chinese
  documentation links point to Chinese user docs.

### Validation

The 0.1.2 release should be validated with:

```bash
git diff --check
node --check bin/hcc.mjs
node --check scripts/regression.mjs
node --check lib/setup.mjs
node --check lib/discover.mjs
npm pack --dry-run --json
npm publish --dry-run --registry=https://registry.npmjs.org/ --access public
npm test
```

The package dry run should include `CHANGELOG.md`, `assets/logo.svg`, and the
English and Chinese command reference files.

The expected full regression marker is:

```text
FULL_REGRESSION_OK
```

### Release Notes Source

Use this changelog section as the source for the GitHub Release notes for
`v0.1.2`. The npm package metadata keeps a short description, while the package
README and this changelog provide the detailed release description.

Publish or backfill the GitHub Release description with:

```bash
GH_TOKEN=... npm run release:github -- --version 0.1.2
```

After `.github/workflows/github-release.yml` is on the default branch, the same
backfill can be run from GitHub Actions with `workflow_dispatch` and version
`0.1.2`, without a personal token.
