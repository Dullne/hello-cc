# Windows Native Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver native Windows CLI, project files, providers and persistent managed terminals with the existing ownership and selected-directory guarantees.

**Architecture:** Keep POSIX backends; add a narrow Windows native filesystem/process component, explicit command resolution, and an independently owned terminal service. Admit Windows behavior only after real platform contracts pass.

**Tech Stack:** Node.js 24, ESM, node:test, Windows SDK/MSVC C++, Node-API, NTFS, Job Objects, ConPTY, existing Web runtime.

**Spec:** `docs/superpowers/specs/2026-11-12-windows-native-support-design.md` (approved in chat).

## Implementation checkpoint — 2026-11-12

The platform backends and product integration for Tasks 1–7 are implemented in the development candidate. The final rebuilt Windows component and independently installed archive passed their checks. The remaining platform acceptance gate is tracked explicitly below; the validation record distinguishes available local evidence from unverified environments.

| Work | Current evidence |
| --- | --- |
| Native filesystem/process, private state, command resolution and persistent terminals | Final Windows 11 x64/NTFS run: 210 passed, zero failures and zero skips, including the rebuilt native corrections. |
| Shared runtime, Web and scoped tools | All 178 shared scenarios have passing evidence: 173 in the initial run and five corrected fixtures in focused reruns; scoped MCP 18/18. |
| Hooks, launchers, diagnosis and installation | Isolated checks and final installed archive acceptance passed, including public task/message/lock operations, Web restart continuity and native service lifecycle. |
| POSIX compatibility | Linux unit suite 2,127 passed / 182 skipped / zero failed; all 13 integration stages passed with `FULL_REGRESSION_OK`. No current macOS runtime result is claimed. |
| CI and support claims | Windows build/selected acceptance jobs are configured, not yet observed on hosted CI. Windows 10 and real-provider account acceptance remain separate. |

The [Windows validation record](../../windows-native-validation.md) is the authoritative account of counts, scope and pending gates. Update it with final source/binary/archive evidence before declaring this plan complete. The new private-state/no-legacy-fallback work does not establish Windows support for the existing POSIX-only offline legacy importer.

## Global Constraints

- First target: Windows 10 22H2 / Windows 11 x64, local NTFS, Node.js 24+; report each tested OS separately.
- No WSL, Git Bash or tmux dependency on the Windows execution path.
- Never weaken directory substitution, ownership, private-state authority, uncertain delivery or uncertain write guarantees to make a test pass.
- Preserve existing Linux/macOS behavior and compatibility.
- No global Node replacement, installation into user provider settings, publishing, pushing or merging in this work.
- Real Windows adversarial tests precede a support claim; provider credentials and user project files are not test fixtures.

## Task 1: Native filesystem/process feasibility and toolchain

**Files:** `native/windows/`, `scripts/build-windows-native.mjs`, `test/windows-native.test.mjs`; disposable experiments under `.superpowers/windows-feasibility/`.

**Interfaces:** Native directory lease retains real Windows handles and exposes a versioned identity plus close; process observation distinguishes live/dead/unknown. Native operations use JS-owned opaque handles, never caller-supplied raw pointers.

- [x] Prepare an isolated Node.js 24 runtime and Node headers/import library; record versions and checksums. Use installed Visual Studio C++ tools.
- [x] Before product integration, write and run real native experiments for directory replacement and attribute-only reparse mutation. Test no-delete handle alone as a known weak baseline, then a retained nondeletable sentinel child preventing leaf emptiness. Verify each relevant reparse tag and pre-existing mutation handles. Disprove any unsafe design before implementing it.
- [x] Add behavioral Node tests for capture/close, identity stability, unknown process access, and startup into the original directory or failure before executing user code. Example invariant:

```js
assert.equal(fs.existsSync(path.join(replacement, 'executed.txt')), false);
assert.ok(childEnteredOriginal || launchRejectedBeforeExecution);
```

- [x] Implement only primitives whose system contract has passed. Run with Node 24 and record concrete Windows results. If the selected-directory contract fails, keep launch unavailable and resolve the counterexample before dependent tasks.
- [x] Review the native boundary, argument sizes, cleanup, and failure paths before continuing.

## Task 2: Windows command resolution and literal arguments

**Files:** `lib/platform/windows-command.mjs`, `test/windows-command.test.mjs`, then owning provider/install call sites.

**Interfaces:** `resolveWindowsCommand(command, { env, cwd })` returns a structured `{ file, args, kind }` descriptor or a typed failure; `windowsEnvironment(env)` provides one case-insensitive PATH key. Provider arguments remain separate from command source.

- [x] Write tests for explicit EXE paths, mixed-case Path/PATH, PATHEXT, missing executables, actual npm launchers, shim recursion, empty arguments, Unicode, spaces, quotes, `%!^&|<>()` and trailing backslashes.
- [x] Run tests to establish missing behavior, then implement resolution without broad shell execution. Unknown wrappers fail explicitly.
- [x] Integrate resolved invocations into JSON-RPC, Codex App Server, npm update and provider builders; keep POSIX results unchanged.
- [x] Run argument echo fixtures and relevant existing provider tests; inspect captured argv, not only command strings.

