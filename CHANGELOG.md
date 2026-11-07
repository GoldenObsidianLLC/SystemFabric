# Changelog

All notable project-level changes should be recorded here. This changelog does not imply that every listed item has been released or production-certified; CI and release-readiness evidence remain separate.

## 0.6.2 (unreleased patch candidate)

### EnginEx repository linkage

- Replaced the copied EnginEx source directory with a Git submodule linked to GoldenObsidianLLC/EnginEx and pinned the renderer to an exact commit.
- Updated renderer license attribution to GPL-2.0-or-later and enabled recursive submodule checkout in CI.
- Updated release-readiness source-tree verification to validate the pinned EnginEx gitlink and its nested clean worktree separately from the superproject's own status.

### Malware scanner process lifecycle

- Keep the private temporary scan input until the `clamdscan` child emits `close` after a timeout or post-spawn error. This prevents cleanup from racing process teardown on Windows and other platforms. Add deterministic coverage for clean, detection, scanner-fault, unavailable-executable, and timeout/reap outcomes. These tests exercise the scanner boundary with a controlled process stub; live ClamAV corpus validation and the independent malware-scanning acceptance gate remain open.

### Library media variant integrity

- Validate media-variant bytes against their declared MIME signature and parent asset category before writing object storage. Revalidate bytes and parent category when serving public variants, so a matching database hash alone cannot authorize mislabeled or corrupted content. Add regression coverage for mismatched signatures, cross-category variants, valid WebP variants, and corrupted reads. This code-level hardening does not replace live provider, malware-corpus, or independent tenant-isolation acceptance.

### Tenant-isolation inventory tooling

- Add a checked, generated route-family inventory with curated authentication, tenant-context, capability, data-access, side-effect, source-anchor and regression-test references. The generator refreshes source line numbers, records implementation/test file digests, and is enforced by the unit-test suite and required-artifact verification. Its 27 families and 78 declared route patterns are a maintainer-authored navigation aid, not an automatically complete route discovery or an independent security assessment. Issue #14 and broader security issue #25 remain open.

### Membership administration site-context reconciliation - PR #88 candidate

- Candidate hardening routes site-member listing, member addition/removal and invitation creation through the shared siteIdFor selector resolver before capability checks. Header, query and JSON-body site selectors must match the path site; conflicts fail before identity-store access. The resolver generic membership precheck is explicitly disabled for this route family so the existing site:manage capability remains the authorization gate and retains its established forbidden response code. Unit and two-site PostgreSQL integration coverage verifies selector mismatches leave membership, invitation, mail-outbox and audit state unchanged. Independent tenant-isolation assessment remains outstanding; hosted CI is pending.

### Site configuration route selector reconciliation - PR #89 candidate

- Candidate change introduces a reusable request-scoped path-site resolver for direct site configuration routes. Design-system, reusable-component, template, navigation-menu and AI-policy handlers reconcile path/header/query selectors before capability checks and reconcile bounded write-body selectors before validation or persistence. The generic membership precheck is disabled in this helper so each route retains its established capability/error contract. The PostgreSQL tenant-isolation suite checks selector conflicts across reads, writes and deletes and compares configuration-table snapshots to rule out unintended side effects. This candidate is not merged; hosted validation is pending.

### Current mainline disposition - 7 November 2026

- PRs #84-#88 are merged. PR #88 reconciles path, header, query and JSON-body site selectors for membership listing, membership mutation and invitation creation via the shared siteIdFor resolver. Its PR workflow [run 42336173083](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42336173083) passed all six jobs; merge commit is c5c31556acb052b9a257931867ef0166e866e822 and post-merge mainline workflow [run 42336343536](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42336343536) passed all six jobs. PRs #84-#87 are merged. PR #87 added a checked, cross-platform tenant-isolation route/data-access inventory covering 27 curated route/processing families and 78 declared route patterns, with source anchors, test references and explicit review limitations. PR #87 head 752a6a2dd02a4ed45a4cc3227e5dee1f41946387 passed all six PR jobs (workflow run [42333235986](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42333235986)); merge commit is 496db8a4a1416502b48a58120986eb665b197846, and its post-merge mainline push run [42333446105](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42333446105) passed all six hosted jobs. The inventory is maintainer preparation only and does not close independent issue #14 or #25. The formal PostgreSQL/Memgraph evidence remains bound to its prior exact-source baseline. No dependencies, database schema or public API change; no SemVer increment, release tag, publication or deployment.

