# hello-cc Documentation

Start with the [project README](../README.md) when you only need the project
summary and first command. Use these docs when you need more detail.

The 1.0.0 contract is breaking: schema v7 has no downgrade path, migrations
create a verified backup, provider peer IDs changed without legacy remapping,
and protected routes use Runtime API v2. Process evidence controls liveness and
only unknown evidence gets 120 seconds of grace; `gc --history` is opt-in.
Use `--tls` directly, or `--trust-proxy` with a fixed `--proxy-origin`.
Plaintext LAN operation and
authenticated selection of any existing server directory are accepted risks.

## User Docs

- [User Guide](guide.md): install, start, Web console, coordination semantics,
  workflow, stable peer identity, and environment behavior.
- [Command Reference](commands.md): compact list of public commands and the
  intended use of each command group.
- [DeepSeek Harness](dsh.md): project setup, hooks/Cordis collaboration, ACP workers,
  installable bundles, and session routing boundaries.
- [Native Workers](native.md): owned background workers, provider adapters,
  delivery receipts, permission handling, and resume boundaries.
- [Changelog](../CHANGELOG.md): release notes for published versions.
- Release notes: run `npm run release:check` and
  `npm run release:github:dry-run` before publishing. Pushing a `v*` tag runs
  `.github/workflows/github-release.yml`, which creates or updates the GitHub
  Release description from the current changelog section. Use
  `workflow_dispatch` to backfill older releases without a personal token.

## Design And Implementation

- DeepSeek Harness integration plan (Chinese) (source checkout: `docs/plans/2026-10-02-dsh-integration.md`): implementation stages, module contracts, and completion gates.
- DeepSeek Harness acceptance (Chinese) (source checkout: `docs/verification/2026-10-02-dsh-cordis-native.md`): real models, bundle loading, regression and browser evidence.

- [Web task handoff (Chinese)](web-handoff.zh-CN.md): browser control, draft recovery, persistent detachment, and opt-in Codex App Server sessions.
- [Executor-scoped MCP](mcp.md): project-bound coordination tools, ownership checks and local result evidence.
- [Design Notes](design.md): product boundary, project boundary, capability
  levels, coordination semantics, and provider-session binding.
- [Implementation Notes](implementation.md): architecture, protocol, command
  surface, stack, shim behavior, and implementation plan.
- [Architecture](architecture.md): target project layout, module boundaries,
  dependency direction, and staged migration plan.

- [Desktop Agent communication](app-bridge.md): DSH idle wakeup, Claude Desktop Mod and read-only Codex probes.