## Task 3: Private state and CLI

**Files:** `lib/runtime/private-state.mjs`, `project-trust.mjs`, `project-path.mjs`, `private-file.mjs`, `lib/process/selected-cwd-identity.mjs`, Windows platform adapters and tests.

**Interfaces:** Existing public exports remain stable. Windows objects carry versioned identities. Authority selection and generation transitions retain the same state machine.

- [x] Add Windows CLI acceptance using temporary owned homes/projects: init, doctor, task/message/lock operations, simultaneous initialization, Unicode paths.
- [x] Add private-state tests proving restrictive ACL at creation, no legacy fallback after authority, no replacement-root history reuse, interrupted authority publication and purge recovery.
- [x] Implement SID/DACL and native-handle adapters through Task 1 primitives; do not return fake uid/mode evidence.
- [x] Execute real concurrent SQLite WAL/SHM tests and alias/case lock-domain tests. Run existing portable CLI tests.

## Task 4: File operations

**Files:** Windows file adapter, `lib/web/project-files.mjs`, `project-file-write.mjs`, `context-files.mjs`, corresponding tests.

**Interfaces:** Existing JSON file/list/preview/save/upload responses and error codes. Actual opened component names pass private-file filtering.

- [x] Add real Windows read/write tests including junctions, hard links, 8.3 aliases, ADS/device names, Unicode, CRLF/BOM, conflicts, concurrent upload and uncertain publication.
- [x] Implement handle-relative listing/read/publication and current revision checks. Preserve DACL/basic attributes on save; exclusive upload must never overwrite an existing destination.
- [x] Verify errors before publication leave the original unchanged; faults after possible publication remain unconfirmed without automatic retry.
- [x] Run file/context suites, adapting OS fixtures while retaining their security assertions.

## Task 5: Owned provider launch and lifecycle

**Files:** Windows process adapter, `lib/process/identity.mjs`, `pinned-cwd.mjs`, `lib/runtime/native/`, `lib/integrations/native/`, `lib/web/codex-app-server.mjs`.

**Interfaces:** Existing spawn/readiness and protocol contracts with real Windows creation identity, generation checks and owned process-tree termination.

- [x] Test suspended launch, job assignment, startup error, cancellation, EOF, ignored cancellation, inherited output pipes and child/grandchild cleanup.
- [x] Implement the verified directory launcher and Job ownership; publish only confirmed ready processes. Retain unknown and unconfirmed states.
- [x] Test duplicate daemon startup and owner recovery without terminating unrelated processes.
- [x] Verify fake Codex/dsh protocol lifecycles and isolate Claude SDK where required. Real provider acceptance remains separately recorded.

## Task 6: Persistent Windows terminals

**Files:** `lib/terminal/` backend/service modules, Windows native transport, `lib/web/pty-sessions.mjs`, startup/runtime/routes/serialization/shutdown, CLI peer/run, terminal UI.

**Interfaces:** `create/list/attach/detach/input/resize/snapshot/terminate`; stable host/session generation and capability descriptors; existing control lease enforcement.

- [x] Write lifecycle acceptance before connecting UI: starting/ready, silent cancellation, input echo, Unicode, resize, disconnect, detach, attach, Web restart, host crash and explicit tree termination.
- [x] Validate node-pty public API against Job ownership and silent cancellation. If it cannot satisfy the contract, implement ConPTY in the native component behind the same interface.
- [x] Create authenticated per-user host with bounded screen state and ordered output. Closing Web connections must leave owned terminals alive; host death must clean its Jobs.
- [x] Route CLI/Web terminal operations and UI capability selection through the backend. Keep old tmux endpoints compatible on POSIX.
- [x] Verify no PID 0 publication, no PID-only ownership, no duplicate exit or stale-generation mutation, and correct single-controller enforcement.

## Task 7: Hooks, shims, diagnosis and installed package

**Files:** `lib/integrations/shims*`, hooks, CLI install/doctor, build/package verification scripts, README/docs, Windows CI.

**Interfaces:** Thin Windows launchers delegate to shared JS; generated settings are exactly identifiable for uninstall. Doctor has an environment check independent of database initialization.

- [x] Test install/status/uninstall in temporary provider configuration directories, preserving unrelated entries and preventing recursion.
- [x] Implement Windows executable/Node invocation and diagnostics for Node/component/provider/backend failures.
- [x] Add PE architecture/protocol/source checks and package Windows native artifacts. Verify fresh installation in a Chinese-and-space path using only PowerShell/cmd.
- [ ] Complete every platform acceptance gate. Windows 11 capability and installed end-to-end suites and Linux packaging/unit/integration checks passed. macOS and Windows 10 execution, hosted CI, and real-provider account workflows remain unverified.
- [x] Review full branch, fix material findings, and report achieved support and outstanding acceptance separately. Do not publish or merge automatically.

## Execution Record

Progress and decisions are recorded in `.superpowers/sdd/2026-11-12-windows-native-support/progress.md`. Task 1's selected-directory gate controls product integration; independent command parsing work may proceed while it runs.
