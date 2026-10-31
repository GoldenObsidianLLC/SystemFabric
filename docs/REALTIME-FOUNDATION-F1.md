# Real-Time Foundation 1: Presence and Collaborative Document Previews

**Status:** Implemented developer-preview foundation, F1.9 collaborative CMS correctness proof and F1.10 cross-instance document delivery proof; not production-certified
**Working branch:** `feat/f1-10-cross-instance-collaboration`
**Baseline:** SystemFabric 0.5.1
**Scope:** Foundation 1 process-local event fan-out, lease-based presence and authenticated presence SSE; Foundation 1.1 canonical durable event contract; Foundation 1.2 PostgreSQL consumer-group delivery ledger; Foundation 1.3 shared Redis presence leases; Foundation 1.4 cross-instance presence Pub/Sub; Foundation 1.5 authorization invalidation and session-bound SSE revocation; Foundation 1.6 bounded realtime observability; Foundation 1.7 collaborative CMS architecture spike; Foundation 1.8 authenticated WebSocket presence, shared connection quotas and bounded snapshot-refresh recovery; Foundation 1.9 draft-only semantic OT, PostgreSQL operation sequencing, authenticated document REST/WebSocket protocol and two-session browser proof; Foundation 1.10 bounded Redis document-operation hints, shared REST/WebSocket publication, cross-instance heartbeat repair and two-node 2/5/10-editor browser proof.

This developer-preview track creates reusable seams for SystemFabric while keeping transport and storage adapters replaceable. PostgreSQL remains the durable per-consumer-group event source and the canonical sequencer/materialized store for collaborative draft operations. Redis provides shared ephemeral presence leases and Pub/Sub for site-scoped presence refresh, authorization invalidation and bounded document-operation notifications; authorization messages carry only bounded site, principal and session UUID selectors, never bearer/session tokens. F1.10 extends document notifications across API instances without moving the operation log or acknowledgement source out of PostgreSQL. Dropped, duplicate or out-of-order hints are repaired from the per-document sequence on heartbeat, sequence gap or reconnect. This remains a developer-preview correctness/load baseline, not production certification.

## 1. Implemented components

| Component | Location | Responsibility |
|---|---|---|
| Event hub | `packages/realtime/src/event-hub.js` | Site/topic-scoped fan-out, async subscriptions, bounded queues, authorization checks and targeted subscription invalidation |
| Presence service | `packages/realtime/src/presence.js` | Session leases, heartbeat renewal, multi-session aggregation, hidden-state filtering |
| SSE gateway | `packages/realtime/src/sse-gateway.js` | SSE fallback, shared connection quota leases, periodic session/capability reauthorization, backpressure handling and snapshot-refresh recovery |
| WebSocket gateway | `packages/realtime/src/websocket-gateway.js` | Authenticated presence and draft-document commands, per-document replay/heartbeat reconciliation, origin-echo suppression, periodic reauthorization, ping/pong liveness, bounded frames/rates/buffers and cleanup |
| Connection quota | `packages/realtime/src/connection-quota.js` | Global/site/principal leases with memory preview and atomic Redis Lua adapter; lease expiry reclaims crashed connections |
| Redis realtime bridge | `packages/realtime/src/redis-realtime.js` | Shared ephemeral presence/authorization hints and strictly validated, bounded document-operation notifications; local-first publish and independent ingress queues |
| Collaboration sequencer | `packages/db/src/postgres-store.js` | Canonical per-document operation sequence, accepted history, transactionally materialized document and reconnect/sync authority |
| Transport protocol | `packages/realtime/src/realtime-protocol.js` | Versioned ready/reconnect contract with explicit snapshot-refresh semantics |
| Package exports | `packages/realtime/src/index.js` | Stable module entry point |
| API integration | `apps/api/src/server.js` | Authenticated site-scoped preview endpoints |
| Tests | `test/realtime.test.js`, `test/realtime-websocket.test.js`, `test/realtime-controls.test.js`, `test/redis-realtime.test.js` | Authorization, transports, shared quotas, relay fault injection, cleanup and bounded recovery behavior |

## 2. Enable the preview

Set this in a local development environment only:

```dotenv
SYSTEMFABRIC_REALTIME_ENABLED=true
```

The default is `false`. The built-in event hub and memory presence/quota adapters are process-local and lose state when the API exits. Redis presence mode requires injected shared presence, Pub/Sub bridge and distributed connection-quota adapters. Redis Pub/Sub carries ephemeral presence/authorization hints only; it is not a durable event log.

**Do not enable the built-in preview adapters in production.** When `NODE_ENV=production` and the flag is enabled, the API requires caller-injected distributed event, presence and connection-quota adapters. Production use still requires independently reviewed adapters, multi-instance load/failover evidence, shared authorization semantics, operational runbooks and security review.

## 3. Preview API

All routes require the existing bearer-token or authenticated-session mechanism and the site's `content:read` capability. The development token path is only available outside production.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/sites/:siteId/presence/heartbeat` | Renew the current authenticated session's lease |
| `DELETE` | `/api/v1/sites/:siteId/presence/heartbeat` | Remove the current session's lease |
| `GET` | `/api/v1/sites/:siteId/presence` | List visible site presence |
| `GET` | `/api/v1/sites/:siteId/realtime/events?topic=presence` | Subscribe to presence refresh events over SSE (fallback) |
| `GET` | `/api/v1/sites/:siteId/realtime/ws` | Authenticated bidirectional presence WebSocket preview |

Heartbeat accepts only a JSON object containing optional `availability`: `active`, `idle`, `away`, or `hidden`. The server derives principal and session identifiers from authentication; clients cannot choose another user's identity or session.

SSE and WebSocket events intentionally carry only a `presence.refresh` hint. Clients fetch the authorized presence snapshot over the REST endpoint rather than receiving a broadcast of user/session details. The WebSocket command allow-list is `ping`, `presence.heartbeat` and `presence.leave`; site, principal and session identity are derived server-side. The SSE endpoint remains available as a one-way fallback.

Example heartbeat:

```http
POST /api/v1/sites/11111111-1111-4111-8111-111111111111/presence/heartbeat
Authorization: Bearer <development-token>
Content-Type: application/json

{"availability":"active"}
```

## 4. Safety and operational boundaries

- **Tenant isolation:** subscriptions and presence queries are keyed by validated site UUID; route capability checks run before access.
- **Reauthorization:** the event hub rechecks subscription authorization before each delivery and closes revoked subscriptions.
- **Bounded memory:** subscriptions per principal, queued events, event payload size and presence entry count have explicit limits.
- **Slow consumers:** a full event queue closes the subscription rather than growing memory without bound.
- **Lease expiry:** presence is renewed by heartbeat and expires without requiring a disconnect event.
- **Session separation:** multiple devices/sessions are aggregated for user presence; leaving one session does not mark the user offline if another remains active.
- **Privacy:** hidden users are omitted from other viewers' presence lists; users can still see their own hidden state.
- **Preview hub only:** the in-memory event hub is best-effort and has no replay cursor or persistent queue. The separate PostgreSQL consumer-group ledger provides durable handler delivery but is not the SSE transport.
- **Presence is not document collaboration:** presence hints and leases do not carry document edits. F1.9 adds a separate authenticated semantic-OT document protocol; the full Studio collaborative editing experience remains a later product milestone.
- **No production claim:** this milestone does not establish horizontal scalability, high availability, production security certification, or disaster recovery.

## 5. Durable Domain Event Contract (F1.1)

