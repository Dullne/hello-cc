# Layout Split Stack Audit

Date: 2026-06-14

Audit branch: `audit/layout-split-stack-20260614`

Reviewed range: `origin/master..HEAD`

- Base: `4969100` (`origin/master`, published as `@logicseek/hello-cc@0.1.5`)
- Audited head: `4283234`
- Commit count: 40

This document audits the local architecture split stack before any push or npm
publish. It is intentionally on a dedicated audit branch/worktree so the active
`master` implementation stack is not rewritten during review.

## Review Standard

Each commit is classified against `docs/architecture.md`:

- `keep`: the commit directly moves code toward a documented product boundary.
- `keep-with-cleanup`: the direction is right, but package surface, shim policy,
  or module placement still needs a cleanup decision before release.
- `squash/rebuild`: the code is useful, but the commit exists mostly as an
  intermediate flat extraction and should be folded into a product-boundary
  commit if a clean release branch is rebuilt.
- `decision-needed`: the final location or public surface is not settled.
- `docs-only`: documentation or process record.

The important distinction is code shape versus history shape. A commit can be
useful for reaching the current code state while still being a poor standalone
release-history commit.

## Team Review Split

Parent task: `#232`

- `#234 lead-audit`: maintain this matrix and merge review feedback.
- `#236 review-core-db`: core, coordination, db, peers, session semantics.
- `#235 review-runtime-web`: runtime, web, terminal, integrations, release,
  shared helper placement.
- `#237 review-package-surface`: top-level `lib/*.mjs` compatibility shims,
  npm package surface, and release-note risk.

## Summary

The current `HEAD` is not a random bad refactor. The final code shape has mostly
been corrected toward the target architecture:

- coordination logic under `lib/core/coordination`
- peer/session semantics under `lib/core/peers` and `lib/core/sessions`
- schema and stores under `lib/db`
- runtime state/client/project helpers under `lib/runtime`
- tmux under `lib/terminal`
- Web runtime helpers under `lib/web`
- provider/hooks/shims under `lib/integrations`
- small utilities under `lib/shared`
- text rendering/help under `lib/ui`
- release helpers under `lib/release`

The problem is the history shape. The first 25 local commits were mostly
"extract a helper from `bin/hcc.mjs` into a top-level `lib/*.mjs` file". That
was useful as a safety step, but it does not match the architecture design by
itself. Later commits then moved many of those flat files into real product
boundaries.

Therefore:

1. If the project keeps the current `master` history, do not keep making broad
   split commits. Finish only package-surface cleanup, run full validation, bump
   the version, and publish/sync with a clear changelog.
2. If the project wants clean history for this major refactor, create a rebuild
   branch from `origin/master` and replay the final shape as fewer architectural
   commits. Do not rewrite the active `master` while peers use it.

## Phase Classification

### Phase 1: Early Flat Extractions

These commits reduced `bin/hcc.mjs`, but mostly created top-level helper modules
before the design document existed. They should be treated as
`squash/rebuild` if a clean branch is made.

