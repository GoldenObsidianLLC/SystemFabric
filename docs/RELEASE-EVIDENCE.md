# SystemFabric Release Evidence Contract

SystemFabric separates source-level checks from production evidence. A passing unit suite or a checked-in workflow is not proof that a release gate passed.

## Run the report

```bash
npm run release:readiness
npm run release:assert-ready
```

`release:readiness` runs the source artifact/syntax check, SystemFabric unit/security tests, vendored EnginEx tests, and available integration tests. It writes:

- `artifacts/release-readiness.json` — machine-readable gate snapshot.
- `artifacts/release-readiness.md` — human-readable gate snapshot.
- `artifacts/evidence/artifact-check.log` — syntax/artifact check log.
- `artifacts/evidence/unit-tests.tap.log` — SystemFabric unit/security test log.
- `artifacts/evidence/enginex-tests.tap.log` — vendored renderer test log.
- `artifacts/evidence/integration-tests.tap.log` — integration test log, including explicit skips.

The report records the runtime version and marks a suite with skipped tests as partial rather than passed. Production readiness is deliberately fail-closed. `release:assert-ready` exits nonzero until every gate is evidenced as passed.

## External evidence file format

Evidence belongs under `artifacts/evidence/` using the filenames referenced by `scripts/release-readiness.js`. Each external evidence file must be JSON with this shape:

```json
{
  "status": "passed",
  "executedAt": "2026-10-27T23:00:00.000Z",
  "command": "the exact command or workflow that was run",
  "environment": "runtime, database/provider versions, deployment topology, and relevant configuration (no secrets)",
  "artifacts": [
    "artifacts/evidence/example-run.log"
  ]
}
```

Every path under `artifacts` must be relative to the repository root and point to an existing retained artifact. Do not claim `passed` when a test skipped, a provider was mocked, credentials were absent, or an audit is only planned. Preserve the unredacted original logs in access-controlled CI storage if they may contain sensitive data; the public artifact should use scrubbed logs and must never contain tokens, passwords, connection strings, personal data, or provider secrets.

## Required external gates

| Evidence file | Required proof |
|---|---|
| `postgres-memgraph-live.json` | Migrations 0001–0014 on a fresh database and the supported v0008 upgrade fixture through the latest schema; transaction rollback; concurrency; outbox replay/dead-letter; graph outage/rebuild/reconciliation. |
| `tenant-isolation-review.json` | Role/capability matrix and adversarial cross-site tests, with independent authorization review. |
| `identity-provider-e2e.json` | Real isolated OIDC/SAML/email/MFA recovery flows, replay/rotation/logout/outage handling. |
| `clamav-corpus.json` | Live scanner behavior including known test signatures, timeout/unavailable states, false positives and legacy asset quarantine. |
| `cloud-live-providers.json` | Live provider authentication and least-privilege read/write/delete/lifecycle tests for each advertised provider. |
| `stripe-live-lifecycle.json` | Checkout idempotency, signed/replayed/out-of-order webhooks, ambiguous network outcomes, payment/expiration/failure and inventory reservation transitions. |
| `browser-accessibility.json` | Playwright acceptance for editing/publishing/media/recovery and manual keyboard/screen-reader review. |
| `commerce-parity-acceptance.json` | Explicitly scoped acceptance for taxes, shipping, discounts, refunds, fulfillment, entitlements, and subscription lifecycle. |
| `community-parity-acceptance.json` | Group privacy, forums, abuse controls, search, data export/deletion and browser acceptance. |
| `plugin-container-isolation.json` | Build/scan/SBOM/sign/provenance verification and adversarial runtime isolation. |
| `dependency-sbom-codeql.json` | Reviewed lockfile, clean install, dependency audit, SBOM, provenance and CodeQL results. |
| `load-backup-restore.json` | Reproducible load/soak/fault tests plus backup/restore and graph rebuild drills. |
| `independent-security-review.json` | Independent assessment, findings, severity, owners and remediation verification. |
| `operations-release-approval.json` | Deployment/rollback runbooks, secret rotation, monitoring/alerting, incident response and explicit release approval. |

An evidence file is not sufficient merely because it exists: the report validates its schema and referenced artifact paths. Human review of the evidence and release scope remains mandatory. Never change the release state to certified while any required gate is missing or blocked.
