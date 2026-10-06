# Trusted tmux cwd handoff

`hcc-cwd-handoff` is a small native, one-shot broker/client pair. Its purpose is
to transfer an already-open directory descriptor from the hello-cc parent to a
specific tmux pane. The selected project pathname is never passed to tmux or
opened by the pane.

The parent launches `broker` with the selected directory as fd 3 and its
`fstat` device/inode. The broker verifies fd 3 and binds a socket in a private
0700 directory, then prints `READY`. It does not send the descriptor until the
parent writes `ALLOW <pane-pid> <64-lowercase-hex-nonce>` to stdin. The broker
compares the connected peer's kernel-provided PID and UID with that authorized
PID and its own UID, checks `HELLO <nonce>`, and transfers exactly one directory
descriptor with `SCM_RIGHTS`. The client checks device/inode and directory type,
calls `fchdir`, checks `stat(".")`, sets `PWD` from `getcwd`, acknowledges
`BOUND <nonce>`, and only then calls `execvp`. After validating that acknowledgement,
the broker atomically publishes `${socket}.bound` in the same private directory:
one regular 0600 file containing the 64-character nonce followed by a newline.
It fsyncs the temporary file, renames it into place, and fsyncs the parent
directory before reporting `BOUND` on stdout. The parent synchronously validates
and removes this receipt before admitting the pane. Both sides have bounded
waits and fail closed on malformed messages,
peer credentials, directory identity, socket permissions, or missing helpers.

This pins the **initial process cwd inode**. It does not make later absolute
path strings or `PWD` immune to subsequent renames. Peer PID authenticity
depends on the tmux server truthfully reporting the pane process PID; an
attacker controlling that same-UID server is outside this boundary.

`npm run build:native:cwd-handoff` builds the current platform/architecture
into `native/bin/<platform>-<arch>/hcc-cwd-handoff`. Supported package targets
are darwin-arm64, darwin-x64, linux-arm64, and linux-x64. Linux helpers are
static so the same package works on glibc and musl systems. The dedicated CI
workflow builds each target, tests real FD transfer, assembles one npm tarball,
checks the four binary formats and executable modes, then installs that tarball
without lifecycle scripts and tests again on all four platforms. No compiler,
Homebrew, or helper build hook is required when installing the npm package.

`npm run release:native:verify` and `npm run release:native:pack` are release
gates. A normal `npm publish` directly from a source tree without all four
binaries fails the `prepublishOnly` check. Because `--ignore-scripts` can bypass
lifecycle checks, release CI also invokes the verifier explicitly. The helper
is optional at runtime: an absent or
unsupported-platform binary must cause the caller to reject trusted tmux
launches, never fall back to a pathname-based launch.
