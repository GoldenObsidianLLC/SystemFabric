# SystemFabric Release Evidence Contract

SystemFabric separates source-level checks from production evidence. A passing unit suite or a checked-in workflow is not proof that a release gate passed.

## Run the report

```bash
npm run release:readiness
npm run release:assert-ready
npm run observability:deployment:validate
```

`release:readiness` runs the source artifact/syntax check, SystemFabric unit/security tests, vendored EnginEx tests, available integration tests, and the production-observability evidence gate. It writes:

- `artifacts/release-readiness.json` — machine-readable gate snapshot.
- `artifacts/release-readiness.md` — human-readable gate snapshot.
- `artifacts/evidence/artifact-check.log` — syntax/artifact check log.
- `artifacts/evidence/unit-tests.tap.log` — SystemFabric unit/security test log.
- `artifacts/evidence/enginex-tests.tap.log` — vendored renderer test log.
- `artifacts/evidence/integration-tests.tap.log` — integration test log, including explicit skips.

The report records the runtime version and marks a suite with skipped tests as partial rather than passed. Production readiness is deliberately fail-closed. `release:assert-ready` exits nonzero until every gate is evidenced as passed.

## Consolidated GitHub Actions evidence

Every workflow run now publishes a separate, revision-bound evidence bundle for the Node.js 22.23.4 and 24.22.1 matrix jobs, the PostgreSQL/Memgraph integration job, browser/accessibility smoke tests, and CodeQL. The final `aggregate-release-evidence` job downloads artifacts from the current workflow run, then cross-checks the GitHub Actions run and job records using read-only Actions API access. Every manifest must match the exact run attempt; artifacts from an earlier rerun cannot be reused as current evidence.

Each bundle contains a strict `manifest.json` and an explicit file inventory. The manifest binds the repository, workflow file/name, event, run ID and attempt, pull-request head SHA, checked-out merge/source SHA, job key/name, runtime, generation timestamp, file sizes, and SHA-256 checksums. The aggregator checks the manifest against the exact GitHub run and corresponding job, verifies all files and checksums (including symlink and unlisted-file rejection), validates the expected logs and JSON summaries, and writes:

- `artifacts/release-readiness-ci.json` — machine-readable consolidated CI evidence.
- `artifacts/release-readiness-ci.md` — reviewer-oriented summary and checksum inventory.

Before the source-tree check, Git's cached stat data is refreshed after deterministic postinstall copies. This does not stage files or rewrite content; it only avoids treating a byte-identical file with a changed timestamp as a source edit. The source-tree check then uses Git's NUL-delimited porcelain status, includes untracked files and submodules, and explicitly lists changed paths. Only the exact generated reports/logs enumerated in `scripts/release-readiness-validation.js` are non-blocking. Unknown files, untracked source, tracked source changes, renames, and line-ending-only changes continue to block a clean-source-tree result. There is no blanket exemption for `artifacts/` or other generated-output directories.

The service-less integration sweep recorded by the Node matrix remains a separate PASS/PARTIAL signal; skipped tests stay PARTIAL and are not promoted to a live integration pass. The dedicated PostgreSQL/Memgraph job is independently checked for positive, zero-skip live test counts, fresh 14-migration application plus idempotent rerun, graph outage/recovery, and canonical rebuild evidence. Browser results require at least one passed test and zero failures/skips. Both npm audit logs must contain a valid summary with no high or critical findings, and the SBOM must be CycloneDX and match the project version/lockfile identity.

The aggregate CI status is not the production release decision. `readyForProduction` deliberately remains `false` and `releaseClassification` remains `NOT_PRODUCTION_CERTIFIED`; independent security review, tenant isolation, live provider acceptance, deployment/operations, legal/licensing, and release-owner approval remain separate gates. A report cannot prove external services or human approvals merely because a CI job succeeded.

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
| `observability-production.json` (deployment-controlled, Git-ignored local copy) | Approved production collector/backend, exact source revision, TLS/authentication/network controls, access/retention/deletion/legal-hold policies, named owners, durable retry/dead-letter delivery, capacity/load evidence, and outage/recovery evidence. See [Production Observability Deployment Contract](OBSERVABILITY-DEPLOYMENT.md). |

A normal evidence file is not sufficient merely because it exists: the report validates its schema and referenced artifact paths. The observability deployment manifest is validated by its dedicated strict contract and must match the exact Git HEAD; its opaque evidence references still require independent human verification in the deployment's controlled evidence system. The local manifest path is ignored by Git intentionally and must not contain secret material. Human review of the evidence and release scope remains mandatory. Never change the release state to certified while any required gate is missing or blocked.
