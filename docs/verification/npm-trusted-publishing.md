# npm trusted publishing setup

This workflow publishes the existing, verified release archive using GitHub's
OIDC identity. This record is excluded from npm packaging; configuring publishing
does not alter the immutable 1.2.1 archive or its version tag.

## One-time npm account setup

Open the package page for `@logicseek/hello-cc`, select its settings, and add a
Trusted Publisher with these exact fields:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `Dullne` |
| Repository | `hello-cc` |
| Workflow filename | `github-release.yml` |
| Environment name | Leave empty |
| Allowed actions | Enable **Allow npm publish** |

The default staged-publishing permission alone still requires manual approval
of each staged release. Direct publication is required for the requested
unattended release flow. No npm password, account token, or long-lived secret is
stored in the repository or in GitHub Actions.

New trusted publisher configurations must complete their first successful
publication within two days. The npm page may require account verification when
creating this authorization. Its existence alone does not prove publishing works.

## First publication of 1.2.1

The `v1.2.1` tag predates this workflow addition and remains unchanged. After the
npm authorization is saved, run **Publish GitHub Release** from GitHub Actions,
select branch `master`, and enter version `1.2.1`. The existing GitHub release is
validated/updated first, then the npm job publishes the frozen archive. Future
version tags trigger both jobs automatically.

The workflow accepts manual releases only from `master`, or version-tag push
events, in `Dullne/hello-cc`. npm publication receives only `contents: read` and
`id-token: write` permissions. Node 24 and npm 11.17.0 satisfy trusted publishing
requirements and retain the previously verified packaging version.

Before publishing, the workflow checks the release notes, the package contents
and modes against the frozen manifest, and all native artifacts. It verifies the
archive's SHA-256, SHA-1 and SHA-512 integrity; a registry version that already
matches is an idempotent success, while a different existing archive is an error.
After upload, registry readback must match the same archive. `npm whoami` is not
used: it does not test OIDC publishing authorization.

npm can accept an upload before the public version endpoint becomes available.
The helper records upload acceptance separately and waits up to ten minutes for
matching registry metadata, polling every ten seconds. Every network request and
retry is limited by the remaining deadline. A timeout reports that confirmation
is pending; it does not request another login or automatically upload the package
again. A checksum conflict, malformed metadata, or a non-404 HTTP error still
fails immediately. The job has twenty minutes for validation, upload and this
bounded readback.

The first trusted publication, run `44119229398`, reported npm upload acceptance
and a processing notice, then failed because the original readback used only
twelve attempts two seconds apart. Its failed record is preserved. The corrected
wait does not retroactively mark that workflow successful; registry visibility
and archive integrity are verified independently.

On 2026-11-18 (Asia/Shanghai), independent official-registry readback confirmed
both version `1.2.1` and the `latest` tag. The downloaded archive is 2,371,532 bytes
and all three digests match the frozen manifest, including SHA-256
`50d0a5d240830db8b96595e29baf7f96dc0a2c02d36d5d0355908a6b84227583`.
The registry's SLSA provenance payload identifies workflow `github-release.yml`,
commit `e97e11f19e957869137af23b36c221f137caf337`, and run `44119229398`, attempt 1;
its subject digest matches the archive. The transparency-log index is
`3948535052`, matching the upload log. These are metadata and downloaded-byte
checks, not a separate cryptographic verification of the Sigstore bundle.

## References

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [Package page](https://www.npmjs.com/package/@logicseek/hello-cc)
- [Release workflow](https://github.com/Dullne/hello-cc/actions/workflows/github-release.yml)

Preparation and local checks do not establish that the npm account authorization
has been saved or that 1.2.1 has been published. Those require the account action
and an accepted authenticated upload with matching registry readback. A workflow
can fail during its later confirmation even after npm has accepted the upload;
that failed workflow and the subsequent public-registry verification are separate
pieces of evidence.
