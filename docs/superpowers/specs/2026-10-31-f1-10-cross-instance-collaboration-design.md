# F1.10 Design — Cross-instance collaborative document delivery and recovery

**Date:** 2026-10-31
**Status:** Proposed design for approval
**Base:** F1.9 commit `3e60ebb`
**Scope:** Extend realtime fan-out across API instances without changing the PostgreSQL-authoritative collaboration model.

## 1. Inten

F1.9 proves semantic OT and collaborative draft persistence, but document notifications currently stop at the local process event hub. A browser connected to API instance A does not receive an edit committed through API instance B until it reconnects or a later local event triggers another sync.

F1.10 closes that gap for the developer-preview collaboration path. API instances will relay bounded document-operation notifications through the existing Redis realtime bridge. Each instance still commits operations through PostgreSQL and uses the per-document collaboration sequence to reconcile notifications, detect gaps and recover missed messages.

Redis Pub/Sub is a best-effort wake-up channel, not an operation log, acknowledgement source or source of truth. PostgreSQL remains authoritative.

## 2. Goals

- Deliver a committed draft operation to authorized WebSocket subscribers connected to other API instances.
- Preserve site and document isolation, session-bound authorization and the server-generated origin connection ID.
- Keep presence and authorization invalidation contracts unchanged.
- Validate document channel, envelope, operation schema, sequence and size before forwarding a message to the local hub.
- Bound document ingress independently from presence/authorization ingress so high-volume document updates cannot starve authorization invalidations.
- Recover from out-of-order, duplicate, dropped or missed Redis notifications by reconciling against `getCollaborationSync` and its PostgreSQL sequence.
- Keep edit acknowledgement independent of Redis publish success; a failed relay must not make a committed operation look uncommitted.
- Prove delivery across two API instances and verify 2/5/10-editor fan-out, reconnect and node-loss recovery in a deterministic test harness.
- Add bounded, low-cardinality metrics for relay health and document recovery.

## 3. Non-goals

- Redis Streams, a Redis-backed operation log, CRDT/offline multi-master editing or a change to the F1.9 semantic OT rules.
- Replacing PostgreSQL operation sequencing, revisions, workflow evidence or outbox updates.
- Cross-instance presence/cursor data design; presence continues to use its existing channel.
- Production certification. Independent security review, broader soak/load testing, backup/retention runbooks, operational ownership and the remaining release gates continue after F1.10.
- Publishing document operations through the general domain-event outbox as a second realtime transport.

## 4. Current behavior and constrain

- `packages/realtime/src/redis-realtime.js` currently subscribes to site-scoped presence refreshes and authorization invalidations only. Its `publish` method accepts only `topic === 'presence'` and strips the payload to the exact presence-refresh shape.
- `apps/api/src/server.js` publishes REST collaboration commits directly to `realtimeHub.publish`.
- `packages/realtime/src/websocket-gateway.js` publishes WebSocket collaboration commits directly to the same process-local hub.
- The bridge already owns separate Redis publisher/subscriber clients, bounded ingress, publisher IDs, local-first publication, failure metrics and lifecycle cleanup.
- `packages/db/src/postgres-store.js` exposes a one-statement consistent `getCollaborationSync` snapshot with the canonical sequence, replay floor, operations and reload response.
- Each document WebSocket subscription already tracks `lastSequence`, performs a sync when it observes a sequence gap, and deduplicates notifications by sequence.

The smallest useful seam is therefore a document-specific publication method on the existing Redis bridge plus a shared publisher adapter injected into both REST and WebSocket paths.

## 5. Approaches

### A. Extend the existing Redis bridge with a separate document channel family — recommended

Reuse the existing Redis clients and lifecycle but introduce a separate document pattern, validator, message-size ceiling, inbound queue and metrics. Keep the presence and authorization envelope validators exact and unchanged.

**Trade-off:** Document text/content passes through the secured Redis channel and process memory. The existing bridge remains one availability boundary, but document traffic cannot consume presence/authorization queue capacity.

### B. Add a dedicated Redis document bridge

Create a separate service with its own Redis clients, credentials, queues, health and shutdown lifecycle.

**Trade-off:** Better isolation of credentials and resource budgets, but twice the connections and operational configuration. This is more appropriate if the deployment later requires distinct Redis ACL identities or independent scaling.

### C. Use a PostgreSQL-driven polling/outbox relay for every notification

Poll a durable operation source and fan out through a worker.

**Trade-off:** Durable notification delivery is attractive, but it duplicates the already-authoritative operation log and adds worker latency/complexity. PostgreSQL sync already provides the required repair path.

**Decision:** Use A. Keep the transport ephemeral and the state durable in PostgreSQL. Revisit B if security/operations requires a separate Redis principal or independent resource budget. Do not add C in parallel.

