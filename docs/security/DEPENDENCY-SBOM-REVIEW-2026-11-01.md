# Dependency and SBOM review — 2026-11-01

**Reviewed revision:** `9a004ff38224882d7f9ccf61a9df7a7efec89a84`
**CI workflow run:** [41338029772](https://github.com/GoldenObsidianLLC/SystemFabric/actions/runs/41338029772)
**Related PR:** [#36](https://github.com/GoldenObsidianLLC/SystemFabric/pull/36)
**Disposition:** SBOM and audit evidence refreshed and verified; license/distribution review, inventory variance root cause, provenance and maintainer sign-off remain open.

This record describes the actual matrix evidence. It is not a legal opinion, dependency attestation, or production release approval.

## Reviewed dependency identity

Both CI jobs used the same committed `package-lock.json`:

- Git blob: `fcd29708829f170e89976c82c44ea7338cf04cbf`
- SHA-256: `5b2b79b4fff771a6f0209f51737b320b0513685db5997b1dce9c437adf0d1ad3`
- The file is unchanged from `main` at the reviewed PR base.

The two jobs generated CycloneDX 1.5 SBOMs using `npm sbom --sbom-format=cyclonedx --omit=dev`. Both describe SystemFabric 0.5.1. Their artifact ZIP digests identify the retained evidence sets, while the SBOM hashes identify the SBOM file inside each set.

| CI runtime | Components | Dependency records | SBOM SHA-256 | Evidence ZIP SHA-256 |
|---|---:|---:|---|---|
| Node.js 22.23.4 / npm 10.9.9, Linux x64 | 167 | 168 | `f9826eab9602396122c778ed82da8704ec9e9e969de003b431ed2904dfefab8c` | `7d02df11161c04b160e70e6c4d99d4f37b10c14154745dd382582f6a0e3352f9` |
| Node.js 24.22.1 / npm 11.19.1, Linux x64 | 165 | 166 | `bc86363ae268bb769baa4a2575196cb8db0f5a7558a19b57f9c24f092aa4ba66` | `d1b5bcd1bf1d3c41abf57f9db8156953f083ac6c7493907cf97996c77a0ffd25` |

The same lockfile did not produce byte-identical installed-component inventories. The observed symmetric difference is three components:

| Runtime inventory | Component | Version | License / SBOM observation |
|---|---|---:|---|
| Node 22 only | `@emnapi/runtime` | 1.11.3 | MIT; SBOM marks it optional, development and extraneous |
| Node 22 only | `@img/sharp-wasm32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT; SBOM marks it optional, development and extraneous |
| Node 24 only | `tslib` | 2.8.1 | 0BSD; SBOM scope required |

This is an observed optional/transitive installation or npm-inventory difference, not a lockfile change. The matrix also uses different npm versions (10.9.9 and 11.19.1), so the difference is confounded by npm as well as Node; the precise cause has not been isolated. Do not infer that the package graph is fully equivalent across runtimes from matching lockfiles alone. The refreshed evidence records Node/npm versions, actual SBOM counts, exact hashes, license inventory and generation time for each matrix job.

## Retained-license inventory

Both generated SBOMs reported zero components without an identifiable license. The observed optional image stack includes:

| Component | Version | Identified license |
|---|---:|---|
| `sharp` | 0.35.5 | Apache-2.0 |
| `@img/sharp-libvips-linux-x64` | 1.3.4 | LGPL-3.0-or-later |
| `@img/sharp-libvips-linuxmusl-x64` | 1.3.4 | LGPL-3.0-or-later |
| `@img/sharp-wasm32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT (present in Node 22 SBOM) |

A separate local Windows x64 worktree inventory under Node.js 26.12.1/npm 11.7.0 also observed optional `@img/sharp-win32-x64@0.35.5` with the expression `Apache-2.0 AND LGPL-3.0-or-later`. This local check is not one of the retained Linux CI artifacts, but it reinforces that target-platform inventories must be reviewed separately.

The repository's top-level `LICENSE` is GPL-2.0; the vendored `vendor/enginex/LICENSE` is MIT. These facts do not establish compatibility of the combined product, the correct notice set, or the precise obligations for every distribution form.

A second package-archive inspection verified the lockfile SRI for seven exact Sharp/libvips and platform packages and recorded whether LICENSE/COPYING/NOTICE texts are present in each archive. See `DEPENDENCY-LICENSE-PACKAGE-INSPECTION-2026-11-01.md`. This inspection found no separate license file in the two Linux libvips tarballs and found compound LGPL expressions in the WASM and Windows Sharp package metadata even though the included LICENSE files begin with Apache 2.0. This is a material notice-mapping gap, not a reason to remove the components from the SBOM.

Before distributing binaries, containers or hosted downloadable artifacts, the release owner must determine which optional Sharp/libvips variants are actually shipped for each target platform, verify the package license texts and source offers/notices as applicable, include required third-party notices, and obtain legal review where required. Do not remove a license-bearing package from the SBOM merely because a different platform does not load it.

## Stale evidence defect — corrected in the latest CI run

The previous CI run's retained `artifacts/evidence/sbom-generation.log` stated **163 components / 164 dependency records**, while its actual SBOM documents contained **167 / 168** for Node 22 and **165 / 166** for Node 24. The previous retained `npm-audit.log` also carried a hard-coded execution date of 2026-10-31, despite the artifacts being generated on 2026-11-01.

PR #36 replaced the static SBOM log with a generator-produced record containing exact counts, lockfile/SBOM hashes, Node/npm user-agent, platform, generation time and license observations. Its audit step writes separate full-tree and production-only audit logs from live commands.

The refreshed CI artifacts were inspected directly on commit `9a004ff38224882d7f9ccf61a9df7a7efec89a84`:

- Node 22: 167 components / 168 dependency records; dynamic log matches the SBOM JSON.
- Node 24: 165 components / 166 dependency records; dynamic log matches the SBOM JSON.
- Each log records Node/npm, platform, generation timestamp, package-lock SHA-256, SBOM SHA-256 and license inventory.
- Both `npm-audit-all.log` and `npm-audit.log` report zero vulnerabilities for both runtimes.

The stale-log defect is closed for this reviewed run. The exact cause of differing component inventories remains open and is documented above.

## Gate disposition

- **Lockfile reproducibility:** same committed file in both matrix jobs; PASS for file identity only.
- **SBOM generation:** both CycloneDX 1.5 files and refreshed logs succeeded with exact hashes/counts; PARTIAL because the optional inventory difference is correlated with different npm versions and has not been fully root-caused.
- **Known licenses:** no unidentified license values in either current SBOM; PARTIAL pending notice and distribution analysis, especially LGPL-3.0-or-later components.
- **Vulnerability audit:** both full-tree and production-only audits reported zero vulnerabilities on Node 22 and Node 24 in the latest CI run; this is vulnerability data only, not license/legal or independent security acceptance.
- **Provenance/attestation:** not established by an SBOM alone; still open.
- **Independent review and production certification:** not addressed by this inventory and remain open.

No dependency was purchased, no paid service or external reviewer was engaged, and no funding or liquid reserve is assumed.
