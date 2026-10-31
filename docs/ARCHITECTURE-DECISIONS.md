# SystemFabric Architecture Decision Records

## ADR-001: PostgreSQL is authoritative

**Decision:** Canonical content, schema definitions, revisions, identity, permissions, canonical relationship rows, publication state, audit events, and outbox events live in PostgreSQL.

**Reason:** Relational constraints, transactions, and replayable change events make authoritative state easier to reason about.

**Trade-off:** Graph projections are eventually consistent and require retry, monitoring, reconciliation, and rebuild workflows.

## ADR-002: Memgraph is a rebuildable graph projection

**Decision:** Memgraph stores lightweight identity nodes and allow-listed edges optimized for relationship traversal, not large content payloads or authoritative permissions.

**Reason:** A graph outage must not make canonical content unrecoverable or accidentally grant access.

## ADR-003: Do not promise cross-database atomic rollback

**Decision:** Commit canonical PostgreSQL writes and outbox events in one transaction; apply graph projections asynchronously with idempotency, version checks, retries, dead-letter handling, and reconciliation.

**Reason:** Application-level compensating scripts cannot guarantee distributed atomicity across arbitrary network/process failures.

## ADR-004: Page documents are versioned JSON trees

**Decision:** The visual editor stores JSON documents with stable node IDs, schema versions, typed widget properties, and explicit child arrays.

**Reason:** Documents can be validated, migrated, diffed, exported, and rendered independently of editor state.

## ADR-005: EnginEx is isolated behind a rendering adapter

**Decision:** SystemFabric uses vendored EnginEx 6.2.0 through `packages/render`. The renderer consumes validated documents and prepared data rather than issuing CMS SQL queries.

**Trade-off:** SystemFabric's supported Node.js minimum follows the vendored package declaration (>=22.23.4); this build has only been locally tested on 22.16.0.

## ADR-006: AI is provider-neutral and optional

**Decision:** Provider adapters share a task contract. Rendering and core CMS reads do not require AI.

**Reason:** Providers differ in cost, availability, data handling, schemas, and model behavior.

## ADR-007: AI creates proposals, not unreviewed mutations

**Decision:** Model outputs are untrusted, normalized, validated, and returned as proposals. Human-authored workflow calls govern persistence and publication.

**Reason:** Structured output does not confer permissions or guarantee factual/security correctness.

## ADR-008: MCP is a constrained local integration

**Decision:** The current MCP adapter exposes status, widget listing, document validation, page draft generation, and preview over stdio.

**Trade-off:** The MCP process inherits local user authority. Remote MCP requires separate transport authentication, tenant identity, tool-level authorization, budget controls, and review.

## ADR-009: Identity is database-backed and site-scoped

**Decision:** Use opaque session tokens stored as digests, CSRF checks for cookie-authenticated writes, capability-based site memberships, one-time invitation tokens, and per-route capability enforcement.

**Consequences:** Password reset/email verification token workflows, TOTP MFA, OIDC, and optional SAML implementation foundations exist. Live provider integration and security validation remain release gates.

## ADR-010: Published snapshots are separate from editable drafts

**Decision:** Draft saves update the editable representation and revision history. The live public response reads a separate published snapshot that changes only through approved publish/schedule transitions.

**Reason:** Editorial changes must not mutate the live page before publication.

## ADR-011: Third-party plugins execute outside the API process

**Decision:** Plugin metadata is registered and reviewed in SystemFabric, while execution is delegated to a separate runner that accepts only pinned, allow-listed OCI image digests and applies runtime constraints.

**Release gate:** A package archive inspector is not a secure build pipeline. An archive-to-OCI provenance/signature process and adversarial tests against a real isolated runtime remain mandatory. Manifest capability declarations are not themselves a sandbox.

## ADR-012: Production startup remains guarded

**Decision:** The API refuses production startup when core configuration gates are missing. Passing unit tests does not mark the product production-ready.

**Reason:** Live PostgreSQL/Memgraph behavior, full identity lifecycle, production deployment, isolated plugin execution, browser accessibility, load/soak testing, backup restore, and independent security review remain open release gates.


## ADR-013: SAML replay state is shared and consumed atomically

**Decision:** Use PostgreSQL-backed SAML request/replay state with bounded TTL and atomic consume semantics; periodically remove expired cache entries.

**Reason:** In-memory request IDs do not protect a multi-replica deployment from replay across different processes. The shared cache is still subject to live IdP integration and operational validation.

## ADR-014: AI policy is scoped to a site

