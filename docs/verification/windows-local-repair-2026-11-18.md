# Windows local repair, 2026-11-18

The requested scope is locally actionable Windows repairs. Missing macOS or
Windows 10 environments, hosted runner allocation, and an unidentified external
Claude relay are excluded from this work. Published 1.2.0 and 1.2.1 archives and
tags remain immutable.

## Private manifest publication and reads

The original failure is preserved in Test run
[44123310229](https://github.com/Dullne/hello-cc/actions/runs/44123310229),
Windows job 134180219942, at source `cfa7cb9`. The Web terminal test failed while
reading the new Web runtime manifest after restart, with
`PROJECT_FILE_FORBIDDEN` and `win32Error: 32`. It was not a test timeout.

Native publication atomically makes the new file name visible before closing
its write/delete handle. A concurrent private reader correctly refuses to share
with that handle, but previously treated this brief publication window as a
terminal failure. A separate process holding those exact Windows access/share
flags reproduces the error. Concurrent real native publications also reproduced
it against unchanged production code.

Private file acquisition now waits for at most a 250 ms contention budget,
sleeping at most 10 ms between attempts. Only the actual pre-acquisition
`openFile` failure with the original error code and Windows sharing-violation
number is eligible. Each attempt repeats ancestry and directory trust checks.
File identity, link count, size, ACL and content validation retain their existing
behavior; errors after acquiring the handle are never retried. Native sharing
flags and security policy are unchanged.

Regression coverage includes a real native publisher, a deterministically held
publisher-equivalent handle, persistent contention, missing files after release,
and file/parent ACL changes during the wait, including a retained private scope.

## Native startup and the runtime replacement fixture

The first local candidate installation failed while starting the native service.
Its profile and receipt are retained. The service had claimed ownership and
initialized its database, but had not published readiness before it was stopped;
its log contained no recorded ACL or file error. The original wrapper preserved
the failure code but omitted the detailed launch message.

Separate phase instrumentation on the unchanged candidate measured 9.48 seconds
from child creation to readiness publication, plus about 0.97 seconds of launch
preparation charged to the same 10 second budget. Another readiness check could
itself span the deadline. Windows now uses a 20 second default startup budget,
matching the previously explicit Windows background-test budget. Other platforms
retain 10 seconds and explicit caller overrides remain effective. The deadline
is checked between synchronous operations; it is not a hard wall-clock bound.

Two shared Web tests separately reproduced `NATIVE_CLIENT_TIMEOUT` where they
expected `NATIVE_OWNER_CHANGED`. Their HTTP stand-in rewrote durable ownership
and the private runtime pointer before ending a status response. The slow Windows
write exceeded the 2 second request deadline. The fixture now completes the real
authenticated HTTP request, changes ownership, and only then returns the old
status to Web admission. It preserves the intended owner-change race without
changing production HTTP timeouts or permitting a mutation against a successor.

Profiling also identified repeated native component digest checks. This repair
does not cache component validation or weaken file/ACL checks to reduce that
cost; performance optimization remains separate from these bounded corrections.

## Local verification and installation

Validation used Windows 11 x64, local NTFS and Node 24.22.3.

- With the sharing fix, all 58 Windows core files passed: 320 tests passed and
  one platform test skipped. All four UI files passed: 61 tests passed and one
  platform test skipped. The shared group exposed the two fixture failures
  described above; its original run was deliberately stopped before additional
  edits. All 12 observed processes in that owned test tree exited. This is not
  a claim that the complete shared suite passed.
  The later [native validation follow-up](windows-native-validation-2026-11-18.md)
  completed all eight shared files (220 passing tests) on the optimized source
  and installed the accepted local build `1.2.2-local.20261118.3`; the interrupted
  run described here remains preserved as historical evidence.
- The final private-file suite passed all 16 tests. Independent private-file,
  native-security and native-file review tests passed all 28 tests.
- The delayed-readiness background test failed against the original startup
  default and passed against the final default, including explicit short-budget
  refusal, authenticated reuse and confirmed shutdown. Native process/store
  regressions passed all 24 tests.
- Both corrected Web runtime replacement tests passed, as did both neighboring
  old-daemon tests. Independent review accepted the final stable diffs.
- Final static audit passed all 89 modules; native package verification, syntax
  checks and diff checks passed.

The final local archive is `logicseek-hello-cc-1.2.2-local.20261118.2.tgz`, with
381 files and SHA-256
`e4e3a77ddcf66b5482c0d8079b8f9c2a54f1652b8a16506a2647d20e5f7902c7`.
Its local version is assigned only in a separate assembly directory; the source
release version and published artifacts are not overwritten.

That exact archive passed all seven installed lifecycle groups in 154.771
seconds: environment diagnosis, project/database initialization, coordination
commands, background Web handoff, terminal persistence across Web restart,
controlled input and owned terminal exit, and native up/status/down. Every
fixture service and owned provider process was confirmed exited.

The global installation was then updated from that same archive. All 381 shipped
file hashes matched the archive, `hcc --version` returned
`1.2.2-local.20261118.2`, and environment diagnosis reported ready, trusted private
state and an available Windows native component. This is a local repair build,
not a new npm publication. The original failed candidate receipt and later
passing receipt are kept separately.

## External environment findings

Repeated extra read permission on the private state directory was traced to
Codex elevated Windows sandbox setup refresh logs on November 14, 15 and 17.
Those logs explicitly record granting a read ACE for sandbox users to the HCC
state directory. Current directory permissions are private, the configured and
selected Codex mode is full access, and the HCC environment doctor is ready.
This is a current health observation, not a guarantee against future external
permission changes. No HCC ACL rule was relaxed and no unsupported exclusion
setting was introduced.

The existing Claude endpoint at `127.0.0.1:8120` refuses connections. Targeted
inspection did not identify a matching local launcher, service or container.
Other installed routers use different ports and do not establish the identity
of the missing service. Its URL, credentials and provider selection were left
unchanged; restoration is excluded from this local repair.
