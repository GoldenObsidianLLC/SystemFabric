# SystemFabric Repository Coherence and Continuity Review

**Review date:** 1 November 2026
**Repository:** `GoldenObsidianLLC/SystemFabric`
**Reviewed main SHA:** `1a903b8eab4304dd61b2489381b091d34f1ea546`
**Reviewed candidate:** PR #36, `f9d463ef9ca82d15c9220e15cf50df2ba6367a11`
**Comparison branch:** PR #35, `db18267cece70e30be52425cd66c400b7480d82b`
**Overall conclusion:** coherent engineering direction with material documentation/evidence drift; candidate improvements are not merged; production remains **NO-GO / NOT_PRODUCTION_CERTIFIED**.

> This is a repository and engineering-process review, not an independent penetration test, legal opinion, corporate authorization, deployment assessment, or production certification. It distinguishes source-level observations from externally evidenced behavior.

## 1. Executive assessment

The repository has a recognizable and increasingly evidence-oriented structure. Its application surfaces, shared packages, test layers, architectural references, contribution guidance, release-evidence schema, and CI workflow broadly reinforce one another. The current CI pipeline is materially stronger than several still-committed readiness documents suggest.

The most important weaknesses are not evidence of a broken architecture; they are continuity and assurance-control weaknesses:

1. **Release documentation has drifted.** Several committed documents continue to describe the 30–31 October state, older migration counts, earlier test counts, and PR #12-era CI evidence. They are still useful historical records but are not safe to present as the current status without explicit historical labels.
2. **Readiness evidence is not consolidated.** The candidate's per-runtime readiness report flags source-tree and integration blockers even though the separate live PostgreSQL/Memgraph job passed. The readiness generator and workflow do not yet combine all job artifacts into one exact-candidate assessment.
3. **The security candidate is not yet review-complete.** PR #36 has useful targeted fixes and passing hosted checks, but has no human approval; five CodeQL results remain open; and an automated review comment raises a filesystem-race concern in `scripts/setup-dev.js`.
4. **The highest-risk assurance gates remain external or independent.** No independent tenant-isolation review, independent security assessment, production-provider E2E, full accessibility acceptance, backup/restore drill, or operations approval has been evidenced.
5. **The overlapping security PRs require deliberate continuity management.** PR #35 and #36 diverged from the same `main` base and must not both be merged independently.

The recommended posture is to preserve the current developer-preview boundary, choose one canonical security change set after review, repair the evidence/reporting path, reconcile historical documentation, and keep unfunded or independent work explicitly backlogged.

## 2. Review method and scope

The review compared the default-branch tree and selected source, package, workflow, test, and documentation records against the two open remediation pull requests, their changed-file inventories and diffs, the open release issues, and the latest completed PR #36 workflow run.

### Repository inventory observed on `main`

| Area | Observed inventory | Interpretation |
|---|---:|---|
| Git tree entries | 557 | Includes directory and file entries; tree was not truncated. |
| Domain packages | 21 | AI, auth, billing, cloud, collaboration, commerce, community, DB, domain, graph, icons, library, math, media, notifications, observability, plugins, realtime, render, security, widgets. |
| Application entry-point groups | 5 | API, admin, MCP, plugin runner, worker. |
| JavaScript test files | 44 | Unit/security, integration, and browser suites are separated by directory. |
| Database integration test files | 10 | Dedicated coverage for PostgreSQL, Memgraph, Redis, collaboration, commerce, community, migrations and tenant isolation. |
| GitHub Actions workflow files | 1 | A single CI workflow contains five jobs. |

The inventory is a structural count, not a code-quality score. The review emphasized the release-critical source, workflow, and documentation paths rather than claiming a manual line-by-line audit of all 557 tree entries.

### Positive coherence signals

