# VirgoScorpio Hub 0.6.1 Release Gate Report

**Assessment date:** 4 November 2026 (America/Chicago)
**Repository:** [GoldenObsidianLLC/VirgoScorpio-Hub](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub)
**Branch assessed:** `main`
**Assessed source revision:** `489325585d57fe95f961c36a597faa7065848c7f`
**Latest main change:** PR [#67 — extract AI task route family](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/67)
**Package version:** `0.6.1` (unreleased patch candidate)
**CI evidence:** [Run #258 — 41949722725](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41949722725)

> **Release decision: NO-GO for production.** The current default-branch engineering pipeline is green, but the formal readiness evaluator reports `readyForProduction: false` and classifies this revision as `NOT_PRODUCTION_CERTIFIED`. No GitHub Release or release tag is published.

## 1. Executive decision

The 0.6.1 mainline is a strong engineering baseline: supported Node.js matrix checks, unit/security tests, live PostgreSQL/Memgraph integration, browser smoke, CodeQL execution, dependency audit and consolidated CI evidence all passed on the exact assessed commit.

That evidence does **not** establish production readiness. The machine-readable release-readiness result is:

| Gate status | Count | Assessment |
|---|---:|---|
| PASS | 8 | Configured engineering checks passed. |
| PARTIAL | 2 | Some evidence exists, but maintainer/coverage qualification remains. |
| BLOCKED | 0 | No current automated blocker was recorded. |
| MISSING_EVIDENCE | 14 | Required provider, independent, accessibility, operational and approval evidence is absent. |
| NOT_RUN | 0 | Every configured readiness row was evaluated. |

**Disposition:** continue the 0.6.2 internal modularity candidate on a feature branch, but do not publish, tag, or deploy 0.6.1/0.6.2 as production-certified until all required evidence is accepted and a named release owner approves the exact release commit.

## 2. Source and repository identity

| Item | Observed state |
|---|---|
| Remote default branch | `main` |
| Assessed commit | `489325585d57fe95f961c36a597faa7065848c7f` |
| Commit subject | `refactor(api): extract AI task route family (#67)` |
| Commit date | 4 November 2026 |
| `package.json` version | `0.6.1` |
| Node minimum | `>=22.23.4` |
| Vendored EnginEx | `7.0.0` |
| Database migrations inventoried | 18 (`0001`–`0018`) |
| GitHub Releases | None published at review time |
| Git tags | No release tags returned at review time |
| Branch protection | `main` reported `protected: false` |

PRs #65, #66 and #67 are merged to `main`. PR #65 removed the legacy arbitrary-JavaScript EnginEx renderer and advanced the Hub to the 0.6.0 minor candidate. PR #66 extracted commerce and membership HTTP routes. PR #67 extracted authenticated AI-task status/history/detail routes. The 0.6.1 line is still an unreleased patch candidate; merge status does not equal release approval.

## 3. Hosted CI — PASS

The latest push workflow is run **#258 / 41949722725**, attached to the assessed SHA. All six check-runs completed successfully:

| Check family | Result | Evidence |
|---|---|---|
| Node.js 22.23.4 unit, security and dependency checks | PASS | 461/461 root tests; 94/94 EnginEx tests; syntax/artifact validation; dependency audit/SBOM steps. |
| Node.js 24.22.1 unit, security and dependency checks | PASS | 461/461 root tests; 94/94 EnginEx tests; syntax/artifact validation; dependency audit/SBOM steps. |
| PostgreSQL/Memgraph live integration | PASS | 65/65 live integration tests, zero failures and zero skips. |
| Browser editor/accessibility smoke | PASS | 9/9 Playwright smoke tests. |
| CodeQL analysis | PASS | Analysis workflow completed successfully. |
| Consolidated candidate CI evidence | PASS | Evidence aggregation check completed successfully. |

### 3.1 Runtime, tests and source integrity

- Both supported CI runtimes reported **461/461** root tests passed, with zero failed and zero skipped.
- Vendored EnginEx 7.0.0 reported **94/94** tests passed on both runtime jobs.
- The artifact/syntax validation checked **202 required paths** and syntax-checked **211 JavaScript files**.
- The source checkout used by the consolidated evidence job was revision-identified and clean.
- The service-less integration suites still report **29 skips** in their separate test context. Those skips are not treated as proof of live service coverage or as a failed live integration run; the dedicated PostgreSQL/Memgraph job independently passed 65/65.

### 3.2 PostgreSQL, Memgraph and migration evidence

- Dedicated live integration: **65/65 passed**, zero skips/failures, against the dedicated `virgoscorpio_hub_test` database.
- Fresh migration exercise: **18/18 migrations applied** to a disposable database; a second pass reported **18/18 already applied/skipped**, confirming idempotent re-entry for that test path.
- The disposable database was dropped by the test workflow.
- Memgraph outage/replay preserved the pending event while the graph service was unavailable, released the lease, replayed after recovery and avoided duplicate delivery.
- Canonical graph rebuild preserved tombstones, removed stale projected nodes, rebuilt the expected content/taxonomy/relationships and produced a deterministic second rebuild.

These are valuable bounded CI exercises. They do not replace production backup/restore, deployment migration rehearsal or representative load/soak testing.

### 3.3 Browser and performance observations

- Playwright smoke: **9/9 passed**. Coverage includes editor flows, accessibility smoke, two-/five-/ten-editor collaboration matrices, dropped Redis hints/heartbeat recovery and node-failure recovery.
- The test harness observed approximately **2.15 seconds P95** and **2.17 seconds P99** over 153 samples in one bounded scenario; the ten-editor reconnect storm measured approximately 151 ms.
- These figures are test-harness observations only. They are not a production latency SLO, a capacity guarantee or a substitute for load/soak testing.
- Manual keyboard, screen-reader, contrast, focus and broader WCAG acceptance remain open.

## 4. Security and software supply chain

### 4.1 Dependency audit — PASS

The hosted matrix ran both `npm audit --audit-level=high` and the production-only `npm audit --omit=dev --audit-level=high`; both reported **zero vulnerabilities**.

This is a point-in-time dependency database result. It does not replace maintainer review, package/license obligations, provenance verification or independent security review.

### 4.2 CodeQL — workflow PASS; human disposition still required

The CodeQL workflow completed successfully on the assessed commit. PR #67's merge description reports zero open alerts on the latest main analysis. This review did not independently export and reconcile the full code-scanning alert inventory from the Security dashboard; therefore the workflow result is recorded as PASS, while final human alert disposition remains part of the supply-chain/security evidence gate.

Earlier High auth-cookie findings #30–#33 and the Medium legacy-renderer finding #14 were addressed by code changes in prior merged work rather than by manual dismissal. Keep the alert history and fixed commit evidence attached to the final release record.

### 4.3 SBOM — generated; reproducibility and licensing review PARTIAL

CycloneDX 1.5 SBOMs were generated successfully from the same committed lockfile on both supported runtime jobs:

| Runtime job | npm | Components | Dependency records | Lockfile SHA-256 | SBOM SHA-256 |
|---|---|---:|---:|---|---|
| Node 22.23.4 | 10.9.9 | 179 | 180 | `8b3af35cc5a67467a956994bb50c476f2e9c101409c3311360d933587316e510` | `a301ab64da21a0eb5e8ba62e3537d9f3857dc562c90ad585fda5d07329406890` |
| Node 24.22.1 | 11.19.1 | 177 | 178 | `8b3af35cc5a67467a956994bb50c476f2e9c101409c3311360d933587316e510` | `ccdef1a4be53bc81f5aabf06148a654ab317f911b22b4354dea1435c29649771` |

Both reports found zero missing/unknown component license expressions. However, the same lockfile produces a **two-component / two-dependency-record difference** across npm majors. The difference is not yet explained and must be reconciled before asserting byte-for-byte or inventory-level SBOM reproducibility.

The dependency package inspection also identifies LGPL-3.0-or-later Sharp/libvips-related packages, including platform-specific `@img/sharp-libvips-*` packages and `@img/sharp-wasm32` in the Node 22 report. The existing package-inspection review records that archive-level license/notice availability and LGPL redistribution/source-offer mapping need maintainer/legal review. Do not treat generated license metadata as completed legal clearance.

### 4.4 Dependency evidence disposition

- Automated audit: PASS.
- SBOM generation/schema: PASS.
- Clean install in current main CI: PASS.
- Human lockfile/dependency review: PARTIAL.
- npm-major SBOM component reconciliation: OPEN.
- License/notice obligations and distribution model review: OPEN.
- Release provenance/signing and artifact-to-commit verification: MISSING.

## 5. Formal production evidence still missing

The readiness evaluator reports **14 MISSING_EVIDENCE** rows. The evidence must be attached to the exact release candidate SHA, validated against the relevant schema/runbook and approved by the accountable reviewer.

| # | Missing evidence | Minimum acceptable completion |
|---:|---|---|
| 1 | Independent tenant-isolation and authorization review | Independent route, worker, object and cross-site access review; record tested boundaries, findings, owners and retest results. |
| 2 | Real identity-provider and recovery E2E | OIDC/SAML, email delivery, MFA enrollment/recovery, session renewal/logout and outage/recovery exercised against test infrastructure. |
| 3 | Live malware scanning and quarantine | ClamAV service plus malicious-file corpus, timeout/unavailable behavior, false-positive handling and legacy asset quarantine. |
| 4 | Real cloud/object-storage providers | S3/S3-compatible, GCS and Azure live credentials; least-privilege read/write/delete/lifecycle tests and outage behavior. |
| 5 | Stripe lifecycle qualification | Test-mode checkout, idempotency, signed/invalid/duplicate/out-of-order webhooks, ambiguous outcomes, reconciliation, inventory exactly-once behavior, refunds and subscription lifecycle. |
| 6 | Full editor and accessibility acceptance | Complete edit/publish/media/recovery journeys plus manual keyboard, screen-reader, contrast, focus and WCAG acceptance. |
| 7 | Scoped commerce acceptance | Tax, shipping, coupons/discounts, refunds, fulfillment, download entitlements and subscriptions accepted end-to-end against the declared release scope. |
| 8 | Community privacy and safety acceptance | Group privacy, abuse/spam/moderation, search, export/deletion and forum acceptance, including authorization tests. |
| 9 | Signed plugin pipeline and adversarial isolation | Artifact signing/provenance, immutable images, resource limits, filesystem/network/egress restrictions and adversarial escape/data-exfiltration tests. |
| 10 | Reviewed security/supply-chain evidence | Human-reviewed lockfile, dependency audit, SBOM reconciliation, license notices, provenance and CodeQL alert inventory. |
| 11 | Load, soak and recovery | Representative load/soak/fault injection, queue recovery, backup/restore, graph rebuild and documented RPO/RTO. |
| 12 | Independent security assessment | Independent application/security assessment with severity-ranked findings and verified remediation of release-blocking issues. |
| 13 | Production operations and release approval | Deployment/rollback runbooks, secret rotation, monitoring/alerting, incident response, named operational owners and explicit release-owner approval. |
| 14 | Production observability backend acceptance | Approved OTLP backend, TLS/auth/network controls, access and retention governance, ownership, durable retry/dead-letter behavior, capacity and outage/recovery evidence. |

### 5.1 Stripe issue

[P1 Issue #18 — Validate Stripe checkout, webhook replay, refunds and subscriptions](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/18) remains open. It requires test-mode provider evidence tied to the candidate SHA in `artifacts/evidence/stripe-live-lifecycle.json`; secrets must not be written to the evidence artifact. Mock-backed unit tests do not close this gate.

## 6. Repository governance and release controls

1. **Protect `main`.** It was reported unprotected at review time. Configure a ruleset/branch protection policy requiring PR review and the successful supported-runtime, live integration, browser/accessibility, CodeQL and consolidated evidence checks. Disallow force-push and deletion; dismiss stale approvals as appropriate.
2. **Publish only from a reviewed immutable revision.** Create a signed/verified tag and GitHub Release only after all required evidence is complete. No release tag or GitHub Release was present at this review.
3. **Keep evidence revision-bound.** Readiness, provider, security, SBOM and approval artifacts must identify the exact source SHA and environment. A report from a previous commit is historical evidence, not current-candidate proof.
4. **Keep scope explicit.** The 0.5.1 scope record is historical and must not be interpreted as current release-owner scope approval.
5. **Preserve the unreleased state.** The manifest must remain `EXPANDED_DEVELOPER_PREVIEW_NOT_PRODUCTION_CERTIFIED` until approval evidence is present. Do not infer certification from green CI.

## 7. Local repository state and continuity

The supplied local directory was not on the assessed main revision when inspected:

- Existing worktree branch: `fix/serialize-live-integration-tests`.
- Existing HEAD: `d2dfcd3e8d7b4113941456be0cf96f01a0a036c1` (3 November 2026), reported 96 commits ahead of its corresponding remote-tracking branch.
- Existing untracked file: `artifacts/evidence/clean-npm-ci.log`; it was preserved and not modified.
- Local `main` ref was behind remote main. The remote `origin/main` was fetched and confirmed at the assessed SHA.
- To avoid disturbing that existing branch or untracked evidence, follow-on development was isolated in a separate Git worktree at `.worktrees/release-gate-library-routes-2026-11`, branch `refactor/api-library-routes-2026-11`, based on the assessed main SHA.
- Git initially flagged the repository as having a different owner. The work used a command-scoped `safe.directory` exception; the global Git configuration was not changed.
- Git worktree metadata also contains legacy/prunable references to worktrees under the former `SystemFabric-0.5.1` directory. Do not prune or delete those records until their branch/worktree recovery needs have been reviewed.

This separation preserves the user's original worktree, its branch and its untracked validation log.

## 8. Recommended execution order

**P0 — Release-blocking evidence**
1. Complete the independent tenant-isolation/authorization review and independent application-security assessment; remediate and retest high/severe findings.
2. Execute Issue #18 Stripe test-mode lifecycle acceptance and attach the sanitized, SHA-bound evidence artifact.
3. Complete real identity-provider, malware scanner and cloud-storage provider tests.
4. Complete browser journey and manual accessibility acceptance.
5. Complete signed plugin/adversarial isolation and production observability acceptance.
6. Complete production load/soak/fault injection and backup/restore RPO/RTO drills.
7. Reconcile npm 10/11 SBOM component differences, review LGPL notices/distribution obligations, and sign off dependency/provenance evidence.
8. Confirm release scope, operational owners, rollback procedures and explicit release-owner approval.

**P1 — Engineering maintainability**
- Continue the already-started 0.6.2 route-family extraction by moving site-scoped library/media HTTP behavior out of `platform-routes.js` into a dedicated module with an explicit dependency interface.
- Preserve authentication/site/capability ordering in the API composition layer; preserve body limits, audit events, safe private-download headers, version checks, optimization status semantics and object-store reconciliation.
- Add route-family tests for decline/no-side-effects, tenant scope, upload/audit, private download hardening, version replacement and optimization behavior.
- Do not hide PostgreSQL/object-storage compensation or reconciliation inside a generic transaction abstraction.

## 9. Assessment limitations

This report is an evidence-based engineering assessment of the named source revision and CI run. It is not a penetration test, independent security opinion, legal opinion, accessibility conformance certification, provider acceptance, production capacity guarantee, disaster-recovery attestation or release approval. Where evidence is described as missing or partial, a successful automated workflow does not silently close that item.

## 10. References

- [Main commit `4893255`](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/commit/489325585d57fe95f961c36a597faa7065848c7f)
- [CI workflow run #258](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41949722725)
- [PR #65 — EnginEx renderer security/compatibility](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/65)
- [PR #66 — commerce route-family extraction](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/66)
- [PR #67 — AI task route-family extraction](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/67)
- [Issue #18 — Stripe lifecycle qualification](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/18)
- [Release readiness](../RELEASE_READINESS.md)
- [Production certification plan](../PRODUCTION-CERTIFICATION-PLAN.md)
- [Release evidence contract](../RELEASE-EVIDENCE.md)
- [Dependency license/package inspection](../security/DEPENDENCY-LICENSE-PACKAGE-INSPECTION-2026-11-01.md)
- [Dependency SBOM review](../security/DEPENDENCY-SBOM-REVIEW-2026-11-01.md)
