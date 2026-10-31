# SystemFabric 0.5.1 — Release Readiness Report

- Generated: 2026-10-31T21:09:35.326Z
- Node.js: v26.12.1 (win32/x64)
- Production-ready: **NO**
- Release classification: `NOT_PRODUCTION_CERTIFIED`
- Summary: 9 pass; 1 partial; 0 blocked; 13 missing evidence; 0 not run.

> A successful source test suite does not substitute for live integrations, independent review, deployment drills, or parity acceptance. Missing or skipped evidence is not a pass.

| Gate | Status | Details |
|---|---|---|
| Clean, revision-identified release source tree | **PASS** | Clean source tree at f4d78c6037a658006e72785d9bcc403b3508ec6d. |
| Supported Node.js runtime | **PASS** | Required >=22.23.4; running v26.12.1. |
| Reviewed and committed npm lockfile | **PARTIAL** | package-lock.json is present and tracked; fresh isolated npm ci passed, but human dependency review remains required. |
| Versioned migration files | **PASS** | 14 migration files are present; live fresh/upgrade execution is a separate gate. |
| Required artifacts and JavaScript syntax | **PASS** | Exit 0; 11888 ms. Vendored EnginEx version: 6.2.0; required Node.js: >=22.23.4; current Node.js: 26.12.1. \| Database migrations, Memgraph Cypher, live provider calls, and production security are not validated by this script. |
| SystemFabric unit/security tests | **PASS** | Exit 0; {"tests":212,"pass":212,"fail":0,"cancelled":0,"skipped":0,"todo":0}; 22954 ms. Test execution is on v26.12.1. |
| Vendored EnginEx unit tests | **PASS** | Exit 0; {"tests":88,"pass":88,"fail":0,"cancelled":0,"skipped":0,"todo":0}; 2710 ms. |
| PostgreSQL/Memgraph/product integration tests | **PASS** | Exit 0; {"tests":22,"pass":22,"fail":0,"cancelled":0,"skipped":0,"todo":0}; 48226 ms. Skipped tests do not count as production validation. |
| Playwright dependency available | **PASS** | @playwright/test resolves in this checkout; browser execution and results are separate gates. |
| Fresh/upgrade migrations, PostgreSQL transactions and Memgraph outage/replay | **PASS** | Evidence validated; 3 referenced artifact(s). |
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
| Fresh PostgreSQL migrations and idempotency | **PASS** | All 14 migrations applied to a disposable fresh local PostgreSQL database, all 14 skipped on a second pass, then only that disposable database was dropped. |
| Playwright Chromium smoke tests (not full accessibility acceptance) | **PASS** | The configured Chromium Playwright suite passed with zero failed tests; manual screen-reader and broader WCAG review remain open. |
| Local npm dependency audit (high severity threshold) | **PASS** | npm audit --audit-level=high reported 0 vulnerabilities; manual dependency review and CodeQL remain open. |
| CycloneDX SBOM generation | **PASS** | SBOM generation command completed; the retained CycloneDX file is checked separately by maintainers. |
| Memgraph outage and durable projection recovery | **PASS** | The event remained pending with its lease released during outage, replayed after restart and was not delivered again. |
| Canonical graph projection rebuild | **PASS** | Rebuild preserved tombstones, removed stale nodes, honored safety limit and was deterministic on a second run. |
| Local library-object reconciliation dry run | **PASS** | Dry-run used TEST_DATABASE_URL and an isolated temporary directory; no candidates or deletions. |
| CycloneDX SBOM artifact schema | **PASS** | Format CycloneDX 1.5; 163 components and 164 dependency records. Human review/provenance remain open. |

JSON source of truth: `artifacts/release-readiness.json`. See `docs/RELEASE-EVIDENCE.md` for evidence format.
