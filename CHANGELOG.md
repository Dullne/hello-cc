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
