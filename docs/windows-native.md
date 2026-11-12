# Native Windows support

This branch implements native Windows operation without WSL, Git Bash, or tmux. It is still a release candidate: local checks, hosted CI, installed-package acceptance, and real-provider account workflows are separate gates. Passing one does not establish the others.

The [validation record](windows-native-validation.md) gives the tested Windows build, exact test counts, focused reruns and remaining acceptance work.

## Requirements and validation scope

| Environment | Status |
| --- | --- |
| Windows 11 x64, local NTFS, Node.js 24 | Local development and targeted acceptance environment. Native filesystem, process ownership, private state, SQLite, launcher, hook, and terminal checks exercise real Windows objects. |
| Windows 10 22H2 x64 | Intended target. Requires its own acceptance run before a support claim; Windows 11 or Windows Server results do not substitute. |
| GitHub Actions `windows-latest` | Native build and focused Windows acceptance job. This is a hosted Windows Server environment, not evidence for every desktop Windows version. |
| ARM64, UNC/network shares, non-NTFS filesystems | Outside the initial support boundary; commands must explain the unsupported condition. |
| Linux and macOS | Existing POSIX backends and regression jobs remain in place. |

Node.js 24 or later is required. The implementation uses the built-in SQLite module and a source-validated Windows native component. Node.js 22 is not part of this support target. A missing or mismatched native component is an error; changing a platform check does not enable safe operation.

## Running a candidate

Use a candidate that contains `native/bin/win32-x64/hcc-windows.node`, its manifest, `hcc-shim.exe`, and the launcher manifest. The npm package also carries the native sources needed to verify those manifests. Do not copy just the binary into another checkout.

```powershell
hcc doctor --environment
hcc --root 'C:\Projects\My project' init
hcc --root 'C:\Projects\My project' status
hcc --root 'C:\Projects\My project' web --local
```

Initialization writes project guidance and private state under the current profile. State binding uses Windows volume, file ID, and creation-time identities. It does not manufacture POSIX user IDs or permission modes. Paths containing spaces and Unicode are supported within the filesystem requirements above.

Automatic self-signed HTTPS (`web --tls`) is outside this candidate's implemented Windows capabilities and returns `WINDOWS_TLS_UNAVAILABLE` before background startup. Use loopback access with `web --local`. An independently configured TLS reverse proxy uses the existing `--trust-proxy` / `--proxy-origin` options; no Windows HTTPS acceptance is claimed here.

Private state requires a private owner and trustworthy directory ancestry. Other principals may have harmless traversal/read access, but dangerous mutation rights, junctions, unexpected hardlinks, or changed directory identities are refused. A shared temporary directory may therefore be unsuitable even when an ordinary read/write test succeeds. Do not weaken its ACL policy to make a test pass; use an owned private profile directory.

This candidate creates new Windows private state; it does not import an existing project-local `.hello-cc` store. The offline `migrate-state` implementation currently requires POSIX and is not a supported Windows import procedure. If legacy state is detected, preserve the original directory and databases. Existing data needs a separately reviewed migration procedure before Windows use; deleting the old store is not a migration. The candidate refuses automatic fallback to legacy state.

## Terminals and providers

The Windows terminal host owns the ConPTY and the provider process Job independently of the Web process. The Web interface presents **Terminal CLI**, with input, resize, and termination controls enabled by the capabilities returned for that terminal. Closing a browser connection or restarting Web retains the terminal; reconnecting attaches to the retained session. **Terminate terminal** explicitly stops the owned terminal and its child processes. Host failure has a different outcome: its owned Job cleans up the processes it created.

The default shell uses PowerShell 7 when available and the system Windows PowerShell otherwise. Arbitrary existing Windows Terminal windows and other people's processes are not adopted. Provider commands use an executable plus an argument array. Known npm launchers resolve to their actual JavaScript or executable entry. Unrecognized batch wrappers fail with a diagnostic instead of being passed to a shell with interpolated arguments.

