# VirgoScorpio Hub 0.6.2 Release Gate Report

> **Current mainline decision — 6 November 2026: NO-GO for production.** VirgoScorpio Hub 0.6.2 is on main at 9c28d5501b6e3cfd723f2495d1544beed4f29d4d. PRs #68–#74 are merged; post-merge workflow #309 passed all six hosted jobs. The latest complete formal readiness snapshot retained here is from 70ce31a23aa670afca1d89fb5c776e1ca36abd84 (8 PASS, 1 PARTIAL, 1 BLOCKED, 14 MISSING_EVIDENCE) and is a historical baseline, not a regenerated evaluation of 9c28d55. PR #75 is an unmerged relationship-route site-context hardening candidate based on 9c28d55; targeted tenant integration passed 9/9, but hosted CI and human review remain outstanding. The internal pre-review does not close independent tenant-isolation issue #14. No release tag, GitHub Release, package publication or production deployment is authorized.

## Historical mainline assessment — before PR #70/#71 merge

### 1. Release decision and repository identity

PR [#68](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/68) extracted site-scoped library/media HTTP routes into `apps/api/src/library-routes.js`. PR [#69](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/69) extracted site-member listing/addition/removal and invitation creation into `apps/api/src/site-membership-routes.js`. Both are merged. Current `main` is `d50e56801ea77a811ec809be1574e769917fff78`.

| Property | Current value |
|---|---|
| Product/package version | VirgoScorpio Hub 0.6.2 (unreleased developer-preview patch) |
| Vendored renderer | EnginEx 7.0.0 |
| Node.js support | >=22.23.4; hosted matrix 22.23.4 / 24.22.1 |
| npm CLI | 11.19.1 pinned in `package.json` and CI |
| Database migration inventory | 18 migrations (001–018) |
| Latest mainline commit | `d50e56801ea77a811ec809be1574e769917fff78` |
| Merged PRs | #68 and #69 |
| Release tag / GitHub Release | None |

The 0.6.1 to 0.6.2 increment remains a SemVer **patch**: the merged work is an internal route-family decomposition with no intended public HTTP contract or schema change. The current 0.6.2 mainline is still unreleased; the package version is not evidence of publication or certification.

### 2. Mainline CI — producer jobs PASS; aggregate gate BLOCKED

Mainline workflow [run #278](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42067882403) was rerun once. The run as a whole is **not green**:

| Attempt | Producer/API observation | Aggregate result |
|---|---|---|
| 1 | PostgreSQL/Memgraph job was absent from the Actions job list. Browser job remained queued in the API, although its run-bound browser artifact recorded 9/9 successful Playwright tests. | BLOCKED: missing DB evidence and inconsistent browser job state. |
| 2 | All five required producer jobs completed successfully on exact main SHA `d50e56801ea77a811ec809be1574e769917fff78`. | BLOCKED: the workflow-run API still exposed the previous attempt's failed conclusion while the current attempt's aggregate job was running. |

Attempt 2's five producer jobs yielded:

| Producer | Result | Evidence |
|---|---|---|
| Node.js 22.23.4 | PASS | 486/486 Hub tests; 94/94 EnginEx tests; 208 required paths and 215 JavaScript files syntax-checked. |
| Node.js 24.22.1 | PASS | 486/486 Hub tests; 94/94 EnginEx tests; 208 required paths and 215 JavaScript files syntax-checked. |
| PostgreSQL / Memgraph integration | PASS | 65/65 live integration tests, zero failures/skips; fresh migrations 18/18 applied and 18/18 skipped on the idempotent second pass; Memgraph outage/replay and canonical graph rebuild passed. |
| Browser editor/accessibility smoke | PASS | 9/9 Playwright smoke tests. This is not full manual accessibility or WCAG acceptance. |
| CodeQL | PASS | Analysis workflow completed successfully; this is not an independent security assessment or human-reviewed alert disposition. |

Both hosted Node jobs completed fresh `npm ci`, full and production dependency audits reported zero vulnerabilities, and CycloneDX 1.5 generation passed. The SBOMs identify npm 11.19.1, use lockfile SHA-256 `f404ce5862bffa60daa2cb9cd471e6ac7893b048b2e877e623ddf43c1a15e7ce`, and contain 177 components / 178 dependency records with identical normalized component identities and dependency edges. The service-less integration subset remains PARTIAL (29 skips per runtime) and is not confused with the dedicated live integration run.

The current defect is in the aggregator's interpretation of the workflow-run summary during a rerun, not in the five producer results. The narrowly scoped correction in follow-up branch `fix/ci-evidence-rerun-state-2026-11-05` permits the stale prior-failure window only when all five producer jobs are uniquely identified, bound to the current run attempt and exact revision, and complete/successful, while the current-attempt aggregate job is actively running. It does **not** accept a failed producer, wrong attempt/revision, or a completed failed aggregator. Targeted regression validation: 17 passed, 0 failed, 1 Windows-specific skip in `test/ci-evidence.test.js`. Hosted CI for the correction is pending; do not mark the mainline run green until the complete workflow is green.

Local Windows / Node.js 26.12.1 validation after a clean `npm ci --ignore-scripts --no-audit --no-fund` passed `npm test`: 487 tests, 484 passed, zero failed, and three Windows/platform-specific skips, including the new rerun-state regression. The focused `node --test test/ci-evidence.test.js` run passed 17 tests with one Windows-specific skip. `npm run check` did not complete locally: Node hit a native V8 memory-allocation failure during the sequential syntax-check subprocess loop at `packages/observability/src/deployment-contract.js`; an individual `node --check` of that file passed. The verifier now excludes ignored `.worktrees` copies from the repository syntax inventory, but the local Windows memory limit remains unresolved. Do not report local `npm run check` as PASS. Hosted attempt 2's runtime jobs passed the artifact and syntax checks on Linux.

### 3. Formal release readiness — NO-GO

The current Node 22/24 readiness reports on the exact main SHA agree:

| Formal status | Count | Interpretation |
|---|---:|---|
| PASS | 7 | Configured source/runtime/test checks passed. |
| PARTIAL | 2 | Service-less integration tests are skipped in the matrix jobs; human dependency/lockfile review remains open. |
| BLOCKED | 1 | The formal PostgreSQL/Memgraph evidence contract does not have the required exact-revision evidence record. |
| MISSING_EVIDENCE | 14 | Independent, provider, product-acceptance, security, supply-chain and operations evidence is absent. |
| NOT_RUN | 0 | Configured formal rows were evaluated. |

The formal blocked gate expects `artifacts/evidence/postgres-memgraph-live.json` with schema version 1, product identity, version 0.6.2, and exact source revision. Attempt 2's separate run-bound integration artifact proves 65/65 tests and its fresh-migration artifact proves all 18 migrations plus the idempotent second pass on the current source SHA. These artifacts are valuable engineering evidence, but they do **not** automatically satisfy the distinct formal evidence path/contract. The retained local `artifacts/evidence/fresh-migrations.json` is still historical 0.5.1 evidence for 14 migrations and remains blocked as supplemental evidence; it was preserved rather than rewritten or misrepresented.

The 14 missing gates are:

1. Independent tenant/site isolation and authorization review (issue #14).
2. Live identity provider, email delivery, MFA recovery and session lifecycle (issue #15).
3. Live ClamAV scanning, test corpus and legacy-asset quarantine (issue #16).
4. Enabled cloud storage provider credentials, least privilege and lifecycle (issue #17).
5. Stripe checkout, webhook replay, refunds and subscriptions (issue #18).
6. Full browser journeys and manual accessibility acceptance (issue #19).
7. Commerce parity acceptance (issue #20).
8. Community privacy, moderation, search and export/deletion acceptance (issue #21).
9. Signed plugin pipeline and adversarial container isolation (issue #22).
10. Human dependency/lockfile, SBOM, provenance, license and CodeQL review (issue #23).
11. Load/soak, fault injection and backup/restore drills (issue #24).
12. Independent application security assessment and severe-finding remediation (issue #25).
13. Deployment runbooks, secret controls, rollback, monitoring and release-owner approval (issue #26).
14. Production observability backend, security, retention, delivery and named ownership evidence.

Green engineering CI, including the successful producer jobs in run #278 attempt 2, is not production certification and does not close any of these external gates.

### 4. Architecture and continuity review

The merged route extractions preserve the existing API composition authority:

- Authentication, session resolution, site selection and capability checks remain centralized. Route modules receive narrow, explicit request-scoped dependencies and do not establish a second authentication or tenant-authorization path.
- Library/media routes preserve request paths, methods, status/response contracts, upload bounds, metadata-only audit content, private-download headers, optimistic version checks and explicit PostgreSQL/object-storage compensation/reconciliation.
- Site-membership routes preserve the `site:manage` guard, bounded request bodies, mutation-before-audit ordering and invitation-token minimization. Token material is returned only to the trusted response and is never written to audit metadata.
- Neither extraction introduces a database migration or claims a cross-system atomic transaction.

Root README version badges now identify VirgoScorpio Hub 0.6.2 first and EnginEx 7.0.0 second. `compose.yaml` declares the stable project identity `virgoscorpio-hub`, so future generated service/network names do not depend on the checkout directory. Existing legacy Docker containers and volumes have **not** been removed or renamed; the running Memgraph container and retained PostgreSQL/Memgraph volumes require backup-first migration and verification before retirement.

### 5. Recommended next actions

**P0 — Keep production NO-GO until evidence exists.** Produce/review the formal exact-SHA PostgreSQL/Memgraph evidence record; complete the 14 external/provider/independent acceptance gates; approve the actual release scope, operational controls and release owner. No external evidence should be inferred from CI.

**P1 — Repair and revalidate the CI aggregation path.** Obtain human review of `fix/ci-evidence-rerun-state-2026-11-05`, require all six jobs (five producers plus aggregator) to pass on the exact PR revision, then merge only with a green final check set. Do not weaken checksum, job identity, source revision, zero-skip live integration, or production-boundary checks.

**P1 — Continue route-family decomposition only at a proven seam.** The site-membership extraction is now complete. A candidate next slice is the custom content-type registry/records HTTP family in `server.js`; first add dispatch, authorization-order, versioned-definition, record-validation and tenant-isolation regression tests. Keep the SQL advisory-lock/transaction and content ownership predicates intact, and make no public-contract or schema change without evidence.

**P2 — Migrate local Docker state safely.** Back up the legacy PostgreSQL and live Memgraph data volumes, verify backup contents and restore in isolated new project-named volumes, run application/integration checks, and only then retire old containers/network/volumes. No in-place volume rename or destructive cleanup is authorized by this report.

**Disposition:** retain Hub 0.6.2 as an unreleased developer-preview mainline. No tag, GitHub Release, package publication, production deployment, or production certification is authorized.

## Historical PR #68 candidate record — pre-merge

**Assessment date:** 5 November 2026 (America/Chicago)
**Repository:** GoldenObsidianLLC/VirgoScorpio-Hub
**Default branch:** main
**Default-branch baseline:** 489325585d57fe95f961c36a597faa7065848c7f (Hub 0.6.1)
**Candidate branch:** refactor/api-library-routes-2026-11
**Candidate commit:** 31dd63908fbf8a9fb0340323d92ffd6cdd4d89b9
**PR merge-ref tested by GitHub Actions:** 16d9852126da4aa5c3e15d42460375a2e0ad0cd7
**Pull request:** https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/68
**Candidate package version:** 0.6.2 (unreleased patch candidate)
**CI evidence:** PR run #260 / 41976111045; push run #259 / 41976023520

> **Historical release decision — pre-merge PR #68 candidate: NO-GO for production.** The 0.6.2 candidate passed the full hosted engineering CI matrix on both the push and pull-request events. The revision-bound release-readiness evaluator still reports NOT_PRODUCTION_CERTIFIED, readyForProduction=false, with 14 required evidence items missing. PR #68 was open at that historical assessment; it subsequently merged, followed by PR #69. The current mainline state and run #278 are assessed at the beginning of this report. No production release is authorized.

## 1. Executive decision

The 0.6.2 candidate is a compatible internal route-family extraction from 0.6.1. It moves the site-scoped library/media HTTP route family into a dedicated module while preserving the existing API composition boundary, tenant authorization flow, storage semantics and public route behavior.

The candidate has passed:

- Fresh dependency installation in local Windows validation and both hosted supported-Node.js CI jobs.
- 469/469 VirgoScorpio Hub unit/security tests on Node.js 22.23.4 and 24.22.1.
- 94/94 vendored EnginEx 7.0.0 tests on each supported runtime.
- 65/65 dedicated live PostgreSQL/Memgraph integration tests.
- 18/18 fresh database migrations and an idempotent second pass with 18/18 already applied.
- 9/9 Playwright editor/collaboration/browser smoke tests.
- CodeQL workflow execution, dependency audits and consolidated revision-bound CI evidence.

These results validate the candidate's engineering CI baseline, not its production operating model. The machine-readable production readiness result on the PR merge-ref is:

| Formal readiness status | Count | Interpretation |
|---|---:|---|
| PASS | 8 | Configured source/runtime/test evidence passed. |
| PARTIAL | 2 | Evidence exists, but qualification or service-less coverage remains incomplete. |
| BLOCKED | 0 | No formal readiness-check row is classified BLOCKED. |
| MISSING_EVIDENCE | 14 | Required independent, provider, legal/supply-chain and operational evidence is absent. |
| NOT_RUN | 0 | All configured readiness rows were evaluated. |

The separate CI evidence aggregator also marks the production-certification boundary BLOCKED by design: green CI cannot satisfy independent security, provider, operational or release-owner approval.

**Disposition:** retain 0.6.2 as an unreleased developer-preview candidate. Merge only after required PR review and successful checks on the final PR revision. Do not tag, publish or deploy it as production-certified until all 14 formal evidence gates have been completed and approved.

## 2. Candidate identity and repository state

| Item | Observed state |
|---|---|
| Current main | 489325585d57fe95f961c36a597faa7065848c7f |
| Main package version | 0.6.1 |
| Candidate package version | 0.6.2 |
| Candidate commit | 31dd63908fbf8a9fb0340323d92ffd6cdd4d89b9 |
| CI merge-ref revision | 16d9852126da4aa5c3e15d42460375a2e0ad0cd7 |
| Candidate PR | #68, open, not merged |
| PR mergeability | GitHub reported mergeable=true at review time |
| Reviews captured | No submitted PR reviews returned at review time |
| PR issue comments | None returned at review time |
| Node minimum | >=22.23.4 |
| Vendored EnginEx | 7.0.0 |
| Database migrations | 18 (0001–0018) |
| GitHub Releases | None published |
| Main branch protection | GitHub reported protected=false |

The tested merge-ref is a GitHub-generated merge commit whose parents are the current main SHA and the candidate head SHA. The CI evidence manifests bind to both values. The candidate branch was pushed from an isolated Git worktree, leaving the user's original local branch and its untracked evidence untouched.

### 2.1 SemVer decision

The 0.6.1 to 0.6.2 change is a **patch** increment:

- No intended public HTTP contract change.
- No database migration or schema change.
- No renderer/EnginEx version change.
- The change is an internal modularity improvement with focused route regression coverage.

The package.json, package-lock.json root package metadata and RELEASE-MANIFEST.json are aligned at 0.6.2. The release manifest remains EXPANDED_DEVELOPER_PREVIEW_NOT_PRODUCTION_CERTIFIED.

## 3. Hosted CI — PASS

Both GitHub Actions events completed successfully on candidate head 31dd63908fbf8a9fb0340323d92ffd6cdd4d89b9:

| Workflow event | Run | Final result | Evidence |
|---|---:|---|---|
| Push | #259 / 41976023520 | PASS | Six producer/aggregation jobs completed successfully. |
| Pull request #68 | #260 / 41976111045 | PASS | Six producer/aggregation jobs completed successfully. |

The PR run's producer jobs and consolidated evidence are revision-bound to head SHA 31dd63908fbf8a9fb0340323d92ffd6cdd4d89b9 and merge-ref SHA 16d9852126da4aa5c3e15d42460375a2e0ad0cd7. The final GitHub Actions API state was completed/success for the workflow run and all six jobs.

### 3.1 Supported Node.js matrix

| Evidence | Node.js 22.23.4 | Node.js 24.22.1 |
|---|---:|---:|
| Fresh hosted dependency installation | PASS | PASS |
| Required artifact paths checked | 205 | 205 |
| JavaScript files syntax-checked | 213 | 213 |
| VirgoScorpio Hub unit/security tests | 469/469 | 469/469 |
| EnginEx 7.0.0 tests | 94/94 | 94/94 |
| npm audit | 0 vulnerabilities | 0 vulnerabilities |
| Production-only npm audit | 0 vulnerabilities | 0 vulnerabilities |
| CycloneDX 1.5 SBOM generated | PASS | PASS |
| CI producer job | PASS | PASS |

Both hosted runtimes had zero test failures and zero skips in the root test suite and EnginEx suite. The three Windows-specific skips in the local Node.js 26.12.1 validation do not apply to the Linux hosted test jobs.

The separate service-less integration suite reports 29/29 tests skipped on each Node runtime because its service prerequisites are not enabled in those jobs. The evidence aggregator correctly classifies these results as PARTIAL, not as live integration success. The dedicated PostgreSQL/Memgraph job below supplies the live integration evidence.

### 3.2 PostgreSQL, Memgraph and migration evidence

The dedicated live integration producer job completed successfully on Node.js 22.23.4:

| Check | Result |
|---|---:|
| Live integration tests | 65 passed, 0 failed, 0 skipped |
| Fresh database migrations | 18/18 applied |
| Idempotent second migration pass | 18/18 already applied/skipped |
| Disposable database cleanup | PASS — database dropped |
| Memgraph outage/replay | PASS |
| Canonical graph projection rebuild | PASS |

The live integration artifact identifies the dedicated test database as virgoscorpio_hub_test and the graph endpoint as 127.0.0.1:7687. The fresh migration artifact identifies a disposable database and records successful cleanup. The Memgraph outage/replay evidence records lease release while unavailable, replay after recovery and no duplicate delivery.

**Evidence freshness issue in this snapshot:** the per-runtime release-readiness JSON marks its supplemental fresh-migration check BLOCKED because the retained local file is a tracked historical 0.5.1 artifact for 14 migrations, not versioned evidence for the 0.6.2 18-migration inventory. In the same workflow, the dedicated integration producer emitted a schema-valid fresh-migrations.json with status PASS, 18/18 applied and 18/18 skipped on the second pass; the evidence aggregator accepted the producer artifact and the live integration job passed. Treat the dedicated live migration artifact as the authoritative execution result for that run. The readiness validator must reject stale evidence by product version and exact source SHA rather than weakening migration execution checks or attempting to infer freshness from log text.

### 3.3 Browser and collaboration smoke

Playwright browser/editor smoke completed **9/9 passed** with zero failures. Coverage includes editor behavior, multi-instance collaboration, 2/5/10-editor matrices, dropped Redis hint/heartbeat recovery and a two-node API failure/reconnect scenario.

Observed performance samples from the bounded browser harness:

| Metric | Observed value |
|---|---:|
| Delivery latency P50 | 1.084 s |
| Delivery latency P95 | 2.037 s |
| Delivery latency P99 | 2.048 s |
| Ten-editor reconnect recovery after API-node failure | 73 ms |
| Replayed operations | 24 per editor / 240 total |

These are bounded CI test-harness observations, not production SLOs, capacity guarantees or soak-test results. Manual screen-reader, keyboard-only, contrast, focus and broader WCAG acceptance remains missing.

### 3.4 CodeQL and consolidated evidence

- CodeQL security analysis job: PASS on both workflow events.
- The CI evidence aggregator verified producer job identities, source revisions, artifact manifests and SHA-256 checksums.
- The PR evidence aggregator reported producer CI status PASS.
- CodeQL job artifact manifests contained no additional files in the retained artifact bundle. A successful analysis workflow is not, by itself, evidence of a human-reviewed alert inventory or independent security review.

Do not describe the CodeQL workflow pass as a completed independent security sign-off.

## 4. Dependency, SBOM and software supply chain

### 4.1 Dependency audit — PASS

Both Node runtime jobs ran dependency audits and reported zero vulnerabilities at the configured high-severity threshold. The production-only audit also reported zero vulnerabilities. This is a point-in-time registry advisory result, not an approval of license obligations, package provenance or deployment configuration.

### 4.2 SBOM generation — PASS; cross-runtime inventory reconciliation PARTIAL

CycloneDX 1.5 SBOMs were generated from the same lockfile SHA-256 on both supported Node runtimes:

| Runtime | npm CLI | Components | Dependency records | Lockfile SHA-256 | SBOM SHA-256 |
|---|---:|---:|---:|---|---|
| Node 22.23.4 | 10.9.9 | 179 | 180 | f404ce5862bffa60daa2cb9cd471e6ac7893b048b2e877e623ddf43c1a15e7ce | ac54c55c22594ec1e94fc3e832702e78fb89300cd87c0118c0b000cd679aa68a |
| Node 24.22.1 | 11.19.1 | 177 | 178 | f404ce5862bffa60daa2cb9cd471e6ac7893b048b2e877e623ddf43c1a15e7ce | a87e8dfa31c62381cd7da071a17dc138dce7c65caefe9b4e015b6a423d21f3ac |

The committed lockfile bytes are identical, but the SBOM inventories differ by two component/dependency records. The inventory delta is:

- Present in the Node 22/npm 10.9.9 SBOM only: @emnapi/runtime@1.11.3 and @img/sharp-wasm32@0.35.5.
- Present in the Node 24/npm 11.19.1 SBOM only: tslib@2.8.1.

All listed components had license declarations in the generated SBOMs. That does not constitute legal clearance. The dependency inspection identifies LGPL-3.0-or-later Sharp/libvips-related packages; archive-level license/notice availability and the LGPL redistribution/source-offer obligations still require maintainer/legal review.

Required action: determine whether the inventory delta is expected optional/platform dependency behavior or npm-version normalization; document the cause and define which runtime-specific SBOM is the release artifact of record. Preserve the lockfile hash and both SBOM hashes with the eventual release evidence.

### 4.3 Supply-chain disposition

| Item | Status |
|---|---|
| Clean npm ci on both hosted Node runtimes | PASS |
| Root and production dependency audits | PASS — zero vulnerabilities |
| CycloneDX 1.5 generation/schema | PASS |
| SBOM inventories identical across npm majors | PARTIAL — 2 component/record delta |
| Human lockfile review | MISSING |
| LGPL license/notice and distribution review | MISSING |
| Release provenance/signing and artifact-to-commit attestation | MISSING |
| Human CodeQL alert inventory disposition | MISSING |

## 5. Formal production evidence — 14 MISSING_EVIDENCE

The 0.6.2 readiness JSON is revision-bound to merge-ref 16d9852126da4aa5c3e15d42460375a2e0ad0cd7. It reports releaseClassification=NOT_PRODUCTION_CERTIFIED and readyForProduction=false. The 14 missing evidence rows are unchanged in substance from the 0.6.1 assessment.

| # | Evidence gate | Current status | Minimum completion evidence |
|---:|---|---|---|
| 1 | Independent tenant-isolation and authorization review | MISSING | Independent route, worker, tenant-object and cross-site access review; tested boundaries, findings, owners and verified retests. |
| 2 | Identity-provider and account-recovery E2E | MISSING | Real OIDC/SAML/email delivery, MFA enrollment/recovery, session renewal/logout and outage/recovery evidence. |
| 3 | Live malware scanning and quarantine | MISSING | ClamAV service, malicious-file corpus, scanner unavailable/timeout behavior, false-positive handling and legacy-asset quarantine. |
| 4 | Live cloud/object-storage providers | MISSING | S3/S3-compatible, GCS and Azure live credential, permissions, read/write/delete/lifecycle, encryption and outage tests. |
| 5 | Stripe lifecycle qualification | MISSING | Test-mode checkout/idempotency; signed, invalid, duplicate and out-of-order webhooks; ambiguous outcomes; reconciliation; inventory exactly-once behavior; refunds and subscriptions. |
| 6 | Full browser and accessibility acceptance | MISSING | Full editor/publish/media/recovery journeys plus manual keyboard, screen-reader, contrast, focus and WCAG review. |
| 7 | Commerce parity acceptance | MISSING | Tax, shipping, coupons/discounts, refunds, fulfillment, download entitlements and subscription acceptance against declared scope. |
| 8 | Community privacy/safety acceptance | MISSING | Group privacy, abuse/spam/moderation, search, export/deletion and forum acceptance with authorization tests. |
| 9 | Signed plugin pipeline and adversarial isolation | MISSING | Signed artifacts/provenance, immutable images, resource limits, filesystem/network/egress controls and adversarial escape/data-exfiltration tests. |
| 10 | Reviewed dependency/SBOM/CodeQL evidence | MISSING | Human lockfile/dependency review, SBOM delta reconciliation, license notices, provenance and human-reviewed CodeQL alert disposition. |
| 11 | Load, soak and recovery | MISSING | Representative load/soak, fault injection, queue recovery, backup/restore, graph rebuild and approved RPO/RTO evidence. |
| 12 | Independent security assessment | MISSING | Independent application/security assessment, severity-ranked findings and verified remediation of release-blocking issues. |
| 13 | Production operations and release approval | MISSING | Deployment/rollback runbooks, secret rotation, monitoring/alerting, incident response, named operational owners and explicit release-owner approval. |
| 14 | Production observability backend | MISSING | Approved OTLP backend, TLS/auth/network controls, access/retention governance, named ownership, retry/dead-letter behavior, capacity and outage/recovery evidence. |

### 5.1 Stripe issue #18

Issue #18 remains open: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/18

The required evidence path is artifacts/evidence/stripe-live-lifecycle.json. Acceptance must use a dedicated Stripe test-mode account, bind the results to the exact candidate SHA and exclude all secret values. Mock-backed unit tests do not close this gate.

### 5.2 Evidence that is now stronger but still not sufficient

- The dedicated live PostgreSQL/Memgraph and migration evidence passes; it does not replace tenant isolation review or production backup/restore.
- The browser suite passes smoke-level editor and collaboration checks; it does not replace accessibility conformance or complete product acceptance.
- CodeQL runs successfully; it does not replace independent security assessment or a reviewed alert inventory.
- npm audit reports zero vulnerabilities; it does not replace dependency review, SBOM reconciliation, licensing or provenance.
- Existing unit tests validate Stripe logic; they do not constitute live provider lifecycle acceptance.

## 6. Architecture and implementation review — 0.6.2

The new route boundary is:

- apps/api/src/library-routes.js owns site-scoped library list/upload, metadata patch, optimistic asset-version replacement, version history, private downloads and optional media optimization behavior.
- apps/api/src/platform-routes.js remains the composition layer and delegates matching library/media requests to the focused module.
- Authentication, selected-site resolution, capability enforcement, request lifecycle and centralized error handling remain in the existing API request pipeline.
- Storage operations remain in packages/library/src/file-store.js and the existing media optimizer. The extraction does not move PostgreSQL/object-storage reconciliation behind a fictitious distributed transaction.

Key invariants retained and tested:

1. Site scope is validated before library-store access.
2. Capability checks remain in the API composition layer.
3. Upload body limits and media optimizer byte limits remain explicit injected dependencies.
4. Upload audit records retain metadata and SHA-256 only; raw payload bytes are not written to audit.
5. Private downloads preserve private, no-store caching, nosniff and sandbox CSP headers.
6. Optimistic asset-version semantics and existing store behavior remain unchanged.
7. Unsupported optimization remains an explicit skipped state; optimizer failures retain the existing failure/skipped semantics.
8. No database migration or intended public route/response contract change was introduced.

The focused route suites passed 49/49 on the local Windows workstation, and the full candidate CI matrix passed after clean installs. No new high-risk architecture boundary was identified in this bounded extraction. The production tenant-isolation review is still missing and must not be inferred from unit tests.

## 7. Local validation and repository continuity

The isolated candidate worktree is:

C:\Users\Justin Harlan\Documents\VirgoScorpio Hub v0.5.1\.worktrees\release-gate-library-routes-2026-11

Branch: refactor/api-library-routes-2026-11
Candidate commit: 31dd63908fbf8a9fb0340323d92ffd6cdd4d89b9

Local Windows / Node.js 26.12.1 validation:

| Check | Result |
|---|---|
| Fresh npm ci --no-audit --no-fund | PASS; 180 packages installed and KaTeX postinstall completed |
| npm run check | PASS; 206 required paths, 213 JavaScript files syntax-checked |
| Root suite | 469 total; 466 passed, 0 failed, 3 Windows/platform-specific skips |
| Focused API/library/commerce/platform/request-validation suites | 49/49 passed, 0 skipped |
| EnginEx 7.0.0 | 94 total; 91 passed, 0 failed, 3 Windows/platform-specific skips |
| npm audit --audit-level=high | PASS; zero vulnerabilities |
| git diff --check | PASS before commit |

The local Windows skips cover platform-specific open-file rename/no-follow semantics. Hosted Linux Node 22/24 CI ran all 469 root and 94 EnginEx tests with zero skips.

The original worktree branch fix/serialize-live-integration-tests and its untracked artifacts/evidence/clean-npm-ci.log were not modified by this isolated feature branch work. Legacy/prunable Git worktree metadata under the former SystemFabric-0.5.1 directory was not pruned.

## 8. Repository governance and release controls

1. Protect main. At review time GitHub reports main protected=false. Require PR review and successful supported-runtime, live integration, browser/accessibility, CodeQL and consolidated evidence checks; disallow force-push and branch deletion.
2. Historical at the candidate assessment time, PR #68 was open and unmerged, and the review endpoint returned no submitted reviews. PR #68 subsequently merged as `be1441e216c20358e8506389915a676209808e37`; PR #69 then merged as `d50e56801ea77a811ec809be1574e769917fff78`. The current mainline status is recorded at the start of this report.
3. Keep production certification separate from engineering CI. The release readiness evaluator must pass in strict mode after all 14 evidence artifacts are accepted and reviewed.
4. Bind every evidence artifact to the exact final source SHA, environment and reviewer/date. The PR merge-ref and head SHAs are both recorded in CI producer manifests.
5. Reconcile the 2-component SBOM delta and document LGPL license/notice obligations.
6. Require schema/product/version/source-revision identity for formal and supplemental migration evidence; regenerate evidence for the exact commit being reviewed.
7. Publish only from an approved immutable revision with verified provenance/signature, release notes, a signed tag and explicit release-owner approval.
8. Keep the manifest status EXPANDED_DEVELOPER_PREVIEW_NOT_PRODUCTION_CERTIFIED until the evidence gate and strict assertion pass.

No GitHub Release was published at assessment time. No production release tag was observed. Do not issue a 0.6.2 production release from the current candidate.

## 9. Recommended next actions

### P0 — Required before production certification

1. Complete independent tenant-isolation/authorization review and independent application-security assessment; remediate and retest all release-blocking findings.
2. Execute Stripe Issue #18 on test mode and attach sanitized, SHA-bound lifecycle evidence.
3. Complete real identity-provider, scanner and cloud-storage provider tests.
4. Complete full editor acceptance and manual accessibility review.
5. Complete signed plugin pipeline/adversarial isolation and production observability acceptance.
6. Execute load/soak/fault-injection plus backup/restore and RPO/RTO drills.
7. Reconcile npm 10/11 SBOM inventory differences; complete license/notice and provenance review.
8. Approve production scope, operations/rollback plan, owners and release authorization.

### P1 — Candidate PR and engineering quality

1. Obtain human review and merge PR #68 only after the final checks are green.
2. Bind every formal and supplemental external evidence artifact to schema version, product, package version and exact Git HEAD; regenerate evidence after each source revision.
3. Pin a common npm CLI version across the supported Node.js matrix and require exact normalized SBOM component/dependency graph parity; never erase real optional dependency differences.
4. Keep the route-family dependency context narrow; do not introduce a second authentication or tenant-authorization implementation.

## 10. Limitations and evidence boundary

This assessment covers the named Git revisions, hosted CI producer artifacts, readiness JSON and the local candidate validation described above. It is not a penetration test, independent security opinion, legal opinion, WCAG conformance certification, live commercial-provider certification, production capacity guarantee, disaster-recovery attestation or production release authorization.

A successful CI workflow means the configured engineering checks passed. It does not establish that missing external evidence exists. The 14 missing evidence gates remain release blockers.

## 11. References

- Main baseline commit: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/commit/489325585d57fe95f961c36a597faa7065848c7f
- Candidate commit: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/commit/31dd63908fbf8a9fb0340323d92ffd6cdd4d89b9
- Candidate merge-ref: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/commit/16d9852126da4aa5c3e15d42460375a2e0ad0cd7
- PR #68: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/68
- PR CI run #260: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41976111045
- Push CI run #259: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41976023520
- Stripe lifecycle issue #18: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/18
- Previous 0.6.1 release gate report: 2026-11-04-VirgoScorpio-Hub-0.6.1-Release-Gate-Report.md
- Release readiness: ../RELEASE_READINESS.md
- Release evidence contract: ../RELEASE-EVIDENCE.md
- Architecture map: ../ARCHITECTURE.md
- Codebase optimization review: ../CODEBASE-OPTIMIZATION-REVIEW-2026-11-04.md
- Dependency license/package inspection: ../security/DEPENDENCY-LICENSE-PACKAGE-INSPECTION-2026-11-01.md
- Dependency SBOM review: ../security/DEPENDENCY-SBOM-REVIEW-2026-11-01.md
- Follow-up candidate commit: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/commit/5f900faf3b92307977d3858e1bb0897ab12abe66
- Follow-up PR merge-ref: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/commit/7b20c5685288aa47bcc21b0b3e299546c2a1be36
- Follow-up hosted PR run #264: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42015046006

## Addendum — 5 November 2026: evidence identity and SBOM toolchain hardening

This report's findings above are the snapshot for candidate head `31dd63908fbf8a9fb0340323d92ffd6cdd4d89b9` and CI runs #259/#260. A follow-up implementation was subsequently added to PR #68 and validated by hosted PR run #264; the addendum below records that distinct source revision and evidence without rewriting the earlier snapshot.

The migration discrepancy was diagnosed more precisely: the local `artifacts/evidence/fresh-migrations.json` was a tracked 0.5.1 artifact for 14 migrations. The dedicated PostgreSQL/Memgraph producer in the candidate CI run generated a run-bound 0.6.2 result for all 18 current migrations, proved the idempotent second pass, and dropped its disposable database. The supplemental readiness validator had accepted generic status/timestamp evidence without requiring a product/version/source identity. The fix now requires schemaVersion 1, product `VirgoScorpio Hub`, version `0.6.2`, and an exact 40-character Git `sourceRevision` matching HEAD for formal and supplemental evidence. The fresh-migration runner records this revision. Stale historical JSON is rejected; the SQL migration, ledger, idempotency and cleanup assertions remain unchanged.

The second supply-chain issue was a toolchain mismatch: both CI jobs used the same lockfile bytes but different npm major versions. The candidate now declares `npm@11.19.1` in `package.json` and `RELEASE-MANIFEST.json`; both supported Node.js matrix jobs install and assert that exact CLI version before `npm ci`, audit and SBOM generation. The revision-bound aggregator verifies the npm CLI identity inside each CycloneDX document and compares canonical component identities plus dependency edges across the two SBOMs. It ignores timestamps and generator metadata only; any package or graph difference blocks parity. It does not rewrite the inventory or filter optional dependencies.

Local Windows / Node.js 26.12.1 validation of the follow-up passed `npm run check`: 206 required paths, 213 JavaScript files syntax-checked, and 476 Hub tests (473 passed, 0 failed, 3 Windows/platform-specific skips). `npm audit --audit-level=high` reported zero vulnerabilities and `git diff --check` passed. Hosted PR run #264 passed all six jobs on its exact source revision. The final route/error-contract correction and subsequent #270 evidence are described in the following addendum.

## Addendum — 5 November 2026: final route error contract and PR run #270

The first post-hardening integration rerun (#268) found two tenant-library/media assertions returning the legacy `ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND` code. The current Hub library store and public asset routes expose `ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND`. The final branch revision `8db6c66f07c6ea89745fe2a0c8dd7f5f4f6440b3` consistently uses the canonical Hub error-code namespace and adds focused route-level tests for unavailable storage and missing assets. This is a narrow error-code consistency correction; route paths, methods, HTTP statuses and response shapes remain unchanged. Run #270 passed the live tenant-isolation tests after this correction.

The final candidate revision `8db6c66f07c6ea89745fe2a0c8dd7f5f4f6440b3` passed both hosted push run [#269](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42026938931) and PR run [#270](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42026945926), merge ref `e39cd5c33f940762ed9fa88b27aad8f8d3070947`. All six jobs in each run passed. Node.js 22.23.4 and 24.22.1 each passed 476/476 Hub tests and 94/94 EnginEx tests, zero failures/skips, and 206 required artifact checks / 213 JavaScript syntax checks. Both npm audits reported zero vulnerabilities. Dedicated PostgreSQL/Memgraph passed 65/65 tests with zero skips; all 18 migrations applied and all 18 skipped on the idempotent second pass; the supported v0008-to-v0009 upgrade fixture, Memgraph outage/replay and canonical graph rebuild passed; browser smoke passed 9/9; CodeQL and consolidated revision-bound evidence passed.

Both npm 11.19.1 CycloneDX 1.5 SBOMs contain 177 components and 178 dependency records from the same lockfile SHA and passed normalized package/dependency graph parity. The raw SBOM hashes differ because platform/generation metadata differs; the normalized inventory is identical. Human license/provenance review remains open, including LGPL-3.0-or-later distribution obligations.

The exact formal production gate remains NO-GO: 7 PASS, 2 PARTIAL, 1 BLOCKED and 14 MISSING_EVIDENCE. The blocked formal PostgreSQL/Memgraph record still lacks current schema/product/version/source SHA identity even though the separate run-bound live integration artifact proves the current 65-test/18-migration result. Fourteen independent, provider, product-acceptance, security and operations requirements remain missing. PR #68 remains open and unmerged at this report revision; no release tag, GitHub Release or production deployment is authorized.

## Addendum — 5 November 2026: custom content-type route follow-up (PR #71)

The current main release decision above is unchanged: the mainline is d50e56801ea77a811ec809be1574e769917fff78, run #278 is a failed/incomplete workflow attempt, and production readiness remains NO-GO. The following is a distinct follow-on candidate assessment, not merged mainline evidence.

PR #71 (https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/71) proposes the next bounded API route-family extraction into apps/api/src/content-type-routes.js. Candidate head 7c8549382faa7e39445e8f443f1006d63a1488bc (branch refactor/api-content-type-routes-2026-11) preserves API-composition authentication/site selection/capability authorization, Git-managed definition precedence, PostgreSQL advisory-lock version ordering, bounded definition/record validation, site-scoped store calls and SQL-enforced content:read:own ownership. It introduces no migration or intended public HTTP contract change.

### Hosted candidate CI — PASS on both push and pull-request events

The first checks on the initial extraction commit d56b7c0d017040150ed212ec29ec686ba37468ae caught a real regression: removing the custom route helpers also removed hasContentRead, which is still used by the legacy page-revision read routes. The PostgreSQL/Memgraph isolation suite returned 500 instead of the expected 404 for a missing page revision. The shared helper was restored in the API composition module, and a bearer-authenticated HTTP regression test now exercises the page-revision route after extraction.

The corrected exact candidate head 7c8549382faa7e39445e8f443f1006d63a1488bc passed all six jobs in both hosted workflows:

| Workflow event | Run | Result |
|---|---:|---|
| Push | [#42107807577](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42107807577) | PASS — all six jobs |
| Pull request #71 | [#42107815045](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42107815045) | PASS — all six jobs |

Producer evidence for the final candidate:
- Node.js 22.23.4 and 24.22.1 each completed clean npm ci, npm run check (210 required paths / 217 JavaScript files), and 507/507 tests with zero failures.
- Both npm 11.19.1 dependency audits reported zero vulnerabilities; both CycloneDX SBOMs were generated and the consolidated evidence aggregator passed.
- Dedicated PostgreSQL/Memgraph integration passed 65/65 tests, zero skips; fresh migration validation applied 18/18 migrations and skipped 18/18 on the idempotent second pass; Memgraph outage/replay and canonical graph rebuild passed.
- Browser smoke passed 9/9; CodeQL passed; the consolidated run-bound CI evidence gate reported CI EVIDENCE: PASS.

The formal readiness report produced by the matrix remains NO-GO: 7 PASS, 2 PARTIAL, 1 BLOCKED, 14 MISSING_EVIDENCE. The blocked formal PostgreSQL/Memgraph record still expects the separately versioned, exact-source evidence contract; the dedicated run-bound producer result is not silently substituted. Independent/provider/product-acceptance/security/supply-chain/operations evidence remains outstanding.

PR #71 remains open and has no submitted human review recorded at this assessment. The candidate has passed hosted CI but is not merged. PR #70 (https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/70), which fixes the separate workflow-rerun aggregation race, also has all six hosted checks green but remains open awaiting human review. Consequently, this successful PR #71 candidate does not repair main's historical run #278 check state or authorize a release.

Disposition: retain Hub 0.6.2 as an unreleased developer-preview patch. Merge neither follow-up without human review and the final green checks on the exact revisions. Do not create a tag, GitHub Release, package publication or production deployment. NOT_PRODUCTION_CERTIFIED remains in force.


## Historical mainline merge and local development infrastructure snapshot — 5 November 2026 (before PR #72 merge)

PR #70 (CI rerun evidence correction) merged as `dd811c6bfbd0d4475fa9199f335c65d730679fd4`; its post-merge mainline workflow [#289](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42112860410) passed all six hosted jobs. PR #71 (custom content-type route extraction) then merged to main as `54b62e233e519aa0afa6c4170578def9c02e15fc`; post-merge workflow [#292](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42120302005) passed all six hosted jobs. The current mainline state is 0.6.2; no tag, GitHub Release, package publication, or production deployment is authorized.

The exact-sha formal readiness status remains **NO-GO / NOT_PRODUCTION_CERTIFIED**: 7 PASS, 2 PARTIAL, 1 BLOCKED, and 14 MISSING_EVIDENCE. Successful CI does not satisfy independent/provider/product/operations evidence gates or the formal PostgreSQL/Memgraph evidence contract.

### PR #72 — local Docker resource migration (pre-merge snapshot; superseded by the current-mainline update below)

PR [#72](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/72), branch `chore/docker-resource-migration-2026-11-05`, is based on current main `54b62e233e519aa0afa6c4170578def9c02e15fc` and currently points at `aca463db5b7cdca9284a9a6ea1bab222a470f5cb`. Hosted push workflow [#295](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42127116871) and pull-request workflow [#296](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42127125785) each passed all six jobs: Node.js 22.23.4 and 24.22.1, live PostgreSQL/Memgraph integration, browser/editor smoke, CodeQL, and consolidated evidence. PR #72 remains open and has no requested human reviewers; do not merge it without human review.

The local recovery was performed in an isolated worktree and new stable Compose volumes. All four cold backup archives passed integrity and SHA-256 verification. The original legacy PostgreSQL/Memgraph containers and volumes remain preserved. A new `virgoscorpio_hub` role and application/test databases were provisioned without copying or modifying the legacy 14-migration `systemfabric_test` schema. Both new databases now have the current exact 18-migration ledger and 69 public base tables; application migration re-entry skipped all 18 migrations.

Local validation on Windows / Node.js 26.12.1 against the restored services:

| Check | Result |
|---|---|
| `npm run test:migrations:fresh` | PASS — exact revision-bound result for `aca463db5b7cdca9284a9a6ea1bab222a470f5cb`; 18/18 applied, 18/18 idempotent skips, exact ledger, generated disposable DB dropped. |
| `npm run test:integration:live` | PASS — 65/65, zero failures, zero skips, zero TODOs. |
| `npm run test:integration:memgraph-outage` | PASS — pending event/lease recovery, replay after graph restart, no duplicate delivery. |
| `npm run test:graph:rebuild` | PASS — canonical projection, tombstone preservation, stale-node cleanup, idempotent second rebuild. |
| `npm run dev:doctor` | PASS — 9/9 preflight checks; zero service warnings and blockers. |
| `npm run migrate` | PASS — all 18 application migrations skipped as already applied. |
| `npm run test:e2e` | PASS — 9/9 local Playwright tests using `virgoscorpio_hub_test` and loopback Memurai; temporary API server closed after the run. |

The PostgreSQL container reports healthy; Memgraph is running after the outage/replay test. The pinned runtime images were observed as `postgres@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5` and `memgraph/memgraph@sha256:bd3fe13228f40881365486729c78110dde6e04f3c1f102c84720d31f38b693f8`. The local host `vm.max_map_count` warning (262144 vs. 524288 recommended) remains a development runtime tuning note.

Local Playwright smoke passed 9/9 using the isolated `virgoscorpio_hub_test` database and loopback Memurai endpoint. The E2E suite exercises editor, collaboration and accessibility smoke paths; it does not replace manual WCAG/accessibility acceptance or full application-data acceptance. No legacy-resource retirement/rollback decision has been made. Do not remove the old containers or volumes before the agreed rollback window and explicit acceptance. The detailed backup hashes, restore procedure, image IDs, live test counts and current checklist are in [2026-11-05-LOCAL-DOCKER-RESOURCE-MIGRATION.md](2026-11-05-LOCAL-DOCKER-RESOURCE-MIGRATION.md).

This local validation is supplemental developer-environment evidence only. It does not satisfy the production load/backup/restore gate (issue #24), the formal PostgreSQL/Memgraph evidence contract, or any of the 14 external missing gates. The formal release decision remains NO-GO / `NOT_PRODUCTION_CERTIFIED`.


## Current mainline, application restore acceptance, and release gate — 5 November 2026

### Repository and hosted CI disposition

PR #72 is merged. The mainline commit is `70ce31a23aa670afca1d89fb5c776e1ca36abd84`; PRs #68–#72 are all merged. Post-merge push workflow [#301](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42135144431) completed successfully with all six jobs: supported Node.js 22.23.4 and 24.22.1 unit/security/dependency checks, PostgreSQL/Memgraph integration, browser/editor smoke, CodeQL, and consolidated evidence. Hub 0.6.2 remains an unreleased developer-preview patch. No release tag, GitHub Release, package publication, or production deployment is authorized. No version bump is appropriate for this local-infrastructure/documentation merge.

### Exact-HEAD formal readiness snapshot

The latest local `npm run release:readiness` evaluation was generated on clean source SHA `70ce31a23aa670afca1d89fb5c776e1ca36abd84` using Windows x64 / Node.js 26.12.1:

| Formal result | Count | Current interpretation |
|---|---:|---|
| PASS | 8 | Clean source tree; supported runtime; all 18 migration files present; artifact/syntax check; Hub unit/security tests; EnginEx tests; live integration tests; Playwright dependency available. |
| PARTIAL | 1 | The committed npm lockfile is reproducible, but explicit human dependency/lockfile review remains open. |
| BLOCKED | 1 | `postgres-memgraph-live` evidence does not contain the required current schema/product/version/exact-HEAD identity at the formal evidence path. |
| MISSING_EVIDENCE | 14 | Independent, provider, product, supply-chain, security, backup/restore, observability, and operations gates below. |
| NOT_RUN | 0 | All checks configured by the local evaluator ran. |

The local source checks included 508 Hub tests (505 passed, zero failed, three Windows/platform-specific skips), 94 EnginEx tests (91 passed, zero failed, three platform-specific skips), and the artifact/syntax verifier (210 required paths, 217 JavaScript files). The readiness integration stage passed 65/65 with zero failures, cancellations, skips, or TODOs. These are local engineering results; the supported Node 22/24 hosted matrix is separately validated by mainline run #301.

**Credential-drift diagnostic:** The first local readiness attempt on this SHA reported 20 PostgreSQL authentication errors (`28P01`) because the ignored local `.env` contained stale `DATABASE_URL` and `TEST_DATABASE_URL` credentials. The local preflight at that point checked TCP reachability but not PostgreSQL authentication. Only those two ignored local environment entries were aligned to the checked-in development template; no credentials were printed, committed, or added to Git. The subsequent exact-HEAD readiness run passed the full 65-test live integration suite. The earlier failed invocation is diagnostic history and is not counted as accepted evidence.

The formal database gate remains BLOCKED intentionally. The tracked `artifacts/evidence/postgres-memgraph-live.json` and `fresh-migrations.json` files are historical and must not be represented as current simply because the live test harness passes. Exact-SHA current local migration/integration/API/readiness outputs were retained outside the repository at `VirgoScorpio-Hub Backups/2026-11-05/release-acceptance-70ce31a`. The tracked evidence files were restored byte-for-byte after the test runners; the external local files are supplemental and do not substitute for the required formal evidence record.

### Application-level restored environment acceptance

The restored developer Compose environment was tested at the exact mainline SHA above. All tests used the newly named Compose volumes and the dedicated `virgoscorpio_hub_test` database for test writes. The restored application database was read through the actual API composition pool, not through a replacement test database.

| Acceptance check | Result | Scope / observation |
|---|---|---|
| `docker compose config --quiet` and current service state | PASS | PostgreSQL 18.6 healthy; Memgraph 3.13.1 running. |
| `npm run dev:doctor` | PASS | 9/9 development preflight checks; zero warnings/blockers. Its PostgreSQL checks currently prove TCP reachability, not credential authentication. |
| `npm run test:migrations:fresh` | PASS | 18/18 migrations applied; exact ordered ledger verified; 18/18 skipped on the second pass; only the generated disposable database was dropped. Evidence records exact SHA `70ce31a23aa670afca1d89fb5c776e1ca36abd84`. |
| `npm run test:integration:live` | PASS | 65/65 PostgreSQL/Memgraph/Redis/product/tenant-isolation tests; zero failures, skips, cancellations, or TODOs against `virgoscorpio_hub_test`. |
| Application database migration/schema read | PASS | Application database `virgoscorpio_hub`: 18 migration records, 69 public base tables, one site. No data was written by the smoke query. |
| Actual API runtime smoke | PASS | `createApiServer` listened on an ephemeral loopback port; `/health` returned HTTP 200, service `virgoscorpio-hub-api`, version `0.6.2`; the API's own PostgreSQL pool successfully queried the application database. Listener and pool were closed after the check. |
| Local Playwright smoke | PASS | 9/9 on the PR #72 application code tree using isolated test PostgreSQL and loopback Memurai. Mainline run #301 also passed hosted browser/editor smoke. This is not manual WCAG or screen-reader acceptance. |
| Full application data restore acceptance | PARTIAL | The legacy source `systemfabric_test` core tables inspected earlier were empty, and its 14-migration schema was intentionally not mixed into the current 18-migration Hub schema. The current Hub application DB is a clean schema with one site; no legacy customer/application records were demonstrated as restored. |

The local migration evidence, live integration result, API smoke summary, and current readiness JSON/Markdown were copied outside Git and checksummed. Selected SHA-256 values:

| External artifact (under `release-acceptance-70ce31a`) | SHA-256 |
|---|---|
| `fresh-migrations-70ce31a.json` | `629753EDD4B7D716642161AB9ECD70D197EECC8991EDB59ADB803234FEF2021C` |
| `integration-live-70ce31a.json` | `4374F8C22D1A8673BC2BB61041FFF51D26C1B12B8484431ABACA8A8C3C5B73F6` |
| `application-smoke-70ce31a.json` | `42FCC415872B01B894DE39CC3CB3F5FD5F5DE4B81A5A429FD45366DAAD8B8F4F` |
| `release-readiness-70ce31a.json` | `6ACA877033739DCDB736942EC769A9CFB6B02CAC0DDEA08D8987FDBB40817476` |

Original legacy PostgreSQL/Memgraph containers, all original volumes, and the four verified cold backups remain preserved. No `docker volume prune`, deletion, rename, or legacy-resource retirement was performed. The local Memgraph host `vm.max_map_count` warning (262144 versus the recommended 524288) remains a developer-runtime tuning note. This local restore exercise is not the approved production topology and does not close issue #24.

### Remaining 14 missing evidence gates

| Gate | Tracker | Required evidence / acceptance |
|---|---:|---|
| `tenant-isolation-review` | [#14](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/14) | Independent route/capability/data-access review, adversarial two-tenant tests, findings and retest. |
| `identity-provider-e2e` | [#15](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/15) | Real OIDC/SAML (as scoped), email, MFA recovery, session rotation/logout and failure/replay tests. |
| `clamav-corpus` | [#16](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/16) | Live scanner/corpus, fail-closed outage behavior, legacy-asset rescan/quarantine and tenant isolation. |
| `cloud-live-providers` | [#17](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/17) | Enabled provider credentials, least-privilege CRUD/multipart, lifecycle, outage and restore. |
| `stripe-live-lifecycle` | [#18](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/18) | Stripe test-mode checkout, signatures, replay/idempotency, ambiguous outcomes, refunds and subscriptions. |
| `browser-accessibility` | [#19](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/19) | Full supported-browser journeys, keyboard/screen-reader/manual WCAG review and reviewer sign-off. |
| `commerce-parity-acceptance` | [#20](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/20) | Scoped tax/shipping/discount/inventory/order/refund/download/subscription acceptance; exclude unsupported claims. |
| `community-parity-acceptance` | [#21](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/21) | Privacy, moderation, abuse controls, search, export/deletion and explicit feature-scope acceptance. |
| `plugin-container-isolation` | [#22](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/22) | Signed provenance verification and adversarial filesystem/network/resource/runtime isolation tests. |
| `dependency-sbom-codeql` | [#23](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/23) | Human dependency/lockfile/SBOM/license/provenance/CodeQL review and exact-revision evidence. |
| `load-backup-restore` | [#24](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/24) | Approved production-topology load/soak/fault tests plus full PostgreSQL/graph/object restore with measured RPO/RTO. |
| `independent-security-review` | [#25](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/25) | Qualified independent assessment, severity-ranked findings and critical/high remediation/retest or authorized risk acceptance. |
| `operations-release-approval` | [#26](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/26) | Named owner, rehearsed deploy/rollback/secret/incident runbooks, monitoring and explicit exact-SHA release decision. |
| `observability-production` | — | Approved OTLP backend, TLS/authentication, retention, delivery/alert validation, named owner and exact-environment evidence. |

### Recommended execution order

1. **Keep production NO-GO.** Do not create a release tag, publish packages, enable production traffic, or delete legacy rollback resources.
2. Complete independent tenant-isolation review (#14) and independent application-security assessment (#25); remediate and independently retest severe findings.
3. Freeze the release topology/provider/feature scope, then execute identity, scanner, cloud, Stripe and signed-plugin evidence in the approved test environments (#15–#18, #22).
4. Complete browser/WCAG plus scoped commerce/community acceptance (#19–#21); ensure product claims match accepted capabilities.
5. Complete human supply-chain review (#23), production-topology load/restore drills (#24), observability deployment acceptance, and operations/release-owner approval (#26).
6. Resolve the formal PostgreSQL/Memgraph evidence identity/path issue for the exact final source SHA. Regenerate all revision-bound evidence after the last code or documentation commit; do not transplant the local sidecars as if they were current formal-path evidence.

### Next engineering improvement identified

The credential-drift incident showed that `scripts/dev-doctor.js` reports PostgreSQL PASS after a TCP handshake only; it does not authenticate with `DATABASE_URL` or `TEST_DATABASE_URL`. Add a bounded, read-only `SELECT 1` credential check (with redacted error codes and no connection-string logging) and tests proving a bad password is surfaced without mutating either database. This is a development-diagnostic improvement, not a production-gate waiver or an application-code regression.

## Current mainline after PRs #73 and #74 — 6 November 2026

The current mainline is VirgoScorpio Hub 0.6.2 at 9c28d5501b6e3cfd723f2495d1544beed4f29d4d. PR #73 (release documentation synchronization) merged as 4b24227eebb61d7ad6903a4c6b9f5ce131c07026; PR #74 (authenticated PostgreSQL development preflight) merged as 9c28d5501b6e3cfd723f2495d1544beed4f29d4d. Mainline push workflow #309 passed all six hosted jobs: supported Node.js 22.23.4 and 24.22.1, PostgreSQL/Memgraph integration, browser/editor smoke, CodeQL and consolidated evidence. These changes added no migration, dependency or public API contract change and did not authorize a release or production deployment.

The most recent complete formal local readiness evaluation retained in this report is bound to SHA 70ce31a23aa670afca1d89fb5c776e1ca36abd84 and reports 8 PASS, 1 PARTIAL, 1 BLOCKED and 14 MISSING_EVIDENCE. Do not relabel those counts as a newly generated exact-HEAD evaluation for 9c28d55. The blocked PostgreSQL/Memgraph formal evidence identity and all independent/provider/product/security/operations gates remain open. Regenerate exact-source readiness and formal evidence on the final candidate after the last code/documentation change.

### Internal tenant isolation pre-review — candidate PR #75

The relationship route now uses the shared siteIdFor request-context resolver so path, header, query and POST-body selectors must agree and repeated siteId selectors fail closed. The prior SQL operations were already scoped to the path site; this change makes selector handling consistent with other site-addressed routes. The targeted local PostgreSQL tests passed 9/9 with zero skips: conflicting relationship selectors, repeated query selectors, cross-site relationship endpoints in both directions (404 with no persisted relation), same-site positive control, and existing content/revision/collaboration side-effect checks. The full npm run check also passed on the branch.

The 6 November Tenant Isolation Internal Pre-Review records the test inventory, scope and gaps. It is explicitly **not independent review evidence** and does not close issue #14 or the broader independent security assessment issue #25. A qualified reviewer must still complete the route/data-access inventory, adversarial two-tenant review across workers/providers/realtime/storage/privileged paths, findings disposition and exact-SHA evidence. Production remains NO-GO / NOT_PRODUCTION_CERTIFIED.

PR #75 is the current unmerged code candidate based on mainline 9c28d55; hosted CI and human review are required. No release tag, GitHub Release, package publication or production deployment is authorized.