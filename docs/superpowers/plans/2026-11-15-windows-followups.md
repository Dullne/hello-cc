# Windows follow-up implementation plan

**Goal:** Resolve the concrete Windows CLI, diagnostics, migration, setup and CI gaps reported during the local 1.2.0 acceptance, then validate the installed result.

**Authorization:** The user requested that all reported issues be handled after reviewing the residual-issue inventory. Earlier native Windows design and release authorization remain in effect. No existing user data, provider configuration or immutable release artifact may be discarded.

**Architecture:** Preserve the platform adapters and Windows handle/ACL contracts. Extend existing command surfaces instead of bypassing security checks. Keep local setup, legacy data migration, published artifact provenance and real-provider acceptance separately verifiable.

**Global constraints:** Node 24+, Windows x64/local NTFS; preserve Linux/macOS behavior. Unknown ownership, live source writers, changed directory identity and unexpected reparse/hardlink objects fail closed. Never broaden ACLs to pass tests. Tests isolate HOME and USERPROFILE and disable automatic shim installation. Do not change the immutable 1.2.0 archive or tag. No model credentials in diagnostics or reports.

- [ ] CLI and diagnosis: reproduce POSIX-only env output and state-ACL false readiness; add explicit PowerShell/cmd/POSIX formats, platform defaults, safe quoting and platform-specific help; inspect existing state ACL without creating state; test malformed paths and missing state.
- [ ] Legacy migration: inspect the existing POSIX migration contract and actual legacy layout without changing it; implement a Windows offline migration using native source identity/read protection, private destination staging, SQLite integrity validation, retained backup/source, publication fencing and retry behavior; add adversarial and real database tests. Root applies the validated command to the real legacy project only after backups and offline checks.
- [ ] Windows CI: obtain available failure evidence, identify the stalled test/stage, reproduce locally where possible, correct the underlying lifetime/fixture problem and add bounded per-test evidence; retain all required assertions. Update obsolete artifact actions after checking their current requirements.
- [ ] Windows TLS: add a platform-specific implementation with private key storage and stable certificate reuse/rotation, using the existing Windows primitives; validate certificate/key pairing, SANs, permissions and actual HTTPS. Preserve POSIX behavior.
- [ ] Local setup: back up provider config, user PATH and HCC state; install correct guidance/hooks/shims from the reviewed package; validate normal PowerShell/cmd resolution and real provider auth/status, then one bounded harmless model task per available account.
- [ ] Optional DSH and supported-platform record: inspect the supported DSH distribution and native platform compatibility, install/verify where supported; report missing account/hardware gates explicitly. Windows 10/ARM64/network filesystem acceptance cannot be inferred from this Windows 11 x64 machine.
- [ ] Review, integration and release: inspect all changes, run focused regression plus Linux and Windows acceptance; update current docs without rewriting historical evidence; create a new immutable patch package, install and verify it locally, integrate/push and publish within the authorized release scope when verification gates pass.

## Evidence rules

Record real command exit codes and timestamps. A simulated provider proves process behavior, not real account integration. Cloud timeout must be resolved or remain an explicit incomplete gate; increasing a timeout alone is not proof. Existing registered projects and old state remain recoverable throughout migration.
