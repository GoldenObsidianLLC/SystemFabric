# Dependency and SBOM review — 2026-11-01

**Reviewed revision:** `f8262c68cdcb9a05ae64d05fd168742979d76bd0`
**CI workflow run:** [41335105468](https://github.com/GoldenObsidianLLC/SystemFabric/actions/runs/41335105468)
**Related PR:** [#36](https://github.com/GoldenObsidianLLC/SystemFabric/pull/36)
**Disposition:** preliminary inventory complete; license/distribution review and maintainer sign-off remain open.

This record describes the actual matrix evidence. It is not a legal opinion, dependency attestation, or production release approval.

## Reviewed dependency identity

Both CI jobs used the same committed `package-lock.json`:

- Git blob: `fcd29708829f170e89976c82c44ea7338cf04cbf`
- SHA-256: `5b2b79b4fff771a6f0209f51737b320b0513685db5997b1dce9c437adf0d1ad3`
- The file is unchanged from `main` at the reviewed PR base.

The two jobs generated CycloneDX 1.5 SBOMs using `npm sbom --sbom-format=cyclonedx --omit=dev`. Both describe SystemFabric 0.5.1. Their artifact ZIP digests identify the retained evidence sets, while the SBOM hashes identify the SBOM file inside each set.

| CI runtime | Components | Dependency records | SBOM SHA-256 | Evidence ZIP SHA-256 |
|---|---:|---:|---|---|
| Node.js 22.23.4, Linux x64 | 167 | 168 | `7658d515ef02b32356ac08388eead31a110af6630cfdb288c3fdac4fb3287e42` | `ac0a61b74008c94f79a52f87d148b3c6e9d178144018ba1e5bdf297b02f7bd0e` |
| Node.js 24.22.1, Linux x64 | 165 | 166 | `971fcb3417a2e57df737cc0f564a998af049d471e13a11c24ee3d06a89ba7a73` | `7bc1e9ca1d39dfac0832d5d67c9e559d4b8d3ec553df6575448f16a0c104559e` |

The same lockfile did not produce byte-identical installed-component inventories. The observed symmetric difference is three components:

| Runtime inventory | Component | Version | License / SBOM observation |
|---|---|---:|---|
| Node 22 only | `@emnapi/runtime` | 1.11.3 | MIT; SBOM marks it optional, development and extraneous |
| Node 22 only | `@img/sharp-wasm32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT; SBOM marks it optional, development and extraneous |
| Node 24 only | `tslib` | 2.8.1 | 0BSD; SBOM scope required |

This is an observed optional/transitive installation or npm-inventory difference, not a lockfile change. Do not infer that the package graph is fully equivalent across runtimes from matching lockfiles alone. The next CI evidence update records Node/npm versions, actual SBOM counts, exact hashes, license inventory and generated timestamps for each matrix job so the variance can be reproduced and explained.

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

Before distributing binaries, containers or hosted downloadable artifacts, the release owner must determine which optional Sharp/libvips variants are actually shipped for each target platform, verify the package license texts and source offers/notices as applicable, include required third-party notices, and obtain legal review where required. Do not remove a license-bearing package from the SBOM merely because a different platform does not load it.

## Stale evidence defect found

The retained `artifacts/evidence/sbom-generation.log` in both CI artifacts stated **163 components / 164 dependency records**, while the actual SBOM documents contained **167 / 168** for Node 22 and **165 / 166** for Node 24. The retained `npm-audit.log` also carried a hard-coded execution date of 2026-10-31, despite the artifacts being generated on 2026-11-01.

The original workflow ran the SBOM generator and audit command successfully, but uploaded old tracked log files rather than fresh output. Therefore:
- The SBOM JSON files themselves are retained and were parsed directly for the counts and hashes above.
- The stale generation and audit logs are not acceptable as contemporaneous evidence.
- The successful audit workflow step is useful CI evidence, but the old log does not prove its result for this run.

PR #36 now replaces the static SBOM log with a generator-produced record containing exact counts, lockfile/SBOM hashes, Node/npm user-agent, platform, generation time and license observations. Its audit step also writes separate full-tree and production-only audit logs from the live commands. The refreshed workflow artifacts must be checked before this defect is considered closed.

## Gate disposition

- **Lockfile reproducibility:** same committed file in both matrix jobs; PASS for file identity only.
- **SBOM generation:** commands and both CycloneDX files succeeded; PARTIAL pending refreshed evidence logs and explanation of runtime inventory differences.
- **Known licenses:** no unidentified license values in either current SBOM; PARTIAL pending notice and distribution analysis, especially LGPL-3.0-or-later components.
- **Vulnerability audit:** both matrix audit steps succeeded in CI; the old retained audit log is stale, and the revised workflow must preserve both full and production-only results before evidence acceptance.
- **Provenance/attestation:** not established by an SBOM alone; still open.
- **Independent review and production certification:** not addressed by this inventory and remain open.

No dependency was purchased, no paid service or external reviewer was engaged, and no funding or liquid reserve is assumed.
