# SystemFabric 0.5.1 — Release Readiness Report

- Generated: 2026-10-27T23:41:31.987Z
- Node.js: v22.16.0 (linux/x64)
- Production-ready: **NO**
- Release classification: `NOT_PRODUCTION_CERTIFIED`
- Summary: 4 pass; 1 partial; 3 blocked; 14 missing evidence; 0 not run.

> A successful source test suite does not substitute for live integrations, independent review, deployment drills, or parity acceptance. Missing or skipped evidence is not a pass.

| Gate | Status | Details |
|---|---|---|
| Supported Node.js runtime | **BLOCKED** | Required >=22.23.4; running v22.16.0. |
| Reviewed and committed npm lockfile | **BLOCKED** | package-lock.json is absent; reproducible npm ci cannot be certified. |
| Versioned migration files | **PASS** | 8 migration files are present; live fresh/upgrade execution is a separate gate. |
| Required artifacts and JavaScript syntax | **PASS** | Exit 0; 2346 ms.  \| WARNING: current runtime is below the declared minimum; results are development checks only, not supported-runtime validation. |
| SystemFabric unit/security tests | **PASS** | Exit 0; {"tests":105,"pass":105,"fail":0,"cancelled":0,"skipped":0,"todo":0}; 1695 ms. Test execution is on v22.16.0. |
| Vendored EnginEx unit tests | **PASS** | Exit 0; {"tests":88,"pass":88,"fail":0,"cancelled":0,"skipped":0,"todo":0}; 1043 ms. |
| PostgreSQL/Memgraph/product integration tests | **PARTIAL** | Exit 0; {"tests":5,"pass":0,"fail":0,"cancelled":0,"skipped":5,"todo":0}; 219 ms. Skipped tests do not count as production validation. |
| Playwright dependency available | **BLOCKED** | @playwright/test is not installed/resolvable in this checkout. |
| Fresh/upgrade migrations, PostgreSQL transactions and Memgraph outage/replay | **MISSING_EVIDENCE** | No evidence file at artifacts/evidence/postgres-memgraph-live.json. |
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

JSON source of truth: `artifacts/release-readiness.json`. See `docs/RELEASE-EVIDENCE.md` for evidence format.