## 6. Redis document channel and envelope

### Channel

`<channelPrefix>:<siteId>:document:<contentId>`

Pattern subscription:

`<channelPrefix>:*:document:*`

Both UUIDs are normalized to lowercase and validated before the publisher constructs a channel. The subscriber parses the channel segments and verifies that the envelope's site and content IDs exactly match the channel selectors.

### Version-1 envelope

```json
{
  "schemaVersion": 1,
  "publisherId": "server-generated-uuid",
  "eventId": "server-generated-uuid",
  "siteId": "site-uuid",
  "contentId": "page-uuid",
  "topic": "document",
  "occurredAt": "2026-10-31T00:00:00.000Z",
  "payload": {
    "kind": "document.operation",
    "sequence": 42,
    "originConnectionId": "server-generated-websocket-uuid-or-null",
    "operation": {
      "schemaVersion": 1,
      "opId": "operation-uuid",
      "clientId": "bounded-client-id",
      "baseSequence": 40,
      "type": "document.set_title",
      "payload": { "title": "Updated title" }
    }
  }
}
```

The actual envelope is strict: unknown top-level/payload keys are rejected; all UUIDs and timestamps are validated; sequence must be a positive safe integer; `originConnectionId` is null or a UUID; and the operation must pass the existing `validateCollaborationOperation` validator. The subscriber checks exact topic, payload kind, channel/site/content equality and the same schema before calling `hub.publish` on `document:<contentId>`.

No bearer token, session token, actor ID, email, membership, presence record, database row or arbitrary page snapshot is sent. The only page data relayed is the accepted operation, already bounded by the F1.9 operation envelope (12 KiB).

### Limits and isolation

- Preserve the existing presence/authorization message ceiling (4 KiB by default) and their current inbound queue.
- Add a document envelope ceiling of 16 KiB, never above the F1.8 WebSocket frame ceiling.
- Add an independent bounded document inbound queue (default 1,024 messages, configurable only through a validated constructor option, maximum 10,000).
- On document queue overflow, increment a fixed-name metric and drop the hint. Do not block the Redis callback, grow memory, close unrelated presence/authorization subscriptions or change the PostgreSQL commit result.
- Do not log serialized envelopes or operation text. Logs contain only bounded error codes, site/document UUID selectors where operationally necessary, and counters.
- The Redis channel prefix is shared with the existing bridge. Deployment documentation must include the additional `:<siteId>:document:<contentId>` channel family in Redis ACL/network policy review. TLS and restricted Redis credentials remain environment/deployment responsibilities.

## 7. Publication and acknowledgement behavior

Add `publishDocumentOperation({ siteId, contentId, sequence, originConnectionId, operation })` (or an equivalently explicit bridge method) to the realtime bridge.

1. Validate site, content, sequence, origin ID and operation before local or remote publication.
2. Publish to the local hub first using topic `document:<contentId>`, preserving sequence, origin ID and accepted operation.
3. Publish the exact versioned envelope to the document Redis channel.
4. Return the local hub counts plus `relayPublished` and `degraded` flags. A Redis publish error is reported/metriced and returned as degraded; it must not throw after a successful PostgreSQL commit.
5. The bridge subscriber ignores envelopes whose `publisherId` is its own instance ID (the local hub has already received them). Other instances publish the validated event to their own local hub; the WebSocket gateway reauthorizes subscriptions before enqueue/delivery.
6. REST writes and WebSocket writes both use the injected document publisher. Without a Redis bridge, development/test mode uses the local hub adapter as today.
7. WebSocket acknowledgements still follow the PostgreSQL commit and carry the server-transformed operation. Include `fanoutDegraded` when Redis publication fails. A local/remote fan-out issue must never change operation idempotency or the acknowledgement's durable sequence.

## 8. Ordering, duplicate suppression and recovery

Redis Pub/Sub is unordered across concurrent publishers and does not replay while a subscriber is disconnected. The per-document PostgreSQL sequence remains the ordering authority.

- The gateway delivers only strictly increasing sequence numbers to a joined socket.
- If a notification sequence is greater than `lastSequence + 1`, call `getCollaborationSync(afterSequence=lastSequence)` and deliver the missing accepted operations in database sequence order before considering the notification.
- Duplicates and stale notifications are ignored after reconciliation.
- Keep the server-generated `originConnectionId` unchanged end-to-end. A socket suppresses its own echo only after sequence-gap recovery; its acknowledgement contains the transformed operation so it can reconcile itself.
- On every existing WebSocket heartbeat, after session and document authorization rechecks, reconcile each active document subscription from PostgreSQL. This catches a notification lost during a transient publisher/subscriber partition even when no later operation arrives. It reuses the existing bounded heartbeat rather than creating a second timer per document. Reconciliation is single-flight per document subscription; overlapping heartbeat ticks and Pub/Sub gap-recovery requests share the in-flight sync instead of issuing unbounded duplicate queries.
- If the replay floor has advanced, send the existing canonical `document.reload` response; never guess or partially apply stale state.
- If a socket reconnects to another API instance, `document.join` subscribes before reading `getCollaborationSync`, replaying retained operations or delivering the canonical reload snapshot.