The first durable-event contract is implemented for PostgreSQL outbox producers and consumers.

### Canonical v1 envelope

| Field | Meaning |
|---|---|
| `eventId` | Stable UUID equal to `outbox_events.id`. |
| `eventType` | Reviewed dotted event identifier such as `content.publish` or `relationship.upsert`. |
| `schemaVersion` | Positive integer; this implementation currently accepts v1 only. |
| `occurredAt` | ISO-8601 timestamp derived from the outbox row's `created_at`. |
| `siteId` | Site UUID and current tenancy/isolation boundary. |
| `actor` | `{type: "user", id}` for a recorded user, otherwise `{type: "system", id: null}`. |
| `resource` | Aggregate `type`, UUID `id`, and positive aggregate `version`. |
| `correlationId` | Optional request/workflow correlation identifier. API-driven content writes attach the request ID. |
| `causationId` | Optional parent event UUID; reserved for causation chains. |
| `classification` | `internal`, `site-private`, or `public`. Unregistered event types must remain internal. |
| `payload` | Bounded plain JSON object; maximum 64 KiB. |

The current database models the site as the tenant/security boundary, so v1 carries `siteId` and does not claim a separate `tenantId`. Introduce a separate tenant identifier only with a schema/model change and a later event schema version.

### Producer and consumer rules

- The existing outbox primary key is the stable event identity. No duplicate event ID column is introduced.
- The existing unique constraint on `(aggregate_type, aggregate_id, aggregate_version, event_type)` is the producer idempotency key: one event of a given type per aggregate version.
- Consumers receive the canonical `envelope` alongside the legacy `type` and `payload` fields so the current Memgraph projector remains compatible.
- Delivery remains at-least-once. Consumers must deduplicate by `eventId` and use `resource.version` to prevent stale aggregate projections from overwriting newer state.
- No global ordering guarantee is made. Aggregate version is the ordering/reconciliation signal where a consumer needs one.
- The current registry classifies content, relationship, and taxonomy domain events as `site-private`. Unknown/unregistered event types cannot claim a public or site-private classification.
- Migration `0010_outbox_event_contract.sql` adds the metadata columns and backfills legacy site scope from existing payloads. Migration `0011_outbox_legacy_classification_backfill.sql` restores unregistered legacy event types to `internal`, matching the fail-closed v1 registry. New content and relationship outbox writes persist site, actor, correlation, and classification as dedicated columns.
- The worker validates the envelope before dispatch. Invalid or unsupported events follow the existing retry/dead-letter path rather than being silently interpreted as v1.

F1.2 adds a durable consumer-group delivery ledger so independent handlers can consume the same immutable source events without sharing retry state. The Memgraph projection worker has now migrated to the named `graph.projection.v1` group, with an explicit allow-list of projection-relevant event types and aggregate-sequence-aware content workflow handling.

## 6. Shared Durable Delivery (F1.2)

F1.2 adds a PostgreSQL-backed delivery ledger for independent consumer groups. The original immutable source event remains in `outbox_events`; each consumer group receives its own row in `outbox_deliveries`.

| Component | Location | Responsibility |
|---|---|---|
| Delivery worker | `packages/db/src/outbox-delivery.js` | Registers a consumer group, discovers missing events, claims deliveries and invokes a handler |
| Consumer groups | `outbox_consumer_groups` | Named, independently enabled delivery subscriptions |
| Delivery ledger | `outbox_deliveries` | Per-group status, attempts, lease, retry timing, error code and processed timestamp |
| Subscription filter | `outbox_consumer_groups.event_types` | Explicit allow-list of event types for each group; empty/legacy configurations fail closed |
| Replay helper | `replayOutboxDeliveries()` | Requeues explicit event IDs for a selected group |
| Graph projection worker | `apps/worker/src/outbox-worker.js` | Runs the Memgraph projector as the `graph.projection.v1` consumer group |
| Graph projector | `packages/graph/src/memgraph-store.js` | Applies content, workflow-status, taxonomy and relationship projections with aggregate-sequence guards |
| Migrations | `database/migrations/0012_durable_consumer_group_deliveries.sql`, `0013_consumer_group_event_filters.sql` | Adds consumer-group delivery state, event-type subscriptions and historical content-event sequence backfill |
| Tests | `test/outbox-delivery.test.js`, `test/integration/postgres.integration.test.js` | Contract checks and live PostgreSQL concurrency, ordering, replay and lease-recovery coverage |

### Delivery semantics

- The first worker run inserts its consumer-group row if missing. Existing group enablement is not overwritten by worker startup; an operator can disable a group by setting `enabled = false`.
- Each group persists an explicit 1-64 item event-type allow-list. The worker scans only matching outbox events and idempotently inserts one delivery row per event/group. A different group gets an independent delivery record and independent retry/dead-letter lifecycle. Existing groups with an empty subscription remain unsubscribed until an operator configures them.
- Claims use PostgreSQL row locks with `SKIP LOCKED`, unique per-run lease tokens, and expiring leases. A crashed worker's expired delivery can be reclaimed by another worker in the same group.
- Delivery is **at-least-once**, never exactly-once. A handler can complete its side effect and lose its lease before acknowledgement. Handlers must deduplicate using `envelope.eventId` or an equivalent idempotency record.
- The worker enforces per-aggregate ordering using `aggregate_version`, then `created_at` and event UUID as tie-breakers. It makes no global ordering promise. A dead predecessor blocks later events for that aggregate/group until the predecessor is replayed or otherwise resolved.
- Failed handlers retry with capped exponential backoff and move to `dead` at the configured attempt limit. The stored event is retained as the replay source.
- `replayOutboxDeliveries()` requires 1-500 explicit event UUIDs, defaults to replaying only `dead` rows, and can explicitly include `processed` rows. It does not reset active, pending or processing deliveries.
- Migration `0013_consumer_group_event_filters.sql` adds persisted event-type subscriptions. The graph consumer group explicitly subscribes only to content upsert/delete and content workflow status events, taxonomy upsert/delete and relationship upsert/delete. Non-graph workflow/audit/internal events are not accidentally sent to the graph projector.
- The Memgraph projection worker now runs as `graph.projection.v1` through the consumer-group ledger. It no longer claims or mutates the legacy `outbox_events.status` state. The original `createOutboxWorker` remains available for compatibility and its existing tests, but it is not the production graph-worker entry point.
- Content editorial revision `content_items.version` is distinct from the graph's monotonic aggregate sequence `content_items.lock_version`. Content outbox rows use `lock_version` in `aggregate_version` / `envelope.resource.version`, while payload `version` remains the editorial revision. This allows workflow transitions such as publish/unpublish to update the graph even when no new content revision is created, and prevents an explicit replay of an older status event from overwriting a newer state. The graph rebuild snapshot also carries `lock_version` as its projection sequence.

### Deliberate boundaries

This is durable database-backed handler delivery, not a selected external message broker and not a user-facing event gateway. Redis is used only for ephemeral presence leases in F1.3; it is not the durable event bus. The PostgreSQL ledger remains the source for durable events. Broker selection for durable fan-out remains deferred until topology, throughput, ordering, operational cost and recovery requirements are measured. There is no management API for consumer groups or replay yet; these are controlled through the database and the exported worker/helper interfaces.