- PR #83 merged as `109c05b001003e68dfaa5584353ab683a41d9075`; mainline push workflow [run #353](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42321203517) passed all six hosted jobs. The shared recursive Git-submodule preflight verifies pinned commits before bootstrap creates local files or installs dependencies; dev:doctor reports the same state. Missing, conflicted, mismatched, or unverifiable submodules fail closed with recovery guidance, without automatic update/reset/clean. Recursive-clone guidance is aligned across contributor docs. Seven focused tests passed; `npm run check` passed 530 tests (527 pass, 3 platform-conditional skips) in PR validation. No dependency, schema, or public API change; no SemVer increment or release authorization.

- PR #82 merged as `89c87f9483f915d72a44695dd2a5054c08cdd9ed` after PR CI run #349 passed all six hosted jobs. Stripe Checkout expiration bounds now use one captured clock value; exact lower/upper boundary behavior is deterministic. No dependency, schema, or public API change; no version increment or release authorization.

### Current mainline disposition - 6 November 2026
- PRs #76–#80 are merged. The verified product-code mainline after PR #80 is 29a3e03997da429a1bb05964f46c22cf975a8c2e; mainline push workflow [run #341](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42311936630) passed all six hosted jobs. Formal exact-source PostgreSQL/Memgraph evidence is PASS: 67/67 live tests with zero skips/failures/TODOs, 18/18 fresh migrations and 18/18 idempotent second-pass skips, plus outage/replay and graph rebuild. The service-less Node matrix integrations remain PARTIAL (29 skips per runtime); human lockfile review and 14 independent/provider/product/security/supply-chain/operations gates remain open. Hub 0.6.2 remains unreleased and NOT_PRODUCTION_CERTIFIED; no tag, GitHub Release, package publication or production deployment is authorized.
- Harden the formal CI evidence writer with exclusive same-directory staging, descriptor-based writes, fsync, atomic replacement, and regression coverage for pre-existing files and symlinks. The structured JSON attestation is emitted only after the run/job identity, source SHA, manifest checksums, schema, and zero-skip results pass; raw GitHub Actions REST response values are validated but never serialized. This is CI evidence plumbing only and does not warrant a product version increment.
- Pre-merge candidate notes below preserve their original run/branch context; statements that PRs #76–#80 were open or hosted validation was pending are historical and superseded by this current disposition.

### Local development environment

- Require recursive EnginEx submodule checkout for first-time setup. Development bootstrap and `dev:doctor` perform the same read-only pinned-submodule check and provide recovery guidance without resetting or updating developer worktrees.
### Outbox producer audit - 6 November 2026
- Production outbox writers were audited at mainline d2f1564cbb570e8d4e55d33b64ca5f3993c9a01a: content writer, relationship store/API routes and taxonomy API writer all satisfy the registered site-private envelope contract. Remaining direct inserts are synthetic/internal test fixtures. No remaining production producer gap or migration requirement was found. See docs/reports/2026-11-06-OUTBOX-PRODUCER-AUDIT.md.

