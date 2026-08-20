# Fresh macOS `node-pty` Packaging Design

## Context

The `1.0.1` file-lock candidate passes its source-tree macOS Node 24 tests and
the complete Linux container gate, including a real PTY launched from the
installed npm artifact. Those results do not prove that a new macOS consumer
can launch a PTY.

hello-cc currently declares `node-pty` as `^1.1.0`, and the lockfile resolves
that range to `1.1.0`. The official `node-pty@1.1.0` npm tarball publishes both
`prebuilds/darwin-arm64/spawn-helper` and
`prebuilds/darwin-x64/spawn-helper` with mode `0644`. Its install and
postinstall scripts do not repair those modes.

An actual `hello-cc@1.0.1` tarball was installed on an arm64 Mac into an empty
global prefix with an isolated npm cache under Node 24. The installed helper
remained `0644`, and a real `pty.spawn` failed immediately with
`Error: posix_spawnp failed.` This is the release-blocking RED result. Manually
changing the existing repository's ignored `node_modules` tree cannot make a
published package safe.

Upstream fixed the npm packaging pipeline so Darwin helpers are published as
`0755`. The latest official fixed package available during this design is
`node-pty@1.2.0-beta.15`; npm still labels `1.1.0` as `latest` and the fixed
line as `beta`. The `beta.15` tarball was independently inspected: both Darwin
helpers are `0755`, and its arm64 helper successfully launched a real PTY under
Node 24 from an isolated installation.

## Goals

- Make a normal fresh macOS install of `hello-cc@1.0.1` launch real PTYs
  without a manual permission repair.
- Make the correction independent of lifecycle scripts, the installer's
  ownership, and runtime write access to the dependency tree.
- Pin the reviewed upstream artifact exactly so an npm publication cannot
  resolve to an untested beta.
- Detect dependency-version or Darwin-helper permission regressions before a
  future publication.
- Re-run the complete macOS, Linux source-image, and exact-tarball gates after
  the dependency changes.

## Non-Goals

- Do not add native Windows shell support. hello-cc continues to support Linux
  and macOS, with Windows users directed to WSL.
- Do not fork or republish `node-pty` while an official fixed artifact is
  available.
- Do not mutate dependency files at hello-cc runtime.
- Do not use a broad or recursive permission change.
- Do not treat a manually repaired repository `node_modules` directory as
  fresh-install evidence.
- Do not create the `v1.0.1` tag, GitHub Release, or npm publication as part of
  this repair plan.

## Considered Approaches

### 1. Pin the official fixed beta exactly

Declare `node-pty` as the exact version `1.2.0-beta.15` and regenerate the
lockfile under Node 24. The upstream tarball already contains both Darwin
helpers as `0755`, so installation succeeds even when lifecycle scripts are
disabled or the installed tree becomes read-only. This changes more upstream
code than a local permission workaround and accepts a prerelease dependency,
so the exact artifact must be pinned and the entire acceptance suite repeated.
Selected.

### 2. Keep `1.1.0` and add a hello-cc postinstall permission repair

A postinstall script could resolve `node-pty` and set only the two Darwin
helpers to `0755`. It would preserve the stable dependency API, but it can be
skipped by `--ignore-scripts` and package-manager script policies. It also
introduces installation-time mutation of a third-party package and behaves
poorly with shared or read-only stores. Rejected as an incomplete release fix.

### 3. Repair permissions lazily at runtime

The PTY entry points could try to change the helper mode before each spawn.
That fails for root-owned global installations used by an unprivileged user,
read-only package stores, and immutable images. It would also introduce a
permission-changing race into normal terminal startup. Rejected.

### 4. Maintain a private fork or wait for stable `1.2.0`

A private backport would control the artifact but would add native-build,
provenance, and update obligations. Waiting for the stable upstream release is
the lowest dependency risk but prevents the current `1.0.1` release. Either is
a fallback only if the pinned official beta fails hello-cc's full gate.

## Dependency And Package Contract

`package.json` will declare:

```json
"node-pty": "1.2.0-beta.15"
```

The root dependency declaration and `node_modules/node-pty` record in
`package-lock.json` must resolve to that same exact version and integrity. A
caret, tilde, `beta` tag, Git URL, or unpinned range is not acceptable.

This exact declaration matters for consumers because hello-cc's published npm
tarball does not carry its lockfile as the dependency authority. A fresh global
installation resolves dependencies from the published `package.json`; the
exact version prevents it from silently selecting a later, unverified beta.

No hello-cc lifecycle script will be added for this fix. The executable bits
must originate in the upstream dependency tarball and survive extraction.

## Deterministic RED And GREEN Coverage