**Decision:** Global provider allowlists and external-content opt-in are combined with site-level provider/usage policy. AI output remains a validated proposal and cannot directly publish or change permissions.

**Reason:** Provider flexibility must not bypass tenant policy, human review, or document validation.

## ADR-015: Durable outbox events use a versioned site-scoped envelope

**Decision:** Keep `outbox_events.id` as the stable event identity and add explicit schema version, site scope, actor, correlation/causation metadata, and classification to outbox rows. Consumers receive a validated v1 envelope alongside the legacy event `type` and `payload` fields. The existing aggregate/type/version unique constraint remains the producer idempotency key.

**Reason:** Durable events need stable identity and explicit site, actor, classification and compatibility semantics before additional consumers or a broker are introduced. The v1 envelope uses `siteId` as the current tenancy/isolation boundary; the database does not yet model a separate `tenantId`.

**Consequences:** Delivery is at-least-once. Consumers deduplicate by event identity and use aggregate version to avoid stale projections. Unregistered event types remain internal until classified. Shared fan-out, authenticated network delivery, and broker selection remain separate milestones. The Memgraph projection consumer's durable group and sequence semantics are specified by ADR-016 and ADR-017.


## ADR-016: PostgreSQL is the initial durable consumer-group delivery ledger

**Decision:** Keep the canonical outbox event in `outbox_events` and add one independently leased delivery row per consumer group in `outbox_deliveries`. Use PostgreSQL row locking with `SKIP LOCKED` for concurrent workers, expiring claim leases for crash recovery, per-aggregate ordering barriers, retry/dead-letter state and bounded replay by explicit event IDs. Do not select an external broker in this slice.

**Reason:** The existing PostgreSQL outbox is already the transactional source of truth. A broker-independent delivery ledger creates independent subscriber state and replay semantics without coupling the product to an unmeasured transport or operational dependency. Deployment topology, throughput and ordering needs must be benchmarked before introducing Redis, Kafka, NATS or a managed broker.

**Consequences:** Delivery is at-least-once; handlers must be idempotent. A dead event blocks later events for its aggregate and consumer group until replayed or resolved. Consumer groups have independent delivery/retry state. The Memgraph projection handler has since migrated to a named group and is governed by ADR-017. This ADR does not claim multi-instance SSE/WebSocket delivery, distributed presence, telemetry, or production readiness.


## ADR-017: Memgraph projection consumes a filtered durable consumer group

**Decision:** Run the graph projector through the PostgreSQL-backed `graph.projection.v1` consumer group. Persist an explicit event-type allow-list on each consumer group; reject worker startup when the persisted subscription differs from the code configuration. Project content upsert/delete, workflow status changes, taxonomy changes and relationship changes only. Keep the original source event immutable and store processing/retry state in `outbox_deliveries`.

**Aggregate sequence:** Use `content_items.lock_version` as the monotonic content aggregate sequence in `outbox_events.aggregate_version` and `envelope.resource.version`. Keep payload `version` as the editorial content revision. Migration `0013_consumer_group_event_filters.sql` re-sequences historical content events by original `created_at,id` order and advances each canonical content row's lock-version floor before the worker is deployed. Graph projection nodes store both editorial `version` and `projectionVersion`; workflow status transitions use the latter, so stale replays cannot undo a newer publish/unpublish state.

**Reason:** The former worker claimed every outbox event through one shared status column, while the graph projector supports only graph-relevant event types. It also lacked a monotonic sequence for workflow changes that do not create a new editorial revision. Durable per-group state isolates graph retries from other consumers, event filters prevent unrelated domain events from being misrouted, and the lock-version sequence preserves ordering across workflow transitions.

**Consequences:** The graph projection worker no longer writes `outbox_events.status`; other consumers remain independent. Delivery is at-least-once and the projector remains version-guarded. Event-type subscriptions are routing configuration, not an authorization boundary. A controlled graph rebuild, live Memgraph outage/replay test, operational lag/dead-letter telemetry and production topology validation remain required before production certification.


## ADR-018: Redis-compatible TTL storage backs shared ephemeral presence

**Decision:** Keep presence leases separate from the durable PostgreSQL outbox and store them in a Redis-protocol-compatible service through the `redis` Node client. Use a site-scoped sorted-set expiry index plus one TTL-backed JSON lease per principal/session. Lua scripts make heartbeat renewal, per-site capacity, removal and snapshot cleanup atomic. Session identifiers are hashed in key names; all keys for a site share a Redis Cluster hash tag. Preserve the memory adapter for deterministic tests and single-process preview.

