# Windows 1.2.1 follow-up validation

This record separates local Windows acceptance, account checks, immutable package validation, and hosted CI. Historical 1.2.0 results remain in [the original record](windows-native-validation.md).

## Implemented and checked

- PowerShell/cmd/POSIX environment formatting and existing-state diagnosis: **28 passed**, no failures or skips. These include real shell execution with Unicode/metacharacters and all PowerShell single-quote delimiters, JSON preservation, refusal before rejected peer registration, and SQLite-disabled read-only state inspection.
- Offline migration and related private-state/database/registry contracts: **44 passed**, no failures or skips. Twenty migration tests cover WAL snapshots, large history, live and unknown writers, case-insensitive identifiers, source preservation, destination replacement/ACL changes, interrupted-process retry, and generation/DSH preservation. Independent review reproduced and verified the security regressions.
- Windows TLS: **10 passed**, no failures or skips. Actual HTTPS validates the generated certificate; restart reuse, SAN rotation, private ACLs, redirected generations, eight-way first start and eight-way renewal, immutable key/certificate publication, ACL drift and in-place modification are checked. OpenSSL is required only when a new certificate is needed.
- CI supervisor and resource cleanup: real leaked handles and a blocked JavaScript event loop fail within their deadlines. Test-owned processes are released before directories held by native handles are removed.

The tested desktop remains Windows 11 x64 build 26220, Node.js 24.22.3, with local NTFS. Test profiles isolate both HOME and USERPROFILE and disable automatic shim setup.

## Local machine acceptance

The actual global CLI already used Node.js 24.22.3 before this patch. Provider configuration, registry PATH, project registration, and legacy guidance were backed up before setup. Claude/Codex hooks, native launchers, PATH integration, and project guidance were installed and verified.

The registered old project's legacy directory contained one guidance file and no database. It was explicitly secured and imported after independent migration review. Source, backup, and destination hashes match; the source remains present. A subsequent project status returned successfully without the old registered-project migration warning.

DeepSeek Harness 0.2.1-rc.3 was installed globally after retrying a stalled native Office download from the official registry with SHA-512 verification. PowerShell/cmd launch and the native Office engine pass; profile boot and model access are separate checks.

A bounded real Codex account request returned the expected nonce. This proves one authenticated request, not a complete browser/background-agent workflow. Claude inherited a local relay address with no listener. Its apparent authentication came from the inherited relay token; removing those settings for an isolated diagnostic showed no official login. The configured route was preserved, and a user decision is required to restore the relay or log in to the official account. Claude model acceptance is not claimed.

The private-state ACL had acquired an additional sandbox-group read ACE again after a previous repair. The exact extra ACE was removed from the state root; the new doctor detected the condition before repair and reported trusted state afterward. HCC does not silently change ACLs during diagnosis. No HCC code granting that group access was found; the external cause has not been established.

## Hosted CI evidence

The previous [Test run 43601409868](https://github.com/Dullne/hello-cc/actions/runs/43601409868) completed Ubuntu and macOS regression jobs, while its Windows job reached the one-hour limit. The recovered Windows artifact identifies a native-process test file that finished its assertions but did not exit. Its SHA-256 matched GitHub's artifact metadata.

The first broad local follow-up run preserved all 52 file results: 51 exited successfully and the Web-terminal file failed its existing deadline. Later focused corrections and subsequent hosted runs must be recorded separately; the failed run is not a passing whole-suite result. The new supervisor retains file start/end times, test-start diagnostics, logs, and bounded timeout failures. A later Web-terminal run still failed after 116.7 seconds: following Web restart, its HTTP request exceeded the existing 20-second deadline while the shared runtime suite was also running. Full native ancestry validation is CPU-heavy in these deep isolated profiles. Process-tree cleanup and scan scheduling are fixed, but this measured latency gate is still open at this checkpoint; no production deadline was raised.

## Remaining environment boundaries

Windows 10 still requires a dedicated acceptance machine. ARM64, UNC/network shares and non-NTFS storage remain outside the implemented platform contract. A hosted Windows Server run cannot establish every desktop version. Real account/model behavior is recorded per provider; fake-provider lifecycle checks do not substitute.

Migration preserves incomplete state rather than guessing after a crash before the progress receipt or during final publication. Such cases need manual review. Matching copy-phase receipts can retry automatically. TLS generations remain private; previously generated certificates are retained rather than recursively deleting them during startup.
