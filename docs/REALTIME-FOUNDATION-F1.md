# Real-Time Foundation 1: Presence Preview

**Status:** Implemented developer-preview foundation; not production-certified
**Branch:** `feature/realtime-foundation-f1`
**Baseline:** SystemFabric 0.5.1
**Scope:** Foundation 1 process-local event fan-out, lease-based presence and authenticated presence SSE; Foundation 1.1 canonical durable event contract; Foundation 1.2 PostgreSQL consumer-group delivery ledger; Foundation 1.3 shared Redis presence leases; Foundation 1.4 cross-instance Redis Pub/Sub invalidation fan-out.

This developer-preview track creates reusable seams for SystemFabric while keeping transport and storage adapters replaceable. PostgreSQL remains the durable per-consumer-group event source. Redis provides shared ephemeral presence leases and a Pub/Sub bridge for site-scoped refresh invalidations to connected SSE clients; this is not a durable event broker, collaborative editing protocol or production-certified multi-replica gateway.

## 1. Implemented components

| Component | Location | Responsibility |
|---|---|---|
| Event hub | `packages/realtime/src/event-hub.js` | Site/topic-scoped fan-out, async subscriptions, bounded queues, authorization checks |
| Presence service | `packages/realtime/src/presence.js` | Session leases, heartbeat renewal, multi-session aggregation, hidden-state filtering |
| SSE gateway | `packages/realtime/src/sse-gateway.js` | SSE framing, keepalive, backpressure handling and disconnect cleanup |
| Package exports | `packages/realtime/src/index.js` | Stable module entry point |
| API integration | `apps/api/src/server.js` | Authenticated site-scoped preview endpoints |
| Tests | `test/realtime.test.js` | Isolation, authorization revocation, queue limits, lease expiry and API/SSE behavior |

## 2. Enable the preview

Set this in a local development environment only:

```dotenv
SYSTEMFABRIC_REALTIME_ENABLED=true
```

The default is `false`. The current built-in event hub and presence adapter are process-local and lose all state when the API process exits. They do not coordinate multiple API instances.

**Do not enable the built-in preview adapter in production.** When `NODE_ENV=production` and the flag is enabled, the API requires both a caller-injected event hub and presence service. Production use still requires independently reviewed distributed adapters, shared authorization semantics, capacity controls, telemetry, and operational testing.

## 3. Preview API

All routes require the existing bearer-token or authenticated-session mechanism and the site's `content:read` capability. The development token path is only available outside production.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/sites/:siteId/presence/heartbeat` | Renew the current authenticated session's lease |
| `DELETE` | `/api/v1/sites/:siteId/presence/heartbeat` | Remove the current session's lease |
| `GET` | `/api/v1/sites/:siteId/presence` | List visible site presence |
| `GET` | `/api/v1/sites/:siteId/realtime/events?topic=presence` | Subscribe to presence refresh events over SSE |

Heartbeat accepts only a JSON object containing optional `availability`: `active`, `idle`, `away`, or `hidden`. The server derives principal and session identifiers from authentication; clients cannot choose another user's identity or session.

SSE events intentionally carry only a `presence.refresh` hint. Clients fetch the authorized presence snapshot over the REST endpoint rather than receiving a broadcast of user/session details. This keeps ephemeral presence payloads small and reduces unnecessary disclosure.

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
- **No document collaboration:** presence is not a CRDT/OT editing protocol and must not be used as one.
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

Redis presence and Pub/Sub are not authorization boundaries. Each API request authenticates its actor and checks site capability; each receiving hub rechecks every local subscription before delivery. Pub/Sub contains no principal/session data and is not a durable event source. Per-site session capacity does not replace API rate limits, distributed connection quotas or abuse controls. There is no scheduled expiry sweeper, SSE replay cursor, WebSocket transport, distributed connection counter or production certification.

## 8. Cross-instance Pub/Sub Fan-out (F1.4)

F1.4 adds Redis Pub/Sub for immediate, ephemeral site-scoped presence invalidation between API instances. The PostgreSQL outbox and consumer-group delivery ledger remain the durable event source; Pub/Sub is intentionally not used for durable business events.