**Expiry behavior:** Expired members are pruned on the next heartbeat or site snapshot. A short metadata-retention window allows the adapter's `onExpired` callback to observe the expired session during that cleanup. This is lazy notification, not a background sweeper or a cross-node broadcast.

**Reason:** Presence is ephemeral and high-churn. A shared TTL store provides multi-process visibility without coupling presence lifecycle to durable content/event tables. Redis protocol compatibility permits local Memurai and managed Redis-compatible deployments to use the same adapter contract.

**Consequences:** Redis errors fail closed with HTTP 503; the application does not silently fall back to process-local memory when Redis is selected. Shared snapshots and lease expiry are implemented and verified with two independent clients. The event hub/SSE fan-out remains process-local, so this ADR does not claim immediate cross-instance notifications, distributed connection quotas, production readiness or an authenticated multi-replica gateway. Production hosts must inject both a distributed event hub and shared presence service.

## ADR-019: Use server-authoritative semantic OT for the first collaborative CMS release

**Status:** Provisional implementation direction; F1.9 two-client correctness proof implemented and independently review/security/load gates remain open.

**Decision:** For the first online collaborative CMS release, use a server-authoritative, document-specific semantic operational-transformation (OT) protocol. Clients submit typed operations against a known document sequence. A PostgreSQL-backed per-document sequencer deduplicates and orders accepted operations, transforms stale operations against retained history, validates the resulting page-document v1 tree and commits accepted state. Keep the versioned JSON page document as the canonical materialized representation. Do not embed CRDT metadata in page-document v1 or adopt a general-purpose CRDT runtime for this first release.

**Operation model:** Address structural edits by stable node ID, parent ID and sibling anchor rather than array indexes. Use typed operations for title changes, node insert/delete/move, allow-listed property changes and bounded text-range edits. Define deterministic rules for same-property writes, simultaneous sibling insertion, delete-versus-edit, simultaneous moves and missing/deleted parents. The server remains authoritative for actor/site identity, authorization, operation sequence and validation.

**Reason:** The current editor is an online-first structured page builder, not a rich-text document editor. Its page schema already supplies stable node identities, typed widget properties, child arrays and strict tree constraints. PostgreSQL already owns canonical JSON content, row locking, optimistic version checks, immutable revisions and the outbox. Semantic OT is the narrower fit for the current operation set and existing authoritative write path. A CRDT can provide stronger offline/multi-master convergence, but it does not remove the need to define single-parent moves, duplicate identity, schema validation, publication isolation, authorization, durable updates and compaction for this tree model.

**Consequences:** F1.9 implements a durable collaboration sequence/history, idempotent operation IDs (including compact replay tombstones and canonical reload when a duplicate's applied operation has been pruned), a 1,000-operation replay window with canonical reload, Unicode code-point text transforms and the documented conflict matrix. Editorial `version`, aggregate `lock_version` and collaboration sequence remain distinct. Whole-document save/restore and workflow transitions establish new collaboration checkpoints. Accepted operations commit through PostgreSQL with revision, workflow evidence and outbox state in one transaction; Redis Pub/Sub is not the operation log or acknowledgement source. Authenticated REST and document-scoped WebSocket routes are implemented for draft pages. Local two-session browser convergence, duplicate retry, reconnect replay, expired-history reload and exact post-transform acknowledgement are tested. Origin echo suppression uses a unique server connection ID, not a client-supplied editor ID. Cross-instance live document fan-out, multi-editor load/soak, independent security/accessibility review and production runbooks remain open. Production use is not approved.

**Revisit when:** Offline-first editing, multi-master operation, extended disconnection recovery or a broader rich-text model becomes a hard product requirement. In that case, run a library-backed CRDT prototype against the same conflict matrix and persistence/authorization gates before revising this decision. This ADR does not claim that F1.9 is a complete Studio collaboration experience or that the gateway, OT protocol or persistence path is production-ready.

**Evidence:** `docs/COLLABORATIVE-EDITING-SPIKE.md` records the codebase assessment and algorithm comparison; `docs/superpowers/specs/2026-10-30-f1-9-collaborative-cms-design.md`, `docs/REALTIME-FOUNDATION-F1.md` (F1.9 section), `test/collaboration.test.js`, `test/integration/postgres-collaboration.integration.test.js`, `test/realtime-websocket.test.js` and `test/e2e/collaboration.spec.js` record the implementation and validation evidence.
