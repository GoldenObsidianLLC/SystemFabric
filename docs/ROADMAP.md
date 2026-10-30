# SystemFabric Roadmap

This roadmap is evidence-oriented rather than a promise of dates. Items should move to complete only when linked evidence exists for the target commit and environment. The roadmap now covers two complementary tracks: completing the current secure, reliable platform foundation and developing toward a real-time collaborative AI-native platform.

Priorities: **P0** = critical reliability/security/release work; **P1** = foundational next capabilities; **P2** = major product capabilities; **P3** = strategic advanced capabilities. These labels indicate sequencing, not delivery dates or guarantees.

## Human-AI agency — cross-cutting product and engineering gate

The [SystemFabric Manifesto](../SYSTEMFABRIC_MANIFESTO.md) is the project's north star for human-AI collaboration. It frames the goal as amplifying human capability, preserving creative dignity and productive relevance, and resisting designs that treat human obsolescence or concentrated control as inevitable. This roadmap translates those values into engineering work; it does not claim that software alone can guarantee employment, income or broader economic outcomes.

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

## Track A — Stabilize the 0.5.x platform baseline (P0)

### Reliability and release process

- [ ] Make CI green across the supported Node.js matrix, live PostgreSQL/Memgraph job, browser smoke tests, and CodeQL upload.
- [ ] Add fresh-database migration and supported upgrade-path evidence.
- [ ] Exercise concurrent writes, outbox retry/recovery, and failure recovery under representative load.
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

- [ ] Keep feature descriptions and badges aligned with CI evidence.
- [ ] Keep setup commands, environment examples, and module responsibilities synchronized with the source.
- [ ] Track recurring onboarding friction from contributor feedback and simplify the most common paths.

**Exit condition:** the applicable 0.5.x release gates have current evidence for the exact target commit. A green unit suite or configured CI workflow alone is insufficient.

## Track B — Build the real-time platform foundation (P1)

This track establishes reusable infrastructure before individual screens and features independently implement real-time behavior.

**Foundation 1 progress (developer preview):** the first process-local event hub, lease-based presence service, authenticated site-scoped SSE presence stream, bounded queues and authorization rechecks exist on the `feature/realtime-foundation-f1` development branch. **Foundation 1.1** added the v1 PostgreSQL outbox envelope and explicit event metadata. **Foundation 1.2** added durable consumer-group deliveries, concurrent claims, leases, per-aggregate ordering, retry/dead-letter, bounded replay and explicit event-type subscriptions; the Memgraph projector now uses `graph.projection.v1`. Content workflow transitions use the monotonic `lock_version` aggregate sequence. **Foundation 1.3** adds Redis/Memurai-compatible TTL presence leases, atomic per-site capacity, session aggregation and lazy expiry callbacks; two independent Redis clients are verified against the same shared state. Foundation 1.4 adds Redis Pub/Sub fan-out of bounded presence-refresh invalidations to connected SSE clients on other API instances, with site isolation and authorization rechecks in receiving hubs. Live Redis integration verifies heartbeat fan-out and lazy expiry propagation across two API servers; Pub/Sub remains ephemeral/best-effort, not the durable event source. See [Real-Time Foundation 1](REALTIME-FOUNDATION-F1.md) and migrations `0010`–`0013`. Do not mark the multi-instance exit condition complete based on this preview.

- [x] Publish and review the real-time event contract: v1 event identity/schema, site scope, actor, correlation, classification, aggregate-version idempotency and payload bounds. See [Real-Time Foundation 1](REALTIME-FOUNDATION-F1.md). A distinct tenantId is not yet modeled.
- [ ] Design an authenticated real-time gateway with WebSocket delivery and an appropriate server-sent-event or polling fallback where useful.
- [x] Implement PostgreSQL consumer-group delivery records, explicit event-type subscriptions, at-least-once claims, lease recovery, per-aggregate ordering, retry/dead-letter and bounded replay by event ID; migrate the Memgraph projector to `graph.projection.v1` and validate content workflow projection ordering.
- [ ] Select and validate durable event fan-out beyond the PostgreSQL delivery ledger only after measuring deployment topology, throughput, ordering and operational cost; the F1.4 Redis Pub/Sub bridge is ephemeral presence invalidation only.
- [x] Implement a Redis-protocol-compatible shared presence lease adapter with TTL expiry, multi-session aggregation, hidden-state filtering, per-site capacity and expiry callbacks. Live tests verify two independent clients share the same site snapshot.
- [x] Add Redis Pub/Sub expiry and presence-refresh invalidation propagation to connected SSE clients, with site-scoped channels and authorization rechecks in each receiving hub. WebSocket delivery remains open.
- [ ] Add backpressure, per-tenant quotas, connection limits, rate limiting and graceful degradation.
- [ ] Add metrics, traces, logs and operational runbooks for the event gateway, relay and presence subsystem.
- [ ] Validate cross-tenant subscription and delivery isolation with adversarial integration tests.

**Exit condition:** a reproducible multi-instance test demonstrates authenticated, tenant-isolated delivery, reconnect, duplicate handling, stale-presence expiry and recovery from relay or broker interruption.

## Track C — Establish AI governance and orchestration (P1)

- [ ] Define a central AI task lifecycle and orchestration contract across the existing provider adapters.
- [ ] Build an authorization-aware context assembly layer; enforce tenant/site and object-level access before data reaches a model.
- [ ] Define AI task budgets, quotas, timeouts, cancellation, provider fallback and model/provider policy by tenant and use case.
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

- [ ] Evaluate CRDT and operational-transformation approaches against SystemFabric's structured document model; document the decision and trade-offs before selecting one.
- [ ] Implement collaborative document sessions, presence, cursors/selections, conflict handling, recovery and integration with persisted revisions.
- [ ] Add comments and review threads with tenant-scoped authorization and immutable audit context.
- [ ] Integrate the writing assistant for grammar, spelling, clarity, coherence, rewriting, autocomplete and context-aware suggestions.
- [ ] Stream suggestions without silently changing saved content; support accept, reject, undo, attribution and user preferences.
- [ ] Validate collaboration across multiple users, devices and application instances, including reconnect and concurrent edits.

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
- Which CRDT/OT model best matches structured page documents, rich text, comments and concurrent property edits?
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
