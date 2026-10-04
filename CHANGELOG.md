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

## 1.1.0-rc.2

### Summary

This local Web workbench candidate adds project Agent defaults, retained native
history with explicit closed-worker resume, and project file upload/editing.
It is based on the 1.0.5 delivery line and retains its process identity, tmux
snapshot and shutdown fixes. A local candidate does not establish publication.

### Highlights

- Create Codex, Claude and DeepSeek Harness background Agents from one Web form;
  save project defaults without changing provider credentials or global settings.
- Read HCC-retained native events and resume explicitly closed workers with
  owner, session and working-directory identity checks.
- Upload new project files up to 10 MiB and edit complete UTF-8 text up to 1 MiB,
  with revision conflicts, preserved drafts and explicit uncertain-write readback.
- Bind browser project requests and drafts to the selected directory identity.
- Preserve native Web connections and control tokens when background discovery
  overlaps Agent creation or history restore; discard stale discovery results.
- Recheck provider initialization before rejecting an older snapshot with no
  session ID, and retain exact project file matches when a wider search times out.
- Keep the existing terminal/App Server modes, readonly previews and bounded
  reconnect behavior.

### Validation

The candidate is checked with the full source regression suite, a disposable
npm installation and desktop/narrow browser flows. Real-provider entry and
history checks have separate receipts. These checks do not establish a public
release, a global installation upgrade or real business acceptance.

## 1.0.5

### Summary

macOS process identities use the kernel boot session UUID so changes to the
reported boot time cannot make a running process appear to have been replaced.
The issue was observed during post-release sustained acceptance of 1.0.4.

### Highlights

- Preserve process identity across changes to the wall-clock-derived boot time.
- Keep live processes with an older Darwin identity format protected while their
  ownership cannot be compared; a format change does not prove that an owner exited.
- Retain strict process state, start time and zombie checks, with unknown results
  when a stable boot session identifier cannot be read.
- Keep the existing npm `latest` release channel.
- Confirm the original local runtime has exited when its stop response is lost,
  while preserving unknown owners and replacement runtime pointers.
- Retain structured shutdown error codes when Node warnings share stderr.

### Validation

Targeted regression tests cover boot identity drift, boot-session changes,
malformed observations and conservative handling of existing runtime ownership.
Full source, package, current-device and sustained-run validation are recorded
separately. The interrupted 1.0.4 sustained run remains a failed attempt.
The first 1.0.5 candidate passed the current-Mac sustained check; a subsequent
CI transport timeout exposed the separate stop-confirmation failure. Its
targeted verification and replacement candidate retain separate evidence.

Existing processes keep the implementation they started with. Quit and reopen
Harness normally to activate the update. An older active owned runtime should
finish and stop normally before it is reclaimed; do not force takeover based
on an incompatible identity marker.

## 1.0.4

### Summary

Session lists no longer run synchronous tmux client probes for each displayed
terminal. A bounded asynchronous snapshot supplies display information while
live process and terminal observations continue to guard control actions.

### Highlights

- Share one short-lived tmux display snapshot across sessions. Cold, stale or
  failed observations remain unknown, and pending probes stop with the runtime.
- Preserve live checks for terminal control, rebind, stop and ownership.
- Treat exited macOS zombie processes as dead, so shutdown waits can complete
  while a parent has yet to reap the PID; malformed observations remain unknown.
- Include the HTTP method, request path, deadline and elapsed time in runtime
  request failures, without request bodies, query parameters or credentials.
- Keep DeepSeek Harness on the existing npm `latest` channel.

### Validation

Targeted tests cover slow probes, stale and failed snapshots, refresh coalescing,
shutdown and request diagnostics. Full regression, official installed Harness,
registry readback and current-Mac model checks have separate verification records.
The earlier 1.0.3 macOS CI timeout remains historical evidence: removing a known
blocking path does not identify the specific cause of that earlier timeout.
Regression shutdown tracks the exact fixture process identity, distinguishes
reused PIDs and zombies, and retains bounded failure diagnostics before cleanup.

## 1.0.3

### Summary

This maintenance release keeps DeepSeek Harness on the normal npm `latest`
channel and repairs the CLI, native-session and Web regressions identified while
archiving 1.0.2. It retains the verified Cordis cleanup and recovery behavior.

