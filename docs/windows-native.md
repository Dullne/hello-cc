# Native Windows support

Version 1.2.1 implements native Windows operation without WSL, Git Bash, or tmux. The tested desktop environment is Windows 11 x64 with Node.js 24 and local NTFS. Windows 10 and real-provider account workflows require separate acceptance evidence. Hosted CI and desktop Windows are recorded independently.

The [current follow-up record](windows-followups-validation.md) and [1.2.0 validation record](windows-native-validation.md) give the tested Windows build, exact test counts, focused reruns and remaining acceptance work.

## Requirements and validation scope

| Environment | Status |
| --- | --- |
| Windows 11 x64, local NTFS, Node.js 24 | Local development and targeted acceptance environment. Native filesystem, process ownership, private state, SQLite, launcher, hook, and terminal checks exercise real Windows objects. |
| Ordinary signed-in user terminal | Accepted local launch context. Newly created private files must belong to that user. Elevated administrator terminals require separate qualification. |
| Windows 10 22H2 x64 | Intended target. Requires its own acceptance run before a support claim; Windows 11 or Windows Server results do not substitute. |
| GitHub Actions `windows-latest` | Native build and focused Windows acceptance job. This is a hosted Windows Server environment, not evidence for every desktop Windows version. |
| ARM64, UNC/network shares, non-NTFS filesystems | Outside the initial support boundary; commands must explain the unsupported condition. |
| Linux and macOS | Existing POSIX backends and regression jobs remain in place. |

Node.js 24 or later is required. The implementation uses the built-in SQLite module and a source-validated Windows native component. Node.js 22 is not part of this support target. A missing or mismatched native component is an error; changing a platform check does not enable safe operation.

Run HCC from an ordinary PowerShell or cmd window opened as your signed-in user. An elevated administrator token can assign new files to the Administrators group by default, including files and SQLite sidecars inside an otherwise private directory. HCC requires the current user to own private state and rejects that mismatch. Open an ordinary terminal and run `hcc doctor --environment` before retrying. Existing files with a different owner still require explicit review and repair; changing terminals does not repair them, and HCC does not silently change their ownership.

## Running 1.2.1

Use the 1.2.1 package, which contains `native/bin/win32-x64/hcc-windows.node`, its manifest, `hcc-shim.exe`, and the launcher manifest. The npm package also carries the native sources needed to verify those manifests. Do not copy just the binary into another checkout.

```powershell
hcc doctor --environment
hcc --root 'C:\Projects\My project' init
hcc --root 'C:\Projects\My project' status
hcc --root 'C:\Projects\My project' web --local
```

Initialization writes project guidance and private state under the current profile. State binding uses Windows volume, file ID, and creation-time identities. It does not manufacture POSIX user IDs or permission modes. Paths containing spaces and Unicode are supported within the filesystem requirements above.

Automatic self-signed HTTPS (`web --tls`) uses OpenSSL from PATH and private Windows certificate storage. The key remains in private storage and the certificate is reused across restarts. Parallel starts and renewals serialize publication. Browsers still require a one-time trust decision for a self-signed certificate. `web --local` offers loopback HTTP; a configured TLS reverse proxy can use `--trust-proxy` / `--proxy-origin`.

Private state requires current-user ownership, restricted access, and trustworthy directory ancestry. Ancestor directories may allow harmless traversal/read access to other principals; private-state entries have stricter access requirements. Dangerous mutation rights, junctions, unexpected hardlinks, or changed directory identities are refused. A shared temporary directory may therefore be unsuitable even when an ordinary read/write test succeeds. Do not weaken its ACL policy to make a test pass; use an owned private profile directory.

