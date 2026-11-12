# Windows native validation record

This record describes the native Windows development candidate checked on 2026-11-12. It records completed checks separately from unverified environments. It is not a published-release announcement. Setup instructions are in [Native Windows support](windows-native.md), and the implementation checklist is in the [approved plan](superpowers/plans/2026-11-12-windows-native-support.md).

## Tested environment

| Component | Observed environment |
| --- | --- |
| Windows | Windows 11, build **26220.8370** |
| Architecture and storage | x64; local NTFS project, profile and package paths |
| Node.js | **v24.22.3** |
| Windows execution | Native Windows processes, handles, Job Objects and ConPTY; PowerShell/cmd entrypoints |
| Isolation | Disposable projects and profiles; both `HOME` and `USERPROFILE` set for runtime fixtures; automatic shim installation disabled |
| Providers | Fake executables/protocol adapters or simulated SDK behavior; no real provider login or model request |

PATH installation tests use disposable `HKCU\Software\hello-cc\tests\<UUID>` subkeys. A temporary profile alone does not isolate `HKCU\Environment`; runtime tests set `HCC_SKIP_SHIM_INSTALL=1`. Tests do not use the developer's provider settings or persistent PATH as fixtures.

## Completed results and remaining verification

| Check | Recorded result | Scope and qualification |
| --- | --- | --- |
| Windows-specific tests | **210 passed, zero failures, zero skipped** | Final rebuilt native component, 46 test files, serial run on Windows 11. Includes the completed migration-backup corrections. |
| Shared runtime and Web suites | **178 scenarios covered**: initial run 173 passed / 5 failed / zero skipped; each of the five subsequently passed after fixture corrections | Detailed accounting below. This is combined evidence from the broad run and focused reruns, not a claim that the initial command exited successfully. |
| Shared scoped MCP | **18 passed, zero failures, zero skipped** | Actual stdio tools, ownership checks and capability revocation with isolated state. |
| Linux full unit suite | **2,309 total: 2,127 passed, 182 skipped, zero failures** | Disposable Linux container, Node v24.22.3. Final database/terminal changes were also checked in a focused run: 35 passed, 34 Windows-specific skips, zero failures. This does not establish a macOS result. |
| Linux integration regression | **All 13 stages passed; `FULL_REGRESSION_OK`, exit 0** | Final implementation with the packaged POSIX helpers. Includes bootstrap, runtime/database workflow, tmux/WebSocket control, shim launch, session recovery, coordination, GC, packaging, identity checks, diagnosis and uninstall. No fixture services/providers remained afterward. |
| Installed Windows npm candidate | **Final archive passed independent installation and lifecycle acceptance** | Fresh installation into paths containing Chinese characters and spaces; final run completed in 137 seconds. The archive includes the final rebuilt sources and binaries. |
| Source audit | **89 factory modules passed** | Free-identifier audit at the recorded checkpoint; existing scanner exceptions remain explicit. |
| Browser presentation | **244 passed / one POSIX shell-execution skip** in 245 UI tests; rendered desktop/mobile checks passed | Shipped page/modules in installed Microsoft Edge, with a mocked HTTP/WebSocket contract. This establishes UI behavior, not a real-provider browser session. |

The final native correction retains read protection for a migration snapshot through publication. Review reproduced replacement of the initially created file, pathname changes during SQLite verification, in-place modification after verification, and permission broadening before publication. Native creation receipts, overlapping pathname/content guards, and published-object permission checks close these demonstrated gaps. All 51 targeted migration/filesystem/database tests passed; an independent review reran the five security regressions successfully. The final 210-test Windows run includes the rebuilt component.

## Shared Windows behavior accounting

All three suites use actual HTTP and SQLite ownership with fake providers. Their Windows fixtures create the real private state layout instead of manually creating the legacy project-local `.hello-cc` directory. No whole test or suite was disabled to obtain these results.

| Suite | Broad run | Focused correction evidence |
| --- | --- | --- |
| `test/native-runtime.test.mjs` | 66 passed / 4 failed, 70 total | All four passed together after fixing Windows request deadlines and the process creation-token fixture. |
| `test/web-native-sessions.test.mjs` | **79 passed / zero failed** | No additional correction was needed after the private-state fixture update. |
| `test/web-structured-routes.test.mjs` | 28 passed / 1 failed, 29 total | The terminal-history case passed after wiring the actual Windows session manager to a fake terminal host. |

Three runtime cases deliberately hold a provider admission open while issuing other requests. Their old three-second fixture deadline expired during real Windows identity and private-file checks. Windows fixtures now use the existing production request deadline of 35 seconds; the product deadline and uncertainty behavior were not changed. The fourth case now uses a different valid Windows v1 creation token to simulate PID reuse. An arbitrary incompatible token correctly remains unknown.