- Root `README.md` clearly states that 0.5.1 is not production-certified and points readers to readiness documentation.
- `docs/ARCHITECTURE.md` accurately frames itself as a high-level code map, not a deployment blueprint; it describes the same five app surfaces and shared package structure found in the tree.
- `docs/README.md` and `DOCUMENTATION_STANDARDS.md` establish useful task-based navigation and distinguish implementation from certification evidence.
- `docs/RELEASE-EVIDENCE.md` defines an explicit evidence schema, artifact-path requirements, and gate catalogue.
- The CI workflow uses an Ubuntu 24.04 runner, a Node 22/24 matrix, full-SHA action pins for checkout/setup-node/artifact upload, limited default permissions, a dedicated PostgreSQL/Memgraph/Redis integration job, Playwright smoke, and CodeQL analysis.
- `CHANGELOG.md` retains an Unreleased section; `ROADMAP.md` is evidence-oriented and avoids delivery-date promises.
- The project documentation repeatedly warns that passing tests, adapters, and test doubles are not provider certification.

## 3. Findings: continuity, correctness, and risk

### C-01 — Release-readiness documentation is stale (High)

`docs/RELEASE_READINESS.md` still presents a 31 October snapshot with 9 PASS / 1 PARTIAL / 0 BLOCKED / 13 missing evidence, an earlier source SHA and PR #12 references. Its test counts and EnginEx counts predate the 1 November candidate evidence. The current PR #36 snapshot reports 6 PASS / 2 PARTIAL / 2 BLOCKED / 13 MISSING_EVIDENCE / 0 NOT_RUN. The candidate's five hosted CI jobs passed, but the readiness report itself contains two blockers that need resolution and interpretation.

`docs/RELEASE-GATE.md` still says CI had not run successfully in the packaging environment and references 13 migrations and earlier local validation. `docs/LOCAL-VALIDATION.md` and `docs/LOCAL-VALIDATION-CHECKPOINT-2026-10-28.md` record earlier branch-specific local runs and migration counts. Those snapshots are valuable history; without prominent labels they can contradict current CI evidence.

**Disposition:** preserve old records but label them as historical/superseded; add one current report and one current repository review as the top-level assurance references. Do not rewrite historical results as if they were rerun.

### C-02 — Readiness tool and CI workflow do not form one evidence chain (High)

The 1 November candidate readiness report identifies four changed paths on a GitHub-generated merge-ref checkout (`15f35a4f28e547b8437c5f034722096e2b3a16db`). Exact path names were not resolved in the assessed summary. The CI unit/dependency job performs postinstall, SBOM generation and other artifact-producing actions before invoking `release:readiness`; the readiness script evaluates `git status --porcelain` and can mark the clean-source check blocked. Its evidence validation also blocks otherwise valid evidence when the source tree is dirty.

Separately, the dedicated database integration job passes 22/22 tests with zero skips, but the readiness script invoked in the service-less Node matrix sees integration tests skip because that job has no PostgreSQL/Memgraph services. The readiness tool does not import the dedicated integration job's artifact into its report. This produces an incomplete candidate-level status: the actual live suite passed, while the unit-job report says partial/blocked.

This is an **evidence orchestration defect**, not a reason to conceal source mutations or to convert skipped tests into passes.

**Disposition:** backlog a narrowly-scoped fix. Identify every dirty path first; preserve fail-closed behavior for genuine source edits; explicitly model generated outputs; aggregate exact-SHA workflow artifacts in a final report; distinguish service-less skips from the real integration job; add positive and negative tests.

### C-03 — PR #35 / PR #36 are overlapping and diverged (High)

Both PRs target `main` at `1a903b8eab4304dd61b2489381b091d34f1ea546`. PR #35 head is `db18267cece70e30be52425cd66c400b7480d82b` (5 commits, 11 changed files). PR #36 head is `f9d463ef9ca82d15c9220e15cf50df2ba6367a11` (10 commits, 21 changed files, draft). Comparing their heads reports 10 commits ahead and 5 behind, with a common merge base at `main`.

PR #36 contains the expanded filesystem/input fixes, dynamic SBOM/dependency evidence, route/capability map, broader denied-capability tests, and a Stripe subscription tenant-binding correction. PR #35 includes overlapping fixes and older SBOM-normalization artifacts (`artifacts/systemfabric.sbom.cdx.json`, `scripts/normalize-sbom.js`, `test/sbom-normalization.test.js`) that may be superseded by PR #36's dynamic generator and dependency-evidence tests. Supersession must be confirmed from the actual commit history and functional requirements, not assumed from filenames.

**Disposition:** keep both unmerged; select one canonical branch after a commit/file-level reconciliation. Port any still-required unique behavior into the canonical branch, re-run hosted checks, request human review, then close the superseded PR with a clear cross-reference. Never merge both independently.

