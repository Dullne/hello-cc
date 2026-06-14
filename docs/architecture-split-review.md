# Architecture Split Review

Date: 2026-06-14

This review covers the local commits on `master` that are ahead of
`origin/master` after `0.1.5`.

It is written from the separate review branch
`arch-review/split-layout-from-origin`. The main worktree is intentionally left
untouched because other peers may still be finishing scoped implementation work.

## Recommendation

Keep the current architecture direction. Do not merge the new product-boundary
modules back into `bin/hcc.mjs`, and do not collapse them into another large
generic helper file.

If the goal is to publish or synchronize soon, keep the current local commit
history and add one or more cleanup commits. Those cleanup commits should focus
on remaining boundary issues and compatibility-shim policy.

If the goal is clean commit history, rebuild the stack in a separate worktree
from `origin/master`. Do not rewrite the active `master` worktree while peers
are coordinating through it.

## What Happened

The first local split commits were mostly flat helper extraction from
`bin/hcc.mjs` into top-level `lib/*.mjs` files. They reduced the entrypoint size
but did not yet express the product architecture:

- provider and tmux helpers
- lock and team planning helpers
- peer identity, peer format, and peer binding helpers
- project registry and project context helpers
- handoff, timeline, runtime state, task liveness, automation, and render helpers
- help text, message store, runtime request, task store, task CLI, and
  coordination-state helpers

Later commits introduced `docs/architecture.md` and started moving primary
implementations into product boundaries:

- `lib/core/coordination`
- `lib/core/peers`
- `lib/core/sessions`
- `lib/db`
- `lib/db/stores`
- `lib/runtime`
- `lib/terminal`
- `lib/web`
- `lib/integrations`
- `lib/release`
- `lib/shared`
- `lib/ui`

That second phase is the correct direction.

## Keep

These boundaries are worth keeping as the primary implementation shape:

- `lib/core/coordination/*` for product coordination semantics.
- `lib/core/peers/*` for pure peer semantics.
- `lib/db/schema.mjs` and `lib/db/stores/*` for SQLite schema and stores.
- `lib/runtime/*` for runtime files, runtime client access, project registry,
  and project context.
- `lib/terminal/tmux.mjs` for tmux adapter behavior.
- `lib/web/*` for Web runtime, HTTP helpers, peer actions, and UI template.
- `lib/integrations/*` for provider, hook, shim, and process integration
  details.
- `lib/release/*` for release metadata and release-note logic.
- `lib/shared/*` only for small dependency-light utilities.
- `lib/ui/*` for text/help/state rendering.

## Cleanup Candidates

The remaining cleanup should be deliberate, not another broad helper extraction.

### Top-Level Compatibility Shims

Many top-level `lib/*.mjs` files are now compatibility re-export shims. Examples
include `lib/tmux.mjs`, `lib/provider-commands.mjs`, `lib/web-runtime.mjs`,
`lib/web-http.mjs`, `lib/web-ui-template.mjs`, `lib/task-store.mjs`,
`lib/messages.mjs`, `lib/locks.mjs`, `lib/db-schema.mjs`, and
`lib/session-launch.mjs`.

Before publish:

- If deep `lib/` imports are not treated as public API yet, remove or reduce
  unnecessary shims in a cleanup commit.
- If deep `lib/` imports may already be used externally, keep the shims for at
  least one release cycle and document them as compatibility surface.

### CLI Boundary

`bin/hcc.mjs` is smaller but still mixes command dispatch, command handlers, Web
startup, session lifecycle, and terminal/Web orchestration. Future work should
move by command or subsystem boundary, not by helper name.

Good next boundaries:

- `lib/cli/args.mjs`
- `lib/cli/context.mjs`
- `lib/cli/dispatch.mjs`
- `lib/cli/commands/*`

### Regression Runner

`scripts/regression.mjs` has grown too large. It should become a runner over
domain-specific files:

- `scripts/regression/cli.mjs`
- `scripts/regression/db.mjs`
- `scripts/regression/runtime.mjs`
- `scripts/regression/web.mjs`
- `scripts/regression/integrations.mjs`
- `scripts/regression/release.mjs`

This should be done after the current layout work is stable, because regression
coverage is the safety net for the refactor.

### Setup, Discover, Guidance, and Shims

`lib/setup.mjs`, `lib/discover.mjs`, `lib/guidance.mjs`, and
`lib/shim-script.mjs` still carry mixed responsibilities. Continue splitting
these by product boundary:

- hooks under `lib/integrations/hooks*`
- shims under `lib/integrations/shims*`
- shell and terminal adapters under `lib/terminal`
- runtime/project concerns under `lib/runtime`
- guidance text generation under `lib/ui` or a dedicated guidance boundary

### Handoff Boundary

`lib/handoff.mjs` is still a top-level helper. Decide whether it belongs in
`lib/core/coordination/handoff.mjs` as product semantics or under
`lib/cli/commands/handoff.mjs` if it is mostly CLI formatting and file listing.

## Branch Strategy

Use one of two paths.

Path A: publish-oriented cleanup

1. Keep current `master` history.
2. Add focused cleanup commits.
3. Run full regression, release checks, GitHub release dry-run, and pack dry-run.
4. Publish/synchronize only after the cleanup decision is complete.

Path B: clean-history rebuild

1. Keep `master` untouched.
2. Use a separate worktree from `origin/master`.
3. Rebuild the split as fewer architectural commits:
   - architecture docs
   - core coordination and peer semantics
   - db schema/stores
   - runtime/project/session helpers
   - terminal adapters
   - web runtime and UI
   - integrations providers/hooks/shims
   - release/shared/ui helpers
   - regression restructuring
4. Run full regression and release checks before replacing the active stack.

## Current Decision

The safer default is Path A: keep current history and add cleanup commits.

Choose Path B only if the project explicitly values a clean local commit stack
more than the time and risk of rebuilding and revalidating the entire series.

## Coordination Notes

Continue finishing any already-started layout lanes that are clearly correcting
the architecture boundary. For example, moving setup hooks and shim
implementation into `lib/integrations` is still part of the same boundary
cleanup, not a new random helper extraction.

After those active lanes finish, pause new implementation splits and make a
cleanup decision:

1. Decide whether this review document should be copied into `master` as a
   durable design record.
2. Decide whether top-level compatibility shims are public for this release.
3. If shims are kept, document that they are compatibility paths.
4. If shims are removed, do it before publish and run full pack/release checks.
5. Do not start broad `bin/hcc.mjs` command extraction or regression runner
   splitting until the shim policy is settled.