| Commit | Area | Classification | Reason |
| --- | --- | --- | --- |
| `1bb1967` | providers + tmux | `squash/rebuild` | Mixed two product boundaries in one top-level extraction; should become integrations/provider and terminal/tmux commits. |
| `e155d5a` | locks | `squash/rebuild` | Useful code, but final home is `lib/core/coordination/locks.mjs`, not top-level `lib/locks.mjs`. |
| `9ab464d` | team planning | `squash/rebuild` | Same pattern; final home is `lib/core/coordination/teams.mjs`. |
| `807fa96` | peer identity | `squash/rebuild` | Useful extraction, but identity is split between integration discovery and core peer semantics later. |
| `494d38f` | peer format | `squash/rebuild` | Good low-level helper, but should land with peer-boundary cleanup rather than a standalone flat helper commit. |
| `e2b745d` | project registry | `squash/rebuild` | Final boundary is runtime/project registry. |
| `e4c4497` | project context | `squash/rebuild` | Final boundary is runtime/project context. |
| `dec3e2e` | handoff | `decision-needed` | `lib/handoff.mjs` remains top-level; decide core coordination semantics versus CLI command helper. |
| `61b02a2` | timeline | `squash/rebuild` | Final boundary is core coordination timeline. |
| `62ede11` | runtime state | `squash/rebuild` | Final boundary is `lib/runtime/state.mjs`. |
| `7d885f1` | task liveness | `squash/rebuild` | Final boundary is core peer liveness. |
| `3f0cc7e` | session launch | `decision-needed` | Current compatibility file bridges core session launch and terminal/tmux helpers; keep an eye on dependency direction. |
| `b07e9b5` | automation | `squash/rebuild` | Final boundary is core coordination automation. |
| `428bbf3` | state render | `squash/rebuild` | Final boundary is UI state rendering. |
| `8a6120f` | tmux pane | `squash/rebuild` | Should be folded into terminal/tmux movement. |
| `3ec062b` | help text | `squash/rebuild` | Final boundary is UI help. |
| `7e8068c` | uninstall help | `squash/rebuild` | Should be folded into UI help extraction. |
| `9ed79b6` | message store | `squash/rebuild` | Final boundary is core coordination messages. |
| `07ddcc9` | runtime client | `squash/rebuild` | Final boundary is `lib/runtime/client.mjs`. |
| `c06e55d` | web runtime server helpers | `squash/rebuild` | Useful step, but final boundary is `lib/web/runtime.mjs`; route/session/server split still pending. |
| `fe36930` | task store | `squash/rebuild` | Final boundary is core coordination tasks. |
| `3bd0782` | task CLI parsing | `keep-with-cleanup` | This is a CLI-specific helper and can remain near CLI until `lib/cli/*` exists. |
| `61538fc` | peer bindings | `squash/rebuild` | Final split crosses core peer bindings and db peer store. |
| `787857f` | CLI runtime | `keep-with-cleanup` | Still not the final `lib/cli/context.mjs` layout, but it is a valid CLI/runtime entrypoint reduction. |
| `00ac7ba` | coordination state | `squash/rebuild` | Useful factory boundary, but should be evaluated with core coordination dependencies. |

### Phase 2: Architecture Documentation And First Boundary Correction

| Commit | Area | Classification | Reason |
| --- | --- | --- | --- |
| `94d63c0` | architecture docs | `docs-only` | Correctly establishes the target layout. |
| `76d5181` | web peer actions | `squash/rebuild` | Good product boundary direction, but final import path is corrected later under `lib/web/peer-actions.mjs`. |
| `265284a` | broad architecture alignment | `keep-with-cleanup` | Correct direction, but too broad for ideal history; should become several product-boundary commits on a rebuild branch. Also review whether SQL/transaction-heavy task code belongs in `lib/core/coordination/tasks.mjs` or should split pure task policy from a db store. |

### Phase 3: Product-Boundary Cleanup Commits

These commits are much closer to the target design. They are the model for the
rebuild branch if one is created.

| Commit | Area | Classification | Reason |
| --- | --- | --- | --- |
| `294eb2e` | peer layout boundaries | `keep` | Moves peer semantics toward `core/peers`, `db/stores`, and integrations boundaries. |
| `a3eabd8` | tmux adapter | `keep` | Clear terminal adapter boundary. |
| `fb9c35a` | shared JSON file helpers | `keep-with-cleanup` | Shared utility is appropriate; keep `lib/json-file.mjs` compat because it was already published in `0.1.5`. |
| `77c098d` | provider commands | `keep` | Correct integrations boundary. |
| `6bbe4a0` | project context | `keep` | Correct runtime boundary. |
| `be7c882` | session launch helpers | `decision-needed` | Direction is mostly correct, but compat surface exports both core session and terminal/tmux helpers. Review dependency direction before release. |
| `ffc42a7` | setup hook installers | `keep` | Correct integrations/hooks boundary. |
| `1bd110f` | setup shims | `keep` | Correct integrations/shims boundary. |
| `c191c72` | shim script generator | `keep` | Correct integrations/shims/script boundary. |
| `11fd4f6` | CLI errors | `keep` | Correct small shared utility boundary with compatibility re-export. |

### Phase 4: Review And Policy Docs

| Commit | Area | Classification | Reason |
| --- | --- | --- | --- |
| `19c0856` | split review | `docs-only` | Captures the historical concern and branch strategy. |
| `4283234` | package surface policy | `docs-only` | Captures npm `0.1.5` fact, version-bump requirement, and A/B/C shim policy. |

## Initial Recommendations

### Use A New Branch

Yes. This is a major refactor stack and should not be pushed or published
directly just because `master` is currently green. Use this audit branch for
review. If the team chooses clean history, create a separate rebuild branch from
`origin/master`, not from current `master`.