### Highlights

- Preserve provider process identity during registration and discovery; update
  owned hooks without discarding unrelated hooks or damaged user configuration.
- Keep explicit hook database routing and quote generated terminal arguments.
- Preserve the recorded origin of native submissions across restarts; peer
  messages cannot gain local-user authority from their sender name or text.
- Keep managed state directories and database files private without replacing
  existing data or changing external database parent permissions. Terminal stream
  buffers follow each session's project.
- Bound streaming updates and long-message rendering while preserving complete
  copied content, reader position, approval details and session ownership checks.
- Isolate request parsing failures, retain local/proxy access contracts, serialize
  Web startup and resolve terminal assets with npm dependency hoisting.
- Native runtime ownership uses alternate ports for identifiable unrelated local
  listeners while keeping one owner per project. Silent or legacy listeners are
  rejected conservatively, and ownership remains until shutdown completes.

### Validation

The full restored regression suite and the installed official Harness package
checks run against this composed release. The frozen file manifest and verification
record live under `docs/verification/`; those source-only records are excluded
from the npm package. Publication, current-device activation and real-model
acceptance are recorded separately from source and CI checks.

## 1.0.2

### Summary

DeepSeek Harness now joins hello-cc through project hooks, a Cordis collaboration
bundle, and owned ACP workers. This release promotes the runtime verified in
`1.0.2-dsh.3` to the normal npm `latest` channel. Runtime code is unchanged from
that candidate; version metadata and release documentation identify this release.

### Highlights

- Harness Agents use their exact session and project identity for task, message,
  lock, result, and handoff operations. Context acknowledgements follow committed
  model input, and permission decisions retain the Harness policy chain.
- Owned ACP workers support queued prompts, scoped MCP tools, approvals,
  interruption, session resume, and shutdown through the CLI and Web interface.
- Managed project configuration migrates verified paths from source checkouts to
  installed packages while preserving user edits.
- Cordis sessions recover after a verified owner process exits; transient
  database failures during retirement remain retryable while old tool authority
  is revoked immediately.
- Node.js 24+ and official Harness `0.2.0-rc.2` are required. Supported hosts are
  macOS and Linux; Windows uses WSL. Native Windows shells are not supported.

### Validation

The byte-identical preview runtime passed macOS real-model installation checks
(11), Linux container installation and deterministic collaboration checks (8 + 7),
and frozen-package recovery tests (17). Its registry download and all 216
installed files matched the candidate. This stable package receives independent
release, installation, and registry readback checks. Other-device and genuine
business acceptance remain separate stages.

## 1.0.2-dsh.3

### Summary

This preview keeps the DeepSeek Harness integration introduced in `1.0.2-dsh.2`
and fixes session cleanup when a temporary database failure interrupts shutdown.
It remains an npm `dsh` preview and a GitHub prerelease.

### Highlights

- Revoking a Cordis Agent immediately blocks its tools while allowing database
  retirement to retry after storage becomes available again.
- Preserve failed cleanup records across plugin reloads. Recovery requires the
  exact disposed Agent, provider session, and project; active owners cannot be
  replaced based on another Agent's disposal event.
- Retain the pinned Harness `0.2.0-rc.2`, Node.js 24+, and Linux/macOS/WSL support
  boundaries. Every candidate has independent package and acceptance receipts.

## 1.0.2-dsh.2

### Summary

This preview integrates DeepSeek Harness sessions with the hello-cc task,
message, lock, and handoff services. It adds project hooks, an installed Cordis
bundle, and owned ACP workers, including session recovery and explicit approval
handling. The preview is intended for the `dsh` npm dist-tag and a GitHub
prerelease; publication and business acceptance are separate delivery gates.

### Highlights

- `hcc dsh setup`, `status`, and `web` manage project hooks or a Cordis overlay.
  Setup verifies its managed files before migrating paths from a source checkout
  to an installed package and preserves user-edited configuration.
- The Cordis bundle exposes collaboration tools using each Agent's complete
  provider session ID and project root. Inbox acknowledgements follow the
  committed model context; simultaneous sessions retain separate ownership.
