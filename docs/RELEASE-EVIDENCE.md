# VirgoScorpio Hub Release Evidence Contract

VirgoScorpio Hub separates source-level checks from production evidence. A passing unit suite or a checked-in workflow is not proof that a release gate passed.

## Latest candidate evidence snapshot — 5 November 2026

PR #68 candidate source `5f900faf3b92307977d3858e1bb0897ab12abe66` passed pull-request workflow [run #264](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42015046006), merge ref `7b20c5685288aa47bcc21b0b3e299546c2a1be36`. All six hosted jobs completed successfully. Node 22.23.4 and 24.22.1 each passed 473/473 Hub tests and 94/94 EnginEx tests, with zero failures/skips; both passed 206 required artifact checks and 213 JavaScript syntax checks. Both audits reported zero vulnerabilities.

The candidate pins npm CLI 11.19.1. Both CycloneDX 1.5 SBOMs report 177 components and 178 dependency records from the same lockfile SHA-256 `f404ce5862bffa60daa2cb9cd471e6ac7893b048b2e877e623ddf43c1a15e7ce`; the evidence aggregator confirmed parity of normalized component identities and dependency edges. SBOM generation hashes differ because document metadata/host fields differ; the normalized dependency inventory is identical. License and distribution obligations, including LGPL terms, still require human review.

The dedicated PostgreSQL/Memgraph job passed 65/65 tests with zero skips, fresh-applied 18 migrations, verified 18 idempotent second-pass skips, and dropped only its disposable database. The browser/editor smoke suite passed 9/9; CodeQL and consolidated revision-bound evidence jobs passed. The service-less integration matrix retains 29 skips and remains PARTIAL, not a substitute for the dedicated live service job.

Exact source-bound formal readiness remains **NO-GO** (7 PASS, 2 PARTIAL, 1 BLOCKED, 14 MISSING_EVIDENCE; `readyForProduction: false`). The blocked formal PostgreSQL/Memgraph evidence record lacks current schema/product/version/source SHA identity even though the dedicated CI producer artifact passes; the old local supplemental migration JSON is likewise rejected as stale. Fourteen independent/provider/security/product/operations evidence gates remain missing. PR #68 is open and unmerged; no release is authorized.

## Previous hosted candidate evidence snapshot — 5 November 2026

Hub 0.6.2 PR #68 head `31dd63908fbf8a9fb0340323d92ffd6cdd4d89b9` was tested by GitHub Actions PR run [#260](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41976111045) and push run [#259](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41976023520). All six checks in each run completed successfully. The PR merge-ref was `16d9852126da4aa5c3e15d42460375a2e0ad0cd7`. Node 22.23.4 and 24.22.1 each passed 469/469 Hub tests, 94/94 EnginEx tests, 205 required artifact checks and 213 JavaScript syntax checks. Live PostgreSQL/Memgraph passed 65/65; 18 migrations applied and were skipped on the idempotent second pass; browser smoke passed 9/9; dependency audit reported zero vulnerabilities; CodeQL and consolidated evidence jobs passed.

The exact candidate readiness result on that earlier revision remains **NO-GO**: `NOT_PRODUCTION_CERTIFIED`, `readyForProduction: false`, 8 PASS, 2 PARTIAL and 14 MISSING_EVIDENCE. The CI artifact bundle proved the dedicated live migrations passed; a separate local readiness snapshot consumed tracked 0.5.1 migration evidence and marked the supplemental check BLOCKED because it did not describe the 0.6.2 inventory. This was stale, unversioned evidence—not a failed live migration marker. The follow-up implementation below binds formal and supplemental evidence to schema version, product version and exact Git source revision. PR #68 remains unmerged and no release is authorized.

## Historical mainline evidence snapshot — 4 November 2026