- PR #76 merged taxonomy GET/POST/PUT/DELETE site-context reconciliation and a reusable site-private taxonomy outbox writer. Live CRUD verifies no mutation on conflicting selectors and site_id/actor_id/correlation_id/classification for upsert and delete events. No migration or version bump.
- Harden the relationships route with shared path/header/query/body selector reconciliation, bidirectional cross-site endpoint denial, and a same-site positive control. Both relationship.upsert and relationship.delete now emit site-private outbox envelopes with site_id, actor_id and correlation_id, matching the canonical relationship-store pattern. Integration tests assert both event envelopes and clean only their fixture aggregate. Internal pre-review only; independent issue #14 remains open.
- Strengthen dev:doctor so DATABASE_URL and TEST_DATABASE_URL are authenticated with a bounded read-only SELECT 1; require a test-suffixed database name for the latter and redact connection errors. Add deterministic success, authentication, timeout, and safety-boundary tests. No schema, API contract, or dependency change.
- Give the Compose project a stable `virgoscorpio-hub` identity and assign explicit physical names to PostgreSQL, Memgraph, MinIO, and ClamAV data volumes so local state does not depend on the checkout directory. Document local startup and volume-retention behavior; this is development infrastructure, not production deployment configuration.
- PR [#72](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/72) merged as 70ce31a23aa670afca1d89fb5c776e1ca36abd84. Backup-first local Docker restore acceptance is recorded in docs/reports/2026-11-05-LOCAL-DOCKER-RESOURCE-MIGRATION.md; original legacy containers/volumes remain preserved. Local checks are developer-environment evidence only and do not satisfy production backup/restore certification or change the NO-GO release status.

### API architecture and maintainability
- Extract site membership administration and invitation creation into `apps/api/src/site-membership-routes.js`. Preserve the existing `site:manage` authorization guard, bounded request bodies, audit ordering, invitation-token response, and metadata-only audit behavior; keep authentication and tenant authorization in the API composition pipeline. Add focused route-family tests while retaining the live tenant-isolation integration suite.
- Extract the site-scoped library and media HTTP routes into `apps/api/src/library-routes.js`; retain request authentication, site resolution, capability enforcement, request lifecycle and centralized errors in the API composition pipeline.
- Preserve library upload limits, metadata and optimistic-version operations, audit events, private-download headers, optional optimization status handling, and tenant-scoped store operations. Keep PostgreSQL/object-storage compensation and reconciliation explicit; no distributed transaction or database migration is introduced.
- Add focused tests for unmatched dispatch, site/capability ordering, cross-site rejection before store access, upload audit minimization, private-download hardening, version replacement and unsupported optimization behavior.
- Extract the Git/admin custom content-type registry and record route family into `apps/api/src/content-type-routes.js`. Keep API authentication, site selection and capability enforcement in the composition layer; preserve Git-managed definition precedence, schema validation, site-scoped record storage and existing route/response contracts.
- Reuse `packages/db/src/transaction.js` for advisory-lock-protected admin definition version increments and atomic active-version replacement. Cache parsed Git-managed definitions for the API process lifetime; bound JSON object input and validate record values before persistence. Add focused registry/record tests plus an HTTP composition test. Use the API composition layer's shared content-read scope resolver for both the custom content-type family and legacy page/revision reads; enforce `content:read:own` at the store query/detail boundary using the actor ID: list queries receive the owner filter and detail reads use `getByIdForOwner`, so own-only readers cannot enumerate or retrieve another user's records. No database migration or public HTTP contract change is intended.
- Update required-artifact verification and architecture/route ownership documentation. Preserve route paths, methods, HTTP statuses and response shapes; keep disabled/not-found errors in the established `ERR_VIRGOSCORPIO_HUB_*` namespace shared by the current library store and public-asset routes, with regression coverage for both outcomes.
- Bump VirgoScorpio Hub from 0.6.1 to 0.6.2 as a SemVer patch for a compatible internal route-family extraction. This is an unreleased candidate; no tag or package publication is implied.

### Validation and release evidence hardening
- Fresh `npm ci --no-audit --no-fund` completed in the isolated candidate worktree on Windows / Node.js 26.12.1.
- The full `npm test` suite passes on Windows / Node.js 26.12.1 after both route-family extractions: 486 tests (483 passed, 0 failed, 3 Windows/platform-specific skips). The focused API/auth/session/site-capability suites pass; the live tenant-membership database suite is skipped locally when its service environment is absent and remains required in hosted PostgreSQL CI. `npm audit --audit-level=high` reports zero vulnerabilities. The route-level disabled/not-found errors use the established VirgoScorpio Hub error-code namespace shared by the library store and public asset routes; the live tenant-library CI suite verifies the contract.
- Follow-on custom content-type route-family validation on Windows / Node.js 26.12.1: `npm run check` passed, with 210 required paths and 217 JavaScript files syntax-checked; the serial root suite passed 507 tests (504 passed, 0 failed, 3 Windows/platform-specific skips). The focused API composition and route-module suites passed 44/44; `git diff --check` and `docker compose config --quiet` passed. The verifier excludes ignored `.worktrees` checkouts so scratch copies do not expand the current source syntax inventory. The first hosted push/PR runs exposed one integration regression: the extraction had removed `hasContentRead`, which remains used by legacy page-revision routes in `server.js`. The shared helper is restored, and a new bearer-authenticated page-revision regression test proves a missing record returns the established 404 rather than a 500.
- The corrected PR #71 head `7c8549382faa7e39445e8f443f1006d63a1488bc` passed all six hosted CI jobs on both push run [#42107807577](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42107807577) and PR run [#42102228955](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42102228955). Both Node 22/24 jobs passed 507/507 tests, 210 required paths / 217 JavaScript syntax checks and zero-vulnerability audits; the live database producer passed 65/65 with zero skips, 18/18 fresh migrations and idempotent re-entry, Memgraph outage/replay and graph rebuild; browser smoke 9/9; CodeQL and consolidated evidence passed. The formal release gate remains NO-GO. PR #71 remains open for human review.
- Pin npm CLI `11.19.1` in `package.json` and `RELEASE-MANIFEST.json`; the Node 22/24 CI matrix installs and verifies the same CLI before `npm ci`, audits and SBOM generation. The CI evidence aggregator verifies the SBOM tool identity and compares normalized package identities/dependency edges across runtimes, blocking real inventory drift.
- Bind formal and supplemental release evidence to schema version, product, exact candidate version and full Git source revision. The fresh-migration harness records that revision; old or unversioned retained evidence is rejected rather than treated as current. Dedicated CI migration artifacts remain independently run- and checksum-bound.
- Focused API/library/commerce/platform/request-validation regression suites passed 49/49 with zero skips.
- Hosted push run #269 and PR run #270 passed all six jobs on the final pre-merge route/error-contract and evidence/toolchain candidate: Node.js 22.23.4 and 24.22.1 each passed 476/476 Hub tests and 94/94 EnginEx tests; dedicated PostgreSQL/Memgraph passed 65/65 with zero skips; migrations applied 18/18 and skipped 18/18 on rerun; the v0008-to-v0009 upgrade fixture and Memgraph outage/replay/rebuild passed; browser smoke passed 9/9; CodeQL and consolidated evidence passed. Both SBOMs identify npm 11.19.1 and match at 177 components / 178 dependency records with identical normalized dependency graphs. Audits reported zero vulnerabilities. Strict formal readiness remains NO-GO: 7 PASS, 2 PARTIAL, 1 BLOCKED and 14 MISSING_EVIDENCE.
- PR #69 merges the site-membership administration/invitation route-family extraction into main at `d50e56801ea77a811ec809be1574e769917fff78`; it preserves the centralized `site:manage` authorization guard, bounded request bodies, audit ordering and invitation-token minimization, with no schema migration or intended HTTP contract change.
- Harden the CI evidence aggregator for rerun metadata consistency: accept a stale prior-attempt workflow failure only while the aggregate job for the current attempt is active and every required producer job is uniquely identified, completed successfully, and bound to the current run attempt and exact source revision. Add regression coverage for accepted stale-prior-attempt state and rejection of failed producers, wrong attempts and completed failed aggregation. This is CI-control hardening only; it does not weaken evidence validation or production readiness. Hosted validation is pending.
- Restrict the local `scripts/verify.js` JavaScript syntax walk to the repository tree by excluding ignored nested `.worktrees` alongside `node_modules`, `.git` and vendored sources. Stale/concurrent local worktree copies are not part of the current repository's source inventory and must not inflate verification scope or trigger redundant parsing.


## 0.6.1 (unreleased patch candidate)

### API architecture and maintainability
- Extract the authenticated AI task status, history collection, and task-detail GET routes into `apps/api/src/ai-task-routes.js`; keep request authentication, site selection, and `ai:use` enforcement in the API composition pipeline.
- Move actor/site/filter-bound pagination cursor validation and serialization behind the AI task route module. Preserve existing route paths, response shapes, status codes, query limits, and actor/site-scoped task-store calls.
- Add focused route-module regression coverage for cursor reuse across actors/sites/filters, malformed queries, unavailable persistence, missing tasks, invalid cursor sources, and unmatched dispatch. AI provider generation, policy mutation, and async queue execution remain separate concerns.

- Extract product, order, refund, checkout, and membership route handling from `apps/api/src/platform-routes.js` into `apps/api/src/commerce-routes.js`, using a narrow request-scoped dependency context. The API composition layer retains authentication, site resolution, and capability dispatch; SQL predicates and existing transaction, inventory, idempotency, and Stripe behavior are preserved.
- Add `apps/api/src/request-validation.js` for bounded JSON-object validation with UTF-8 byte ceilings and fail-closed serialization handling; reuse the canonical UUID validator from `packages/domain/src/identifiers.js`.
- Add route regression tests for unmatched-route behavior, site/capability ordering, site-filtered reads, invalid product writes with no database side effect, rejected cross-site access, and preservation of the previous platform-module productInput export; add request validation tests for UTF-8 bounds and serialization failures.
- Local validation on Node.js 26.12.1: artifact check passes (202 required paths, 211 JavaScript files syntax-checked); full unit suite passes (461 tests, 458 passed, 0 failed, 3 Windows/platform-specific skips); focused AI route/API/context suites pass 45/45; `npm audit --package-lock-only --audit-level=high` reports 0 vulnerabilities. The full suite used the existing shared dependency cache with the candidate's vendored EnginEx 7.0.0; a clean npm ci and hosted CI remain merge gates.
- Update the architecture map, contributor guide, roadmap, required-artifact verification, and release manifest. No database migration or public HTTP contract change is intended.
- Bump VirgoScorpio Hub from 0.6.0 to 0.6.1 as a SemVer patch for compatible internal route-family refactors. This combined 0.6.1 candidate includes the merged commerce extraction and this AI task read-route extraction; it remains unreleased, with no tag or package publication implied.

## 0.6.0 (merged to main, unreleased security and compatibility candidate)

### Security and renderer compatibility

- Upgrade the vendored EnginEx renderer from 6.2.0 to 7.0.0 and remove `vendor/enginex/engine-legacy.js`, the legacy `<?njs ?>` arbitrary-JavaScript execution adapter.
- Make `allowUnsafeCode: true` and `engine.unsafe()` fail closed with `ERR_ENGINEX_UNSAFE_API`; legacy template blocks fail with `ERR_ENGINEX_UNSAFE_CODE_DISABLED`. The safe expression interpreter and generated renderer remain available.
- Add `docs/ENGINEX-7-MIGRATION.md`, a tested EnginEx 6.x to 7.0 migration guide: replace historical JavaScript blocks with restricted expressions and narrowly allow-listed helpers. No automatic converter is provided.
- Update release manifests, package metadata, security model, architecture records, third-party notices, artifact checks and versioned test fixtures.
- Serialize the root unit suite with `--test-concurrency=1`, matching the vendored EnginEx test runner, after the default parallel Node.js test runner exhausted memory on the Windows development workstation. This keeps test resource use bounded and the complete suite repeatable.
- Bump VirgoScorpio Hub from 0.5.4 to 0.6.0 as a SemVer minor pre-1.0 compatibility change; bump vendored EnginEx from 6.2.0 to 7.0.0 as a SemVer major. This is an unreleased candidate; no tag or publication is implied.
- Local validation: root `npm run check` passes on Node.js 26.12.1 (195 required paths, 205 JavaScript files syntax-checked, 437 tests: 434 passed, 0 failed, 3 Windows/platform-specific skips); vendor EnginEx 7.0.0 check passes (94 tests: 91 passed, 0 failed, 3 skips; 31 package files verified); `npm audit --audit-level=high` reports 0 vulnerabilities. A repeat `npm ci` attempt on the workstation hit a Node.js out-of-memory failure under local memory pressure; clean-install verification remains an explicit hosted CI gate.
- Preserve `NOT_PRODUCTION_CERTIFIED`; independent security and deployment validation remain required.

## 0.5.4 (merged to main, unreleased patch)

### Authentication architecture and maintainability

- Extract the browser session persistence/lifecycle contract from the identity service into `packages/auth/src/session-service.js`, with explicit pool, clock/TTL, digest, safe-user, and authorization-invalidation dependencies. The identity service composes the extracted `createSession` function privately and retains the same public methods and token behavior.
- Add focused session-service tests for 256-bit session/CSRF token generation, digest-only database persistence, site membership aggregation, expiry/idle checks, CSRF validation, session listing, and scoped logout/revocation invalidation.
- Update the architecture map, required-artifact verification, changelog, and release manifest. Full local validation passes: 194 required paths, 205 JavaScript files syntax-checked, 437 tests (434 passed, 0 failed, 3 platform-specific skips), focused session/auth tests 35/35, and zero npm audit vulnerabilities. Hosted integration CI is the remaining candidate gate. No public API or database migration change is intended.
- Bump the package and lockfile from 0.5.3 to 0.5.4 as a SemVer patch; this is an unreleased candidate, not a published release.

## 0.5.3 (merged to main, unreleased patch)

### Security and API architecture

- Extract browser authentication route families from the API composition module into `apps/api/src/auth-routes.js`, separating unauthenticated login/recovery/SSO routes from authenticated account/session/MFA routes while retaining session authentication, site policy, Origin checks, and CSRF enforcement in the API request pipeline.
- Centralize authentication cookie parsing, serialization, and CSRF double-submit comparison in `apps/api/src/auth-cookies.js`; validate cookie names, opaque token values, flags, expiry, SameSite, and path attributes before emitting Set-Cookie headers.
- Add regression coverage for cookie attribute safety and preserve the existing login, MFA, session, and CSRF HTTP behavior.
- Record the post-merge CodeQL result on `dc4a82d`: High auth-cookie findings #30–#33 changed to `fixed` in the default-branch analysis without dismissal; the Medium unsafe legacy-template finding #14 remains open and requires an explicit compatibility/security-owner decision.
- Bump the package and lockfile from 0.5.2 to 0.5.3 as a SemVer patch. No public HTTP contract or database migration change is intended; this remains an unreleased developer-preview candidate.

## 0.5.2 (merged to main, unreleased patch)

### Architecture and maintainability

- Reuse the shared PostgreSQL transaction lifecycle module across all five community workflow transactions and Stripe checkout reconciliation; keep response writes outside transactions and update reconciliation counters only after commit succeeds.
- Add commit/rollback/client-release regression coverage for community conversation creation and checkout reconciliation commit failure; the focused community, checkout-reconciliation, and transaction suites pass 22/22.
- Add a canonical product-version module derived from `package.json`, then reuse it in verification, CI/SBOM evidence, fresh-migration evidence, and OpenTelemetry service-version defaults to prevent hard-coded version drift.
- Add the 4 November 2026 repository-wide codebase optimization review, covering the 198-file baseline inventory, current module-size pressure points, reusable-pattern boundaries, and staged architecture priorities.
- Bump the package and lockfile version from 0.5.1 to 0.5.2 as a SemVer patch. No public HTTP contract or database migration change is intended; this is an unreleased candidate, not a published release.

## Unreleased

### Documentation and assurance

- Archive the 1 November 2026 VirgoScorpio Hub 0.5.1 project status report and repository coherence/continuity review; add current-status navigation and mark earlier release/local-validation snapshots as historical. This documentation update does not merge the security candidate or change the NOT_PRODUCTION_CERTIFIED release state.

### CI and request security

- Serialize live integration test files that share the dedicated PostgreSQL database and graph fixture, preventing cross-suite outbox/event cleanup races from making the Memgraph consumer-group test flaky.
- Separate explicitly authenticated bearer sessions from cookie sessions; cookie-authenticated writes always undergo same-origin and CSRF validation even when an invalid bearer header is also supplied.
- Pin CI runners to Ubuntu 24.04 and use full-commit SHA pins for current Node.js 24-compatible checkout, setup-node, and artifact-upload actions.
- Seed the PostgreSQL migration-upgrade fixture with the shared line-ending-normalized checksum helper so Windows CRLF checkouts match the migration runner's checksum contract.
- Expand tenant-isolation integration coverage for repeated and malformed site selectors, accepted matching route/header/query selectors, cross-site denial, response non-disclosure, and rejected-write side effects.

### Documentation and maintainability

- Restructure the project overview around capabilities, architecture, setup, testing, security, contribution, and release-readiness navigation.
- Add task-oriented documentation for architecture, development setup, testing, security boundaries, roadmap, and release evidence.
- Document README design standards and the influence of public README examples without copying their template text.
- Add structured issue and pull-request templates to encourage reproducible reports and clear validation notes.
- Add a linked first-contribution quickstart with verified setup commands, service prerequisites, safe troubleshooting, and issue-reporting guidance.

### Real-time and durable event foundation

- Add the bounded process-local event hub, lease-based presence service and authenticated SSE presence preview.
- Define a validated v1 durable event envelope for PostgreSQL outbox events, add migrations 0010 and 0011, and carry site, actor, correlation, causation and classification metadata with stable event identity.
- Add migration 0012 and a transport-neutral PostgreSQL delivery worker with independent consumer-group state, leased concurrent claims, per-aggregate ordering, exponential retry, dead-letter handling and bounded explicit-ID replay.
- Add migration 0013; persist allow-listed event-type subscriptions so a consumer group receives only its intended event families.
- Migrate the Memgraph projection worker to graph.projection.v1; project content workflow state by monotonic lock_version aggregate sequence while retaining editorial revision version separately.
- Add unit/integration coverage for graph handler wiring, workflow status projection, event filters, group isolation, ordering, replay, lease recovery and actual Memgraph outage replay.
- Add Redis/Memurai-compatible shared presence leases with atomic Lua updates, per-site sorted-set indexes, hashed session keys, multi-session aggregation, hidden-state handling, capacity limits and lazy expiry callbacks.
- Add API bootstrap settings for memory or Redis presence, bounded reconnect behavior and fail-closed store errors; add live coverage proving two independent Redis clients share presence snapshots.
- Add cross-instance Redis Pub/Sub presence-refresh invalidation fan-out to authenticated SSE clients, including site validation, bounded inbound dispatch, authorization rechecks and lazy lease-expiry propagation. PostgreSQL remains the durable event source.
- Add targeted authorization invalidation for membership changes, session logout/revocation, password reset and MFA disable; propagate UUID-only invalidation envelopes across Redis-backed API instances.
- Bind SSE subscriptions to their authenticated session and absolute expiry; revalidate session revocation, idle expiry, account status and site capability on each heartbeat, closing streams when access is no longer valid.

### Real-time observability (F1.6)

- Add a fixed-name realtime metric registry with counters, gauges and histograms for active subscriptions/SSE connections, authorization denials and revocations, event fan-out and lag, queue overflow, backpressure, presence leases and Redis Pub/Sub publications, receives, failures and reconnects.
- Instrument event hub, SSE gateway, memory/Redis presence adapters, Redis Pub/Sub bridge and realtime API authorization checks; telemetry failures are isolated from request and delivery paths.
- Extend the existing bearer-token-protected Prometheus /metrics endpoint with realtime series. Keep metrics disabled by default, avoid high-cardinality identity/site labels, and document process-local aggregation and lazy Redis lease-expiry semantics.
- Add focused tests for registry validation/rendering, hub lifecycle/fan-out, presence lease accounting and protected API scraping.

### Collaborative editing architecture spike (F1.7)

- Compare CRDT and operational transformation against the current page-document v1 tree, editor mutation model, PostgreSQL revision history and one-way SSE transport.
- Record a provisional server-authoritative semantic-OT recommendation for the first online CMS collaboration release, with stable node/sibling anchors, operation sequencing, conflict semantics, PostgreSQL durability and explicit CRDT revisit conditions.
- Document the follow-on two-client browser prototype and security/performance acceptance gates. No collaboration runtime, CRDT dependency, operation table, migration or editor collaboration behavior is claimed.

### Distributed real-time controls and recovery (F1.8)

- Add a same-origin, authenticated WebSocket presence preview with a strict command allow-list, per-command authorization rechecks, ping/pong liveness, bounded payload/rate/buffer controls and the existing SSE fallback.
- Add a shared global/site/principal connection quota interface with memory preview and Redis Lua lease adapters; leases renew during SSE/WebSocket sessions and expire after process crashes. Redis multi-key leases share one Cluster hash slot and quota-store outages fail closed.
- Share quotas across SSE and WebSocket, require injected distributed quota adapters for Redis-backed/production mode, and release leases on disconnect and graceful shutdown.
- Add a versioned connection-ready contract with bounded full-jitter reconnect guidance and snapshot-refresh recovery. Ephemeral presence Pub/Sub does not provide replay or durable client event history.
- Make presence relay publication local-first so a Redis publish outage does not suppress same-instance refresh delivery; record degraded relay state, failures and fan-out/transport/quota metrics.
- Add failure-injection and API tests for origin/auth rejection, authorization rechecks, command/frame limits, shared quota behavior, disconnect cleanup, relay interruption and local authorization revocation.
- Production remains NO-GO pending multi-instance/Redis Cluster load and failover tests, browser/proxy reconnect soak, independent security review and operations runbooks.

### Collaborative CMS correctness proof (F1.9)

- Add a bounded server-authoritative semantic-OT engine for typed page-document title, node, property and plain-text operations, including stable-ID tree edits, deterministic stale-operation transforms, Unicode code-point text ranges and full materialized-document validation.
- Add migration 0014 and transactional PostgreSQL collaboration sequencing with accepted-operation history, 1,000-operation replay window, canonical reload responses and idempotency tombstones that survive replay pruning.
- Commit accepted collaborative edits atomically with the draft body, editorial revision, workflow evidence and content outbox event; preserve separation between collaboration sequence, editorial version and aggregate lock_version, and never mutate published snapshots.
- Add site-scoped draft-only REST submit/sync endpoints and authenticated WebSocket document join/operation/leave commands with session-derived identity, edit/owner authorization, periodic revocation checks, replay, acknowledgements and local per-document notifications.
- Keep document notification fan-out process-local; PostgreSQL remains the durable operation and reconnect source. Redis Pub/Sub is not used for document operations and no cross-instance live document delivery is claimed.
- Prove concurrent edits, convergence, lost-ack idempotent retry, reconnect replay and expired-history reload using two separate cookie-authenticated browser contexts and real Chromium WebSocket connections.
- Production remains NO-GO pending multi-instance fan-out/recovery, the 2/5/10-editor load matrix, reconnect soak, independent security/accessibility review, backup/retention runbooks and operational ownership.

### Cross-instance collaborative document delivery (F1.10)

- Extend the shared Redis realtime bridge with a strictly validated document-operation channel scoped by site and content UUID. Operation notifications are bounded to 16 KiB, use a separate bounded ingress queue and carry the PostgreSQL-accepted sequence plus a server-generated WebSocket origin selector.
- Share one document-publisher adapter across REST and WebSocket operations; publish to same-instance subscribers before attempting ephemeral Redis fan-out, and acknowledge a committed operation as degraded rather than failing the durable write when Redis publication is interrupted.
- Reconcile each active document subscription from PostgreSQL on sequence gaps and on the bounded WebSocket heartbeat. Use one in-flight sync per document subscription, filter duplicate/stale sequence hints, recover dropped/reordered notifications and avoid re-echoing operations already acknowledged to the originating socket.
- Add live loopback-Redis integration coverage for two independent bridge/hub pairs, same-document fan-out, site/document isolation, self-echo suppression and local-first degraded publication.
- Add two-API-instance Playwright coverage for A↔B browser WebSocket delivery, scope isolation, dropped-hint heartbeat recovery, reordered/duplicate hints, node loss/reconnect and the 2/5/10-editor convergence matrix. Record local-harness peer-delivery samples (153 samples: p50 1,347 ms, p95 2,575 ms, p99 2,620 ms); this is correctness evidence, not a production capacity benchmark.
- A focused gateway regression test covers a gap-replay that includes the origin socket's already-acknowledged operation; a bounded 1,000-entry per-subscription opId set suppresses the duplicate while preserving the missing remote sequence.
- Production remains NO-GO pending Redis Cluster/partition/failover validation, sustained load beyond the 2/5/10 matrix, orchestrated rolling-deploy/node-loss rehearsal, browser/proxy soak, independent security/accessibility review and operational runbooks/ownership.

### Collaboration resilience qualification (F1.11)

- Add an opt-in, loopback-only real-Redis failure/recovery test proving that a one-shot document PUBLISH failure preserves local delivery and that a subsequent publish restores bridge readiness.
- Add a bounded sustained fan-out integration test. Local Memurai/Redis validation delivered 2,000 operations to ten subscribers (20,000/20,000 deliveries) at approximately 69 publications/second, with p50/p95/p99 subscriber delivery latency of 0.98/1.45/1.93 ms and zero document-ingress or slow-consumer queue overflows. These are local harness observations, not production capacity or SLO claims.
- Add a ten-session WebSocket reconnect-storm check after one local API instance is stopped. Each session replays 24 stored operations in order (240 deliveries), and a subsequent sequence-25 operation reaches all peers; measured reconnect/replay interval was 529 ms using an in-memory test store.
- Re-run the full multi-case `test/e2e/collaboration-multinode.spec.js` browser file locally with one worker: 4/4 passed. The 2/5/10 editor matrix recorded 153 samples (p50/p95/p99: 1,270/2,508/2,545 ms); heartbeat repair completed in 3,625 ms; ten-editor reconnect replay delivered 240 operations in 396 ms and accepted sequence 25. This resolved the earlier local page-crash observation for this file; clean hosted CI remains required.
- Focused collaboration/realtime unit tests passed 61/61; full `npm run check` passed 206/206, with 141 required paths and 139 JavaScript files syntax-checked. The F1.9 two-session browser collaboration regression passed 1/1.
- Production remains NO-GO pending Redis Cluster/network-partition and orchestrator failover rehearsals, sustained production-shaped load and soak, complete browser-suite validation on clean CI, independent security/accessibility review, and owned operational runbooks.

### Release engineering and local validation

- Synchronize the Redis 6.3.1 dependency graph in package-lock.json; validate a fresh isolated npm ci and retain install evidence.
- Add npm run test:migrations:fresh to apply all 14 migrations to a disposable database derived only from TEST_DATABASE_URL, verify a second pass is idempotent, and drop only the generated test database.
- Add dedicated Redis services to PostgreSQL/Memgraph and browser/accessibility CI; pass the explicit loopback URL to the multi-instance browser suite and retain zero-skip integration evidence.
- Inject independent Redis-backed connection-quota adapters into multi-instance presence/SSE integration fixtures, using a shared per-test namespace so the test topology matches the runtime's distributed-quota requirement; local loopback Redis presence/API/authorization integration passed 4/4 with zero skips.
- Forward the live integration runner's validated local Redis URL into `VIRGOSCORPIO_HUB_TEST_REDIS_URL` as well as the presence adapter configuration, so F1.10/F1.11 document Pub/Sub recovery and sustained-fan-out tests run instead of being silently skipped.
- Run the combined F1.10/F1.11 document Pub/Sub and presence/API/authz live-Redis integration bundle: **8/8 passed, zero skips**. The sustained relay case delivered 20,000/20,000 notifications to ten subscribers at 77 publications/second, p50/p95/p99 0.78/1.11/1.51 ms, with zero queue overflows. Local loopback-harness results only.
- Make the WebSocket close-cleanup regression test wait for the server-side connection gauge to reach zero rather than assuming client and server close-event ordering is synchronous.
- Pin the CI Memgraph loopback port for the outage/restart test so the service remains reachable after Docker restarts its fixed-port container.
- Refresh release-readiness evidence and regenerate the CycloneDX SBOM after dependency and test-harness changes.
- Normalize SQL migration line endings before hashing/execution so Windows CRLF checkouts do not trigger false migration-drift failures; add LF/CRLF/CR regression tests.

### Security hygiene

- Replace fabricated Stripe-shaped test fixtures with clearly non-live test placeholders.
- Replace the collaboration browser fixture's computed property assignment with an explicit allow-list of supported page-document properties after CodeQL identified a high-severity remote property-injection path.
- Clean the affected local Git history and require a clean current-tree and history scan before public publication.

## 0.5.1

See the release tag and commit history for source changes associated with this baseline. Reconstruct a detailed release entry only from verified changes; do not infer release scope from test names or documentation alone.