The heartbeat reconciliation bounds stale connected clients by the configured WebSocket heartbeat interval plus the database sync time. The load matrix records the extra sync-query cost. If the cost is unacceptable, a later design may introduce a more targeted recovery signal, but not at the expense of eventual convergence.

## 9. Failure policy

| Failure | Required behavior |
|---|---|
| Redis publish throws after PostgreSQL commit | Keep the successful operation acknowledgement; return `fanoutDegraded=true`; record relay failure; local subscribers still receive the operation |
| Redis subscriber disconnects/reconnects and loses messages | Heartbeat sync catches up from PostgreSQL; sequence gaps also trigger immediate sync |
| Duplicate or out-of-order Pub/Sub messages | Monotonic sequence guard and PostgreSQL sync prevent duplicate/stale application |
| Document ingress queue reaches its cap | Drop notification, increment overflow metric; heartbeat/reconnect sync repairs it |
| Invalid/mismatched channel or envelope | Reject before hub publish; increment invalid-message metric |
| Slow WebSocket consumer | Existing bounded queue/backpressure closes it; reconnect/sync restores canonical state |
| API instance exits | Its sockets close; clients reconnect to another instance and use PostgreSQL sequence/replay |
| PostgreSQL sync is unavailable | Do not apply uncertain state; send a bounded `document.sync.degraded` signal and retry on the next heartbeat, without closing unrelated presence subscriptions; repeated transport failure may close only the document subscription and require rejoin |

## 10. Metrics

Add only fixed-name, low-cardinality metrics, with no operation IDs, content IDs, site IDs or user IDs as labels:

- `redis_document_pubsub_publishes_total`
- `redis_document_pubsub_messages_total`
- `redis_document_publish_failures_total`
- `redis_document_invalid_messages_total`
- `redis_document_inbound_queue_size`
- `redis_document_inbound_queue_overflows_total`
- `document_sync_reconciliations_total`
- `document_sync_recovered_operations_total`
- `document_sync_reload_required_total`
- `document_sync_failures_total`

Metric failures remain isolated from publication and WebSocket paths.

## 11. Verification plan

- Validator tests: invalid UUID/site/content mismatch, unknown envelope keys, malformed timestamps, invalid or oversized operation, invalid sequence/origin, invalid channel pattern and over-limit encoded envelope.
- Redis bridge tests using two independent clients/hubs: document channel fan-out, strict same-site/same-document routing, no cross-site/document delivery, no self-echo, independent inbound-queue limits, malformed-envelope rejection, local-first success and degraded publish behavior.
- Gateway tests: out-of-order sequences, duplicates, missing notification repaired on heartbeat, gap repaired immediately, reload after replay-floor expiration, authorization remains checked, sender echo suppression still uses server-generated connection ID, single-flight heartbeat/gap reconciliation and transient PostgreSQL sync failure isolation.
- API tests: REST and WebSocket both route through the shared document publisher and preserve committed acknowledgements when Redis is unavailable.
- Multi-instance Playwright proof: two separate API server instances, two browser contexts/sessions and actual WebSockets. Prove A-to-B and B-to-A updates, operation order, same-document only, lost Pub/Sub notification repaired while sockets remain connected, and reconnect from a replacement API instance restores state.
- 2/5/10-editor matrix distributed across two API instances: no missing accepted sequence after reconciliation, no duplicate sequence delivered to a socket, bounded queue sizes, no unhandled errors, and record p50/p95/p99 operation-to-peer-delivery and heartbeat reconciliation latency. The matrix is a correctness/resource baseline, not a production capacity certification.
- Run the suite against an approved local Redis endpoint with `SYSTEMFABRIC_RUN_REDIS_INTEGRATION=true`. Use fake Redis for deterministic failure injection. Do not modify or migrate any primary database.
- Run `npm run check`, focused Redis/API/WebSocket tests, multi-instance browser proof and `git diff --check`.

## 12. Release gates left open after F1.10

F1.10 can prove cross-instance correctness under the stated test matrix. Production remains NO-GO until a larger deployment-specific load/soak, Redis partition/cluster/failover review, node-loss and rolling-deploy rehearsal, independent security review, accessibility review, backup/retention runbooks, alert thresholds and operational ownership are approved.