The reviewed 0.6.1 mainline revision is `489325585d57fe95f961c36a597faa7065848c7f`; hosted workflow [run #258](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41949722725) completed all six checks. The Node.js 22.23.4 and 24.22.1 jobs each passed 461/461 Hub tests and 94/94 EnginEx tests; the dedicated PostgreSQL/Memgraph job passed 65/65 tests and verified 18 migrations plus idempotent re-entry; browser smoke passed 9/9; CodeQL and consolidated CI evidence jobs completed successfully.

The formal production gate on this exact revision remains **NO-GO** (8 PASS, 2 PARTIAL, 14 MISSING_EVIDENCE; `readyForProduction: false`). Read the [4 November 2026 full release gate report](reports/2026-11-04-VirgoScorpio-Hub-0.6.1-Release-Gate-Report.md) for evidence detail, all missing external/independent gates, supply-chain observations, and required next steps. The subsequent local 0.6.2 worktree is a separate engineering candidate; its local results do not change or supersede this mainline evidence snapshot.

## Run the report

```bash
npm run release:readiness
npm run release:assert-ready
npm run observability:deployment:validate
```

`release:readiness` runs the source artifact/syntax check, VirgoScorpio Hub unit/security tests, vendored EnginEx tests, available integration tests, and the production-observability evidence gate. It writes:

- `artifacts/release-readiness.json` — machine-readable gate snapshot.
- `artifacts/release-readiness.md` — human-readable gate snapshot.
- `artifacts/evidence/artifact-check.log` — syntax/artifact check log.
- `artifacts/evidence/unit-tests.tap.log` — VirgoScorpio Hub unit/security test log.
- `artifacts/evidence/enginex-tests.tap.log` — vendored renderer test log.
- `artifacts/evidence/integration-tests.tap.log` — integration test log, including explicit skips.

The report records the runtime version and marks a suite with skipped tests as partial rather than passed. Production readiness is deliberately fail-closed. `release:assert-ready` exits nonzero until every gate is evidenced as passed.

## Consolidated GitHub Actions evidence

Every workflow run now publishes a separate, revision-bound evidence bundle for the Node.js 22.23.4 and 24.22.1 matrix jobs, the PostgreSQL/Memgraph integration job, browser/accessibility smoke tests, and CodeQL. The final `aggregate-release-evidence` job downloads artifacts from the current workflow run, then cross-checks the GitHub Actions run and job records using read-only Actions API access. Every manifest must match the exact run attempt; artifacts from an earlier rerun cannot be reused as current evidence.

Each bundle contains a strict `manifest.json` and an explicit file inventory. The manifest binds the repository, workflow file/name, event, run ID and attempt, pull-request head SHA, checked-out merge/source SHA, job key/name, runtime, generation timestamp, file sizes, and SHA-256 checksums. The aggregator checks the manifest against the exact GitHub run and corresponding job, verifies all files and checksums (including symlink and unlisted-file rejection), validates the expected logs and JSON summaries, and writes:

- `artifacts/release-readiness-ci.json` — machine-readable consolidated CI evidence.
- `artifacts/release-readiness-ci.md` — reviewer-oriented summary and checksum inventory.

Before the source-tree check, Git's cached stat data is refreshed after deterministic postinstall copies. This does not stage files or rewrite content; it only avoids treating a byte-identical file with a changed timestamp as a source edit. The source-tree check then uses Git's NUL-delimited porcelain status, includes untracked files and submodules, and explicitly lists changed paths. Only the exact generated reports/logs enumerated in `scripts/release-readiness-validation.js` are non-blocking. Unknown files, untracked source, tracked source changes, renames, and line-ending-only changes continue to block a clean-source-tree result. There is no blanket exemption for `artifacts/` or other generated-output directories.

The service-less integration sweep recorded by the Node matrix remains a separate PASS/PARTIAL signal; skipped tests stay PARTIAL and are not promoted to a live integration pass. The dedicated PostgreSQL/Memgraph job is independently checked for positive, zero-skip live test counts, fresh migration application for the current 18-file inventory plus idempotent rerun, graph outage/recovery, and canonical rebuild evidence. Browser results require at least one passed test and zero failures/skips. Both npm audit logs must contain a valid summary with no high or critical findings. The SBOM must be CycloneDX, match the product/lockfile identity, identify the pinned npm CLI, and have an identical normalized component and dependency graph across the supported Node matrix.

The aggregate CI status is not the production release decision. `readyForProduction` deliberately remains `false` and `releaseClassification` remains `NOT_PRODUCTION_CERTIFIED`; independent security review, tenant isolation, live provider acceptance, deployment/operations, legal/licensing, and release-owner approval remain separate gates. A report cannot prove external services or human approvals merely because a CI job succeeded.

The 0.6.2 candidate pins the CLI as `npm@11.19.1` in `package.json` and the release manifest. Both supported Node.js matrix jobs install and verify that exact CLI before `npm ci`, audit and SBOM generation. The aggregator checks the npm tool version embedded in each SBOM and compares the normalized CycloneDX component identities and dependency edges across runtimes. Timestamp and generator metadata differences are ignored; package or dependency graph differences block CI parity. This removes the prior uncontrolled npm-major variable without rewriting or filtering package inventory content.

## External evidence file format

Evidence belongs under `artifacts/evidence/` using the filenames referenced by `scripts/release-readiness.js`. Each external evidence file must be JSON with this shape:

```json
{
  "schemaVersion": 1,
  "product": "VirgoScorpio Hub",
  "version": "0.6.2",
  "sourceRevision": "<exact 40-character Git HEAD SHA>",
  "status": "passed",
  "executedAt": "2026-11-05T00:00:00.000Z",
  "command": "the exact command or workflow that was run",
  "environment": "runtime, database/provider versions, deployment topology, and relevant configuration (no secrets)",
  "artifacts": [
    "artifacts/evidence/example-run.log"
  ]
}
```

Every formal external evidence record must identify `schemaVersion: 1`, `product: "VirgoScorpio Hub"`, the exact candidate `version`, and `sourceRevision` equal to the full Git HEAD SHA being assessed. The readiness evaluator rejects missing, legacy, stale-version and stale-revision records. Regenerate the evidence after any source commit; do not copy forward an older JSON file or edit its revision field manually. The dedicated CI producer manifests separately bind their artifacts to the workflow run, head SHA and merge SHA.

Every path under `artifacts` must be relative to the repository root and point to an existing retained artifact. Do not claim `passed` when a test skipped, a provider was mocked, credentials were absent, or an audit is only planned. Preserve the unredacted original logs in access-controlled CI storage if they may contain sensitive data; the public artifact should use scrubbed logs and must never contain tokens, passwords, connection strings, personal data, or provider secrets.

## Required external gates

| Evidence file | Required proof |
|---|---|
| `postgres-memgraph-live.json` | Migrations 0001–0018 on a fresh database and the supported v0008 upgrade fixture through the latest schema; transaction rollback; concurrency; outbox replay/dead-letter; graph outage/rebuild/reconciliation. |
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
