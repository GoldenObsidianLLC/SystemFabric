# VirgoScorpio Hub Roadmap

This roadmap is evidence-oriented rather than a promise of dates. Items should move to complete only when linked evidence exists for the target commit and environment. The roadmap now covers two complementary tracks: completing the current secure, reliable platform foundation and developing toward a real-time collaborative AI-native platform.

Priorities: **P0** = critical reliability/security/release work; **P1** = foundational next capabilities; **P2** = major product capabilities; **P3** = strategic advanced capabilities. These labels indicate sequencing, not delivery dates or guarantees.

## Human-AI agency — cross-cutting product and engineering gate

The [VirgoScorpio Hub Manifesto](../VIRGOSCORPIO-HUB-MANIFESTO.md) is the project's north star for human-AI collaboration. It frames the goal as amplifying human capability, preserving creative dignity and productive relevance, and resisting designs that treat human obsolescence or concentrated control as inevitable. This roadmap translates those values into engineering work; it does not claim that software alone can guarantee employment, income or broader economic outcomes.

Apply these checks to every AI-enabled product track:

- [ ] Identify the human goal, user benefit and decision owner before automating a workflow.
- [ ] Make AI participation and generated or materially transformed content identifiable to the user.
- [ ] Provide user controls to enable, limit or disable AI assistance where feasible, with clear data-use and context boundaries.
- [ ] Define action risk tiers. Permit only explicitly authorized, bounded and reversible automation without additional approval; require appropriate human review for consequential, privileged, externally visible or hard-to-reverse actions.
- [ ] Preserve inspection, correction, rejection, undo, appeal or escalation paths appropriate to the action.
- [ ] Attribute human and AI contributions where useful and consented, without presenting attribution as a legal determination of authorship or ownership.
- [ ] Design for accessibility, skill development and meaningful participation; do not use presence or activity telemetry for covert productivity scoring.
- [ ] Test for over-automation, biased outcomes, deskilling risks, deceptive AI presentation, prompt injection and authority escalation.

**Exit condition:** each AI-enabled feature has documented user control, data-use boundaries, delegated permissions, action-risk classification, recourse and validation criteria. High-impact actions cannot bypass required approval or audit controls.

## Track A — Stabilize the pre-1.0 platform baseline (P0)

### Reliability and release process