The delivery ledger does not by itself provide SSE/WebSocket reconnection cursors, authorization checks for downstream broadcasts, cross-instance event fan-out, delivery telemetry, retention/compaction or disaster-recovery certification. Redis-backed presence snapshots are shared, but event delivery and immediate presence-refresh notifications remain process-local. Consumer group event subscriptions are configuration, not an authorization boundary; any future network gateway must still enforce site access before each downstream delivery.

## 7. Shared Presence Leases (F1.3)

F1.3 adds a Redis-protocol-compatible presence adapter. Redis-compatible storage is used for expiring session leases and per-site indexes; PostgreSQL remains the authoritative content and durable-event store.

| Component | Location | Responsibility |
|---|---|---|
| Redis presence adapter | `packages/realtime/src/redis-presence.js` | Atomic session lease upsert/removal, site-scoped session lookup, expiry detection and capacity enforcement |
| Presence service factory | `createRedisPresenceService()` | Opens the configured Redis client, applies bounded reconnect settings and creates the existing presence service around the shared adapter |
| Client dependency | `redis@6.3.1` | Redis-protocol client used with Redis, Memurai and compatible services |
| Configuration | `.env.example` | Selects memory or Redis, lease duration, per-site session ceiling and expiry metadata retention |
| Tests | `test/redis-presence.test.js`, `test/integration/redis-presence.integration.test.js` | Adapter contracts plus live multi-session, site isolation, expiry, capacity and failure behavior |

### Lease and isolation semantics

- Each active session is stored as a JSON lease with a Redis TTL. A per-site sorted-set index records lease expiry times; expired entries are pruned when a site performs a presence snapshot or a new heartbeat.
- Redis Lua scripts make heartbeat renewal, capacity checking, index updates, removal and snapshot cleanup atomic. Site keys share a Redis Cluster hash tag; principal/session IDs are hashed in key names rather than exposed as key text.
- The default lease is 30 seconds and is bounded to 5–120 seconds. The default per-site session ceiling is 10,000. These are operational limits, not user-count or connection guarantees.
- Expired lease metadata is retained briefly (30 seconds by default) so `onExpired` can be invoked when a site index is swept by a later read or heartbeat. This callback is lazy cleanup notification, not a background expiry scheduler. F1.4 publishes a site-scoped invalidation when cleanup observes an expired lease.
- The existing service continues to aggregate multiple sessions per principal, prefer the most active visible state, and hide a principal from other viewers when all sessions are hidden.
- Store errors fail closed with `503`. Selecting `SYSTEMFABRIC_PRESENCE_STORE=redis` does not silently fall back to process-local memory. Redis connectivity is verified during API startup.
- Set `SYSTEMFABRIC_REALTIME_ENABLED=true` and `SYSTEMFABRIC_PRESENCE_STORE=redis` to select Redis for the standalone development API. Configure `SYSTEMFABRIC_PRESENCE_REDIS_URL` and the bounded lease/session settings. Keep Redis private; use TLS and authentication/ACLs in deployed environments and inject the URL from a secret manager.
- The Windows development machine has a local Memurai service listening on loopback port 6379. The live integration can also run against a separately managed Redis-compatible service by setting `SYSTEMFABRIC_PRESENCE_REDIS_URL` and `SYSTEMFABRIC_RUN_REDIS_INTEGRATION=true`.

### Deliberate boundaries

F1.3 shared presence snapshots without distributed push. F1.4 adds a Redis Pub/Sub bridge for ephemeral presence invalidations so heartbeat, leave and lazily observed expiry can refresh clients connected to another API replica. The standalone API still refuses production real-time startup; production hosts need independently reviewed distributed adapters and deployment controls.

Redis presence and Pub/Sub are not authorization boundaries. Each API request authenticates its actor and checks site capability; each receiving hub rechecks every local subscription before delivery. Presence messages contain no principal/session data. The separate authorization channel carries only opaque UUID selectors and is not a durable event source. Per-site session capacity does not replace API rate limits, distributed connection quotas or abuse controls. There is no scheduled expiry sweeper, SSE replay cursor, WebSocket transport, distributed connection counter or production certification.

## 8. Cross-instance Pub/Sub Fan-out (F1.4)

F1.4 adds Redis Pub/Sub for immediate, ephemeral site-scoped presence invalidation between API instances. The PostgreSQL outbox and consumer-group delivery ledger remain the durable event source; Pub/Sub is intentionally not used for durable business events.

| Component | Location | Responsibility |
|---|---|---|
| Redis realtime bridge | `packages/realtime/src/redis-realtime.js` | Separate publisher/subscriber clients, site-scoped channels, envelope validation and bounded inbound dispatch |
| API wiring | `apps/api/src/server.js` | Routes heartbeat/leave invalidations through the bridge; waits for subscription readiness and closes the bridge on shutdown |
| Expiry propagation | Redis presence `onExpired` callback | Publishes the same invalidation when a site read/heartbeat lazily discovers an expired lease |
| Tests | `test/redis-realtime.test.js`, `test/integration/redis-presence.integration.test.js` | Fake-broker presence/authz fan-out contracts and live two-API presence/SSE, site-isolation and expiry tests |

### Publish and receive behavior

- Each API instance owns independent Redis publisher and pattern-subscriber clients. The presence subscriber listens for channels shaped as `systemfabric:realtime:v1:<site-uuid>:presence`; those channel names contain no principal or session identifiers. The separate authorization channel is global and carries only validated UUID selectors in its bounded envelope.
- The presence channel accepts only `{ "kind": "presence.refresh" }`. Its bounded v1 envelope includes a UUID event ID, publisher instance ID, site ID, topic and timestamp. The inbound message limit is 4 KiB by default; the dispatch queue is capped at 1,024 messages.
- A separate global `systemfabric:realtime:v1:authorization` channel carries `{ kind: "authorization.invalidate", siteId?, principalId?, sessionId? }`. At least one UUID selector is required; unknown fields and token-like data are rejected. The bridge uses the same bounded message size and inbound queue.
- A publisher emits to Redis, then delivers the same event to its local hub. Its own Pub/Sub echo is ignored. Other instances validate the channel/envelope and forward the invalidation to their local hub.
- The local hub still performs a fresh authorization check for every matching SSE subscription before enqueueing. Redis Pub/Sub subscription itself never grants a user access to a site.
- The existing heartbeat rate limit, per-principal SSE connection cap and bounded per-subscription queue remain in force. Broker reconnects use bounded retry settings; clients must refetch the authorized presence snapshot after receiving an invalidation.
- If a presence publish fails, the API returns an unavailable error rather than silently claiming the cross-instance notification was sent. If an authorization publish fails, the local hub is still invalidated and the failure is logged; remote hubs revalidate active sessions and site capabilities on each SSE heartbeat, bounding stale-stream exposure by the reauthorization interval. Redis presence remains fail-closed when selected.

### Deliberate boundaries

Pub/Sub is best-effort, at-most-once notification transport. It has no durable history, acknowledgement, replay cursor or exactly-once guarantee. A client that disconnects during a publication must reconnect and fetch a fresh snapshot; event replay is not implemented. Expiry notification is lazy: it is propagated when a request sweeps an expired site index, not at the exact TTL instant, and there is no global expiry scheduler. WebSocket transport, distributed connection quotas, relay metrics/alerts, load/soak testing and production certification remain open. The standalone API entry point still refuses production real-time startup.

## 9. Authorization Invalidation and Session-Bound SSE (F1.5)

F1.5 extends the ephemeral Redis bridge with targeted authorization invalidation and binds every authenticated SSE subscription to the server-side session that established it. This is a best-effort fast path paired with periodic authorization checks; it is not a durable authorization event log.