| Component | Location | Responsibility |
|---|---|---|
| Redis realtime bridge | `packages/realtime/src/redis-realtime.js` | Separate publisher/subscriber clients, site-scoped channels, envelope validation and bounded inbound dispatch |
| API wiring | `apps/api/src/server.js` | Routes heartbeat/leave invalidations through the bridge; waits for subscription readiness and closes the bridge on shutdown |
| Expiry propagation | Redis presence `onExpired` callback | Publishes the same invalidation when a site read/heartbeat lazily discovers an expired lease |
| Tests | `test/redis-realtime.test.js`, `test/integration/redis-presence.integration.test.js` | Fake-broker fan-out contracts and live two-API SSE, site-isolation and expiry tests |

### Publish and receive behavior

- Each API instance owns independent Redis publisher and pattern-subscriber clients. The subscriber listens for channels shaped as `systemfabric:realtime:v1:<site-uuid>:presence`; channel names contain no principal or session identifiers.
- The only accepted payload is `{ "kind": "presence.refresh" }`. The bounded v1 envelope includes a UUID event ID, publisher instance ID, site ID, topic and timestamp. The inbound message limit is 4 KiB by default; the dispatch queue is capped at 1,024 messages.
- A publisher emits to Redis, then delivers the same event to its local hub. Its own Pub/Sub echo is ignored. Other instances validate the channel/envelope and forward the invalidation to their local hub.
- The local hub still performs a fresh authorization check for every matching SSE subscription before enqueueing. Redis Pub/Sub subscription itself never grants a user access to a site.
- The existing heartbeat rate limit, per-principal SSE connection cap and bounded per-subscription queue remain in force. Broker reconnects use bounded retry settings; clients must refetch the authorized presence snapshot after receiving an invalidation.
- If Redis publish fails, the API returns an unavailable error rather than silently claiming the cross-instance notification was sent. Redis presence and Pub/Sub remain fail-closed when selected.

### Deliberate boundaries

Pub/Sub is best-effort, at-most-once notification transport. It has no durable history, acknowledgement, replay cursor or exactly-once guarantee. A client that disconnects during a publication must reconnect and fetch a fresh snapshot; event replay is not implemented. Expiry notification is lazy: it is propagated when a request sweeps an expired site index, not at the exact TTL instant, and there is no global expiry scheduler. WebSocket transport, distributed connection quotas, relay metrics/alerts, load/soak testing and production certification remain open. The standalone API entry point still refuses production real-time startup.

## 9. Validation


Run from the repository root:

```bash
node --check packages/realtime/src/event-hub.js
node --check packages/realtime/src/presence.js
node --check packages/realtime/src/sse-gateway.js
node --check packages/realtime/src/event-contract.js
node --check packages/realtime/src/redis-presence.js
node --check packages/realtime/src/redis-realtime.js
node --check packages/db/src/outbox-worker.js
node --check packages/db/src/outbox-delivery.js
node --check packages/graph/src/memgraph-store.js
node --check apps/worker/src/outbox-worker.js
node --check apps/api/src/server.js
node --test test/outbox-contract.test.js test/outbox-delivery.test.js test/graph-projection-worker.test.js test/memgraph-projector.test.js test/redis-presence.test.js test/redis-realtime.test.js test/realtime.test.js test/api.test.js
npm run check
```

The focused real-time, outbox-contract, outbox-delivery, graph-projection-worker, Memgraph-projector, Redis-presence and API suites cover local behavior. Run PostgreSQL and Memgraph live integration against the dedicated test database after migrations 0010–0013. Run the Redis integration against an isolated Redis/Memurai instance with `SYSTEMFABRIC_RUN_REDIS_INTEGRATION=true` and `SYSTEMFABRIC_PRESENCE_REDIS_URL` set. The live Redis test creates two Redis clients and two API server instances to verify cross-instance snapshot reads; it does not test cross-instance SSE pushes. Run `npm run test:graph:rebuild` and `scripts/test-memgraph-outage.js` for graph rebuild and interrupted-dependency recovery checks. Browser E2E, load/soak and production security suites remain separate gates and should be run where their prerequisites are available.