- [x] Remove the legacy EnginEx arbitrary-JavaScript renderer and fail closed on the retired compatibility flags. Review [EnginEx 7.0 Migration](ENGINEX-7-MIGRATION.md); this breaking renderer upgrade merged as Hub 0.6.0 / EnginEx 7.0.0. It does not constitute release approval.
- [x] Extract commerce and membership HTTP route handling into `apps/api/src/commerce-routes.js`, preserve the API server's authentication/site/capability dispatch, and reuse bounded JSON-object and canonical UUID helpers. This internal route-seam refactor merged in the unreleased 0.6.1 mainline.
- [x] Extract site membership administration and invitation creation into `apps/api/src/site-membership-routes.js`; preserve `site:manage` policy order, bounded body parsing, audit-before-response sequencing, and invitation secret minimization. The route-family unit suite and the existing tenant-membership integration suite remain the acceptance boundary.
- [x] Extract site-scoped library/media HTTP handling into `apps/api/src/library-routes.js` as the unreleased 0.6.2 candidate. Preserve authentication, site resolution, capability checks, upload bounds, metadata/version semantics, audit events, private-download headers, optimization status and explicit object-storage reconciliation. The route extraction and evidence/toolchain follow-up pass both hosted PR run [#270](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42026945926) and push run [#269](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42026938931): both Node runtimes passed 476 Hub tests and 94 EnginEx tests, live PostgreSQL/Memgraph passed 65/65, migrations and supported v0008-to-v0009 upgrade passed, browser smoke passed 9/9, CodeQL and consolidated evidence passed. npm 11.19.1 SBOMs match at the normalized component/dependency graph level. The PR remains open pending human review/merge; formal production readiness remains NO-GO. See [the 0.6.2 release-gate report](reports/2026-11-05-VirgoScorpio-Hub-0.6.2-Release-Gate-Report.md).
- [x] Make CI green across the supported Node.js matrix, live PostgreSQL/Memgraph job, browser smoke tests, and CodeQL upload. Verified on main commit `489325585d57fe95f961c36a597faa7065848c7f` by hosted run [#258](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41949722725): six checks passed, including 65/65 live integration tests and 9/9 browser smoke. This is engineering CI evidence only; the [production release gate](reports/2026-11-04-VirgoScorpio-Hub-0.6.1-Release-Gate-Report.md) remains NO-GO.
- [x] Retain exact-revision evidence for a fresh PostgreSQL database applying migrations 0001–0018, idempotent re-entry, and the supported v0008-to-v0009 upgrade fixture. PR #68 run #270 passed the dedicated live suite (65/65), generated current-source migration evidence (18/18 apply and 18/18 second-pass skips), and exercised the upgrade fixture. The separate formal PostgreSQL/Memgraph release record still requires current source identity; see [release readiness](RELEASE_READINESS.md).
- [x] Validate concurrent outbox claims, independent consumer-group delivery, transient graph-projection retry/replay, dead-letter ordering and expired-lease recovery against live services. PR #68 run #270 passed the dedicated integration suite and explicit Memgraph outage/replay test.
- [ ] Run representative sustained load/soak and fault-injection tests; publish measured throughput, resource bounds, recovery latency and production capacity limits. The existing bounded integration tests are correctness evidence, not a production load certificate.
- [ ] Perform backup/restore drills and document RPO/RTO results.
- [ ] Require an explicit release-readiness review and approval record.

### Security and identity

- [ ] Complete an independent security review and track remediation.
- [ ] Review tenant/site isolation across all API routes and background work.
- [ ] Validate OIDC/SAML/email delivery/MFA flows with real test infrastructure where applicable.
- [ ] Verify production malware-scanning integration and quarantine behavior.
- [ ] Validate plugin isolation, immutable images, resource limits, and egress policy in the intended deployment environment.
- [ ] Verify SBOM, provenance, dependency scan, CodeQL, and release artifact retention.

### Provider and product parity

- [ ] Validate cloud storage providers using supported integration accounts and failure-mode tests.
- [ ] Validate Stripe flows with test-mode accounts, idempotency, reconciliation, webhook verification, and ambiguous transport outcomes.
- [ ] Add acceptance evidence for commerce and community workflows that spans application, database, and user-facing behavior.
- [ ] Complete keyboard, screen-reader, contrast, focus, and browser acceptance testing.
- [ ] Define explicit WordPress, Elementor, WooCommerce and BuddyPress acceptance subsets; do not claim parity until their selected tests pass.

### Documentation and developer experience

- [x] Centralize PostgreSQL transaction lifecycle handling and adopt it in the community workflow and Stripe checkout reconciliation modules. Keep adoption incremental; auth, content persistence, API routes, and cross-system object-storage workflows still require separate contract review.
- [x] Extract the authenticated AI task status/history/detail read routes into a dedicated handler while retaining authentication, site selection, and `ai:use` enforcement in the API composition pipeline.
- [ ] Keep feature descriptions and badges aligned with CI evidence.
- [ ] Keep setup commands, environment examples, and module responsibilities synchronized with the source.
- [ ] Track recurring onboarding friction from contributor feedback and simplify the most common paths.

**Exit condition:** the applicable 0.6.x release gates have current evidence for the exact target commit. A green unit suite or configured CI workflow alone is insufficient.

## Track B — Build the real-time platform foundation (P1)

This track establishes reusable infrastructure before individual screens and features independently implement real-time behavior.

**Foundation 1 progress (developer preview):** the Foundation 1 implementation lineage (`feat/f1-10-cross-instance-collaboration` and follow-on `feat/f1-11-collaboration-resilience`) contains the event hub, lease-based presence, authenticated SSE/WebSocket transport, Redis/Memurai shared presence and ephemeral Pub/Sub, session-bound authorization invalidation, bounded realtime metrics, and F1.9/F1.10 collaborative-document proofs. **F1.7** records the provisional server-authoritative semantic-OT direction in [Collaborative Editing Spike](COLLABORATIVE-EDITING-SPIKE.md) and ADR-019. **F1.8** adds authenticated presence WebSockets, shared global/site/principal connection quotas and bounded snapshot-refresh guidance. **F1.9** adds draft-only semantic OT and PostgreSQL operation sequencing. **F1.10** adds bounded cross-instance Redis document hints and PostgreSQL gap/heartbeat repair; live loopback Redis and two-API-instance browser tests prove A↔B delivery, dropped/reordered/duplicate hint recovery, reconnect after node loss and 2/5/10 editor convergence. Pub/Sub is still ephemeral and PostgreSQL remains authoritative. F1.11 adds a loopback-Redis transient-publish recovery check, a 10-subscriber × 2,000-operation sustained relay check, and a 10-session reconnect storm after local API-node loss; these are bounded local-harness observations, not production capacity certification. This remains a developer-preview correctness/load baseline, not durable client-event replay or production certification. See [Real-Time Foundation 1](REALTIME-FOUNDATION-F1.md) and migrations `0010`–`0014`.

- [x] Publish and review the real-time event contract: v1 event identity/schema, site scope, actor, correlation, classification, aggregate-version idempotency and payload bounds. See [Real-Time Foundation 1](REALTIME-FOUNDATION-F1.md). A distinct tenantId is not yet modeled.
- [x] Implement an authenticated, same-origin presence WebSocket preview with the existing SSE fallback, site capability checks, command allow-list and periodic reauthorization. Durable collaboration operations and durable event replay remain separate work.
- [x] Implement PostgreSQL consumer-group delivery records, explicit event-type subscriptions, at-least-once claims, lease recovery, per-aggregate ordering, retry/dead-letter and bounded replay by event ID; migrate the Memgraph projector to `graph.projection.v1` and validate content workflow projection ordering.
- [ ] Select and validate durable event fan-out beyond the PostgreSQL delivery ledger only after measuring deployment topology, throughput, ordering and operational cost; F1.4/F1.10 Redis Pub/Sub carries only ephemeral presence/authorization/document hints and is not a durable delivery log.
- [x] Implement a Redis-protocol-compatible shared presence lease adapter with TTL expiry, multi-session aggregation, hidden-state filtering, per-site capacity and expiry callbacks. Live tests verify two independent clients share the same site snapshot.
- [x] Add Redis Pub/Sub expiry and presence-refresh invalidation propagation to SSE and WebSocket presence subscribers, with site-scoped channels and authorization rechecks. Relay failure preserves local presence refresh; remote delivery remains best-effort and no Pub/Sub replay is claimed.
- [x] Add bounded backpressure, shared global/site/principal connection quota leases for SSE and WebSocket, connection-rate controls, and local-first presence degradation when Redis relay publication fails. Redis quotas fail closed when the shared store is unavailable.
- [x] Add bounded low-cardinality realtime metrics for connections, fan-out, authorization, presence and Redis operations; define production scrape/alert ownership separately.
- [x] Document real-time subsystem operating boundaries, current metrics, privacy rules, triage and recovery procedures in the [Real-Time Operations Runbook](REALTIME-OPERATIONS.md). This is a developer-preview operating baseline, not deployment approval.
- [x] Add request-scoped W3C Trace Context v00, AsyncLocalStorage correlation, trusted-ingress guard, internal plugin-runner propagation, and the initial allow-listed API/plugin-runner structured JSON logs. At this milestone logs were local only; the later F1.16 OTLP Logs transport is tracked below. See [Observability and Trace Correlation](OBSERVABILITY.md).
- [x] Add opt-in OpenTelemetry manual span instrumentation and OTLP/HTTP export for API, authenticated plugin runner, PostgreSQL, Redis, outbox/worker, graph projection and scheduler. See [Observability and Trace Correlation](OBSERVABILITY.md); tracing is disabled by default.
- [x] Add an authenticated, loopback-only local OTLP/HTTP Collector development profile with bounded memory, batch processing, a pinned contrib image, and ephemeral debug pipelines for traces and logs. See [Observability and Trace Correlation](OBSERVABILITY.md); this is not a production backend.
- [x] Add an opt-in, vendor-neutral OTLP/HTTP Logs transport for allow-listed structured events, bounded batched export, trace/span correlation, and an authenticated ephemeral local trace+logs Collector smoke test. This is transport plumbing only; no production log backend or retention/access policy is implied.
- [x] Define a vendor-neutral production observability deployment-evidence contract, strict fail-closed validator, and release-readiness gate covering backend selection, TLS/authentication, access, retention/deletion, named ownership, durable delivery, measured capacity and outage recovery. This does not select a provider or attest to external evidence; see [Production Observability Deployment Contract](OBSERVABILITY-DEPLOYMENT.md).
- [ ] Select, deploy, secure and load-test a production OTLP collector/backend against an approved manifest; independently verify evidence, TLS, durable queueing, retries, retention and access policy on the target topology.
- [ ] Centralize redacted logs with approved transport, access controls, retention/deletion, audit and named ownership; do not collect prompt/content/token payloads.
- [x] Validate cross-site/document subscription and delivery isolation with adversarial integration tests; no separate tenantId is modeled yet.

**Exit condition:** a reproducible multi-instance test demonstrates authenticated, tenant-isolated delivery, reconnect, duplicate handling, stale-presence expiry and recovery from relay or broker interruption.

## Track C — Establish AI governance and orchestration (P1)

- [x] Define the initial durable AI queue storage/worker contract: AES-256-GCM task/result payload encryption with site/task/purpose AAD; 128 KiB ciphertext bounds; atomic queue claim + metadata transition; random claim tokens, expiring leases and heartbeat renewal; stale-claim-safe completion/failure; bounded attempts, transient retry delay, exhausted-lease reaping; actor/site-scoped result reads; and input-ciphertext clearing on terminal/cancel paths. Migration `0018_ai_task_durable_queue.sql`; implementation: [encrypted payload cipher](../packages/security/src/ai-task-payload.js), [queue store](../packages/db/src/ai-task-queue.js), [worker contract](../packages/ai/src/queue-worker.js); regression tests cover crypto, queue-state SQL contracts and worker behavior. This is an infrastructure foundation only: API enqueue dispatch, production worker composition, idempotency, policy revalidation, retention/key rotation, quotas and provider fallback remain incomplete.
- [x] Add the first authorization-aware saved-page context path for `POST /api/v1/ai/page-draft`: up to five explicit page IDs, site-scoped retrieval, database-enforced owner-only reads, fail-closed denied/missing/cross-site handling, visible text/alt extraction, untrusted context capped at 3,000 characters, and server-forced `confidential` classification before site-policy enforcement. Implementation: [context assembler](../packages/ai/src/context-assembler.js) and [owner-scoped store query](../packages/db/src/postgres-store.js); regression coverage: [API authorization tests](../test/ai-context-api.test.js), [assembler tests](../test/ai-context-assembler.test.js), and [store query test](../test/content-owner-store.test.js); commit `e7fe2d05af91c8bb807b494e836fef77c7f5c3a2`. This first slice is page-draft only; other AI operations still need explicit context integration.
- [ ] Wire the queue foundation into an authorized enqueue API and independently deployed worker; revalidate caller/site policy at execution time, reserve budgets atomically, add idempotency keys, safe cancellation of queued/running work, result retrieval, retention/deletion and encryption-key rotation. Add bounded provider fallback only after policy and idempotency semantics are defined.
- [x] Propagate HTTP client cancellation through the governed AI service and all provider adapters, abort in-flight provider fetches on disconnect, and distinguish caller cancellation from provider timeout in sanitized audit outcomes.
- [x] Persist metadata-only AI task lifecycle states (`queued`, `running`, `succeeded`, `failed`, `cancelled`, `blocked`) and expose actor- and site-scoped status retrieval. Prompt/context/model output are not stored. This is synchronous request tracking, not a durable worker queue: leases, crash recovery, retries, resumability, task retention/deletion controls, quotas and provider fallback remain open.
- [x] Add an actor/site-scoped AI task collection endpoint with status/type filters, bounded page sizes, deterministic keyset pagination, and query-bound cursors. The cursor is only a pagination bookmark; database actor/site predicates remain the authorization boundary.
- [ ] Add structured output validation, prompt/tool versioning, correlation IDs, traceability and safe error handling.
- [ ] Define an explicit human-approval contract for publishing, role changes, firewall/security changes, moderation actions and workflow execution.
- [ ] Define risk tiers so low-risk, reversible and explicitly delegated tasks can be automated proportionately, while consequential or privileged actions require authorized human review.
- [ ] Provide user-visible AI status, explanation, source/context disclosure where appropriate, and accept/reject/revise/undo controls.
- [ ] Capture human/AI contribution provenance in version history when relevant, respecting user preferences and retention rules.
- [ ] Define consent and preference controls for AI assistance, contextual data access and model-provider processing.
- [ ] Evaluate whether assistance increases user capability and understanding rather than simply optimizing task throughput; do not turn presence metrics into covert worker scoring.
- [ ] Prevent AI tools from changing their own permissions, policy, credentials, approval requirements or audit records.
- [ ] Establish redaction, retention, consent and data-use controls for prompts, context, model responses and diagnostic traces.
- [ ] Build a representative evaluation set for accuracy, refusal behavior, prompt injection, data leakage, bias and cost/latency.

**Exit condition:** an AI-assisted action can be traced from request through authorized context, model/provider call, validation, human approval (when required), execution and audit record, with tests proving denied access and provider failure are safe.

## Track D — Deliver the first collaborative AI experiences (P1–P2)

### Collaborative CMS and writing assistant (P1)

- [x] Evaluate CRDT and operational-transformation approaches against VirgoScorpio Hub's structured document model; record the provisional semantic-OT direction and trade-offs in [Collaborative Editing Spike](COLLABORATIVE-EDITING-SPIKE.md) and ADR-019.
- [x] Implement a two-client semantic-OT proof with durable PostgreSQL operation sequencing, typed conflict handling, authenticated document REST/WebSocket transport, reconnect/replay, persisted revision/workflow/outbox integration and a two-context Playwright convergence proof (F1.9; production gates remain open).
- [ ] Implement collaborative document sessions, presence, cursors/selections, conflict handling, recovery and integration with persisted revisions.
- [ ] Add comments and review threads with tenant-scoped authorization and immutable audit context.
- [ ] Integrate the writing assistant for grammar, spelling, clarity, coherence, rewriting, autocomplete and context-aware suggestions.
- [ ] Stream suggestions without silently changing saved content; support accept, reject, undo, attribution and user preferences.
- [x] Validate collaboration across multiple users and API instances, including reconnect, concurrent edits, cross-scope isolation and 2/5/10 editor sequence convergence (F1.10 local correctness proof; production load/failover gates remain open).

### Collaborative administration and user environments (P2)

- [ ] Add shared admin presence and safe collaborative configuration review.
- [ ] Add versioned change previews, conflict handling, approvals and audit trails for administrative changes.
- [ ] Introduce personalized user workspaces with configurable activity, assistance and notification controls.
- [ ] Provide contextual AI help that only uses data the current user is allowed to access.

**Exit condition:** the first CMS workflow passes browser, accessibility, authorization, conflict/recovery and privacy acceptance tests. Admin and user experiences remain separate scoped milestones.

## Track E — Intelligent platform services (P2)

- [ ] Implement AI-assisted error triage and debugging over redacted, access-controlled telemetry.
- [ ] Provide live observability presence for service health, queue status, latency and incident indicators.
- [ ] Provide security presence for privileged security events, suspicious activity and incident state without exposing sensitive details to unauthorized roles.
- [ ] Add AI moderation recommendations with evidence, moderator review, appeal/reversal and policy versioning.
- [ ] Add AI search with tenant/ACL-aware indexing, deletion/freshness propagation and relevance evaluation.
- [ ] Add contextual documentation/help and translation workflows with source links, terminology guidance and human editorial review.
- [ ] Add UI semantics assistance for accessible names, descriptions, interaction hints and consistency checks, backed by manual accessibility acceptance.
- [ ] Complete live notification/badge presence, chat/forum presence and AI task presence on the shared event foundation.
- [ ] Add operational controls for provider availability, spend, latency, user feedback and model-quality regressions.

**Exit condition:** each service has a defined data boundary, measurable acceptance criteria, privacy/retention policy, failure behavior and user-visible review path.

## Track F — Workflow Studio and collaborative automation (P3)

- [ ] Research a versioned, typed workflow graph schema and node contract.
- [ ] Prototype a collaborative canvas for plans, decision trees, automation graphs and approval paths.
- [ ] Support AI-generated workflow drafts from natural-language requirements, with explanations and explicit validation results.
- [ ] Add static validation, dependency checks and sandboxed simulation before enabling execution.
- [ ] Define durable execution state, retries, cancellation, compensation, pause/resume and recovery.
- [ ] Require the initiating actor's capabilities and policy approval for every privileged node; never let AI-generated plans bypass authorization.
- [ ] Add workflow versioning, diff/rollback, run history, live execution presence and traceable node-level outcomes.
- [ ] Conduct threat modeling and adversarial tests for untrusted workflow definitions, plugins, tool calls, data exfiltration and resource exhaustion.

**Exit condition:** a bounded, non-production prototype supports collaborative editing, deterministic validation, safe simulation, version history and an independently reviewed execution threat model. Production execution is a later gate.

## Cross-track research questions

- What consistency guarantees should apply to collaborative documents, presence and durable events?
- Which event transport and fan-out design fits the expected single-node and multi-node deployments?
- Does the provisional semantic-OT model pass the two-client conflict/recovery prototype, or do offline-first requirements justify reopening the CRDT evaluation?
- How should AI context be assembled so that permissions are enforced before retrieval and again before actions?
- Which model/provider evaluation methods are appropriate for writing, moderation, search, security triage and workflow generation?
- How should live presence and operational telemetry be minimized, retained, exported and deleted?
- What workflow execution isolation is required for actions, plugins and third-party integrations?

Research should produce reproducible experiments, measured trade-offs and documented negative results where an approach is unsuitable.

## Documentation and developer experience

- [ ] Add real screenshots or short screen recordings only after obtaining current, reviewed assets.
- [ ] Keep setup commands, environment examples, architecture diagrams and module responsibilities synchronized with the source.
- [ ] Maintain the [feature coverage matrix](FEATURE-PARITY.md) as the source for distinguishing current code from planned capabilities.
- [ ] Maintain the [real-time and AI architecture](REALTIME-AI-ARCHITECTURE.md) as the design reference for collaborative platform work.

## Human participation, transparency and capability growth (cross-track)

These items are product-quality requirements to be implemented alongside the relevant feature tracks, not a separate promise of economic outcomes.

- [ ] Add clear indicators for AI-generated, AI-transformed and human-authored contributions where attribution is useful to the user.
- [ ] Build user-facing controls for AI assistance preferences, context use and non-AI alternatives where feasible.
- [ ] Add contextual explanation and learning affordances so users can understand suggested changes and develop their own skills.
- [ ] Establish recourse patterns for AI-assisted moderation, access recommendations and other decisions affecting people: explain, appeal, review and reverse where appropriate.
- [ ] Conduct usability research with administrators, creators, workers and community participants to assess agency, workload, accessibility and unintended effects.
- [ ] Document privacy-preserving limits for presence and activity data; prohibit covert individual productivity scoring as a default product capability.

## Completion rule

A roadmap checkbox is not a release gate by itself. Link each completed item to a commit, test report, reviewed artifact, benchmark, threat model or operational record. The authoritative release gate list is [Release readiness](RELEASE_READINESS.md). Never convert a planned capability into an implemented claim solely because its interfaces, documentation or test definitions exist.