- A resumed Cordis session can reclaim ownership after a crashed owner only
  when complete process identity evidence confirms that owner is dead. Live or
  uncertain owners, competing transports, and changed bindings remain protected.
- Native ACP workers use a dedicated `dsh --profile acp` process with scoped MCP
  tools. Queue admission and completed delivery are distinct; close, resume,
  interruption, and approval responses retain the owning session boundary.
- ACP approval requests correlate tool-call IDs with their tool input, including
  out-of-order updates. Requests with missing or truncated context cannot be
  accepted; rejection remains available.
- Release tooling derives GitHub prerelease status from the version and exposes
  it during dry runs, so preview releases do not receive stable release status.

### Compatibility Notes

- Node.js 24 or newer and matching DeepSeek Harness `0.2.0-rc.2` runtime packages
  are required. The Cordis integration checks the actual Agent, AgentLoop, Tools,
  and Sessions package versions before loading.
- Supported host environments are Linux and macOS; Windows users must use WSL.
  Native Windows shells are not supported. The existing macOS arm64 acceptance
  results do not establish Linux, WSL, or other-device acceptance for this preview.
- Choose one injection method per Harness process: profile bundle or project
  overlay. Harness manages profile bundle installation; `setup --mode off`
  disables a managed project overlay.
- Existing schema v7 and Runtime API v2 boundaries still apply. Real model
  acceptance requires a provider route that permits Harness; a route restricted
  to an official client remains restricted.

### Validation

Earlier local macOS arm64 candidates completed official plugin installation and
removal, real Cordis collaboration calls, ACP session lifecycle and approval
denial, and an isolated order-report workflow. Those dated receipts belong to
their recorded candidate hashes. This version requires its own frozen-package
installation receipt and release checks before publication. Other-device
installation and genuine business signoff remain separate, incomplete gates.

## 1.0.1

### Summary

hello-cc 1.0.1 is a file-lock determinism, buffer-GC safety, fresh-install, and
release-reliability patch. It makes worker shutdown reclaim kernel lock
endpoints deterministically when an identity probe keeps its client write half
open, restores real PTY startup in fresh macOS npm installations, and keeps
automatic GC fail-closed when optional buffer paths disappear or change.

### Highlights

- The socket-lock worker now tracks each locally accepted socket and destroys
  those accepted handles during server shutdown, so release no longer depends
  on the peer closing its writable half after reading the lock banner.
- A real half-open identity-probe regression verifies that release returns
  promptly, a nonblocking reacquisition succeeds immediately, and the probe is
  explicitly stopped and awaited during final cleanup.
- `node-pty` is exactly pinned to `1.2.0-beta.15`. The stable `node-pty 1.1.0`
  npm artifact contains non-executable Darwin helpers, which makes a fresh
  macOS install fail with `posix_spawnp failed`; the selected artifact publishes
  both Darwin helpers with executable modes.
- Linux, macOS, and WSL installation instructions now list Node.js 24, tmux
  commands for the major system package managers, CLI verification, and safe
  handling for npm global-install permission errors.
- `hcc down` now waits for the exact Runtime process identity to exit before it
  reports success, including safe handling for PID reuse and a bounded timeout
  when shutdown cannot be confirmed.
- Background Web startup keeps its immediate child-exit failure but allows a
  bounded 60-second health window, avoiding false failures on loaded macOS CI
  hosts where process identity and project restoration can exceed 30 seconds.
- Manual buffer GC allows a bounded 30-second window for runtime evidence
  planning and apply, while still deferring all eligible files if the runtime
  remains unavailable.
- Automatic GC now treats a missing `.hello-cc/bufs` leaf as empty without
  recreating it. A missing state directory, a symlinked path component, an
  inode replacement, or a retargeted project-root alias fails closed with
  `PROJECT_PATH_FORBIDDEN` before buffer, clock, lock, or history mutation.
- Buffer path identity is retained through evidence collection, lease
  acquisition, planning, clock reads, and database transactions. GC uses a
  no-create lease while existing file-lock callers retain their original
  parent-creation behavior.
- Per-connection Web action tokens now require their issuing terminal socket to
  still be open, closing the handshake race before asynchronous token cleanup.
