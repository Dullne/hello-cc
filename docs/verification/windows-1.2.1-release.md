# Windows 1.2.1 release assembly

This record supplements the packaged [follow-up validation](../windows-followups-validation.md). Files in `docs/verification` are excluded from npm packaging so final acceptance receipts do not change the frozen release.

## Frozen package

- Source commit: `8815f72a5063e99770d6f3f1d6b30db6dcaa24c1`.
- Source tree: `5940072da0dfcafd875d3b4967a8626f5a9249c6`.
- Archive: `logicseek-hello-cc-1.2.1.tgz`, 2,371,532 bytes, 381 files.
- Manifest: `dsh-1.2.1-package.json`.
- SHA-256: `50d0a5d240830db8b96595e29baf7f96dc0a2c02d36d5d0355908a6b84227583`.
- npm SHA-1: `b558bcc753337d168a551d1a01b65c27ca51e139`.

A Git bundle preserved the original commit and tree in a Linux checkout with LF text and normal executable permissions. `npm run prepublishOnly` passed release notes, exact frozen content and modes, all four POSIX native targets, and both Windows artifacts. The repacked SHA-256 matched the stored archive exactly. The older 1.2.0 archive, manifest, tag, and historical changelog section remain unchanged.

Relative to the installed `d69885a` candidate, differences are limited to package test scripts, the two new development-test driver modules, and release documentation. Product runtime files and native binaries are byte-identical.

## Final development entry point

The driver passed nine focused Windows regressions and independent review. An actual Windows UI/source invocation passed its four files and static audit. The final `npm run test:regression` invocation passed all seven installed lifecycle groups on 2026-11-16 in 170.8 seconds, using a separately packed 381-file Windows checkout archive. Its driver returned zero and confirmed cleanup. The earlier 174-second passing checkpoint remains distinct.

The POSIX driver was exercised unchanged against two disposable test files: success returned zero, a real test failure returned one, the regression phase retained its original arguments and propagated exit 19, and a signaled child failed without starting the next group. No additional full POSIX run was inferred from these focused checks.

## Release gates

The complete product checkpoint is [d69885a / Test 43746006395](https://github.com/Dullne/hello-cc/actions/runs/43746006395), with all Windows, Ubuntu and macOS jobs successful and verified artifact digests. The final test-entry-point checkpoint, [8815f72 / Test 43749246730](https://github.com/Dullne/hello-cc/actions/runs/43749246730), also completed successfully at 2026-11-15 19:16:04 UTC: Windows, Ubuntu and macOS jobs all passed, including the Windows independent installation.

That final run completed all 70 Windows bounded files: core **314 passed and one platform skip**, UI **61 passed and one platform skip**, and shared behavior **220 passed with no skips**. Every file had a complete footer, with no failures, cancellations, timeouts or unconfirmed cleanup; all three platform-driver receipts returned zero and used distinct profiles. Ubuntu passed **2,149 tests with 260 skips**, macOS **2,153 with 256 skips**; both completed all thirteen integration stages. The separate Ubuntu cross-user test passed without skipping. Windows cloud installation passed all seven lifecycle groups in 50.142 seconds, using its own 381-file archive with SHA-256 `c4294a46ec169b7d73f39800ca43af4d62283f713345ce570cc139f4ab302cfa`.

All three downloaded artifacts matched their official GitHub digests: Windows `74bd5eaf5858b33c0803693e549c2c591fdcf8417b32e06d6259791dcc522cf7`, Ubuntu `c473adf42a50fb9167c28845788dcad109addc1f358d569a11ab9adf7d34b3b3`, and macOS `f647134f950cf3d3f4f62c5c7fe4a8e82bf3bd3062b14a826d5296496841838e`.

The exact frozen archive passed separate Windows installed acceptance on 2026-11-16: **all seven groups passed in 141.812 seconds including installation**, with every authenticated service and owned provider process confirmed exited. The receipt's package SHA-256 matched `50d0a5d240830db8b96595e29baf7f96dc0a2c02d36d5d0355908a6b84227583`; the isolated installation was cleaned up.

The actual global installation was updated from this exact archive. All **381 shipped file hashes matched**, `hcc --version` returned 1.2.1, Node was 24.22.3, environment diagnosis was ready, both SQLite integrity checks returned `ok`, hooks and launchers were present, and the native terminal dependency loaded. The real Codex context-injection proof in the packaged follow-up record remains applicable: the product runtime and generated hook command bytes did not change during release assembly.

Source integration, GitHub release, and npm publication remain separate actions. npm identity verification still returned HTTP 401 at 2026-11-15 19:17 UTC. The expired terminal login requires renewed account authorization; a successful local install does not establish registry publication.
