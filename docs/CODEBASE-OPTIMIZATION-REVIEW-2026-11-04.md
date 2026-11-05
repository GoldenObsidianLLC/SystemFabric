# Codebase Optimization Review — 4 November 2026

**Baseline:** `main` at `a8ca0afec79cf68258906de2cdc65e1a347c1053` (PR #61).
**Working branch:** `refactor/codebase-patterns-2026-11`.
**Release candidate:** `0.5.2` (SemVer patch; unreleased).
**Scope:** repository-wide source/test inventory and pattern scan, followed by representative implementation review. This is an engineering architecture review, not an independent security audit or production-readiness certification.

## Executive summary

The repository has useful package seams and several already-centralized cross-cutting helpers. The highest-return optimization was not a broad rewrite: it was to remove repeated PostgreSQL transaction lifecycle boilerplate from two cohesive modules and route those transactions through the existing `withTransaction` helper. The change preserves the domain SQL, ordering, tenant predicates, advisory locks, and response contracts.

The review deliberately leaves large, policy-sensitive modules intact. Their size is a genuine maintainability concern, but extracting them without strong route-family and authorization seams would increase risk rather than improve architecture.

## Review method and inventory

The scan enumerated **198 JavaScript source and test files** across `apps/`, `packages/`, `scripts/`, and `test/` (10 app files, 76 package files, 26 script files, and 86 test files). It compared repeated transaction lifecycles, identifier handling, output encoding, request parsing, error normalization, worker lifecycle patterns, and module/file-size pressure points. It also reviewed the existing architecture map, roadmap, prior architecture review, and representative implementations/tests.

Pattern-search results were treated as leads, not as proof that two code paths have identical contracts. Several representative call paths were inspected in detail. This method is broad and systematic, but it is not a line-by-line audit of every implementation, test, configuration, or dependency.

## Reusable modules already established

The repository now has these shared modules:

- `packages/domain/src/version.js` (added in this candidate) — derives the SemVer product version from the root package metadata and is reused by verification, CI evidence, migration evidence, and OpenTelemetry defaults so version bumps do not leave stale runtime literals behind.
- `packages/domain/src/identifiers.js` — canonical UUID syntax and validation.
- `packages/security/src/output-encoding.js` — HTML text and quoted-attribute encoding. It is not a general sanitizer for script, CSS, URL, or raw markup contexts.
- `packages/db/src/transaction.js` — explicit PostgreSQL transaction modes, client acquisition/release, commit, best-effort rollback, and preservation of the original failure.
- `packages/observability/src/trace-identifiers.js` — canonical trace/span/flags/request identifier syntax.

The current change extends the transaction helper to the community workflows and Stripe checkout reconciliation modules.

## Changes implemented in 0.5.2

### Community transaction lifecycle

`packages/community/src/workflows.js` now uses `withTransaction` for all five manually managed transactions:

1. Direct conversation creation.
2. Message creation and notification fan-out.
3. Report submission, including serialized rate-limit accounting.
4. Report status changes and dismissal audit records.
5. Activity/message moderation and moderation audit records.

The transaction callbacks return result data. HTTP response writing occurs only after the helper has committed and released the PostgreSQL client. Existing authorization checks, site-scoped SQL predicates, advisory locks, state transitions, notification writes, and response status/payload shapes remain in place.

### Checkout reconciliation

`packages/billing/src/checkout-reconciliation.js` now uses the same transaction helper for the locked pending-order reconciliation. The callback returns a small outcome (`paid`, `expired`, or `held`); in-memory summary counters are updated only after the transaction helper has resolved successfully. This keeps the reported summary aligned with committed transitions rather than work attempted inside a transaction.

### Regression coverage

New community workflow tests verify that direct conversation creation commits before the response is returned, releases its client, and rolls back/releases when the block policy denies creation. Existing transaction and checkout reconciliation tests were included in the focused run.

**Focused validation:** 21 tests passed, 0 failed, 0 skipped across `community-workflows`, `checkout-reconciliation`, and `db-transaction` suites. The full repository check is recorded in CI/PR evidence for this candidate.

No database migration, external provider call, or public HTTP contract change was introduced.

## Architecture pressure points

The largest application and package modules found by the inventory include:

| Module | Approx. lines | Assessment |
| --- | ---: | --- |
| `apps/api/src/server.js` | 2,484 | API composition, routing, authorization dispatch, and domain orchestration are too concentrated. Extract cohesive route families behind narrow explicit contexts; keep authentication, site resolution, and policy enforcement authoritative. |
| `scripts/ci-evidence.js` | 742 | Large evidence aggregation module. Consider separating evidence schemas/validation from report formatting only where the contract is stable. |
| `packages/realtime/src/websocket-gateway.js` | 696 | Complex authorization, reconnect, subscription, quotas, and lifecycle behavior. Prefer internal helpers with behavior-focused tests; preserve delivery guarantees. |
| `packages/db/src/postgres-store.js` | 651 | Several content persistence capabilities share tenant and revision invariants. Extract by cohesive data capability, not by arbitrary file size. |
| `packages/realtime/src/redis-realtime.js` | 609 | Keep ephemeral transport/fan-out semantics explicit and separate from durable PostgreSQL event delivery. |
| `packages/auth/src/service.js` | 546 | Candidate internal seams include session lifecycle, MFA, verification, invitations, and site membership. Retain one authoritative identity and authorization model. |
| `apps/api/src/platform-routes.js` | 552 | Move route families incrementally, passing only the dependencies and policy functions they require. |
| `apps/admin/assets/studio.js` | 502 | Potential UI module split by editor responsibility; preserve browser event and state contracts. |

These are prioritization signals, not mandates to split every large file.

## Reuse opportunities and boundaries

### High-value next steps

1. **API route-family extraction (P1).** Start with a bounded route family whose dependencies are explicit. Its interface should receive a small context containing only required stores, policy checks, and response helpers. Do not pass the entire server closure or a broad mutable registry.
2. **Authentication module deepening (P1).** Identify cohesive internal seams for session, MFA, verification, invitations, and site membership. Keep credential verification, authorization, audit, and invalidation ordering explicit; prove each extraction with existing security tests.
3. **Remaining transaction adoption (P1).** Evaluate smaller persistence modules individually. Adopt `withTransaction` when a block is genuinely one PostgreSQL transaction and all external effects can safely remain outside it. Continue with authentication or content persistence only after each operation's side effects and invariants are mapped.
4. **Content-store capabilities (P2).** Consider separating revision/publication and owner-scoped read capabilities behind narrow store interfaces. Preserve site/actor predicates close to the queries and test against the store seam.
5. **Real-time internals (P2).** Extract helpers only where lease, authorization, backpressure, and reconnect behavior can be defined independently and tested without weakening the gateway's delivery guarantees.

### Deliberately not generalized

- **Worker loops:** outbox delivery, graph projection, mail, scheduler, and AI task processing differ in durability, acknowledgment, ordering, lease, retry, and idempotency semantics. Do not create one generic worker abstraction until two concrete adapters demonstrably share the same contract.
- **HTTP body parsing:** API and plugin-runner paths have different body limits, trust contexts, and failure responses. Define the complete parsing contract before sharing implementation.
- **Error-code normalization:** provider/database/application error identifiers have different fallback and allow-list requirements. Agree on semantics before centralizing.
- **Constant-time comparisons:** callers have different input encodings, empty-secret handling, and policy gates. Share only a byte comparison primitive if it does not absorb those caller policies.
- **Object storage and filesystem work:** library upload/replacement crosses PostgreSQL and object storage/filesystem. Those systems do not share one atomic transaction. Retain explicit compensating cleanup/reconciliation rather than hiding external effects inside a generic SQL helper.
- **Rendering encoders:** context-specific escaping remains context-specific. HTML encoding is not a replacement for URL validation, JavaScript serialization, CSS escaping, or trusted markup policy.

## SemVer and release notes

Version is advanced from **0.5.1 to 0.5.2**, a patch increment under Semantic Versioning: these are compatible internal refactors and regression tests, with no declared public API contract change. The version is an **unreleased candidate**; no release tag or package publication is implied. The release manifest remains `EXPANDED_DEVELOPER_PREVIEW_NOT_PRODUCTION_CERTIFIED`.

## Verification limits and safety

- A clean `npm ci --no-audit --no-fund` completed on Windows / Node.js 26.12.1.
- The focused test suites passed 22/22 after the transaction refactors.
- Full `npm run check` passed on this candidate: 189 required artifact paths, 200 JavaScript files syntax-checked, and 427 tests (424 passed, 0 failed, 3 platform-specific skips). The three skips are explicitly reported by the test suite; none is a failure.
- `npm audit --audit-level=high` reported 0 vulnerabilities on this installed dependency tree.
- Local PostgreSQL/Memgraph live integration was not independently run during this review unless the candidate CI evidence explicitly says otherwise.
- GitHub Code Scanning was checked against the base `main` commit `a8ca0af` on 4 November 2026: five open alerts were reported on that exact commit (four High `js/clear-text-storage-of-sensitive-data` findings in `apps/api/src/server.js` at lines 844, 866, 939, and 969; one Medium `js/unsafe-code-construction` finding in `vendor/enginex/engine-legacy.js` at line 569). They remain open and were not dismissed or waived. Recheck after the candidate merge; a successful build or unit suite is not a security audit.
- The work does not certify production readiness, provider connectivity, disaster recovery, capacity, accessibility, or external integration behavior.

**Design rule:** deepen a module only where it reduces the facts callers must know. Prefer a small interface with a strong implementation, and keep domain policy, authorization, and cross-system consistency visible where contracts differ.

## Follow-up — 4 November 2026: renderer security and compatibility boundary

PR #65 merged Hub 0.6.0 / EnginEx 7.0.0 and removed the explicit legacy arbitrary-JavaScript template renderer instead of suppressing or waiving the finding. The default-branch CodeQL analysis marked alert #14 fixed at `2026-11-04T23:31:37Z`; it was not dismissed. The four High authentication findings #30–#33 were also fixed by the earlier auth route/cookie extraction without manual dismissals. The earlier 0.5.2 architecture review and validation counts above are historical snapshots; the 0.6.0 candidate validation is summarized here.

- Deleted `vendor/enginex/engine-legacy.js`; no application call sites were found in `apps/`, `packages/`, `scripts/`, or `test/`.
- Removed `allowUnsafeRequire`; calls with `allowUnsafeCode: true` or `engine.unsafe()` now fail closed with `ERR_ENGINEX_UNSAFE_API`.
- Legacy `<?njs ?>` source is rejected with `ERR_ENGINEX_UNSAFE_CODE_DISABLED`; the safe restricted-expression interpreter and generated renderer remain.
- Added an explicit EnginEx 6.x to 7.0.0 migration guide. Existing JavaScript blocks must be converted to restricted expressions, host-owned view-model preparation, or narrowly registered helpers. No automatic conversion is attempted.
- Made both root and vendored EnginEx test runners serial (`--test-concurrency=1`) after the default parallel root suite exhausted memory on the Windows workstation. The bounded root runner passes 437 tests (434 passed, 0 failed, 3 platform-specific skips); EnginEx validation passes 94 tests (91 passed, 0 failed, 3 platform-specific skips) and verifies 31 package files.
- Local Hub validation passes 194 required artifacts, 205 JavaScript syntax checks, 437 tests (434 passed, 0 failed, 3 Windows/platform skips), with zero high-severity npm audit vulnerabilities.

**Compatibility/versioning:** EnginEx 6.2.0 → 7.0.0 is a major version change because arbitrary-JavaScript template execution was removed. VirgoScorpio Hub 0.5.4 → 0.6.0 is a minor pre-1.0 increment under SemVer's pre-1.0 compatibility convention. This candidate is not yet released or production-certified.

**Security disposition:** alert #14 was open on baseline `aa361ab` and is now fixed in the default-branch CodeQL record after PR #65; no dismissal or suppression was used. The four High auth alerts #30–#33 are likewise fixed without manual dismissal.

## Follow-up — 4 November 2026: commerce route-family extraction

PR #66 candidate extracts the products, orders, refunds, checkout, and membership route family from apps/api/src/platform-routes.js into apps/api/src/commerce-routes.js. The composition module now coordinates the existing community and commerce route families plus remaining platform routes; it no longer owns the 436-line commerce/membership block. The new commerce module receives a bounded request-scoped context containing the actor, site/capability guards, body reader, response/error functions, database pool, runtime environment, and identity audit dependency.

- The API composition layer retains request authentication, site resolution, authorization dispatch, observability, and central errors. The commerce module does not independently authenticate the actor or infer the site.
- Existing site predicates, Stripe idempotency/recovery, refund locking and provider behavior, inventory reservation transitions, and membership persistence are moved intact rather than reimplemented.
- apps/api/src/request-validation.js centralizes bounded JSON-object checks (UTF-8 byte ceiling; serialization errors fail closed). Platform route UUID validation now reuses packages/domain/src/identifiers.js.
- Added focused tests for route decline/no side effects, site/capability/read order, malformed product writes, cross-site denial, and request object byte/serialization limits. The focused API/commerce/platform test group passes 41/41 using the candidate's vendored EnginEx 7.0.0 and the existing shared dependency cache; this includes a compatibility test preserving the former platform router productInput export.
- Local full validation on Node.js 26.12.1: 200 required artifacts, 209 JavaScript files syntax-checked, and 445 tests (442 passed, 0 failed, 3 Windows/platform-specific skips). The full test run used the existing shared dependency cache; a clean npm ci in this worktree was not performed because workstation memory limits previously exhausted npm. Hosted CI must verify a fresh clean install and the supported Node matrix before merge.
- No schema migration or intended public HTTP contract change. Hub 0.6.0 to 0.6.1 is a SemVer patch for internal modularity and unchanged route behavior; 0.6.1 remains an unreleased candidate pending hosted CI verification.

## Follow-up — 4 November 2026: consolidated 0.6.1 mainline and library/media route extraction

PR #67 merged the authenticated AI task status/history/detail GET route family into `apps/api/src/ai-task-routes.js`, preserving API-pipeline authentication, selected-site resolution and `ai:use` authorization. This closes the previously proposed bounded read-side route seam; AI generation, policy mutation and worker enqueue/orchestration intentionally remain separate.

The current mainline is `489325585d57fe95f961c36a597faa7065848c7f` (Hub 0.6.1). Hosted CI run [#258](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41949722725) passed all six checks: 461/461 Hub tests and 94/94 EnginEx tests on both supported Node versions, 65/65 dedicated live PostgreSQL/Memgraph tests, 9/9 Playwright smoke tests, CodeQL analysis, and consolidated revision-bound evidence. The formal production gate still reports 8 PASS, 2 PARTIAL and 14 MISSING_EVIDENCE. The [0.6.1 release gate report](reports/2026-11-04-VirgoScorpio-Hub-0.6.1-Release-Gate-Report.md) is the detailed evidence snapshot; green CI is not production certification.

The follow-on 0.6.2 local candidate extracts the bounded site-scoped library/media HTTP route family:

- `apps/api/src/library-routes.js` now owns list/upload, metadata patch, optimistic version replacement, version history, private download and optional image/video optimization HTTP behavior. `apps/api/src/platform-routes.js` retains composition and delegates to the focused module.
- The route handler receives a request-scoped context and uses the existing injected site/capability guards, bounded body reader, response/error helpers, PostgreSQL store and audit seam. Authentication and tenant resolution stay in the API pipeline; no new authorization implementation is introduced.
- Preserve security and cross-system invariants: the site guard runs before storage access; private downloads retain `private, no-store`, `nosniff` and sandbox CSP; upload audit records metadata and digest, never payload bytes; expected-version conflict handling remains in the store; optimizer state remains explicit; PostgreSQL and object storage are not hidden behind a fictitious distributed transaction, and reconciliation remains visible.
- Added `test/library-routes.test.js` for decline/no-side-effects, site and capability ordering, cross-site denial, upload/body/audit bounds, private download hardening, version replacement, optimizer skipped-state behavior and platform composition delegation. `scripts/verify.js` now includes the source and test as required artifacts.
- Fresh `npm ci --no-audit --no-fund` completed in the isolated worktree on Windows / Node.js 26.12.1. `npm run check` passed: 205 required artifact paths, 213 JavaScript files syntax-checked, 469 tests (466 passed, 0 failed, 3 Windows/platform-specific skips). The focused API/library/commerce/platform/request-validation group passed 49/49. EnginEx 7.0.0 passed 94 tests (91 passed, 0 failed, 3 platform-specific skips), and `npm audit --audit-level=high` reported zero vulnerabilities.
- No database migration or intended public HTTP contract change. The extraction is tracked as Hub 0.6.2, a SemVer patch increment from 0.6.1, and remains unreleased. The candidate was pushed as PR #68; hosted push run #259 and PR run #260 both passed the two supported Node.js jobs, live service integration, browser smoke, CodeQL and consolidated evidence. The PR remains open and requires human review before merge.

**Continuity note:** counts and findings in the earlier 0.5.2, 0.6.0 and pre-#67 0.6.1 sections above are historical snapshots for the exact commits/environments then described. The current default-branch evidence is the 0.6.1 report linked above. The 0.6.2 candidate is committed and pushed on PR #68; its latest code revision `8db6c66f07c6ea89745fe2a0c8dd7f5f4f6440b3` passed hosted PR run #270 and push run #269. It is still a branch candidate, not mainline or a production release.


## Follow-up — 5 November 2026: 0.6.2 hosted validation and release gate

PR #68 (head 31dd63908fbf8a9fb0340323d92ffd6cdd4d89b9; merge-ref 16d9852126da4aa5c3e15d42460375a2e0ad0cd7) passed both push run #259 and pull-request run #260. Each run completed all six checks: Node.js 22.23.4, Node.js 24.22.1, live PostgreSQL/Memgraph, Playwright browser smoke, CodeQL, and consolidated revision-bound evidence.

- Both supported runtime jobs passed 469/469 Hub tests, 94/94 EnginEx 7.0.0 tests, 205 required-artifact checks and 213 JavaScript syntax checks; clean npm ci and both full/production dependency audits passed with zero vulnerabilities.
- Dedicated live database evidence passed 65/65 tests and 18/18 fresh migrations followed by 18/18 idempotent skips; browser smoke passed 9/9. The service-less matrix integration bundle (29 skips) is correctly labeled PARTIAL and is not conflated with the dedicated live job.
- The earlier Node 22/npm 10.9.9 and Node 24/npm 11.19.1 SBOM snapshots had a component/dependency graph delta despite identical lockfile bytes. The candidate now pins npm 11.19.1 in both supported-runtime jobs and the evidence aggregator compares canonical package identities and dependency edges; hosted PR run #264 passed this new parity check on both supported Node.js runtimes. LGPL notice/distribution review remains a separate human gate.
- The earlier readiness evaluator snapshot remains 8 PASS, 2 PARTIAL and 14 MISSING_EVIDENCE with NOT_PRODUCTION_CERTIFIED. The separate evidence aggregator reports production certification BLOCKED. The local supplemental migration JSON was a tracked 0.5.1 artifact for 14 migrations, not current 0.6.2 evidence; the dedicated current CI producer separately proved 18/18 applied and 18/18 idempotent skips. Follow-up code now requires schemaVersion, product, exact package version and exact Git source revision for formal and supplemental evidence, and the migration harness emits its source revision. This rejects stale evidence instead of interpreting a text marker.
- The previous 5 November report remains an exact-revision assessment of the earlier candidate. The follow-up implementation is documented above and passed hosted PR run #264 on its exact candidate source revision.

## Follow-up — 5 November 2026: evidence/toolchain result on current candidate

Candidate commit `5f900faf3b92307977d3858e1bb0897ab12abe66` passed all six jobs in PR workflow [#264](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42015046006), merge ref `7b20c5685288aa47bcc21b0b3e299546c2a1be36`. Node.js 22.23.4 and 24.22.1 each passed 473/473 Hub tests and 94/94 EnginEx tests, checked 206 required artifacts and 213 JavaScript files, and reported zero audit vulnerabilities. Live PostgreSQL/Memgraph passed 65/65; the v0008-to-v0009 upgrade fixture, all 18 fresh migrations and the 18-entry idempotent second pass passed; the explicit Memgraph outage/replay and graph rebuild checks passed; browser smoke passed 9/9; CodeQL and evidence aggregation passed.

The npm 11.19.1-pinned CycloneDX 1.5 SBOMs both contain 177 components and 178 dependency records from the same lockfile SHA. The normalized component identities and dependency edges are identical across Node 22/24. The npm-major mismatch observed in the earlier run no longer produces inventory drift under the pinned toolchain. This does not replace human license/provenance review; LGPL-3.0-or-later obligations remain open.

Strict readiness is 7 PASS, 2 PARTIAL, 1 BLOCKED and 14 MISSING_EVIDENCE (`NOT_PRODUCTION_CERTIFIED`). The blocked formal PostgreSQL/Memgraph record lacks version/source identity; the run-bound CI integration artifact remains independently PASS. PR #68 has since merged into main. No release or production certification is authorized.

## Follow-up — 5 November 2026: final route error contract and current hosted evidence

The live tenant-library/media isolation suite on PR run #268 exposed two failures because an attempted compatibility patch returned `ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND` while the current Hub library store and public asset routes expose `ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND`. The final branch commit `8db6c66f07c6ea89745fe2a0c8dd7f5f4f6440b3` restores the established current Hub namespace consistently and adds explicit route-level tests for unavailable storage and missing assets. HTTP paths, methods, statuses, and response shapes are unchanged. The follow-up re-ran the complete suite.

Candidate source `8db6c66f07c6ea89745fe2a0c8dd7f5f4f6440b3` passed hosted PR run [#270](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42026945926) and push run [#269](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42026938931), merge ref `e39cd5c33f940762ed9fa88b27aad8f8d3070947`. All six jobs passed in both runs. Each supported Node.js runtime passed 476/476 Hub tests and 94/94 EnginEx tests with zero failures/skips; both checked 206 required paths and 213 JavaScript files, and both audits reported zero vulnerabilities. The live PostgreSQL/Memgraph job passed 65/65 with zero skips, fresh migrations passed 18/18 plus idempotent re-entry, the v0008-to-v0009 upgrade fixture passed, Memgraph outage/replay and canonical graph rebuild passed, browser smoke passed 9/9, CodeQL passed, and consolidated revision-bound evidence passed.

The pinned npm 11.19.1 SBOMs each contain 177 components and 178 dependency records and match exactly at the normalized package/dependency graph level. Raw file hashes differ only due document/platform metadata. Strict production readiness remains NO-GO (7 PASS, 2 PARTIAL, 1 BLOCKED, 14 MISSING_EVIDENCE); the formal database evidence file still requires a current source-bound evidence record, and fourteen independent/provider/security/product/operations requirements remain outstanding. PR #68 has merged into main as `be1441e216c20358e8506389915a676209808e37`. No release tag, GitHub Release, production deployment, or production certification was authorized.


## Follow-up — 5 November 2026: site membership administration route seam

The next P1 authentication/identity seam is implemented on branch `refactor/api-site-membership-routes-2026-11`, now rebased directly onto main after PR #68 merged as `be1441e216c20358e8506389915a676209808e37`. Site member listing/addition/removal and invitation creation are extracted from `apps/api/src/server.js` into `apps/api/src/site-membership-routes.js`. The API server still owns authentication; the supplied `site:manage` guard remains the sole authorization decision. Bounded request parsing, mutation-before-audit ordering, response shapes, and invitation-token minimization are preserved.

The new `test/site-membership-routes.test.js` covers unmatched dispatch, site-capability-before-persistence ordering, member mutation audit metadata, and one-time invitation token handling. The existing `test/integration/tenant-membership-administration-isolation.integration.test.js` remains the live cross-site acceptance test. Local Windows / Node.js 26.12.1 validation completed `npm ci --no-audit --no-fund`, the full `npm test` suite (486 total, 483 passed, 0 failed, 3 platform-specific skips), and `npm audit --audit-level=high` (0 vulnerabilities). The live membership DB integration test was skipped locally because no PostgreSQL service was configured; the new PR must pass the dedicated hosted DB job before merge. The original pre-rebase head passed all six jobs in hosted PR run [#274](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42060056002) and push run [#273](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42059694692): 486/486 tests on Node 22/24, 65/65 live PostgreSQL/Memgraph tests with zero skips (including tenant membership isolation), browser smoke, CodeQL, and evidence consolidation. The branch has since been rebased onto the merged main commit; the new head is `4ec9e31e8ba5ab4cf0ae388d033a5f8635103045` and its exact-revision checks must finish before merge. This is an unreleased development change, not production certification.
