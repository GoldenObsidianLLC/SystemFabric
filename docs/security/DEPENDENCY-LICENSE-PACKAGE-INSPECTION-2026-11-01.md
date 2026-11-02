# Dependency license package inspection — 2026-11-01

**Reviewed lockfile:** SHA-256 `5b2b79b4fff771a6f0209f51737b320b0513685db5997b1dce9c437adf0d1ad3`
**Source:** exact package versions and SRI values from the committed `package-lock.json`; package tarballs fetched with `npm pack --ignore-scripts` into a temporary inspection directory.
**Disposition:** package archive identity verified against lockfile integrity for all seven inspected packages. License-text/notice completeness remains open, especially for bundled libvips binaries.

This is a limited package-content inspection. It is not a legal opinion, full software composition analysis, or proof that all dependencies in every deployment image have been included.

## Exact package archive inspection

For each package below, the downloaded tarball's SHA-512 digest matched the `integrity` value in the reviewed lockfile. SHA-256 values are included to identify the exact inspected archive.

| Package | Version | Declared license | Lockfile SRI match | Archive SHA-256 | License / notice files in tarball |
|---|---:|---|---|---|---|
| `@img/sharp-libvips-linux-x64` | 1.3.4 | LGPL-3.0-or-later | Yes | `e371cb713fc8822c96a0d3fb60a3d092799d0aefab6d7f1fb3b72d8d75f1d109` | No LICENSE, COPYING or NOTICE file found. Package manifest declares LGPL-3.0-or-later. |
| `@img/sharp-libvips-linuxmusl-x64` | 1.3.4 | LGPL-3.0-or-later | Yes | `c6312802c16511458a1cf3d990c3e2b9dba555932caf297025ba0bec34ee5cbe` | No LICENSE, COPYING or NOTICE file found. Package manifest declares LGPL-3.0-or-later. |
| `@img/sharp-wasm32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | Yes | `c68abdf53e1ad2d7b27b53385a3862e16d4bde02ce6d121892ee36f0bfe5bb38` | Contains `package/LICENSE`; inspected file begins with Apache License 2.0. This single file does not by itself account for the full compound license expression. |
| `@img/sharp-win32-x64` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | Yes | `16a804181ddd258ca6fe7079b2faa0c0356654c9db3d93ab0a80ec5e5161c3d4` | Contains `package/LICENSE`; inspected file begins with Apache License 2.0. This single file does not by itself account for the full compound license expression. |
| `sharp` | 0.35.5 | Apache-2.0 | Yes | `3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac` | Contains `package/LICENSE`; inspected file begins with Apache License 2.0. |
| `@emnapi/runtime` | 1.11.3 | MIT | Yes | `e6eb8913a08b551436d65f9a5cfbdcc8006f58e6798226d24e695c25679b5e49` | Contains `package/LICENSE`; inspected file is the MIT License and names Toyobayashi copyright 2021-present. |
| `tslib` | 2.8.1 | 0BSD | Yes | `66f635d5eeabae44807534976913a102cf615b9a045368359c9f79ae6ee2119e` | Contains `package/LICENSE.txt` and `package/CopyrightNotice.txt`; inspected text states Microsoft Corporation and grants use/copy/modify/distribute with or without fee. |

## Findings and required follow-up

1. The two Linux libvips platform archives contain prebuilt binary payloads but no separate LICENSE/COPYING/NOTICE file in the published tarball. Their package manifests declare LGPL-3.0-or-later. Do not mistake an absent text file in the archive for an absence of license obligations. The distribution owner must obtain the applicable license text and notices from the upstream project and determine what source, relinking, offer or corresponding-source obligations apply to the product's actual distribution model.

2. The WASM and Windows Sharp platform packages declare compound SPDX expressions including LGPL-3.0-or-later, but the tarballs inspected here each contain a LICENSE file beginning with Apache License 2.0. The package metadata and actual bundled components therefore require a file/component-level mapping from the upstream maintainer or a qualified reviewer. Do not infer that the single included Apache text exhausts the compound expression.

3. The Windows x64 Sharp platform archive was inspected as an additional platform sample because the local Windows installation can select it. It is not a component listed in either latest Linux CI SBOM. Linux glibc and musl libvips variants were inspected because they are present in those CI inventories.

4. The `@emnapi/runtime` and `tslib` archives were inspected to check the MIT and 0BSD license entries corresponding to the differing Node 22/Node 24 SBOM component lists. Their downloaded archive hashes matched the committed lockfile's integrity values.

5. This inspection covers seven named packages, not every direct or transitive package in the full product dependency graph. The CycloneDX files remain the authoritative inventory snapshots for the CI runtime environments; a full license notice package must include all applicable packages for each target distribution.

## Gate status

- **Archive identity:** PASS for the seven inspected packages; all downloaded archive SRI values matched the committed lockfile.
- **Declared license metadata:** recorded for all seven inspected packages.
- **Bundled license-text completeness:** OPEN. Two Linux libvips archives contain no license text file; compound license expressions in WASM/Windows Sharp platform archives need mapping.
- **Distribution notices/source obligations:** OPEN, requires maintainer/legal review against the actual binary/container and hosted distribution model.
- **Release approval:** NOT implied. SystemFabric remains `NOT_PRODUCTION_CERTIFIED / NO-GO`.

No dependency was installed into the repository or runtime for this inspection. The downloaded tarballs and extracted contents were confined to a temporary directory outside the repository. No paid service or external assessor was engaged, and no spending or liquid reserve is assumed.
