# DeepSeek Harness 1.0.2 source provenance

This branch preserves the source content of the published `@logicseek/hello-cc@1.0.2` package. The npm `latest` tag points to this release. Its 216 package files are taken from the verified registry artifact, not from the concurrently changing development checkout.

- Base Git revision: `f4b9a6d9945f2d311ca7940c429d6feed0dcb49b`.
- Published archive SHA256: `064028e5f7ef620129bec6ba089fda4dfbc522a62ab6bcc326bf05663814adf7`.
- [File manifest](dsh-1.0.2-package.json) records every published file and SHA256, plus the test snapshot provenance.
- Runtime content is identical to the previously tested `1.0.2-dsh.3` release. The stable release changes only package version, changelog and the two public Harness guides.
- The published package also includes the frozen native transport, MCP and Web dependencies used by the integration. This is an archive of the released package, not a claim that every added module was introduced solely for Harness.

The gating tests retain the original Git baseline and add the published Harness, shared native transport, scoped MCP, hook-delivery, ownership and native HTTP contracts from the hash-verified October 2 candidate snapshot. The two final Harness recovery tests come from the October 3 repair snapshot. CLI argument and terminal-session security tests are updated for the corresponding published behavior changes; the release contract expects `1.0.2`. The lockfile has matching dependencies and engines; only its two root version fields are updated. These source-only files are outside the published package. The [test-scope manifest](dsh-1.0.2-test-scope.json) records the selection and hashes (63 files, including 61 test modules).

The Test workflow checks this source tree on Linux and macOS. The Harness acceptance workflow independently packs the checkout, compares all published 1.0.2 file hashes, installs the pinned official Harness `0.2.0-rc.2`, and runs the public CLI/profile lifecycle checks in a private HOME. Its acceptance directory is initialized from shell `RUNNER_TEMP`, since the job-level environment cannot reference the `runner` context. Both workflows accept pushes to this archive branch and pull requests. No workflow publishes npm packages, requests model inference, or receives provider credentials.

Local and CI outcomes are recorded separately. Existing evidence covers macOS real-model collaboration, Linux container installation, stable registry installation, and stable local CLI/Desktop activation. A CI runner does not establish employee-device or business-owner acceptance. GitHub Release publication and merging into the default branch are separate actions.

## Diagnostic limits

The complete later candidate test snapshot was also run against this immutable release: **870 checks, 834 passed, 35 failed, 1 platform skip**. The failures include later streaming/UI/asset contracts and inherited provider identity, ordinary hook, Web lock and startup behavior gaps. They are [recorded individually](dsh-1.0.2-later-snapshot-diagnostics.json), remain unresolved in this archived package, and are not a claim of full-suite acceptance. The original baseline test comparison found one superseded terminal-buffering source assertion; the replacement test verifies the published acknowledgement/uncertain-delivery behavior. The released regression script completed all 13 steps. Scoped CI validates the archived baseline and Harness integration; it does not erase or fix the broader diagnostic findings.

Local source validation: 639 selected checks, 638 passed and one Linux-only platform skip; 63 factory modules audited; all 13 regression steps passed. Release checks and workflow static validation passed. Repacking this checkout reproduced the published archive SHA256 exactly. Remote CI remains a separate result attached to the pushed commit.

The first pushed commit passed the Harness installation matrix but failed the general regression workflow because its source archive omitted `test/web-ui-session-display.test.mjs`, which the frozen regression script invokes directly. That test dependency was restored from the verified candidate snapshot. The complete `npm test` chain then passed locally (audit, 639 unit checks and all 13 regression steps), with no published file changes. The earlier CI failure remains recorded separately from the corrected attempt.