For PowerShell, run the live Redis integration with:

```powershell
$env:SYSTEMFABRIC_RUN_REDIS_INTEGRATION = 'true'
$env:SYSTEMFABRIC_PRESENCE_REDIS_URL = 'redis://127.0.0.1:6379'
node --test test/integration/redis-presence.integration.test.js
```

### Local evidence recorded on 2026-10-30

- `npm run check`: PASS — artifact check recognized **139 required paths**; **119 JavaScript files** syntax-checked; **147 tests passed, 0 failed, 0 skipped** (Node.js 26.12.1).
- PostgreSQL migrations: PASS — migrations `0010_outbox_event_contract.sql`, `0011_outbox_legacy_classification_backfill.sql`, `0012_durable_consumer_group_deliveries.sql` and `0013_consumer_group_event_filters.sql` applied to the dedicated `TEST_DATABASE_URL` database. Migrations 0001–0009 were already recorded as applied there.
- PostgreSQL + Memgraph live integration: PASS — **9 passed, 0 failed, 0 skipped** across `test/integration/postgres.integration.test.js` and `test/integration/memgraph.integration.test.js` against the dedicated test database and local Memgraph service. Coverage includes content/outbox metadata, consumer-group concurrency and isolation, aggregate-order blocking, replay, expired lease recovery, live graph projection ordering and stale workflow-event replay protection.
- Graph rebuild live test: PASS — `npm run test:graph:rebuild`; canonical content, taxonomy and relationships rebuilt, deletion/tombstone state preserved, stale graph nodes removed, safety limit preserved existing graph state, and a second rebuild produced the same summary.
- Memgraph outage/recovery test: PASS — `scripts/test-memgraph-outage.js` stopped the isolated test graph, verified the persisted delivery returned to pending with its lease released, restarted Memgraph, replayed the event through `graph.projection.v1`, verified the projection and confirmed it was not delivered again. The temporary test container was removed.
- Redis/Memurai integration: PASS — **3 passed, 0 failed, 0 skipped**. Live coverage includes two separate Redis bridge pairs/API servers, heartbeat-to-SSE fan-out across instances, isolation between sites, and a presence snapshot that lazily observes expiry and propagates refresh to the remote stream. The lower-level service test also covers multi-session aggregation, hidden-state filtering, cross-instance leave visibility and capacity. The live integration also confirms two independent API servers share presence state.
- `git diff --check`: PASS. Git reported expected LF-to-CRLF working-copy conversion warnings; no whitespace errors were found.

These results are local development evidence, not a production rollout. Migrations 0010–0013 have **not** been applied to the primary `DATABASE_URL` database. Before deploying the new worker code to any environment, stop existing graph workers, apply and verify all four migrations against that environment, then start the new worker version. Redis Pub/Sub now provides cross-instance SSE invalidation, but durable external broker selection, WebSocket delivery, reconnect/replay cursors, distributed connection quotas, browser E2E, load/soak and production security validation remain outstanding. Presence refresh and lazily observed expiry are propagated to connected replicas on a best-effort basis.

## 10. Next engineering slices

1. **F1.5 — Authorization invalidation:** permission-change events, subscription revocation propagation, session expiry and long-lived connection policy.
2. **F1.6 — Observability:** active connections, fan-out, event lag, queue overflow, lease counts, reconnects, expiry notifications and authorization denials.
3. **F1.7 — Collaborative CMS spike:** evaluate CRDT and operational transformation against SystemFabric's versioned page-document schema before selecting an editing protocol.
4. **F1.8 — Distributed controls and recovery:** connection quotas, relay failure drills, fan-out telemetry and bounded reconnect/resume behavior.
5. **Projection operations:** validate consumer-group lag, dead letters, replay and recovery under the target deployment topology.


Do not promote the preview adapter to production or mark collaborative CMS as implemented until the relevant distributed, security, recovery and browser evidence exists.