The terminal-history fixture previously supplied only a POSIX PTY spawn stub. Its Windows path now executes the real routing and Codex history guard, with a fake host at the process-creation boundary. It verifies rejection before any host creation, refuses a shell-command string, and passes the exact executable/argument descriptor for an authorized resume. The four-case runtime correction run and the terminal-history rerun both had zero failures and zero skips.

The shared tests cover delivery admission and acknowledgments, asynchronous completion, owner loss, restart and interrupted cleanup, directory replacement, read-only provider policy, session forks, history restoration, approval/control behavior and uncertain operations that must not be replayed automatically.

Local working evidence includes `.superpowers/shared-native-fixtures-windows-v2.log`, `.superpowers/shared-native-fixtures-corrections.log` and the installed/Linux checkpoint records under `.superpowers/sdd/2026-11-12-windows-native-support/`. These are local development artifacts, not a promise that the untracked evidence directory is part of an npm archive. CI uploads its own logs and installed acceptance report.

## Installed-package scope

The installed acceptance command packs the candidate, installs it into a disposable prefix and uses only the installed public CLI and installed production modules for the lifecycle checks:

```powershell
node scripts/windows-installed-acceptance.mjs --output .superpowers/windows-installed-acceptance.json
```

The final run checked environment doctor, project initialization and database doctor, public task creation/claim, local message/inbox, resource lock/release, background Web startup, Web stop/restart retaining terminal PID/generation/screen, controlled input, confirmed terminal Job termination, and native service up/status/down. Cleanup confirmed exit of the authenticated fixture services and their owned provider processes. There was no global installation or real provider account workflow.

The tested archive is `.superpowers/deliverables/hello-cc-windows-native-candidate.tgz`, assembled on Linux to retain executable modes for the existing POSIX helpers. Its SHA-256 is `5e54aa154aa34bb8403d17e502c9214d422add856d1e8746b0a00273b639ba85`. Windows installed acceptance used this exact archive through `--package-input`; the final report is `.superpowers/sdd/2026-11-12-windows-native-support/windows-installed-final.json`. All 339 packaged runtime files and `package.json` matched the final local implementation byte for byte. This validation document is updated after execution; the archive's embedded documentation records its earlier assembly checkpoint.

All four POSIX helper source hashes, architectures and executable modes passed the package gate. The Windows addon and launcher passed source/binary hash, protocol and PE architecture checks. These static checks do not establish a macOS runtime acceptance result. The package retains version `1.1.6` as a local development candidate; these changes have not been published to npm.

## CI selection and reproduction

The Windows job in [`.github/workflows/test.yml`](../.github/workflows/test.yml) builds the component and launcher using the running Node version's headers and import library, verifies the downloaded SHA-256 sums, and runs:

1. `test/windows-*.test.mjs`, including extracted-package checks.
2. The selected shared UI suites and source audit.
3. The explicitly listed shared behavior suites below.
4. The independently installed npm candidate acceptance script.

```powershell
node --test --test-concurrency=3 test/native-runtime.test.mjs test/web-native-sessions.test.mjs test/web-structured-routes.test.mjs test/scoped-mcp.test.mjs test/native-fixture-root.test.mjs test/codex-terminal-history-boundary.test.mjs test/web-browser-lifecycle.test.mjs test/web-files-platform.test.mjs
```

The job allows 60 minutes overall and 40 minutes for this shared stage because it performs real private-directory and identity checks. It uploads the Windows/native log, shared behavior log, native manifests and installed acceptance JSON. Workflow syntax and its PowerShell blocks have been checked locally; no hosted Windows CI run is claimed here.

The complete legacy Windows `node --test test/*.test.mjs` collection has **not** been fully ported or reported green. Some older fixtures assume POSIX shell commands, permissions or project-local state. Windows CI deliberately selects the suites above rather than hiding unsupported fixtures behind blanket skips or treating a partial run as the complete legacy suite.

## Unverified environments and workflows

- Windows 10 22H2 remains a target, with no acceptance result recorded here.
- macOS has no current runtime acceptance result for this branch. Linux unit results and static package checks do not substitute.
- Hosted `windows-latest` CI has not yet provided a result. A Windows Server runner also would not establish every desktop Windows version.
- Real Claude, Codex and DeepSeek Harness account/model workflows remain separate acceptance work.
- Windows HTTPS has not been accepted. Candidate examples use loopback HTTP with `web --local`.
- Importing legacy project-local `.hello-cc` data is not implemented on Windows. The offline `migrate-state` command still requires POSIX. Preserve the original store and use a separately reviewed migration procedure; this record does not recommend deleting legacy data or claim that Windows `migrate-state` succeeds.
- ARM64, UNC/network shares and non-NTFS filesystems remain outside the initial implementation boundary.

These are verification limits of the candidate, not a revision of the approved product target.