Suggested rebuild branch:

```bash
git worktree add ../hello-cc-layout-rebuild -b rebuild/layout-split-20260614 origin/master
```

Suggested rebuilt commit order:

1. Architecture docs.
2. Core coordination modules: locks, teams, messages, tasks, timeline,
   automation, liveness-related coordination state.
3. Core peer/session modules and db peer store.
4. Runtime modules: paths, state, client, project registry, project context.
5. Terminal adapter: tmux.
6. Web modules: runtime, HTTP, peer actions, UI template.
7. Integrations: providers, hooks, shims, shim script, peer identity.
8. Shared/release/ui helpers.
9. Compatibility shim policy and package-surface release notes.

### Do Not Revert The Final Shape Blindly

The final code shape is mostly aligned with the architecture document. The
problem is the noisy path taken to get there. A rebuild should preserve the
validated final behavior while changing the history granularity.

### Core/DB Review Findings

The core/db review from `#236` and the parallel read-only subagent agree on the
main shape:

- Keep the final direction of `lib/core/coordination/*`, `lib/core/peers/*`,
  `lib/core/sessions/launch.mjs`, `lib/db/schema.mjs`,
  `lib/db/stores/peers.mjs`, and `lib/shared/errors.mjs`.
- Rebuild the early top-level coordination/peer/session helper commits into
  product-boundary commits if clean history is chosen.
- Do not treat `lib/handoff.mjs`, `lib/session-launch.mjs`, or
  `lib/coordination-state.mjs` as settled final architecture.

Concrete cleanup items from that review:

- `lib/core/coordination/tasks.mjs` is currently SQL/transaction-heavy. Split
  pure task lifecycle/takeover/team policy from DB store operations, or move the
  store-style SQL operations under `lib/db/stores/tasks.mjs`.
- `lib/core/coordination/automation.mjs` and
  `lib/core/coordination/timeline.mjs` depend on top-level `lib/format.mjs` for
  `shellQuoteArg` / `compactText`. Move dependency-light text helpers to
  `lib/shared/text.mjs` or keep rendering concerns in the UI/CLI layer.
- `lib/handoff.mjs` mixes CLI input normalization with runtime Git changed-file
  discovery. Split handoff product semantics from CLI/runtime file inspection.
- `lib/session-launch.mjs` re-exports both core session helpers and
  terminal/tmux helpers. That is acceptable only as a compatibility entrypoint;
  do not let it become the conceptual module boundary.
- `lib/coordination-state.mjs` is useful as an interim assembler, but it mixes
  DB queries, timeline, automation, hook context, status summary, and message
  ack batching. Later split it into core state services plus CLI/Web adapters.

### Runtime/Web/Integrations Review Findings

The runtime/web/terminal/integrations review from `#235` and the parallel
read-only subagent agree on the main shape:

- Keep the final direction of `lib/terminal/tmux.mjs`.
- Keep the final direction of `lib/integrations/providers.mjs`,
  `lib/integrations/hooks.mjs`, `lib/integrations/shims.mjs`, and
  `lib/integrations/shims/script.mjs`.
- Keep the final direction of `lib/release/*`, `lib/shared/errors.mjs`, and
  `lib/shared/json-file.mjs`.
- Keep the runtime and Web movement as directionally correct:
  `lib/runtime/{paths,state,client,projects,project-context}.mjs` and
  `lib/web/{http,runtime,ui-template,peer-actions}.mjs`.

Concrete cleanup items from that review:

- `lib/runtime/client.mjs` and `lib/runtime/state.mjs` import `runtimeApiUrl`
  from `lib/web/runtime.mjs`. That creates a runtime -> web reverse dependency.
  Move the URL helper into `lib/runtime`, `lib/shared`, or inject it from the
  caller before claiming strict dependency direction.
- `lib/web/runtime.mjs` and `lib/web/peer-actions.mjs` import CLI parsing
  helpers from `lib/cli-args.mjs`. Move shared option parsing such as
  `intOpt`/`required` to a dependency-light shared helper, or inject parsing at
  the route boundary.
- `lib/web/peer-actions.mjs` imports `normalizeStateResources` from
  `lib/ui/state-render.mjs`. Move non-render normalization out of the UI layer,
  or keep the dependency at a CLI/Web adapter edge.