| Component | Location | Responsibility |
|---|---|---|
| Authorization-aware event hub | `packages/realtime/src/event-hub.js` | Tracks principal/session/expiry metadata, reauthorizes subscriptions, and closes matching subscriptions by site, principal or session |
| Session validation | `packages/auth/src/service.js` | Checks session revocation, absolute expiry, idle expiry and active account status |
| Authorization Pub/Sub | `packages/realtime/src/redis-realtime.js` | Validates and distributes UUID-only invalidation envelopes across API instances |
| SSE lifecycle | `packages/realtime/src/sse-gateway.js` | Revalidates session and site capability on each heartbeat and closes streams when authorization is no longer valid |
| Mutation hooks | `packages/auth/src/service.js` | Emits invalidation callbacks after committed membership/session mutations |
| Tests | `test/auth-security.test.js`, `test/realtime.test.js`, `test/redis-realtime.test.js` | Covers scoped invalidation, cross-instance propagation, session expiry and fail-closed authorization |

### Invalidation semantics

- Membership addition/removal and invitation acceptance emit a site-plus-principal invalidation. Logout and single-session revocation emit a principal-plus-session invalidation. Password reset and MFA disable emit a principal-wide invalidation after their database transaction commits.
- The event hub supports site-wide invalidation as well, so role/capability administration can close all subscriptions for a site when no single principal is known.
- The Redis authorization channel accepts only a v1 envelope with a UUID event ID, publisher ID and timestamp plus at least one of `siteId`, `principalId` or `sessionId`. Unknown fields, arbitrary identifiers and bearer/session tokens are rejected.
- The publisher closes matching local subscriptions before attempting Redis publication. If Redis is unavailable, the local streams are still closed and the failure is logged; remote instances revalidate on the next SSE heartbeat.
- Real authenticated subscriptions carry the session ID and absolute expiry returned by the identity service. The bearer/session token itself is never stored in the event hub or sent through Redis.
- The built-in preview hub rechecks the backing session (revoked state, absolute expiry, idle expiry and active user status) and the site's `content:read` capability at connection time and on each SSE heartbeat. An expired, idle, revoked or no-longer-authorized session is disconnected.
- SSE keepalives do not renew session idle time. Normal authenticated API requests continue to update `last_seen_at`; an otherwise idle connection closes when the configured idle TTL is reached.
- No database migration is required. The invalidation channel is ephemeral and at-most-once; periodic reauthorization is the bounded fallback for missed Pub/Sub messages.

### Production boundary

The standalone API remains unavailable for production real-time startup. A production host must inject a distributed event hub that implements `invalidateAuthorization()`, a distributed presence service, and an identity service whose authorization callback publishes invalidations and whose session validation is checked by the injected hub. The production host must also verify that all replicas use the same session, idle-timeout and site-capability semantics. This slice does not certify production topology or Redis availability.

## 10. Real-Time Observability (F1.6)

F1.6 adds process-local, low-cardinality telemetry for the event hub, SSE gateway, presence services and Redis Pub/Sub adapters. It extends the existing protected Prometheus endpoint; it does not add a new public diagnostics route or persist realtime data.

| Area | Metrics / signals | Collection point |
|---|---|---|
| Connections | Active subscriptions and SSE streams; opened/closed totals; per-principal connection-limit rejections | Event hub and SSE gateway |
| Authorization | Subscribe denials, revocations and session expirations | Event hub and API site-capability checks |
| Fan-out | Events published/delivered/revoked, number of fan-out targets and event lag | Event hub |
| Backpressure | Queue overflow, SSE backpressure waits and reconnect-required frames | Event hub and SSE gateway |
| Presence | Heartbeats, leaves, memory lease gauge, last observed Redis site lease count and snapshot size histogram | Presence service/adapters |
| Redis | Pub/Sub publications/receives/failures, inbound queue size/overflow, reconnect attempts, invalid envelopes and client errors | Redis presence and realtime adapters |
| HTTP | Existing request counter and duration histogram | API request handler |

### Metric contract and access

- `createRealtimeMetrics()` in `packages/observability/src/metrics.js` provides a fixed-name counter, gauge and histogram registry. Unknown metric names, negative increments and invalid gauge/observation values are rejected.
- Realtime metric names use the `systemfabric_realtime_` prefix. The registry uses no request-, user-, session-, event- or site-ID labels, preventing tenant identifiers and high-cardinality values from leaking into Prometheus series.
- The existing `GET /metrics` endpoint remains disabled unless `SYSTEMFABRIC_METRICS_ENABLED=true`; when enabled it requires the dedicated `SYSTEMFABRIC_METRICS_TOKEN` bearer credential. The metrics token is separate from the developer API token. Production startup requires a token of at least 32 characters when this endpoint is enabled.
- `server.systemfabric.realtimeMetrics` exposes a read-only snapshot for local tests and diagnostics; the production scrape surface remains the authenticated Prometheus text endpoint.
- Metric collection is best-effort and must not change request, authorization, delivery or shutdown behavior if an injected metrics adapter throws.
- A production host that injects its own event hub or presence service must construct those adapters with the same `createRealtimeMetrics()` instance passed into `createApiServer`; internally created adapters are wired automatically.

### Interpretation and operational limits

- Metrics are process-local. Scrape every API replica and aggregate in the monitoring backend; a single instance's counters are not a cluster-wide total and reset when that process restarts.
- `presence_memory_active_leases` is the count in one process-local memory adapter. `presence_redis_last_site_lease_count` is the most recently observed site snapshot size on that API instance, not a global Redis cardinality total.
- Redis lease-expiry callbacks are lazy sweep notifications: they fire when a heartbeat or snapshot operation prunes an expired site index, not at the exact Redis TTL boundary. The expiry counter therefore measures observed callbacks, not all TTL expirations in real time.
- Event lag is measured from each event's `occurredAt` timestamp at local fan-out. Fan-out target count records eligible site/topic subscriptions before per-subscription reauthorization. These histograms are operational approximations, not end-to-end client latency.
- SSE opened/closed totals include reconnect attempts that reach the server. The service does not infer the cause of a client disconnect or claim that every reconnect was successful.
- No durable metrics store, alert policy, shared cross-replica exporter, tracing backend, or SLO is introduced in this slice. Configure scraping, retention, alert thresholds and operational ownership in the deployment environment.

## 11. Collaborative CMS Spike (F1.7)

F1.7 completes a codebase-specific evaluation of CRDT and operational transformation against page-document v1. It records a provisional recommendation for server-authoritative, document-specific semantic OT for the first online collaboration release. It does not implement collaboration.

| Topic | F1.7 outcome |
|---|---|
| Current model | Stable node IDs, typed JSON-tree widgets, bounded depth/node count, full-document editor saves and immutable PostgreSQL revision snapshots. |
| CRDT assessment | Better fit if offline-first or multi-master editing becomes a hard requirement; tree moves, single-parent identity, schema validation, durable updates and compaction remain explicit work. |
| OT assessment | Better first fit for the current online-first editor and PostgreSQL authority, provided the implementation is semantic and node-ID-based rather than a generic JSON-patch transformer. |
| Provisional direction | Server-authoritative semantic OT with typed operations, stable node/parent/sibling IDs, a durable per-document sequence and deterministic conflict rules. |
| Deferred | No CRDT library, OT engine, collaboration table, migration, WebSocket route or multi-user editor behavior is added. |

### Required operation semantics