- Runtime request deadlines now reach the underlying HTTP transport, and peer
  start/attach preflight and mutation requests use a bounded 60-second window
  while stop and terminal-input operations use 30 seconds, instead of all
  inheriting the shorter read-request default.

### Compatibility Notes

- No CLI command or package-surface behavior changes are intended. Schema v7,
  Runtime API v2, the authenticated browser's ability to choose any existing
  server directory as a project root, and the 1.0.0 accepted-risk boundaries
  are unchanged.
- Stable project-root aliases remain supported. Only path disappearance,
  replacement, symlink traversal, or alias retargeting during GC is rejected.
- The existing five-second fail-closed deadline and cleanup-error behavior are
  unchanged.
- `node-pty@1.2.0-beta.15` is a bounded prerelease dependency risk. The exact
  pin prevents unreviewed beta movement, and release tests verify the installed
  version, regular-file identity, executable modes, and a real PTY. There is no
  postinstall or CI-only `chmod` workaround.

### Validation

The 1.0.1 release gate includes repeated macOS Node 24 tests; a no-cache Linux
Node 24/tmux image build followed by three complete `npm test` runs in that same
image, each ending with `FULL_REGRESSION_OK`; and a fourth clean container that
installs the same 1.0.1 package tarball and passes PTY, database, Web, and
missing-buffer GC smoke checks. Fresh macOS consumer installs pass both normal
and `--ignore-scripts` installation, proving that executable helper modes come
from the package artifact rather than lifecycle-script mutation. GC regression
coverage includes absent optional leaves, symlink and ancestor replacement,
alias retargeting, no-create lock acquisition, and path guards around clock and
history writes.

## 1.0.0

### Summary

hello-cc 1.0.0 is a breaking data, identity, and Runtime API release. It makes
process identity the authority for session liveness, bounds unknown evidence,
and hardens browser terminal control and technical-state cleanup.

### Highlights

- Process identity now controls live/dead decisions across tmux and ordinary
  child processes, including sleep, detach, PID reuse, and stale status rows.
- Browser credentials, trusted proxy headers, Runtime API TLS, and buffer GC
  all have narrower, tested authority boundaries.

### Breaking Changes

- Databases upgrade to schema v7. Downgrading a migrated database is not
  supported. Before migration, hello-cc creates a verified
  `<db>.pre-v<from>-to-v7.<timestamp>.<suffix>.bak` snapshot; stop all hello-cc
  processes and validate the backup with SQLite `quick_check` before any manual
  recovery. At most five strictly named backups are retained per database; the
  recovery procedure is documented in the user guide.
- Provider peer IDs now hash the complete provider session value. Existing
  pre-v1 provider IDs and bindings are left unchanged: there is no automatic
  alias, graph rewrite, or migration to the new ID.
- Protected HTTP and WebSocket operations require Runtime API v2. Browser
  terminal write tokens are issued per WebSocket connection and revoked when
  that connection closes.

### Security And Reliability

- Live tmux and non-tmux sessions are decided from immutable process evidence;
  sleep and tmux detachment do not mark a live process dead. Unknown evidence
  receives at most 120 seconds of grace, while confirmed dead owners expire.
- Generated Web access tokens are scoped to one runtime and are not persisted.
  HTTPS runtime overrides use normal certificate verification; set
  `HCC_RUNTIME_CA` to a CA file for a private or self-signed endpoint.
- `--trust-proxy` now requires `--proxy-origin https://host[:port]`; forwarded
  scheme and host must match that fixed origin and arrive from loopback.
- Garbage collection keeps task/message/event/handoff history unless
  `hcc gc --history --yes` is explicitly requested. Buffer deletion rechecks
  producer evidence and leases immediately before each bounded batch.

### Accepted Risks

- The default Web listener remains `0.0.0.0` over plaintext HTTP for trusted
  LAN use. The token controls access but does not provide transport encryption;
  use `--tls` or a pinned TLS reverse proxy when the network is not trusted.
- An authenticated browser may select any existing server directory as a
  project root. This is intentional for the operator console and is not a
  project-root sandbox or tenant boundary.

### Validation

The release gate requires Node 24 unit and full regression tests, package import
closure checks, a fresh Docker build, and three consecutive container runs that
end with `FULL_REGRESSION_OK`.

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
