# SystemFabric 0.5.1 — Release Readiness Report

- Generated: 2026-10-30T23:06:48.244Z
- Node.js: v26.12.1 (win32/x64)
- Production-ready: **NO**
- Release classification: `NOT_PRODUCTION_CERTIFIED`
- Summary: 7 pass; 1 partial; 2 blocked; 13 missing evidence; 0 not run.

> A successful source test suite does not substitute for live integrations, independent review, deployment drills, or parity acceptance. Missing or skipped evidence is not a pass.

| Gate | Status | Details |
|---|---|---|
| Clean, revision-identified release source tree | **BLOCKED** | HEAD 637e1b15059892550192597e237c54ada51e87b9; 55 tracked/untracked path(s) are modified. Release evidence must be regenerated for a clean, committed target revision. |
| Supported Node.js runtime | **PASS** | Required >=22.23.4; running v26.12.1. |
| Reviewed and committed npm lockfile | **PARTIAL** | package-lock.json is present and tracked; fresh isolated npm ci passed, but human dependency review remains required. |
| Versioned migration files | **PASS** | 13 migration files are present; live fresh/upgrade execution is a separate gate. |
| Required artifacts and JavaScript syntax | **PASS** | Exit 0; 9920 ms. Vendored EnginEx version: 6.2.0; required Node.js: >=22.23.4; current Node.js: 26.12.1. \| Database migrations, Memgraph Cypher, live provider calls, and production security are not validated by this script. |
| SystemFabric unit/security tests | **PASS** | Exit 0; {"tests":147,"pass":147,"fail":0,"cancelled":0,"skipped":0,"todo":0}; 9230 ms. Test execution is on v26.12.1. |
| Vendored EnginEx unit tests | **PASS** | Exit 0; {"tests":88,"pass":88,"fail":0,"cancelled":0,"skipped":0,"todo":0}; 2570 ms. |
| PostgreSQL/Memgraph/product integration tests | **PASS** | Exit 0; {"tests":16,"pass":16,"fail":0,"cancelled":0,"skipped":0,"todo":0}; 11419 ms. Skipped tests do not count as production validation. |
| Playwright dependency available | **PASS** | @playwright/test resolves in this checkout; browser execution and results are separate gates. |
| Fresh/upgrade migrations, PostgreSQL transactions and Memgraph outage/replay | **BLOCKED** | Evidence targets 4653c84f21e9652affeebbb36f5803cd7354d397, but current HEAD is 637e1b15059892550192597e237c54ada51e87b9; rerun against the exact release revision. |
| Independent tenant-isolation and authorization review | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/tenant-isolation-review.json. |
| OIDC/SAML/email delivery/MFA recovery end-to-end evidence | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/identity-provider-e2e.json. |
| Live ClamAV, malicious-file corpus and legacy-asset quarantine | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/clamav-corpus.json. |
| Live S3/GCS/Azure/S3-compatible credentials and least-privilege operations | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/cloud-live-providers.json. |
| Stripe webhook replay, ambiguous-outcome recovery and inventory lifecycle | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/stripe-live-lifecycle.json. |
| Playwright editor journeys and WCAG-focused accessibility acceptance | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/browser-accessibility.json. |
| Tax/shipping/coupons/refunds/fulfilment/downloads/subscription acceptance | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/commerce-parity-acceptance.json. |
| Group privacy, spam/abuse, search, export/deletion and forum acceptance | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/community-parity-acceptance.json. |
| Signed plugin pipeline and adversarial container isolation | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/plugin-container-isolation.json. |
| Reviewed dependency audit, SBOM/provenance and CodeQL evidence | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/dependency-sbom-codeql.json. |
| Load/soak, fault injection, backup/restore and recovery drills | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/load-backup-restore.json. |
| Independent security assessment and severe-finding remediation | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/independent-security-review.json. |
| Deployment runbooks, secrets/rollback plan, monitoring and release approval | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/operations-release-approval.json. |

## Supplemental local evidence (not included in the formal gate count)

These additional local checks passed. They do not replace the independent/external acceptance gates above.

| Local check | Status | Details |
|---|---|---|
| Fresh clean npm ci installation | **PASS** | Fresh isolated npm ci completed on Windows x64 / Node.js 26.12.1, installed 167 packages and ran the KaTeX postinstall; maintainer review and CI matrix evidence remain open. |
| Fresh PostgreSQL migrations and idempotency | **PASS** | All 13 migrations applied to a disposable fresh local PostgreSQL database, all 13 skipped on a second pass, then only that disposable database was dropped. |
| Playwright Chromium smoke tests (not full accessibility acceptance) | **PASS** | 4 Chromium smoke tests passed with one worker; broader browser acceptance and manual WCAG review remain open. |
| Local npm dependency audit (high severity threshold) | **PASS** | npm audit --audit-level=high reported 0 vulnerabilities; manual dependency review and CodeQL remain open. |
| CycloneDX SBOM generation | **PASS** | SBOM generation command completed; the retained CycloneDX file is checked separately by maintainers. |
| Memgraph outage and durable projection recovery | **PASS** | The event remained pending with its lease released during outage, replayed after restart and was not delivered again. |
| Canonical graph projection rebuild | **PASS** | Rebuild preserved tombstones, removed stale nodes, honored safety limit and was deterministic on a second run. |
| Local library-object reconciliation dry run | **PASS** | Dry-run used TEST_DATABASE_URL and an isolated temporary directory; no candidates or deletions. |
| CycloneDX SBOM artifact schema | **PASS** | Format CycloneDX 1.5; 162 components and 163 dependency records. Human review/provenance remain open. |

JSON source of truth: `artifacts/release-readiness.json`. See `docs/RELEASE-EVIDENCE.md` for evidence format.
