# Release Readiness and Certification Gates

> **Current status: NOT_PRODUCTION_CERTIFIED.** The readiness report is an engineering evidence snapshot, not production approval.

## Current candidate snapshot — 5 November 2026

Hub 0.6.2 is proposed in PR [#68](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/68), head commit `31dd63908fbf8a9fb0340323d92ffd6cdd4d89b9`. PR CI run [#260](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41976111045) and push run [#259](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41976023520) passed all six checks. The revision-bound PR merge-ref is `16d9852126da4aa5c3e15d42460375a2e0ad0cd7`; its Node.js 22.23.4 and 24.22.1 jobs each passed 469/469 Hub tests, 94/94 EnginEx tests, 205 required artifact checks and 213 JavaScript syntax checks. Dedicated live PostgreSQL/Memgraph passed 65/65 tests, applied 18/18 migrations with an idempotent second pass, and browser smoke passed 9/9. Dependency audit reported zero vulnerabilities; CodeQL workflow and consolidated evidence passed.

The formal evaluator on both runtime jobs reports `NOT_PRODUCTION_CERTIFIED`, `readyForProduction: false`, 8 PASS, 2 PARTIAL and 14 MISSING_EVIDENCE. The evidence aggregator separately records production certification as BLOCKED because independent/provider/operational approval is not part of CI. A supplemental fresh-migration marker/parser discrepancy is documented in the [5 November 2026 0.6.2 Release Gate Report](reports/2026-11-05-VirgoScorpio-Hub-0.6.2-Release-Gate-Report.md). PR #68 remains open and unmerged; no release tag or GitHub Release has been published.

The complete exact-revision assessment, SBOM variance and all 14 external evidence blockers are in the [0.6.2 Release Gate Report](reports/2026-11-05-VirgoScorpio-Hub-0.6.2-Release-Gate-Report.md). The 4 November report below is retained as the prior 0.6.1 mainline snapshot.

## Current mainline snapshot — 4 November 2026

The current default branch was reviewed at commit `489325585d57fe95f961c36a597faa7065848c7f` (`refactor(api): extract AI task route family`, PR #67). Hosted CI run [#258 / 41949722725](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41949722725) completed all six checks successfully: Node.js 22.23.4, Node.js 24.22.1, dedicated PostgreSQL/Memgraph integration, browser/accessibility smoke, CodeQL, and consolidated revision-bound evidence. Both runtime jobs passed 461/461 Hub tests and 94/94 EnginEx tests; the live database job passed 65/65 tests and applied all 18 migrations with an idempotent second pass; browser smoke passed 9/9.

The formal readiness evaluator on this revision remains **NO-GO**: 8 PASS, 2 PARTIAL, 0 BLOCKED, 14 MISSING_EVIDENCE and 0 NOT_RUN; `readyForProduction` is false. The outstanding items include independent tenant-isolation/security reviews, live identity/scanner/cloud/Stripe provider verification, full accessibility and product acceptance, signed plugin isolation, SBOM/license/provenance review, load/backup/restore, production observability, operations and release-owner approval. Green CI is engineering evidence, not production certification.

The complete revision-bound assessment is in the [4 November 2026 VirgoScorpio Hub 0.6.1 Release Gate Report](reports/2026-11-04-VirgoScorpio-Hub-0.6.1-Release-Gate-Report.md). The report preserves the distinction between the 0.6.1 mainline candidate and the follow-on 0.6.2 local development branch. No release tag or GitHub Release was published at review time.

## Historical pre-PR #65 assessment — 4 November 2026 (superseded)

PR [#59](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/59) completed the identity cutover. PR #61 added the encrypted durable AI queue foundation; PR #62 centralized transaction/version infrastructure; PR #63 extracted browser auth routes/cookie handling; and PR #64 separated session persistence/lifecycle from identity orchestration. These PRs are merged to `main` at the latest pre-candidate commit `aa361ab` (4 November 2026). They are code changes, not release-certification events. The detailed candidate evidence below was generated on 1 November and is historical, not current-commit evidence.

The post-PR #63 CodeQL analysis on `dc4a82d` marked High auth-cookie alerts #30–#33 fixed without manual dismissal. Medium alert #14 (`js/unsafe-code-construction`) remains open on the `aa361ab` baseline, at the now-removed vendor legacy renderer. PR #65 is the 0.6.0 / EnginEx 7.0.0 compatibility/security candidate that removes that legacy execution adapter; its CodeQL and other hosted checks must pass before the alert can be recorded as fixed. No finding is manually dismissed or suppressed.

**Historical disposition for the pre-PR #65 snapshot:** NOT_PRODUCTION_CERTIFIED / NO-GO. This section records the then-current 0.6.0 candidate and is retained for audit continuity; use the current mainline snapshot above and the linked 4 November report for the latest evidence.

## Historical candidate snapshot — 1 November 2026

The latest reviewed engineering evidence is recorded in the [1 November 2026 project status report](reports/2026-11-01-VirgoScorpio-Hub-0.5.1-Project-Status-Report.md). It covers candidate PR #36 at `f9d463ef9ca82d15c9220e15cf50df2ba6367a11` (based on `main` `1a903b8eab4304dd61b2489381b091d34f1ea546`). The candidate's latest hosted workflow completed all five jobs successfully, including the dedicated PostgreSQL/Memgraph job (22/22 tests, zero skips), fresh migrations (14/14 applied, 14/14 idempotently skipped), Chromium smoke (9/9), and CodeQL analysis execution.

The candidate readiness snapshots report **6 PASS, 2 PARTIAL, 2 BLOCKED, 13 MISSING_EVIDENCE, 0 NOT_RUN**. The two blockers concern (1) source-tree changes observed on a generated merge-ref checkout, whose exact four paths require diagnosis, and (2) readiness failing to aggregate the separate live integration job. The service-less matrix integration skips must remain distinct from the 22/22 dedicated live result. These are unresolved readiness-control issues, not a failed live integration run.

The candidate still has five open CodeQL results (four High and one Medium), no independent tenant-isolation or application-security review, no accepted production-provider/operations evidence, and no release-owner scope approval. **Production remains NO-GO; `readyForProduction` remains false.** This summary does not close any gate or imply PR #36 is merged.

## Historical recorded assessment (31 October 2026; superseded)

The authoritative recorded snapshot is generated by `npm run release:readiness` and retained in:

- `artifacts/release-readiness.md` — human-readable summary.
- `artifacts/release-readiness.json` — machine-readable source of truth.

The latest retained snapshot reports:

| Status | Count | Interpretation |
|---|---:|---|
| Pass | 9 | Source cleanliness, supported runtime, migration inventory, syntax/artifact check, unit/security tests, EnginEx tests, live integration, Playwright dependency availability, and PostgreSQL/Memgraph live evidence. |
| Partial | 1 | The committed npm lockfile installs reproducibly, but a maintainer has not completed the explicit dependency/lockfile review. |
| Blocked | 0 | No current source-level check is recorded as failed. |
| Missing evidence | 13 | External or independent certification gates remain without accepted evidence. |
| Not run | 0 | All programmatic checks configured by the report ran. |

The machine report tracks **9 programmatic checks plus 14 external evidence gates (23 rows total)**. One external gate (PostgreSQL/Memgraph live integration) passed; 13 remain open. The retained report was generated at `2026-10-31T21:09:35.326Z` on source commit `f4d78c6037a658006e72785d9bcc403b3508ec6d`, before PR #12 was squash-merged. The resulting main commit is `81e31b235a846c291d3d100eb33c08bf0ecd86cf`. Treat the artifact as the latest recorded snapshot, not as a report generated from the exact merge commit. Regenerate and reconcile the report when preparing the actual release candidate.

### Certification execution plan

See [Production Certification Execution Plan](PRODUCTION-CERTIFICATION-PLAN.md) for the sequenced 13-gate work plan, release-scope/provider matrix, independent tenant-isolation review checklist, workstream owners, evidence acceptance rules, and release exit criteria.

### Confirmed engineering evidence

- `npm run check`: 212/212 VirgoScorpio Hub unit/security tests passed, zero skips; 146 required artifacts and 143 JavaScript files checked.
- `npm --prefix vendor/enginex test`: 88/88 passed, zero skips.
- Fresh PostgreSQL database: all 14 migrations applied, then all 14 skipped on the second pass; only the generated disposable test database was dropped.
- Live local PostgreSQL/Memgraph/Redis integration: 22/22 passed, zero skips, against the dedicated `virgoscorpio_hub_test` database.
- Memgraph outage/recovery and canonical graph rebuild rehearsals passed using isolated test resources.
- Playwright Chromium suite: 9/9 passed with one worker, including editor, accessibility smoke, two-session collaboration and multi-node collaboration recovery. Manual screen-reader and broader WCAG acceptance remain open.
- `npm audit --audit-level=high` and runtime-only audit both reported zero vulnerabilities.
- CycloneDX 1.5 SBOM generated with 163 components and 164 dependency records.
- Gitleaks working-tree and locally fetched Git-history scans exited successfully with zero findings. Re-scan the exact published refs before release.
- PR #12 validation completed successfully: workflow runs [41242423422](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41242423422) and [41242454838](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41242454838) each passed all five jobs on the release-tooling correction.
- Post-merge main workflow [41242636499](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41242636499) passed all five jobs on merge commit `81e31b235a846c291d3d100eb33c08bf0ecd86cf` (Node.js 22.23.4 and 24.22.1, PostgreSQL/Memgraph integration, browser/accessibility smoke, and CodeQL).

These are development/test results only. They do not prove production deployment behavior or replace third-party, manual, or independent assessments.

## Remaining certification gates

### Build and test integrity

- [x] Fresh database install and migrations 0001–0014 pass on a disposable PostgreSQL database.
- [x] Supported v0008 upgrade fixture is exercised through the current migration set by the integration runner.
- [x] Live PostgreSQL/Memgraph integration passes with zero skipped tests on the current application baseline.
- [x] Hosted CI passes on the release-tooling correction across the supported Node.js matrix and all configured jobs. See the PR and post-merge workflow runs above.

### Identity, tenancy, and external providers

- [ ] Independent tenant/site isolation and authorization review across applicable routes and capabilities. The regression test expansion in merged PR #10 is targeted coverage, not an independent review.
- [ ] Real OIDC/SAML, email delivery, MFA recovery, replay/rotation/logout and outage flows for the providers in the approved release scope.
- [ ] Live ClamAV (or selected scanner) malicious-file corpus, timeout/unavailable behavior, false-positive handling and legacy-asset quarantine/rescan.
- [ ] Live object-storage provider authentication, least-privilege read/write/delete, credential resolution, encryption, retention and lifecycle tests for every provider enabled or claimed for this release.
- [ ] Stripe checkout/webhook replay, ambiguous network outcomes, inventory reservation, refund and subscription lifecycle validation.

### Browser, product acceptance, isolation and supply chain

- [ ] Full browser/accessibility acceptance, including manual keyboard, focus, contrast and screen-reader review. The 9-test Playwright suite is smoke/functional evidence, not this entire gate.
- [ ] Scoped commerce acceptance for tax, shipping, discounts, refunds, fulfilment, entitlements and subscriptions. Do not claim full parity for incomplete features.
- [ ] Scoped community acceptance for group privacy, forums, abuse controls, search, export and deletion. The release manifest explicitly records some of these features as incomplete.
- [ ] Plugin build/sign/provenance pipeline and adversarial container isolation in the actual supported runtime.
- [ ] Maintainer review of the committed lockfile and dependency tree; retained SBOM/provenance/attestation; current CodeQL and dependency-analysis evidence on the release candidate. npm audit, SBOM generation and hosted CodeQL have passed, but the complete reviewed evidence record remains open.

### Operations and approval

- [ ] Representative load/soak, resource-exhaustion and fault-injection tests.
- [ ] Backup restoration, database/graph recovery and storage crash-recovery drills.
- [ ] Independent security assessment; critical/high findings resolved or formally accepted with owners.
- [ ] Deployment and rollback runbooks, secret rotation, monitoring/alerting and incident response reviewed.
- [ ] Named operations/release owner records explicit approval for a defined release scope.

## Evidence record template

For each remaining gate, record:

| Field | Required value |
|---|---|
| Gate | Named requirement. |
| Commit | Full SHA reviewed. |
| Environment | OS/runtime, service/provider versions, topology and relevant configuration; no secrets. |
| Command or procedure | Exact command or linked runbook. |
| Result | Pass, partial, blocked or not run. |
| Evidence | Retained workflow, report, artifact or approval record. |
| Reviewer/date | Named reviewer or accountable role and UTC date. |
| Caveats | Limitations, skipped tests, failures or approved waivers. |

## Release decision

VirgoScorpio Hub remains **NOT_PRODUCTION_CERTIFIED**. Do not mark it production-ready until every required gate has current evidence for the intended release revision, exceptions are documented and approved, restore/rollback paths are proven, and the release owner signs off. A green CI run, public repository, or a passed unit suite is not production certification.

### Recommended developer-preview scope

The [0.5.1 release-scope proposal](RELEASE-SCOPE.md) remains a historical proposal pending named release-owner approval. Reconcile its exclusions and limitations against the 0.6.0 candidate before preparing a release decision. It does not certify production or waive any evidence gate.