- `cmdWeb()` in `bin/hcc.mjs` still owns server lifecycle, session manager,
  WebSocket terminal transport, tmux/PTY orchestration, external-buffer
  adoption, and shutdown cleanup. Future work should split this by subsystem;
  do not continue random helper extraction from it.

No immediate runtime blocker was found. `#235` also reran `npm test` and got
`FULL_REGRESSION_OK`.

### Decide Shim Policy Before Release

Because `@logicseek/hello-cc@0.1.5` is already published from `4969100`, the
next package version must be new. Before that publish:

- Group A: already-published or CLI-facing top-level `lib/*.mjs` paths stay.
- Group B: migration compatibility paths stay one release if needed and are
  documented as compatibility-only deep-import paths.
- Group C: unpublished top-level shims with no internal use or compatibility
  value should be removed before release.

Initial package-surface inventory:

| Group | Paths | Current decision |
| --- | --- | --- |
| A: published in `0.1.5` | `lib/cli-args.mjs`, `lib/db-schema.mjs`, `lib/discover.mjs`, `lib/errors.mjs`, `lib/format.mjs`, `lib/guidance.mjs`, `lib/json-file.mjs`, `lib/package-meta.mjs`, `lib/release-notes.mjs`, `lib/runtime-paths.mjs`, `lib/setup.mjs`, `lib/shell-path.mjs`, `lib/shim-script.mjs`, `lib/web-http.mjs`, `lib/web-runtime.mjs`, `lib/web-ui-template.mjs` | Keep for the next release, even if some are now compatibility re-exports. Removing them would be a package-surface break. |
| A: current internal top-level runtime refs | `lib/cli-runtime.mjs`, `lib/coordination-state.mjs`, `lib/handoff.mjs`, `lib/project-context.mjs`, `lib/task-cli.mjs`, `lib/tmux.mjs` | Keep until a focused cleanup moves current internal imports to the target directories. Do not delete these as pure compatibility shims today. |
| B/C candidates: new re-export-only paths with no current runtime ref | `lib/automation.mjs`, `lib/help.mjs`, `lib/locks.mjs`, `lib/messages.mjs`, `lib/peer-bindings.mjs`, `lib/peer-format.mjs`, `lib/peer-identity.mjs`, `lib/project-registry.mjs`, `lib/provider-commands.mjs`, `lib/runtime-client.mjs`, `lib/runtime-state.mjs`, `lib/session-launch.mjs`, `lib/state-render.mjs`, `lib/task-liveness.mjs`, `lib/task-store.mjs`, `lib/team-planning.mjs`, `lib/timeline.mjs`, `lib/web-peer-actions.mjs` | Treat as C only if the project decides they have no migration compatibility value. Otherwise keep for one release as B and document them as compatibility-only deep imports. |
| C: remove before publish | None confirmed yet | Do not delete by guess. A candidate becomes C only after checking it was not in `0.1.5`, is not imported internally, and has no release compatibility value. |

### Watch Items

- `lib/handoff.mjs`: decide core coordination versus CLI command helper.
- `lib/session-launch.mjs`: review mixed core session and terminal/tmux
  compatibility exports.
- `lib/core/coordination/tasks.mjs`: split pure task policy from DB store style
  SQL/transactions.
- `lib/core/coordination/{automation,timeline}.mjs`: remove dependency on
  top-level `lib/format.mjs`.
- `lib/coordination-state.mjs`: keep as interim assembler, but split before
  claiming final architecture.
- `lib/runtime/{client,state}.mjs`: remove reverse dependency on
  `lib/web/runtime.mjs`.
- `lib/web/{runtime,peer-actions}.mjs`: remove direct dependency on CLI parsing
  helpers.
- `lib/web/peer-actions.mjs`: remove direct dependency on UI state-render
  helpers for non-render normalization.
- `scripts/regression.mjs`: current test coverage is valuable, but its size
  should be split after the architecture stack is stable.
- `bin/hcc.mjs`: still contains large command and Web orchestration areas; do
  not continue extracting from it until this audit decides branch strategy.

## Current Status

Peer feedback from `#235`, `#236`, and `#237` has been merged into this audit.
The audit conclusion is:

- The final code shape is mostly reasonable.
- The early commit history is not clean architecture history.
- Use a new rebuild branch from `origin/master` if clean history matters.
- Keep the current `master` stack only if the project accepts noisy local
  history and completes the release cleanup items above before publish.
- Do not resume release task `#233` until this audit decision is accepted.