### C-04 — Candidate review is not complete (High)

The latest PR #36 hosted workflow run `41340899584` completed all five jobs successfully on the candidate head. The candidate remains draft; no human reviewer was requested or approval recorded. The PR has an automated review comment from GitHub Advanced Security on `scripts/setup-dev.js` describing a potential filesystem race condition. This comment needs explicit investigation and response, even though it is not necessarily one of the five CodeQL findings reported in the candidate scan.

The candidate scan still has four High cookie-flow alerts (#4–#7) and one Medium legacy dynamic-code alert (#14). A successful CodeQL action means analysis completed, not that the result set is clean. The main branch has not received candidate fixes.

**Disposition:** investigate the automated filesystem-race comment; manually triage each open alert; preserve alerts until a supported disposition is verified; obtain human security review on the exact candidate SHA.

### C-05 — Tenant isolation is the critical unresolved assurance gate (Critical)

The candidate contains a preliminary route/capability/data-access map, 16 denied-capability route-family test cases and an authorized positive control. Existing PostgreSQL integration tests cover selected two-site community-feed access and malformed/conflicting site selectors. The Stripe webhook regression verifies tenant-binding SQL parameters with a query-recording test double.

These are worthwhile regression controls, but they are not a comprehensive two-tenant object-ID and side-effect matrix, a complete route/worker/realtime audit, or independent review. The candidate route map pins an earlier commit than PR #36 head and requires refresh. The dedicated two-site webhook PostgreSQL test remains absent from the committed/hosted candidate evidence described in the status report.

**Disposition:** refresh route inventory to the exact reviewed candidate; extend real PostgreSQL tests for cross-site object IDs, denied side effects, duplicate/replayed webhooks and mismatched site/user/plan bindings; keep issue #14 open until a genuinely independent reviewer completes and records the assessment.

### C-06 — Supply-chain and licensing questions remain (High)

The package lock SHA is identical across the Node matrix, but SBOM component inventories differ because the npm versions differ. The observed optional/transitive component variance has not been isolated under a constant Node/npm environment. Archive-level inspection recorded LGPL-declared Linux libvips tarballs without separate license/notice files and compound-license sharp archives with an included Apache-2.0 license text. SBOM presence and zero npm vulnerabilities do not establish compliance with distribution obligations. Provenance/attestation is also not established.

**Disposition:** maintain issue #23; hold Node and npm constant to isolate inventory differences; map exact platform-specific artifacts to upstream license terms and required notices/source/relinking obligations; seek qualified legal review before distribution; implement verifiable provenance.

### C-07 — Release scope and manifest are not yet owner-approved/current (High)

`docs/RELEASE-SCOPE.md` is clearly labelled recommended, with named release-owner sign-off pending. Its recorded source baseline is historical. `RELEASE-MANIFEST.json` contains prior commit pins and previous test/CI counts. Updating these values to the current PR #36 head would be premature while the candidate is unapproved, draft and unreconciled with PR #35.

**Disposition:** keep the proposed preview scope unapproved until a named release owner selects providers, exclusions, topology and candidate SHA. Refresh the manifest and scope baseline only as part of that reviewed decision; never infer adoption or sign-off from this engineering review.

### C-08 — Architecture is modular at package boundaries but has large orchestration files (Medium)

The package layout is coherent, but `apps/api/src/server.js` is approximately 166 KB and `apps/api/src/platform-routes.js` approximately 56 KB on the reviewed main snapshot. These files carry large portions of server composition and route dispatch. That raises change-coupling, review-surface and regression-localization costs, especially around authorization and provider callbacks.

**Disposition:** defer broad refactoring while the security candidate is being stabilized. Later, extract route families behind explicit, tested interfaces, preserve authorization ordering and side-effect contracts, and migrate one route family at a time with characterization tests. Do not mix broad refactoring into the release/security remediation branch.

### C-09 — Documentation has useful depth but some historical patch-note sprawl (Medium)

The root `PATCH-NOTES-*` and `SECURITY-PATCH-NOTES.md` files overlap in subject matter with the changelog, release evidence, and focused security review documents. The detailed records should not be deleted during a release hardening pass; however, they can make it difficult to distinguish authoritative current state from implementation history.

**Disposition:** keep the patch-note archive intact for now. After the 0.5.1 candidate is stable, establish a clear policy: changelog for project-level changes, dated reports for evidence snapshots, ADRs for durable decisions, and patch notes only where a focused historical record adds unique value. Link rather than duplicate.

### C-10 — Unfunded governance constraints remain real gates (High)

The project operating premise remains no funding, no liquid reserve and no approved spending budget. Issue #32 remains open. The zero-reserve operating/capital resolution is a draft, not a verified adopted/signed company resolution. No independent reviewer/assessor or vendor has been contacted, retained or approved.

**Disposition:** no paid work, vendor/assessor engagement, subscriptions, borrowing, provider mutation or other financial commitment absent cleared funds and proper transaction-specific authority. Do not rely on the draft resolution as corporate authorization. Entity status, governing documents, authority and any formal adoption require appropriate professional advice.

## 4. Safe fixes to apply in the documentation layer

The following changes are suitable as a documentation-only review patch and do not pretend to close a certification gate:

- Archive the complete 1 November project status report at `docs/reports/2026-11-01-SystemFabric-0.5.1-Project-Status-Report.md`.
- Add this repository coherence/continuity review at `docs/REPOSITORY-COHERENCE-AND-CONTINUITY-REVIEW-2026-11-01.md`.
- Add direct links to both records in `docs/README.md` under a clearly marked current-status section.
- Add a prominent 1 November status correction to `docs/RELEASE_READINESS.md`, and relabel the 31 October snapshot as historical/superseded rather than silently overwriting it.
- Add historical/superseded notices to `docs/RELEASE-GATE.md` and `docs/LOCAL-VALIDATION.md`, preserving the original dated results as historical evidence.
- Add a current-baseline notice to `docs/PRODUCTION-CERTIFICATION-PLAN.md` while preserving its gate procedures.
- Correct the stale migration milestone wording in `docs/IMPLEMENTATION-ROADMAP.md` to reference the current 14-migration fresh-install evidence and supported v0008-to-current upgrade fixture.
- Add a changelog entry describing the documentation/evidence reconciliation, not a software release claim.

The documentation-only patch has now been applied to an isolated local worktree on branch \`docs/repo-coherence-continuity-2026-11-01\`, created from the reviewed \`main\` SHA. The separate local GitHub CLI session is authenticated; issue [#37](https://github.com/GoldenObsidianLLC/SystemFabric/issues/37) has been created for the readiness-aggregation work. The primary \`main\` worktree and the PR #35/#36 worktrees were left unchanged. This branch contains documentation/evidence reconciliation only; it does not change application code, release manifest, release scope, security posture, or governance decisions.

## 5. Work that cannot be completed from this review and must remain backlogged

| Priority | Work | Why it remains open | Tracking / acceptance boundary |
|---|---|---|---|
| P0 | Reconcile PR #35 and #36 into one reviewed candidate | Requires human maintainer/security disposition of overlapping commits and automated comments. | PR #35/#36; one canonical reviewed SHA; all unique required changes retained; CI rerun. |
| P0 | Human triage of CodeQL #4–#7 and #14 plus filesystem-race comment | Automated analysis does not make a risk acceptance decision. | Issue #23 / security review; per-finding rationale, code change or explicit authorized risk decision, retest. |
| P0 | Independent tenant/site isolation assessment | Cannot be self-certified by the implementer; no reviewer engaged. | Issue #14; independent reviewer, exact SHA, scope/matrix, findings, retests and retained evidence. |
| P0 | Independent application security assessment | Requires qualified independent assessor and remediation/verification. | Issue #25; accepted report and critical/high remediation. |
| P0 | Release scope and release-owner sign-off | No named owner approval and candidate reconciliation yet. | Issue #13; signed/reviewed scope, provider matrix, exact SHA, limitations. |
| P0 | Operations readiness and release approval | No approved deployment topology, operations owner, backup/restore/rollback and incident acceptance. | Issue #26; rehearsed runbooks and exact-candidate approval record. |
| P0 | Corporate zero-reserve controls | Draft only; legal standing/authority/adoption not verified. | Issue #32; proper company process and qualified advice; no implied spend authority. |
| P1 | Cross-job readiness aggregator and dirty-tree diagnosis | Needs code changes, job artifacts and negative tests. | GitHub issue [#37](https://github.com/GoldenObsidianLLC/SystemFabric/issues/37); identify four paths, safe generated-output policy, exact-SHA aggregate. |
| P1 | Identity/email/MFA provider validation | Requires real provider test infrastructure and recovery workflows. | Issue #15; provider-scoped test evidence. |
| P1 | Live ClamAV corpus and legacy-asset treatment | No accepted scanner/corpus evidence. | Issue #16; fail-closed, known test signatures, outage and rescan results. |
| P1 | Cloud storage provider least-privilege validation | No provider account/credential validation in scope. | Issue #17; select providers and test actual lifecycle and isolation. |
| P1 | Stripe lifecycle validation | Query-recording unit test is not full provider/database lifecycle. | Issue #18; dedicated PostgreSQL + Stripe test-mode replay/failure/refund/subscription evidence. |
| P1 | Accessibility, commerce/community acceptance | Smoke tests and partial route foundations are narrower than acceptance. | Issues #19–#21; selected supported scope and actual user-facing acceptance. |
| P1 | Plugin signature/provenance and adversarial isolation | Interface/policy source is not runtime assurance. | Issue #22; built/sign/verify and hostile execution boundary evidence. |
| P1 | SBOM variance, license notices and provenance | Root cause and legal notice mapping remain open. | Issue #23; stable matrix, legal review and verifiable attestations. |
| P1 | Load/soak/fault injection and backup/restore | No production topology or accepted RPO/RTO evidence. | Issue #24; rehearsed target environment and measured recovery. |
| P2 | Incremental API route-module extraction | Broad refactoring adds regression risk during release stabilization. | Separate architecture issue after security candidate freeze; characterization tests and narrow migrations. |
| P2 | Consolidate duplicated patch-note history | Historical records should be preserved until references and unique content are mapped. | Documentation maintenance task after candidate freeze. |

The evidence gates above should be narrowed only by an explicit, reviewed release-scope decision that also disables or removes out-of-scope capabilities. They must not be marked complete because a checklist, adapter, draft plan, automated test, or internal review exists.

## 6. Recommended execution sequence

1. **Preserve the current release posture.** Continue describing 0.5.1 only as an expanded developer preview and keep production NO-GO.
2. **Publish the records.** Apply the documentation patch so the status report and repository-level continuity review are discoverable from `docs/README.md`.
3. **Reconcile the security branches.** Review commits and changed files across PR #35/#36; retain one canonical candidate; address the setup-dev filesystem-race comment and all open CodeQL results; request appropriate human review.
4. **Repair the evidence chain.** Identify exact dirty paths, correct generated-artifact handling without weakening source integrity, aggregate dedicated live integration evidence, and add negative/positive regression tests. Keep the actual independent/provider gates separate.
5. **Approve scope before external validation.** A named release owner should set exact candidate SHA, selected provider matrix and exclusions. Refresh `RELEASE-MANIFEST.json` only then.
6. **Complete independent and provider gates only with legitimate evidence.** Tenant isolation and security require independent reviewers; provider tests require actual isolated provider environments; operations gates require an approved target topology.
7. **Keep capital controls intact.** No paid work or commitments until cleared funds and appropriate authority exist. The draft resolution is not an approval.
8. **Refactor only after security stabilization.** Move route code behind narrow interfaces gradually, retaining authorization and side-effect characterization tests.

## 7. Final conclusion

SystemFabric's source and process show a sound direction: modular domain packages, separate application entry points, layered test suites, a useful evidence contract, and a security-conscious CI baseline. The most pressing continuity problem is that the repository's current-state documentation and the formal readiness tooling lag the latest engineering evidence. A documentation reconciliation is safe and valuable now; readiness aggregation and source fixes should be implemented as a separate, test-driven code change. Independent review, production-provider acceptance, legal/license analysis, operating controls, and production operations cannot be simulated or declared complete from this repository review.

**Disposition:** engineering-positive; documentation report and continuity review applied on an isolated, unmerged documentation branch; readiness aggregation backlogged as issue #37; security candidate still requires human review; production remains **NO-GO / NOT_PRODUCTION_CERTIFIED**.