The release-contract test will assert all of the following:

- `package.json` declares exactly `1.2.0-beta.15`;
- the lockfile root declaration is identical;
- the locked `node-pty` package version is identical;
- the installed package reports the identical version;
- both published Darwin `spawn-helper` files exist as regular, non-symbolic
  files and have execute permission for owner, group, and other.

Before the dependency update, the declaration/version assertions fail and the
freshly extracted `1.1.0` x64 helper is non-executable. That is the repository
RED. After the exact update, the test must pass on Linux and macOS without
modifying `node_modules` in the test.

The real consumer RED already captured from the `1.0.1` candidate remains part
of the evidence record: empty prefix, empty cache, installed version `1.1.0`,
both helpers `0644`, and `posix_spawnp failed`. The corresponding GREEN must
install a newly packed candidate into new empty prefixes and must never reuse
the RED installation.

## Fresh macOS Artifact Gate

After source tests pass, create one actual hello-cc tarball and fingerprint it.
Use that same file for two independent global installations, each with a unique
empty prefix and npm cache and with Node 24 first in `PATH`:

1. a normal `npm install -g`;
2. an `npm install -g --ignore-scripts`.

For each installed tree:

- verify hello-cc metadata, engine, CLI version, and help;
- verify the installed `node-pty` version is exactly `1.2.0-beta.15`;
- use `lstat` to verify both Darwin helpers are regular, non-symbolic files
  with exact executable mode `0755`;
- launch a real PTY through the installed dependency and require expected
  output and a zero exit;
- launch and reap 50 sequential PTYs in one Node process, require the expected
  output and zero exit from every child, then require the parent to exit within
  30 seconds without an active PTY handle;
- confirm no `posix_spawnp failed` error and no child process remains.

The arm64 host executes the arm64 helper. The x64 helper's tarball and installed
mode are verified locally, but this Apple Silicon host has no Rosetta or x64
Node runtime, so it cannot honestly claim x64 execution. The repository's fresh
macOS CI run remains the execution check for its runner architecture after the
commits are pushed. If no x64 runner executes it, Intel macOS remains an
explicit unverified platform boundary rather than being inferred from arm64.

## Full Regression And Container Gate

Because `1.2.0-beta.15` is a prerelease native dependency, a focused PTY smoke
is not enough. After GREEN, verification repeats from the final commit:

- the half-open file-lock regression 20 consecutive times;
- three sequential complete macOS Node 24 unit suites;
- the real PTY identity test and the 50-process repeated PTY lifecycle test;
- the complete 13-stage macOS regression with `FULL_REGRESSION_OK`;
- syntax, release-contract, release-note, GitHub dry-run, package dry-run, and
  whitespace checks;
- one fresh no-cache Linux Node 24 image, then three complete `npm test` passes
  from the same immutable image ID;
- one actual `1.0.1` tarball created only after the third container pass;
- a clean Linux Node 24 container installation of that exact tarball, including
  metadata, CLI, real PTY, schema-v7 database, Runtime API v2, and clean `down`.

Every new source or artifact failure blocks publication. A Linux success cannot
replace the fresh macOS installation gate, and the pre-upgrade container image
or tarball cannot be reused as post-fix evidence.

## Release Notes And Risk Boundary

The `1.0.1` changelog will disclose the exact prerelease native dependency and
why it is pinned: the stable `1.1.0` npm artifact cannot launch a fresh macOS
PTY because its helper lacks execute permission. It will also state that this
does not change hello-cc's CLI, database schema, Runtime API v2, browser root
selection, or accepted internal-network exposure boundary.

The risk accepted here is limited to consuming the official, exact
`1.2.0-beta.15` artifact after full project verification. It does not authorize
floating beta updates. Any later beta or stable update must change the exact
version and pass the same dependency and artifact gates.

The upstream evidence for this boundary is the confirmed
[`1.1.0` permission defect](https://github.com/microsoft/node-pty/issues/850),
the merged [Darwin helper fix](https://github.com/microsoft/node-pty/pull/866),
the official [publish-time `chmod` gate](https://github.com/microsoft/node-pty/blob/main/publish.yml),
and the pinned [`v1.2.0-beta.15` release](https://github.com/microsoft/node-pty/releases/tag/v1.2.0-beta.15).

## Rollback And Publication Boundary

Before publication, rollback is a normal revert of the dependency, lockfile,
tests, and changelog amendment. Reverting restores the known macOS failure, so
it also restores the publication block; it is not a releasable alternative.

No tag, GitHub Release, npm publication, or push is performed by the design or
implementation plan. Publication is considered only after the final verified
commit is clean, all local gates pass, and post-push CI evidence is reviewed.