- Typed operations cover title changes, node insert/delete/move, allow-listed property updates and bounded text edits.
- Structural positions use stable IDs and sibling anchors, never persistent array indexes.
- The implementation must define same-property writes, concurrent sibling inserts, delete-versus-edit, concurrent moves, parent deletion and operation replay.
- PostgreSQL remains the operation authority and recovery source; Redis Pub/Sub may notify replicas but is not the durable operation log.
- Editorial `version` and aggregate `lock_version` remain distinct. The OT sequence and its interaction with workflow transitions/restores must be explicitly designed.
- Full schema validation, site/document authorization and session revocation apply before accepted operations are committed. Collaboration is draft-only; publication continues to consume a validated committed snapshot.

### Next implementation gate

Before production use, build a two-client browser prototype with durable operation sequencing, idempotent retries, reconnect/replay, authorization revocation and the conflict matrix. Test 2, 5 and 10 active editors against a maximum-size valid page document; report measured latency, transform cost, transaction time, snapshot size and memory. Revisit CRDT if semantic OT becomes too complex or offline-first becomes mandatory.

See [Collaborative Editing Spike](COLLABORATIVE-EDITING-SPIKE.md) and [ADR-019](ARCHITECTURE-DECISIONS.md#adr-019-use-server-authoritative-semantic-ot-for-the-first-collaborative-cms-release).

## 12. Validation


Run from the repository root:

```bash
node --check packages/observability/src/metrics.js
node --check packages/realtime/src/event-hub.js
node --check packages/realtime/src/presence.js
node --check packages/realtime/src/sse-gateway.js
node --check packages/realtime/src/connection-quota.js
node --check packages/realtime/src/realtime-protocol.js
node --check packages/realtime/src/websocket-gateway.js
node --check packages/realtime/src/event-contract.js
node --check packages/realtime/src/redis-presence.js
node --check packages/realtime/src/redis-realtime.js
node --check packages/db/src/outbox-worker.js
node --check packages/db/src/outbox-delivery.js
node --check packages/graph/src/memgraph-store.js
node --check apps/worker/src/outbox-worker.js
node --check apps/api/src/server.js
node --test test/realtime-controls.test.js test/realtime-websocket.test.js test/realtime-observability.test.js test/auth-security.test.js test/outbox-contract.test.js test/outbox-delivery.test.js test/graph-projection-worker.test.js test/memgraph-projector.test.js test/redis-presence.test.js test/redis-realtime.test.js test/realtime.test.js test/api.test.js
npm run check
```

The focused real-time, outbox-contract, outbox-delivery, graph-projection-worker, Memgraph-projector, Redis-presence and API suites cover local behavior. Run PostgreSQL and Memgraph live integration against the dedicated test database after migrations 0010–0013. Run the Redis integration against an isolated Redis/Memurai instance with `SYSTEMFABRIC_RUN_REDIS_INTEGRATION=true` and `SYSTEMFABRIC_PRESENCE_REDIS_URL` set. The live Redis integration verifies cross-instance presence refresh and site/principal/session authorization revocation over two independent API instances. Run `npm run test:graph:rebuild` and `scripts/test-memgraph-outage.js` for graph rebuild and interrupted-dependency recovery checks. Browser E2E, load/soak and production security suites remain separate gates and should be run where their prerequisites are available.

For PowerShell, run the live Redis integration with:

```powershell
$env:SYSTEMFABRIC_RUN_REDIS_INTEGRATION = 'true'
$env:SYSTEMFABRIC_PRESENCE_REDIS_URL = 'redis://127.0.0.1:6379'
node --test test/integration/redis-presence.integration.test.js
```

### Local evidence recorded on 2026-10-30

- F1.7 architecture spike: COMPLETE — reviewed page-document v1, editor mutation/save behavior, PostgreSQL revision/sequence semantics and current SSE limits; compared CRDT with server-authoritative semantic OT; recorded provisional OT recommendation and conflict/verification gates in `docs/COLLABORATIVE-EDITING-SPIKE.md` and ADR-019. No collaboration runtime or database migration was added.
- F1.6 focused observability suite: PASS — **4 passed, 0 failed, 0 skipped**. Verified the fixed metric registry, Prometheus rendering, hub counters/gauges/histograms, presence counters/lease gauge, SSE lifecycle accounting and token-protected API scraping.
- Realtime regression suites: PASS — **29 passed, 0 failed, 0 skipped** across `test/realtime-observability.test.js`, `test/realtime.test.js`, `test/redis-realtime.test.js` and `test/redis-presence.test.js`; this includes fake-broker cross-instance telemetry and lazy Redis lease-expiry counters.
- F1.6 syntax validation: PASS — observability registry, event hub, memory presence, SSE gateway, Redis presence, Redis Pub/Sub bridge and API server all passed `node --check`.
- `npm run check`: PASS — artifact check recognized **141 required paths**; **123 JavaScript files** syntax-checked; **158 tests passed, 0 failed, 0 skipped** (Node.js 26.12.1).
- PostgreSQL migrations: PASS — migrations `0010_outbox_event_contract.sql`, `0011_outbox_legacy_classification_backfill.sql`, `0012_durable_consumer_group_deliveries.sql` and `0013_consumer_group_event_filters.sql` applied to the dedicated `TEST_DATABASE_URL` database. Migrations 0001–0009 were already recorded as applied there.
- PostgreSQL + Memgraph live integration: PASS — **9 passed, 0 failed, 0 skipped** across `test/integration/postgres.integration.test.js` and `test/integration/memgraph.integration.test.js` against the dedicated test database and local Memgraph service. Coverage includes content/outbox metadata, consumer-group concurrency and isolation, aggregate-order blocking, replay, expired lease recovery, live graph projection ordering and stale workflow-event replay protection.
- Graph rebuild live test: PASS — `npm run test:graph:rebuild`; canonical content, taxonomy and relationships rebuilt, deletion/tombstone state preserved, stale graph nodes removed, safety limit preserved existing graph state, and a second rebuild produced the same summary.
- Memgraph outage/recovery test: PASS — `scripts/test-memgraph-outage.js` stopped the isolated test graph, verified the persisted delivery returned to pending with its lease released, restarted Memgraph, replayed the event through `graph.projection.v1`, verified the projection and confirmed it was not delivered again. The temporary test container was removed.
- Redis/Memurai integration: PASS — **4 passed, 0 failed, 0 skipped**. Live coverage includes shared session leases, two-API presence snapshots, cross-instance SSE presence refresh, site isolation, lazy expiry propagation, and authorization invalidation by site/principal/session across independent API instances. The authorization test verifies a site-scoped invalidation closes only the matching site's stream and a session invalidation closes the remaining stream.
- Playwright E2E: PASS — **4 passed, 0 failed** across accessibility and editor workflows.
- `git diff --check`: PASS. Git reported expected LF-to-CRLF working-copy conversion warnings; no whitespace errors were found.

The bullets above are historical local evidence recorded before the F1.8 implementation update; they are not a production rollout. Migrations 0010–0013 have **not** been applied to the primary `DATABASE_URL` database. Before deploying the new worker code to any environment, stop existing graph workers, apply and verify all four migrations against that environment, then start the new worker version. Durable client-event replay, external durable broker selection, multi-instance WebSocket load/soak and independent production security validation remain outstanding. Presence and authorization Pub/Sub are best-effort; periodic session/capability reauthorization is the fallback for missed authorization messages.

## 13. Next engineering slices

1. **F1.9 — Collaborative CMS implementation proof:** build the selected semantic OT prototype with durable operation sequencing, a two-client browser workflow, conflict handling and reconnect/replay evidence.
2. **Projection operations:** validate consumer-group lag, dead letters, replay and recovery under the target deployment topology.


Do not promote the preview adapter to production or mark collaborative CMS as implemented until the relevant distributed, security, recovery and browser evidence exists.

## 14. F1.8 Implementation Update — Distributed Controls and Recovery

F1.8 adds a developer-preview duplex presence transport and shared connection controls. This is a bounded transport foundation, not a durable event replay system or production certification.

### Transport contract

| Surface | Behavior |
|---|---|
| WebSocket | GET /api/v1/sites/:siteId/realtime/ws; the existing HTTP server owns the upgrade, same-origin check, firewall, authenticated session/development-token flow and content:read capability check. |
| SSE fallback | The existing /realtime/events?topic=presence endpoint remains available for one-way refresh notifications and uses the same connection limiter. |
| Commands | ping, presence.heartbeat and presence.leave only. The server derives site, principal and session from authenticated request context. |
| Ready frame | connection.ready, protocol v1, heartbeat interval and reconnect contract. |
| Payload and rate bounds | 4 KiB maximum message, 60 commands/minute/connection, 1 MiB maximum outbound buffering; binary and unknown commands are rejected, WebSocket compression is disabled. |
| Slow/failed connections | Backpressure and liveness failures close with retryable WebSocket status; authorization failures close the stream. Cleanup releases the subscription and quota lease. |

### Connection quota leases

The shared quota interface is implemented by packages/realtime/src/connection-quota.js. The in-memory adapter is for local preview/tests only. The Redis adapter uses Lua scripts to atomically update global, site and hashed-principal sorted-set leases; the three keys share a Redis Cluster hash slot. Leases expire after process crashes and are renewed while the connection remains healthy.

| Limit | Default | Configuration |
|---|---:|---|
| Global connections | 10,000 | SYSTEMFABRIC_REALTIME_MAX_CONNECTIONS |
| Connections per site | 500 | SYSTEMFABRIC_REALTIME_MAX_CONNECTIONS_PER_SITE |
| Connections per principal | 4 | SYSTEMFABRIC_REALTIME_MAX_CONNECTIONS_PER_PRINCIPAL |
| Lease duration | 45 seconds | SYSTEMFABRIC_REALTIME_CONNECTION_LEASE_MS |

SSE and WebSocket use the same limiter. New Redis-quota acquisitions fail closed when the quota store is unavailable. The Redis presence mode and production API path require an injected distributed connection-quota adapter; they do not silently fall back to process-local quota accounting.

### Recovery and relay behavior

- The reconnect policy is full-jitter exponential backoff with a 1-second minimum, 30-second maximum and at most 8 attempts. It is guidance in the ready frame; a client implementation must still honor application/network policy.
- Recovery mode is explicitly snapshot-refresh, with eventReplay false. After reconnect, clients fetch the current authorized presence snapshot through REST. No replay cursor or durable history is implied.
- Redis Pub/Sub remains ephemeral. Presence refresh is delivered to the local hub before relay publication. A relay outage therefore does not suppress local subscribers; publish results and bounded metrics record degraded remote fan-out.
- Authorization invalidation revokes local subscriptions before publishing the remote invalidation. A relay failure is reported as unavailable and remote replicas rely on periodic reauthorization. Do not interpret this as instantaneous cluster-wide revocation during a broker partition.
- Metrics include connection quota outcomes, WebSocket lifecycle and rejection/backpressure/reconnect counters, active WebSocket count, Redis bridge ready/degraded gauges, fan-out duration, Redis publish duration and connection duration. Metrics remain fixed-name/low-cardinality and use the existing protected scrape route.

### Verification and remaining gates

F1.8 unit/API evidence covers authenticated same-origin upgrade, unauthenticated/cross-origin rejection, site capability delegation, allow-listed presence commands, authorization rechecks, frame/rate bounds, SSE/WebSocket shared principal quotas, lease release, local-first relay failure handling and API shutdown cleanup. Redis Lua execution is covered with a fake Redis protocol contract; a live Redis cluster/replica quota stress run has not yet been recorded.

Still required before production:
- Multi-instance and Redis Cluster quota correctness/load tests, including node loss, lease expiry and Redis partition/recovery.
- Browser/proxy compatibility and reconnect soak tests with multiple API replicas.
- External WebSocket, origin/CSWSH, rate-limit and resource-exhaustion security review.
- Operational runbooks and alert ownership for relay degradation, quota exhaustion and reconnect storms.
- Durable event replay is a separate future design. Presence refresh hints are transient and cannot replace the PostgreSQL outbox consumer-group ledger.

Production remains NO-GO. No database migration or primary-database operation was performed for F1.8.

### F1.8 validation evidence recorded on 2026-10-30

- Focused realtime API/transport/quota/relay tests: PASS — the expanded F1.8 tests cover authenticated same-origin WebSocket upgrades, rejection of unauthenticated and cross-origin upgrades, presence heartbeat/leave, per-command authorization, binary/oversized/malformed command rejection, per-principal quotas shared across SSE and WebSocket, quota release on disconnect, Redis relay failure and local-first authorization invalidation.
- Redis quota Lua behavior: PASS against the fake Redis protocol client for atomic acquire/reject/renew/release and fail-closed store errors. The Redis key layout uses a shared Cluster hash tag so the multi-key script targets one slot. No live Redis Cluster quota stress test is claimed.
- Recovery contract: PASS at protocol level — connection.ready advertises an 8-attempt full-jitter exponential reconnect policy and snapshot-refresh mode with eventReplay=false. Clients must fetch the authoritative REST presence snapshot after reconnect; no event replay is implemented.
- Remaining F1.8 gates: multi-instance load and partition recovery, Redis Cluster failover/lease-expiry stress, browser/proxy reconnect soak, external security review and production runbooks remain open. The production gate stays NO-GO.
- Live Redis-compatible quota checks: PASS — a local Redis-compatible service accepted/rejected/renewed/released leases, reclaimed a slot after TTL expiry, and preserved a replacement lease when a stale lease released. Two independent Redis clients raced for a global limit of one and exactly one acquisition succeeded. Each check used a unique temporary key prefix and released its leases; this is not a Redis Cluster or multi-API-replica stress result.


## 9. Collaborative CMS operation proof (F1.9)

F1.9 implements a draft-only server-authoritative semantic OT path over the existing page-document v1 tree. PostgreSQL owns the accepted sequence and materialized draft; Redis is not used as an operation log or document-data relay.

| Component | Location | Responsibility |
|---|---|---|
| Semantic OT engine | `packages/collaboration/src/semantic-ot.js` | Validates the bounded operation vocabulary, transforms stale edits and applies them to a cloned page tree followed by full document validation |
| Collaboration tables | `database/migrations/0014_collaborative_document_operations.sql` | Per-document sequence/replay floor, accepted operation history and compact idempotency tombstones |
| PostgreSQL store | `packages/db/src/postgres-store.js` | Transactional document row lock, sequencing, transformation, materialization, revision/workflow/outbox update, idempotency and replay |
| REST protocol | `apps/api/src/server.js` | Authenticated operation submission and reconnect/sync |
| WebSocket protocol | `packages/realtime/src/websocket-gateway.js` | Document join/operation/leave, bounded notifications, replay delivery and per-subscription authorization |
| Browser proof | `test/e2e/collaboration.spec.js`, `test/fixtures/collaboration-client.js` | Two isolated cookie sessions using real browser WebSockets against an in-memory store adapter |

### Semantic and persistence rules

- The versioned page-document JSON tree remains canonical. There is no CRDT state or transport metadata stored in the published document.
- Supported operations are `document.set_title`, `node.insert`, `node.delete`, `node.move`, `node.set_prop`, `text.insert` and `text.delete`. Structural edits use stable node, parent and sibling IDs; moves reject cycles. Property writes are restricted by the existing widget `TYPE_PROPS` allow-list.
- Text operations address existing plain-string widget properties using Unicode code-point offsets. The semantic engine validates the full resulting page document before the store can commit it.
- PostgreSQL locks the site-scoped content row and the collaboration sequence. One transaction applies the operation and writes materialized content, an editorial revision, workflow evidence, the content outbox event, accepted operation history and the acknowledgement/idempotency result.
- Collaboration sequence, editorial `content_items.version` and aggregate `lock_version` are separate counters. Published snapshots are not mutated by draft operations.
- Accepted-operation replay is bounded to 1,000 operations per document. Compact payload-hash idempotency tombstones survive history pruning so a retry of an already committed operation is never applied twice. While its applied operation remains in the replay window, the retry returns the exact transformed acknowledgement; after pruning, the server returns the canonical current document for reload instead of an incomplete acknowledgement. A whole-document save or new draft editing generation establishes a fresh checkpoint.
- Whole-document draft saves and transitions back to draft invalidate the old operation replay generation. Operations are refused outside draft status. A cursor older than the replay floor receives a canonical reload snapshot rather than an attempted speculative transform.

### Document routes and WebSocket commands

| Transport | Method / command | Contract |
|---|---|---|
| REST | `POST /api/v1/pages/:id/collaboration/operations` | Body contains only `operation`; returns the committed sequence/version acknowledgement |
| REST | `GET /api/v1/pages/:id/collaboration/sync?afterSequence=N` | Returns accepted operations after N, or a canonical reload snapshot when history expired |
| WebSocket | `document.join` | Subscribe to one draft and reconcile from `afterSequence`; subscribes before reading sync to close the join/snapshot race |
| WebSocket | `document.operation` | Submit one operation for a joined document; acknowledgement follows the durable commit |
| WebSocket | `document.leave` | Close only the selected document subscription |

Document access requires the site's `content:edit` capability or ownership plus `content:edit:own`, a current authenticated session and a draft page. Site/principal/actor identity is derived from the authenticated session. The WebSocket gateway rechecks authorization on commands and on its heartbeat; disconnect and leave release document subscriptions. Each server connection has an unguessable origin ID so the submitting socket does not receive its own operation notification; the post-commit acknowledgement includes the transformed operation so that the sender can reconcile exactly what the server accepted. Sequence-gap recovery runs before origin-echo suppression. Frames are capped at 16 KiB and individual operation envelopes at 12 KiB. Existing message-rate and outbound-buffer limits remain in force.

WebSocket document notifications are process-local in F1.9. An operation committed through REST or WebSocket is durable regardless of fan-out status; other API replicas do not receive a live document notification in this milestone. All replicas can recover accepted operations from PostgreSQL on reconnect/sync. Redis Pub/Sub remains presence/authorization-only.

### F1.9 validation evidence recorded on 2026-10-30

- Semantic operation tests cover envelope validation, approved widget properties, insert/move/delete, cycle and deleted-target rejection, concurrent sibling insert order, property merge/last-write behavior, text range transformation, Unicode code points, overlapping delete conflicts and final document validation.
- Live PostgreSQL test-database integration validates sequencing, stale-base convergence, idempotent retry and opId misuse, tombstone behavior after replay pruning, 1,000-operation history pruning, canonical reload, site isolation, draft-only enforcement, whole-document save/restore checkpointing and revision/workflow/outbox integration.
- REST/WebSocket tests cover site/draft/capability boundaries, session-derived actor identity, 12 KiB operation and 16 KiB frame boundaries, document-topic isolation, replay-on-join, reload snapshots, authorization revocation and disconnect cleanup.
- A Playwright test with two separate cookie-authenticated Chromium contexts and actual browser WebSockets proves concurrent property edits converge; it also proves an unacknowledged accepted op can be replayed and safely retried, and that an expired replay cursor installs a canonical snapshot. The browser proof uses an in-memory store and does not access PostgreSQL.
- F1.9 remains a developer-preview correctness proof. The 2/5/10-editor load matrix, multi-instance live document fan-out/recovery under node loss, browser/proxy reconnect soak, independent security review, accessibility review, retention/backup runbooks and production operational ownership remain open. Production remains NO-GO.


## 10. Cross-instance collaborative document notifications (F1.10)

F1.10 extends the F1.9 draft-only semantic-OT path across multiple API instances. PostgreSQL remains the authoritative operation sequencer, idempotency store, accepted-operation history and canonical materialized document. Redis Pub/Sub carries only bounded, ephemeral operation notifications to connected peers on other API instances. It is not the durable operation log, acknowledgement source or recovery cursor.

### Redis document channel contract

- Each document notification is published to `<channelPrefix>:<siteId>:document:<contentId>`. The subscriber pattern is `<channelPrefix>:*:document:*`; the bridge re-parses and validates both UUIDs from the channel and envelope before dispatch.
- The version-1 JSON envelope contains only `schemaVersion`, `publisherId`, `eventId`, `siteId`, `contentId`, `topic`, `occurredAt` and the operation notification `payload`. The payload contains `kind=document.operation`, a positive per-document `sequence`, a nullable server connection-origin UUID and the validated semantic operation.
- The complete Redis envelope is bounded to 16 KiB. The operation validator independently enforces the 12 KiB operation limit. The bridge rejects unknown fields, malformed UUIDs/timestamps, channel/envelope scope mismatch and unsupported operation payloads.
- Presence/authorization ingress retains its own queue. Document ingress uses a separate bounded queue (default 1,024, configurable up to 10,000) and a dedicated drain loop, so a burst of document operations cannot starve authorization invalidations or presence refreshes. The queue is lossy by design: overflow or Redis outage is repaired by PostgreSQL sync, not by an unbounded in-memory backlog.
- The bridge suppresses a publisher's own Redis subscription echo using its private publisher UUID. The local hub receives the event before the Redis publish is attempted. A publish interruption therefore does not suppress same-instance delivery; the publisher result records `relayPublished=false` and `degraded=true`.
- The REST and WebSocket operation paths use the same injected document-publisher seam. A durable PostgreSQL commit is acknowledged even when remote Pub/Sub publication fails; the WebSocket acknowledgement exposes `fanoutDegraded`, while peers on other nodes reconcile from PostgreSQL.

### Sequence repair and origin handling

- Each WebSocket document subscription has an independently monotonic `lastSequence`. Duplicate or stale Pub/Sub hints at or below that sequence are ignored.
- A hint that skips one or more sequence numbers triggers a sync from the current last sequence before the hint is considered. The gateway sends accepted operations in PostgreSQL order and then discards an already-covered out-of-order hint.
- Each document subscription also performs a bounded PostgreSQL reconciliation on the connection heartbeat, even when no later operation arrives. One `reconcilePromise` per document subscription makes heartbeat and immediate gap recovery share a single in-flight sync rather than issuing overlapping queries. A transient sync failure reports a bounded `document.sync.degraded` notice and leaves the subscription available for the next heartbeat.
- WebSocket-originated notifications carry the server-generated connection UUID. The origin socket does not need an echo because its post-commit acknowledgement includes the exact transformed operation. A bounded 1,000-entry per-subscription opId set also prevents a sequence-gap PostgreSQL replay from repeating an operation already acknowledged to that socket. This is separate from the durable idempotency keys in PostgreSQL.
- REST-originated operations have no WebSocket connection origin and can reach any authorized live socket, including sockets on the API instance that handled the REST call.
- On reconnect or node loss, the client joins any healthy API instance with its last sequence. The API subscribes to the Redis document topic before fetching the PostgreSQL sync, closing the join/snapshot race. If the replay cursor has expired, the canonical reload snapshot is sent instead of speculative transformation.

### Observability

The bounded metric registry includes document Pub/Sub publish/message/failure/invalid/queue-overflow counters, document ingress queue gauges, bridge-ready/degraded gauges, plus WebSocket sequence-reconciliation, recovered-operation, reload-required and sync-failure counters. Labels remain fixed-name and low-cardinality; no user, site, session or document identifiers are added as metric labels.

### F1.10 validation evidence recorded on 2026-10-31

- Live loopback Redis integration: 2/2 pass using `redis://127.0.0.1:6379` only, with independent bridge/client pairs, random per-test channel prefixes, same-document cross-instance fan-out, strict site/document isolation, self-echo behavior, and an injected Redis PUBLISH failure after local delivery. The gate rejects non-loopback Redis URLs and URLs containing credentials/query/hash. No Redis database flush or key scan is performed.
- Real-browser two-node proof: 3/3 Playwright tests pass on Chrome 156.0.8078.48. Separate API servers have independent hubs/bridges, isolated cookie sessions, and a shared in-memory content store; the browser suite does not open PostgreSQL or the application's configured database.
- Scenarios include A-to-B and B-to-A delivery, cross-site/document isolation, heartbeat repair after a deliberately dropped Redis hint with no later operation, sequence-2-before-sequence-1 reconciliation, duplicate/stale hint suppression, and reconnect to the surviving API node after the first node closes.
- The 2/5/10-editor matrix passed on two API instances with no missing or duplicate peer sequence and canonical document convergence. The local harness recorded 153 peer-delivery samples with p50 1,347 ms, p95 2,575 ms and p99 2,620 ms; the dropped-hint heartbeat repair in the same harness completed in approximately 3.57 seconds with a 5-second heartbeat setting. These values are repeatable test-harness observations, not production capacity SLOs or a deployment benchmark.
- Focused real-time/collaboration suite: 63/63 pass, including 2/2 live Redis integration tests and the sender-echo sequence-gap regression. Full `npm run check`: 206/206; artifact verification checked 141 required paths and 138 JavaScript files.
- No F1.10 migration, package dependency, primary-database operation or production Redis operation was performed. The browser E2E uses in-memory content/identity fixtures; the live Redis integration uses only loopback Redis.

### Remaining production gates

F1.10 proves the notification and reconciliation behavior in a local two-process harness. It does not certify Redis Cluster topology, broker/network partitions, rolling-deploy or process-crash recovery under production load, autoscaling, durable notification delivery or operational capacity. The 2/5/10 matrix is a correctness check, not a large-scale benchmark. Still required: deployment-specific sustained/peak load and reconnect soak, Redis Cluster slot/failover and network-partition review, node-loss/rolling-deploy rehearsal with the real orchestration platform, adversarial authorization/security review, accessibility/browser review, backup/retention and alert/runbook ownership. Production remains NO-GO.



## 11. Collaboration resilience qualification (F1.11)

F1.11 adds local resilience evidence for the F1.10 collaboration path. It does not change the protocol or persistence model: PostgreSQL remains the canonical operation sequencer/history/materialized draft, while Redis Pub/Sub remains bounded, ephemeral peer notification.

### Validation scenarios and evidence recorded on 2026-10-31

- **Transient relay interruption:** a real loopback Redis bridge was configured with a one-shot fault injected into its first document `PUBLISH` call. The publisher's local hub received the operation and returned degraded status; the next publish succeeded and the bridge readiness/degraded gauges returned to ready. This validates recovery from a failed publish call while the Redis connection remains established. It does not simulate a TCP partition, client reconnect, Redis process restart or Cluster failover.
- **Sustained relay fan-out:** ten independent remote subscriptions received 2,000 sequential operations each from a second bridge through the local Redis-compatible service. All 20,000 expected deliveries arrived in strict sequence. In the combined four-test live-Redis run, the publisher run completed in 29,114 ms (about 69 publications/second); per-recipient observed delivery latency was p50 0.98 ms, p95 1.45 ms and p99 1.93 ms. Redis document ingress overflow count and slow-consumer overflow count were both zero, and the receiver document queue drained to zero. A prior isolated repeat also delivered 20,000/20,000 with zero overflows; these results are local harness measurements, not production SLOs, capacity estimates or deployment benchmarks.
- **Node-loss reconnect storm:** ten concurrent authenticated WebSocket protocol clients were established across two API instances. After 24 accepted operations were present in the shared in-memory collaboration store, API node A was closed and all ten clients reconnected concurrently to node B from sequence zero. Each client replayed sequences 1–24 in order (240 replay deliveries total); a subsequent operation was accepted as sequence 25 and reached all nine peers. The observed reconnect/replay interval was 529 ms in the final assertion-enabled rerun. This test uses the in-memory collaboration store and direct WebSocket clients; it is not a PostgreSQL failover or end-user browser UI drill.
- **Full multi-case browser rerun:** `test/e2e/collaboration-multinode.spec.js` passed **4/4** on the Windows development host with one Playwright worker. This run covered dropped-Redis-hint heartbeat repair (3,625 ms), reordered/duplicate-hint PostgreSQL reconciliation, the 2/5/10 editor matrix (153 peer-delivery samples; p50/p95/p99 1,270/2,508/2,545 ms), and the ten-editor node-loss reconnect storm (240 replay deliveries; 396 ms recovery; post-recovery sequence 25). This supersedes the earlier local combined-run page-crash observation for this test file, but does not replace a clean hosted-CI run. The historical F1.10 metrics above remain unchanged.
- **Focused regressions:** focused collaboration/realtime unit tests passed 61/61. The combined F1.10/F1.11 live-Redis integration suite passed 4/4 with zero skips using `redis://127.0.0.1:6379` only. The F1.9 two-session real-browser collaboration proof passed 1/1. Full repository `npm run check` passed 206/206 tests; artifact verification covered 141 required paths and syntax-checked 139 JavaScript files.

All live Redis scenarios used a unique random Pub/Sub prefix and loopback URL without credentials, query parameters or fragments. They performed no Redis key scans/flushes, application database access, migration, dependency changes or production operations.

### Remaining production gates

F1.11 adds local fault-recovery, sustained relay fan-out and reconnect-storm evidence only. It does not certify Redis Cluster slot behavior/failover, TCP/network partitions, broker restart, actual orchestrator node loss or rolling deployment, PostgreSQL failover, autoscaling, representative peak production load or a multi-hour soak. Still required: run the complete browser suite on clean CI infrastructure; deployment-specific sustained/peak load and reconnect soak; Redis Cluster/partition/failover review; node-loss/rolling-deploy rehearsal in the target orchestrator; independent authorization/security and accessibility reviews; backup/retention verification; and named alert/runbook ownership. Production remains NO-GO.