Windows supports explicit offline import with `hcc --root "C:\Projects\My project" migrate-state --offline --yes`. Stop all writers and back up the original `.hello-cc` directory first. The source and files must have private current-user ACLs; HCC does not silently repair permissions. Migration preserves source bytes, snapshots SQLite databases, rejects active or uncertain owners, and records destination progress for safe retry. An interrupted migration cannot become an empty fresh project. DSH artifacts are retained for explicit re-setup. A crash before the progress receipt or during final publication requires manual recovery: preserve the incomplete private destination and legacy source; never delete or fabricate a binding marker. Copy-phase interruptions with a matching receipt can retry automatically.

## Terminals and providers

The Windows terminal host owns the ConPTY and the provider process Job independently of the Web process. The Web interface presents **Terminal CLI**, with input, resize, and termination controls enabled by the capabilities returned for that terminal. Closing a browser connection or restarting Web retains the terminal; reconnecting attaches to the retained session. **Terminate terminal** explicitly stops the owned terminal and its child processes. Host failure has a different outcome: its owned Job cleans up the processes it created.

The default shell uses PowerShell 7 when available and the system Windows PowerShell otherwise. Arbitrary existing Windows Terminal windows and other people's processes are not adopted. Provider commands use an executable plus an argument array. Known npm launchers resolve to their actual JavaScript or executable entry. Unrecognized batch wrappers fail with a diagnostic instead of being passed to a shell with interpolated arguments.

Windows process launch has a separate working-directory limit: the path passed to the Windows process API must be at most **258 UTF-16 code units**, including any trailing separator. HCC reports `WINDOWS_PROCESS_CWD_TOO_LONG` before starting a provider, terminal, or service and releases its directory pins. Choose a shorter project location when this occurs. HCC does not substitute an 8.3 alias for the selected directory. Longer private database, migration-backup, and executable filenames are supported independently; they do not extend the working-directory limit. This follows the documented [Windows process/current-directory restriction](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setcurrentdirectory) and was checked at the 258/259-unit boundary, including non-BMP Unicode and a trailing separator.

The Web **Background Agent** and **Terminal CLI** modes remain distinct. Provider account access, authentication, SDK behavior, and live task execution need provider-specific acceptance. Fake-provider protocol tests establish process and transport behavior, not successful use of a real provider account.

The advanced POSIX shortcut that inserts an `hcc` shell command into an arbitrary terminal is hidden on Windows because the current terminal program may be PowerShell, cmd, or a provider UI. The corresponding direct Web actions and literal terminal input remain available.

## Hooks, launchers, and PATH

Windows hooks invoke an explicit system PowerShell executable and an encoded, generated program. Both the outer command and encoded program use PowerShell syntax: Codex's normal Windows shell selection is PowerShell regardless of whether Codex was launched from PowerShell or cmd. Explicit custom execution-environment shells require separate hook compatibility verification. User/provider arguments do not become shell syntax. Installation and removal recognize both the earlier cmd form and the corrected PowerShell ownership form, preserving unrelated configuration.

Codex separately reviews hook trust. Open `/hooks` in Codex and review the installed HCC commands before approving them; untrusted commands are skipped even when enabled. HCC setup installs configuration, while `hcc doctor --codex` reports that configuration and recorded project invocations. Its version and help probes use the same Windows provider installation selected by HCC and isolated temporary homes. They do not approve hooks or establish model receipt of injected context.

The `claude` and `codex` launchers live in the private `%USERPROFILE%\.hcc-shims` directory. Each native `.exe` forwards the original argument vector and standard streams to its adjacent JavaScript dispatcher. Utility commands such as help, login, and noninteractive execution pass through to the real provider. An interactive invocation in an initialized project routes through the managed HCC CLI. Resolution excludes HCC's own launchers, including indirect paths back into the shim directory.

```powershell
hcc shim install
hcc shim status
hcc shim uninstall
```

Installation records owned-file hashes. An altered or unrelated file is not silently overwritten or removed. An interrupted bundle update can leave a manifest mismatch; preserve any custom content and restore the owned installation before retrying. Persistent PATH installation updates the current user's `HKCU\Environment\Path`, preserves its string/expandable-string type and unrelated entries, and records the previous matching entry for removal. Open a new terminal after changing the persistent PATH. It does not edit a Bash profile or the machine-wide PATH.

