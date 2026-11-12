# Windows native component

This component exposes process identity, filesystem/ACL primitives, owned
provider-process launch and ConPTY terminals. The first build target is Windows x64 on Node.js 24 or
later. It uses the C Node-API interface (version 8), Windows SDK APIs and the
static MSVC runtime (`/MT`).

## Build

Use an installed Visual Studio C++ toolchain and trusted Node.js headers plus the
matching Windows x64 `node.lib`. The build discovers Visual Studio through
`vswhere.exe` and obtains its environment in a child process; it does not change
the user's PATH or install build tools.

```powershell
& 'C:\path\to\node.exe' scripts/build-windows-native.mjs `
  --headers 'C:\path\to\node-headers\include\node' `
  --node-lib 'C:\path\to\node.lib'
```

An optional `--vswhere PATH` selects a nonstandard Visual Studio Installer path.
The script emits `native/bin/win32-x64/hcc-windows.node` and the adjacent
`hcc-windows.json` manifest. It compiles every top-level `.cc` in this directory;
keep shared native headers at this same level. Build intermediates stay inside a
unique temporary output directory and are removed after the build.

The manifest records the protocol and Node-API version, platform/architecture,
native source hash, binary hash and build Node version. The source hash covers
all top-level `.cc`, `.h` and `.hpp` files in lexical filename order, encoding
each filename, a NUL separator, its exact bytes and a final NUL. The binary also
exports its compiled source hash and protocol. Changing native sources requires
a rebuild. The loader rejects missing or inconsistent metadata before returning
the component. These checks bind artifacts to this checkout; they are not an
authenticity signature for untrusted downloaded packages.

## Interface

Import `loadWindowsNative` from `lib/platform/windows-native.mjs`. Importing the
loader has no native loading side effect. Calling it on a non-Windows platform
returns `null`; an unavailable or mismatched Windows component raises
`WINDOWS_NATIVE_UNAVAILABLE` with a diagnostic `extra.reason`.

The returned object currently provides:

- `protocolVersion: 1`
- `sourceHash`: the source hash embedded at build time
- `capabilities: { processIdentity: true }`
- `inspectProcess(pid)`

`inspectProcess` accepts an integer PID from 1 through 4294967295. Invalid values
produce `{ state: 'unknown', pid: null, reason: 'invalid_pid' }` without coercion.
A live observation contains `pid`, `creationTime` and `imagePath`.
`creationTime` is the decimal string of Windows' 64-bit process creation FILETIME
and must remain a string to preserve its precision. `imagePath` is the executable
path obtained from Windows; it is **not** the process command line.

One process handle is retained across the entire observation, so PID reuse cannot
mix creation time and image path from different process instances. A signaled
process handle or Windows' missing-PID response produces `state: 'dead'`. Access
denial and other incomplete observations produce `state: 'unknown'`, a reason,
and a numeric `win32Error` when available. Neither dead nor unknown observations
contain an identity. Handles close on every return and exception path.

This read-only observation does not grant authority to terminate a process.
Owned process controllers retain the process and Job handles created during
their own startup; they never acquire termination authority from a supplied PID.

## Owned provider processes and selected directories

`startOwnedProcess` creates the root suspended with a restricted inherited handle
list and `PROC_THREAD_ATTRIBUTE_JOB_LIST`. The Job has `KILL_ON_JOB_CLOSE` and no
breakaway permission. Job membership therefore exists from process creation,
including when the launcher dies before it can resume the root. Cancellation
terminates this Job explicitly; Windows does not emulate POSIX signals.

Production pinned launch supplies an opaque native directory lease. Startup
duplicates its ancestor-directory handles and leaf sentinel into the root and
retains another copy in the controller until the Job drains. Those handles
prevent rename/replacement and attribute-only reparse conversion while the root
starts, including if the launching host exits. The admission guarantee is that
the launched root enters the selected directory or fails before provider/user
code executes. It does not constrain a provider's intentional `chdir`, or promise
that every later descendant permanently retains that directory. Trusted provider
code must not deliberately close or sabotage its inherited protection handles.

The JavaScript prepared launch is a one-use native capability; it cannot be
converted to an ordinary `child_process.spawn` recipe, which would drop its
handle protection. Stdio uses bounded pipes, a bounded native stdin queue and a
worker for blocking writes. Output and process-tree exit must both finish before
the adapter confirms close. Observation failure remains unconfirmed cleanup even
if the adapter also emits a close event. The process controller also retains
immutable creation time and executable image path read from its process handle
before a suspended root resumes. Fast exits therefore preserve the same process
identity as live inspection without relying on a later PID lookup.

## Trusted background hosts

`startDetachedHost` has a different lifetime contract from provider processes.
It creates the trusted service root runnable, with the inherited directory pins
already present, and retains its process handle until the caller confirms
readiness. It has no outer Job: a terminal service started by the Web service
must survive Web shutdown. Closing the controller before handoff terminates the
specific retained process; `detach()` relinquishes that authority after a live
handoff. Runnable creation avoids leaving an unresumable orphan if the launcher
dies immediately after process creation.

The JavaScript service adapter allows only this installation's current Node
binary and exact HCC native/Web service or terminal-host entry points. It does
not offer arbitrary unmanaged provider launch. Logging uses a native private
append cursor whose file and directory protection handles are independently
retained by startup. Node file descriptors must not be passed to the addon's
separate static C runtime descriptor table.

## ConPTY terminals

`startOwnedPty` requires the opaque selected-directory lease and adds a
`PSEUDOCONSOLE` startup attribute to the same atomic Job and restricted handle
inheritance used for provider processes. The root and descendants belong to that
Job. A separate worker handles pseudoconsole resize and closure so Windows
versions whose `ClosePseudoConsole` blocks can still drain output on the host's
event loop. Valid resize requests racing terminal closure have no further screen
to resize and do not replace the exit receipt with an error.

`spawnWindowsPty` exposes literal text input, bounded backpressure, resize,
pause/resume, immutable creation identity, output callbacks and confirmed owned
termination. Exit callbacks follow complete output drainage and Job exit;
observation or cleanup failures report an uncertain exit. The persistent HCC
terminal host owns these controllers, screen snapshots and control epochs.
CLI and Web clients attach to that host; detaching a client leaves its terminal
running. Host shutdown closes the owned Jobs. No tmux or existing-console
adoption is involved.

## Verification

After building, run with the supported Node runtime:

```powershell
& 'C:\path\to\node.exe' --test test/windows-native-loader.test.mjs
```

The suite verifies lazy loading, missing/malformed/incompatible manifests,
source and binary mismatch rejection, real repeated current-process identity,
invalid arguments, and observation after a disposable child exits. Real native
tests run only on Windows; portable metadata tests remain active elsewhere.