The Web **Background Agent** and **Terminal CLI** modes remain distinct. Provider account access, authentication, SDK behavior, and live task execution need provider-specific acceptance. Fake-provider protocol tests establish process and transport behavior, not successful use of a real provider account.

The advanced POSIX shortcut that inserts an `hcc` shell command into an arbitrary terminal is hidden on Windows because the current terminal program may be PowerShell, cmd, or a provider UI. The corresponding direct Web actions and literal terminal input remain available.

## Hooks, launchers, and PATH

Windows hooks invoke an explicit system PowerShell executable and an encoded, generated program. User/provider arguments do not become shell syntax. Installation and removal recognize the generated ownership form and preserve unrelated configuration.

The `claude` and `codex` launchers live in the private `%USERPROFILE%\.hcc-shims` directory. Each native `.exe` forwards the original argument vector and standard streams to its adjacent JavaScript dispatcher. Utility commands such as help, login, and noninteractive execution pass through to the real provider. An interactive invocation in an initialized project routes through the managed HCC CLI. Resolution excludes HCC's own launchers, including indirect paths back into the shim directory.

```powershell
hcc shim install
hcc shim status
hcc shim uninstall
```

Installation records owned-file hashes. An altered or unrelated file is not silently overwritten or removed. An interrupted bundle update can leave a manifest mismatch; preserve any custom content and restore the owned installation before retrying. Persistent PATH installation updates the current user's `HKCU\Environment\Path`, preserves its string/expandable-string type and unrelated entries, and records the previous matching entry for removal. Open a new terminal after changing the persistent PATH. It does not edit a Bash profile or the machine-wide PATH.

## Building and testing

Development builds require the Visual Studio x64 C++ toolchain, Windows SDK, headers for the Node.js version in use, and the corresponding `win-x64/node.lib`:

```powershell
node scripts/build-windows-native.mjs --headers C:\toolchain\node\include\node --node-lib C:\toolchain\node.lib
node --test --test-concurrency=1 test/windows-*.test.mjs
node scripts/windows-installed-acceptance.mjs --output .superpowers/windows-installed-acceptance.json
```

The Windows CI job downloads the exact running Node version's headers/import library, checks their official SHA-256 sums, builds the component and launcher, and runs the Windows tests. Those tests include extracting `npm pack --ignore-scripts` and loading the native API without access to the source checkout. Ignoring lifecycle scripts creates a candidate for validation; it does not bypass release/publish gates for an actual release.

The installed acceptance script packs the candidate and installs it into a disposable prefix containing spaces and Chinese characters. It then invokes the installed public CLI for environment checks, project initialization, background Web, native services, and terminal lifecycle. Its Windows 11 acceptance covers Web restart retaining the terminal process, generation and screen, followed by explicit input and termination. It writes a bounded JSON report without credentials and confirms that its owned processes have exited. Hosted CI and other desktop versions still require their own runs.

Tests that create runtime state must isolate **both** `HOME` and `USERPROFILE`. Runtime/Web test fixtures also set `HCC_SKIP_SHIM_INSTALL=1`: changing the profile directory does not isolate the current user's registry PATH. PATH-specific tests use a disposable `HKCU\Software\hello-cc\tests\<UUID>` key and clean it up. Tests must not alter real provider account settings or the developer's persistent PATH.

Local browser acceptance uses the shipped page/modules in installed Microsoft Edge, with a mocked API/WebSocket contract, at desktop and mobile sizes. It checks Windows terminal selection, input receipts, reload without duplicate creation, explicit termination intent, and absence of browser errors. This complements native runtime tests; it does not replace a browser run against a real provider or prove every desktop Windows environment.

File publication uses checked native handles, flushed temporary files, atomic publication, and a real parent-directory flush. A failure after publication is reported as unconfirmed, with recovery state retained. This is a bounded Windows publication contract, not a claim of physical power-loss proof on every storage device.