## Building and testing

`npm test` selects the native Windows verification flow: the same core, UI/source and shared behavior groups used by Windows CI, then the independent installed-package lifecycle. `npm run test:unit` and `npm run test:regression` run those phases separately. The driver isolates HOME and USERPROFILE, disables automatic shim setup, retains bounded per-file diagnostics, and stops after a failed group. This qualifies the selected Windows contracts; the legacy POSIX fixture collection is not silently treated as a Windows pass. Linux and macOS retain their complete unit and thirteen-stage regression flows.

Development builds require the Visual Studio x64 C++ toolchain, Windows SDK, headers for the Node.js version in use, and the corresponding `win-x64/node.lib`:

```powershell
node scripts/build-windows-native.mjs --headers C:\toolchain\node\include\node --node-lib C:\toolchain\node.lib
node .github/scripts/run-bounded-tests.mjs --log-dir .superpowers/windows-tests test/windows-*.test.mjs
node scripts/windows-installed-acceptance.mjs --output .superpowers/windows-installed-acceptance.json
```

The Windows CI job downloads the exact running Node version's headers/import library, checks their official SHA-256 sums, builds the component and launcher, and runs the Windows tests. Those tests include extracting `npm pack --ignore-scripts` and loading the native API without access to the source checkout. Ignoring lifecycle scripts creates a validation installation; it does not bypass release/publish gates for an actual release.

Hosted CI records its test shell's user and default-owner identities. If they differ, the CI wrapper changes only that shell's default owner to its existing user identity, verifies the result, and then starts the test step. A separate probe checks new private files and SQLite sidecars. The follow-up hosted runs confirmed this normalization and passed the five file-ownership probes. This does not change existing ACLs, token privileges, or machine settings, and does not qualify elevated end-user terminals. The validation record reports each run's remaining test outcomes separately.

The installed acceptance script installs the selected package archive into a disposable prefix containing spaces and Chinese characters. It then invokes the installed public CLI for environment checks, project initialization, background Web, native services, and terminal lifecycle. Its Windows 11 acceptance covers Web restart retaining the terminal process, generation and screen, followed by explicit input and termination. It writes a bounded JSON report without credentials and confirms that its owned processes have exited. Hosted CI and other desktop versions still require their own runs.

Tests that create runtime state must isolate **both** `HOME` and `USERPROFILE`. Runtime/Web test fixtures also set `HCC_SKIP_SHIM_INSTALL=1`: changing the profile directory does not isolate the current user's registry PATH. PATH-specific tests use a disposable `HKCU\Software\hello-cc\tests\<UUID>` key and clean it up. Tests must not alter real provider account settings or the developer's persistent PATH.

Local browser acceptance uses the shipped page/modules in installed Microsoft Edge, with a mocked API/WebSocket contract, at desktop and mobile sizes. It checks Windows terminal selection, input receipts, reload without duplicate creation, explicit termination intent, and absence of browser errors. This complements native runtime tests; it does not replace a browser run against a real provider or prove every desktop Windows environment.

File publication uses checked native handles, flushed temporary files, atomic publication, and a real parent-directory flush. A failure after publication is reported as unconfirmed, with recovery state retained. This is a bounded Windows publication contract, not a claim of physical power-loss proof on every storage device.

## Shell environment and diagnostics

Windows `hcc env` and `hcc join` emit PowerShell assignments by default. Select `--shell cmd` for a batch file, or `--shell posix` for a POSIX shell. cmd cannot faithfully represent every value; unsupported characters are rejected before peer registration. `--json` retains the original values.

`hcc doctor --environment` checks both profile ancestry and existing private state without creating state or importing SQLite. Unsafe ACLs, redirected paths, unexpected hardlinks, or an incomplete bounded scan prevent a ready result. Preserve data and review the named path before repairing permissions. If another application grants a shared account access again, correct that application configuration; do not relax HCC private-state checks.
