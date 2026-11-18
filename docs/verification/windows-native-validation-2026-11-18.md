# Windows native validation optimization and shared acceptance

This follow-up implements the user's requested local performance work and
completes the Windows shared test suite. The starting source is `c3d07e2`.
External Codex permission changes and unavailable operating system qualification
remain outside this work.

## Optimization boundary

A single internal synchronous private directory operation previously admitted
the same native component repeatedly while capturing and checking its directory
handles. The optimization passes one freshly admitted component through that
operation's internal captures. It does not cache component admission between
public operations, across a retained private-scope callback, or across sharing
violation retries.

Native source and binary validation remains strict at the next operation.
Filesystem capability checks, directory ancestry checks, pre/post-callback ACL
checks, identity assertions, link-count checks and file size limits remain in
place. No process-lifetime or modification-time cache is introduced.

The performance comparison uses separate, owned profiles for matching public
init/up/status/down operations and repeated private-file operations. Instrumented
component validation counts and time are reported separately from total command
latency. Before/after artifacts are retained separately.

## Measurements

The comparison ran on Windows 11 x64, NTFS and Node 24.22.3. Five instrumented
samples of 200 operations each produced these medians. The baseline source was
checked against the exact starting commit and loaded in memory; the working
tree was not swapped during verification.

| Operation | Admissions per operation, before/after | Before median | After median |
| --- | --- | --- | --- |
| Directory inspection | 3 / 1 | 2,524.8 ms | 1,731.4 ms |
| Private file read | 3 / 1 | 3,337.6 ms | 3,851.7 ms |
| Pinned directory callback | 4 / 1 | 3,573.2 ms | 3,566.9 ms |
| Three reads in one private scope | 6 / 3 | 8,287.1 ms | 6,854.9 ms |

The repeated validation work is deterministically reduced. Wall-clock results
are mixed: the corrected read sample was slower, so these results do not justify
a claim that every operation is faster. The original microbenchmark receipts
had an aliased counter snapshot and are retained as superseded evidence;
`before2-microbench.json` and `after2-microbench.json` contain corrected counts.

A separate pair of instrumented public CLI observations measured native startup
at 10,860 ms before and 7,672 ms after. Launcher component admissions fell from
1,251 to 585, and service-lifetime admissions from 560 to 274. Public init,
up, status and down all returned zero, and the owned service exit was confirmed.
The probe also retained an expected offline error from a redundant cleanup/down
request; it is not claimed to be an entirely error-free cleanup transcript.
These are individual local observations, not a general latency guarantee.

Because the corrected read result was slower, a separate bounded A/B/B/A
follow-up used a fresh process per sample, one shared fixture, 20 warm-up reads
and 200 measured reads. Baseline samples took 3,708.3 and 4,443.6 ms; optimized
samples took 2,803.3 and 2,879.5 ms. Each baseline sample admitted the component
600 times and each optimized sample 200 times. The earlier slowdown was not
reproduced, but two samples per implementation do not establish a general
percentage speedup. Both experiments are retained in `read-abba-comparison.json`
and the corrected microbenchmark receipts.

## Validation scope

The complete shared suite consists of native runtime, Web native sessions,
structured routes, scoped MCP, native fixture roots, Codex terminal history
boundaries, browser lifecycle and platform file operations. The previous
interrupted run remains a historical failure record. The new run must finish
every file and confirm cleanup; a subset of passing files does not complete it.

## Completed shared acceptance

The standard Windows shared group completed on November 18, 2026, from
08:03:11.680Z to 08:24:00.257Z: 1,248.577 seconds, all eight files and all 220
tests passed, with zero failures, skips, cancellations, todos or timeouts.
Concurrency remained three and the original 35-minute per-file and 40-minute
group deadlines were unchanged. No tests were retried or omitted.

| Shared test file | Passed |
| --- | ---: |
| codex-terminal-history-boundary | 2 |
| native-fixture-root | 5 |
| native-runtime | 70 |
| scoped-mcp | 18 |
| web-browser-lifecycle | 15 |
| web-files-platform | 2 |
| web-native-sessions | 79 |
| web-structured-routes | 29 |

The driver reports exit code zero and the bounded runner reports completion
with every child exit code zero. All 727 tracked/untracked source hashes matched
before and after the run. All 22 observed process identities exited and the
isolated profile was removed. The retained evidence is
`hcc-shared-complete-20261118/attempt-01/acceptance-summary.json`, SHA-256
`f01079c8a656e84e3ed9028e3d43a603fe046e5686aa355a85767ff2fa51e7af`.

The PowerShell observer returned a null `Process.ExitCode` after refresh. The
raw receipt and initial aggregation error remain preserved; that observer field
is not presented as an independent successful driver exit. The test driver's
own receipt, eight child results and supervisor command exit establish the
reported outcome. Documentation was finalized only after the source snapshot.

## Security regression and installed acceptance

The new admission tests first reproduced five expected failures on the baseline,
then all 11 passed on the optimized implementation. They verify fresh validation
at public operation and sharing-retry boundaries, including rejection of
manifest, source and binary tampering within a retained scope. They alter only
test-observed read results, never the actual native artifacts.

The focused regression passed all 58 tests across seven files. The static audit
passed all 89 modules; native package verification, syntax and diff checks passed.
An independent read-only review found no blocking issue in the final source.
The optimized private-state SHA-256 is
`02e2f537d78b31252e86ac8acc017799ec244075f01bfebeb044136c9b3648c8`;
the admission-test SHA-256 is
`394263c7dc226c500e92ec4919230defc910430b664e7ce86c482bd445480875`.

The accepted local archive is
`logicseek-hello-cc-1.2.2-local.20261118.3.tgz`, with 381 files and SHA-256
`dce5f81c8844838a0e730c312fcdb1f2e70df130b3c7917dfebe143b225f549e`.
That exact archive passed all seven installed lifecycle groups in 84.721 seconds:
environment diagnosis, project/database initialization, coordination commands,
background Web handoff, terminal persistence across Web restart, controlled input
and confirmed terminal exit, and native up/status/down. All authenticated fixture
services and owned provider processes were confirmed exited. Provider tests used
local simulated responses; they do not establish live model connectivity.

The global installation was updated from the same accepted archive. All 381
shipped files matched the extracted archive by SHA-256. `hcc --version` reports
`1.2.2-local.20261118.3`; environment diagnosis reports ready, trusted private
state, NTFS and an available native component. Project database integrity and
quick checks both report `ok`, schema version 7 is compatible, and no migration
is required. Local installation receipts are retained under
`hcc-native-optimization-20261118`.

The local version is assigned only in a separate package assembly. Source release
version 1.2.1 and the frozen published archive remain unchanged. This follow-up
does not publish a new npm version or qualify other operating systems.
