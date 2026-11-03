# Real-Time Operations Runbook

**Status:** Internal developer-preview runbook; deployment owner and production topology are unassigned.  
**Applies to:** F1 real-time presence, SSE/WebSocket gateways, Redis relay, and collaborative document synchronization.  
**Assurance:** Operational guidance only. This document does not certify production readiness, Redis Cluster behavior, high availability, or a service-level objective (SLO).

## 1. Operating model and hard boundaries

VirgoScorpio Hub has two related but distinct data paths:

- **Presence and connection coordination:** Redis-compatible storage may hold ephemeral presence leases and shared connection-quota leases. Redis Pub/Sub carries bounded, ephemeral presence, authorization-invalidation, and collaborative-document notifications.
- **Durable collaboration:** PostgreSQL is authoritative for document content, accepted operation sequencing, replay history, idempotency, and canonical synchronization. Redis document notifications are hints, not an operation log.

A successful local test does not certify a deployment. The current F1.11 qualification is based on bounded local harnesses and loopback Redis. It does not demonstrate Redis Cluster failover, a real network partition, PostgreSQL failover, a multi-hour production soak, autoscaling, or a production orchestrator node-loss drill.

### Runtime modes

| Mode | Expected behavior | Operational implication |
|---|---|---|
| Process-local preview | Memory hub, presence, or quota state is local to one API process. | Restart loses ephemeral state. It is not a multi-instance mode. |
| Redis-backed preview | Shared leases/quotas and ephemeral Pub/Sub use the configured Redis-compatible service. | Redis availability is required for the configured shared path; store failures must not silently downgrade to process-local state. |
| Production | Requires independently reviewed distributed adapters, deployment-specific validation, monitoring, runbooks, and release approval. | The documented developer-preview implementation is not production authorization. |

When realtime is enabled in production, the API requires an injected realtime hub with authorization invalidation, a presence service, and a distributed connection-quota adapter. A distributed document publisher is also required. Redis-backed mode additionally requires a connected Redis presence service, a cross-instance realtime bridge, and a distributed quota adapter. Do not interpret successful startup as proof of adapter correctness or production readiness.

## 2. Responsibilities and escalation

The following operational roles must be assigned by the release owner before any production deployment. They are deliberately **UNASSIGNED** here; do not infer a person or team.

| Responsibility | Owner |
|---|---|
| Service/release owner and deployment approval | UNASSIGNED |
| API on-call / incident commander | UNASSIGNED |
| PostgreSQL owner | UNASSIGNED |
| Redis-compatible service owner | UNASSIGNED |
| Security and authorization escalation | UNASSIGNED |
| Backup, restore, and retention owner | UNASSIGNED |

Escalate suspected cross-site access, authorization bypass, token exposure, unexplained privilege changes, or inconsistent tenant data immediately to the security owner. Preserve relevant redacted evidence and avoid reproducing a suspected exploit against production. Do not dismiss a CodeQL finding or mark a release gate complete through operational response.

## 3. Metrics endpoint and safe collection

The API exposes request and realtime metrics at /metrics when metrics are enabled. The endpoint is bearer-protected by a dedicated metrics token. The current test contract verifies an unauthenticated request receives HTTP 401 and an authorized request receives HTTP 200.

Configuration used by the current test/runtime path:

- VIRGOSCORPIO_HUB_METRICS_ENABLED=true enables collection/serving.
- VIRGOSCORPIO_HUB_METRICS_TOKEN supplies the dedicated bearer token; production startup requires at least 32 characters when metrics are enabled.
- Scrape with the Authorization: Bearer header; never put the token in a URL, query string, dashboard label, or log.
- Keep the endpoint private to the approved monitoring network. Do not expose it publicly or reuse an application/user credential as the scrape token.
- Rotate the token through the deployment's approved secret-management process. Do not write secrets into tickets, chat, command history, or this repository.

Collection is in-process. A process restart resets its in-memory counters, gauges, and histograms. A reset is not proof that an incident cleared. Scrape each API replica independently and identify the instance through monitoring infrastructure outside the metric labels.

### Cardinality and privacy rules

The realtime metric registry has a fixed list of names and does not accept arbitrary user-defined metric names. Do not add labels containing site, tenant, principal, session, document, content, email, IP address, request ID, token, or provider identifiers. Do not log cookies, authorization headers, session tokens, invitation tokens, API keys, customer content, document operation bodies, or prompt/response bodies for troubleshooting. Prompt logging remains disabled by default.

Use request IDs for approved log correlation only after redaction and retention controls are defined. If traces are introduced later, propagate trace context without adding sensitive business identifiers or payloads. Logs/traces need access controls, redaction, retention, and deletion policy before centralized export is enabled.

## 4. Metrics catalog

The test suite compares these exact catalog entries with the fixed registry in packages/observability/src/metrics.js. Update this catalog and its test whenever the registry changes. Metric names are fixed; values below are process-local measurements, not durable records.

### Counters

<!-- METRIC-CATALOG:COUNTERS:START -->
| Metric | Interpretation |
|---|---|
| subscriptions_opened_total | Realtime subscriptions opened. |
| subscriptions_closed_total | Realtime subscriptions closed. |
| authorization_denials_total | Subscribe/operation authorization denials recorded by the realtime layer. |
| authorization_revocations_total | Local subscription revocations requested by authorization changes. |
| connection_limit_rejections_total | Connections rejected by configured limits. |
| session_expirations_total | Session-expiry events observed by realtime components. |
| events_published_total | Events accepted by the local realtime hub. |
| fanout_targets_total | Subscription targets evaluated for fan-out. |
| events_delivered_total | Events delivered to local subscribers. |
| events_revoked_total | Deliveries prevented by authorization rechecks. |
| queue_overflows_total | Local subscriber queue overflows. |
| sse_connections_opened_total | SSE connections opened. |
| sse_connections_closed_total | SSE connections closed. |
| sse_heartbeats_total | SSE heartbeat frames sent. |
| sse_backpressure_waits_total | SSE writes delayed by backpressure. |
| sse_reconnect_required_total | SSE clients told to reconnect or refresh. |
| presence_heartbeats_total | Presence lease heartbeats accepted. |
| presence_leaves_total | Presence lease removals requested. |
| presence_expiry_notifications_total | Presence lease-expiry notifications observed. |
| redis_pubsub_messages_total | Valid inbound Redis Pub/Sub messages. |
| redis_pubsub_publishes_total | Redis Pub/Sub publish attempts recorded. |
| redis_publish_failures_total | Redis Pub/Sub publish failures. |
| redis_inbound_queue_overflows_total | Presence/authorization Redis inbound queue overflows. |
| redis_reconnect_attempts_total | Redis reconnect attempts. |
| redis_errors_total | Redis bridge errors. |
| redis_invalid_messages_total | Invalid or rejected Redis messages. |
| redis_document_pubsub_publishes_total | Collaborative-document Pub/Sub publish attempts. |
| redis_document_pubsub_messages_total | Valid inbound collaborative-document notifications. |
| redis_document_publish_failures_total | Collaborative-document notification publish failures. |
| redis_document_invalid_messages_total | Invalid collaborative-document notifications. |
| redis_document_inbound_queue_overflows_total | Collaborative-document Redis ingress queue overflows. |
| document_sync_reconciliations_total | PostgreSQL synchronization/reconciliation attempts. |
| document_sync_recovered_operations_total | Operations recovered through synchronization. |
| document_sync_reload_required_total | Synchronizations requiring a canonical reload snapshot. |
| document_sync_failures_total | Document synchronization failures. |
| connection_quota_acquires_total | Shared connection-quota leases acquired. |
| connection_quota_rejections_total | Shared connection-quota acquisitions rejected. |
| connection_quota_releases_total | Shared connection-quota leases released. |
| connection_quota_renewals_total | Shared connection-quota leases renewed. |
| connection_quota_expirations_total | Connection-quota leases expired. |
| connection_quota_store_errors_total | Connection-quota store errors. |
| websocket_connections_opened_total | WebSocket connections opened. |
| websocket_connections_closed_total | WebSocket connections closed. |
| websocket_messages_received_total | WebSocket messages received. |
| websocket_message_rejections_total | WebSocket messages rejected by validation or policy. |
| websocket_backpressure_closes_total | WebSocket connections closed for backpressure. |
| websocket_pings_sent_total | WebSocket ping frames sent. |
| websocket_reconnect_required_total | WebSocket clients instructed to reconnect. |
| fanout_failures_total | Realtime fan-out failures. |
| realtime_reconnects_advised_total | Realtime reconnect advisories emitted. |
<!-- METRIC-CATALOG:COUNTERS:END -->

### Gauges

<!-- METRIC-CATALOG:GAUGES:START -->
| Metric | Interpretation |
|---|---|
| active_subscriptions | Current local hub subscriptions. |
| active_sse_connections | Current local SSE connections. |
| presence_memory_active_leases | Active process-local presence leases. |
| presence_redis_last_site_lease_count | Last observed Redis presence count for the site being queried. |
| redis_inbound_queue_size | Current presence/authorization Redis ingress queue depth. |
| redis_document_inbound_queue_size | Current collaborative-document Redis ingress queue depth. |
| active_websocket_connections | Current local WebSocket connections. |
| redis_bridge_ready | Redis bridge reports ready (1) or not ready (0). |
| redis_bridge_degraded | Redis bridge reports degraded (1) or not degraded (0). |
<!-- METRIC-CATALOG:GAUGES:END -->

### Histograms

<!-- METRIC-CATALOG:HISTOGRAMS:START -->
| Metric | Interpretation |
|---|---|
| event_lag_milliseconds | Observed event age at local delivery. |
| fanout_targets_per_event | Number of subscription targets evaluated per event. |
| presence_snapshot_lease_count | Number of leases included in a presence snapshot. |
| fanout_duration_milliseconds | Local fan-out duration. |
| redis_publish_duration_milliseconds | Redis publish duration. |
| realtime_connection_duration_milliseconds | Realtime connection lifetime. |
<!-- METRIC-CATALOG:HISTOGRAMS:END -->

Counter values are monotonic only for the lifetime of one process. Gauges are instantaneous/local and may be zero after restart. Histogram bucket counts are cumulative within each configured bucket boundary; compare like-for-like replicas and windows. Do not aggregate raw per-process gauges as if they represented one globally consistent count.

## 5. Alert design guidance

No production SLOs, alert thresholds, retention windows, or paging schedules have been approved. Establish a measured baseline in a safe test deployment before setting thresholds. Candidate alert conditions to evaluate:

| Signal | Candidate condition | Initial response |
|---|---|---|
| redis_bridge_ready / redis_bridge_degraded | Bridge remains not-ready or degraded beyond the measured recovery window. | Check Redis availability, connection errors, reconnect attempts, and queue depth. |
| Redis publish failures / queue overflows | Failure or overflow rate increases while traffic is present. | Determine whether local delivery still succeeds; assess remote fan-out and recovery lag. |
| Document sync failures | Failures persist or canonical reloads increase unexpectedly. | Check PostgreSQL availability/latency and operation history/replay-floor behavior. |
| Connection quota rejections | Sustained rejections exceed expected legitimate concurrency. | Check current quota configuration, connection churn, and possible abuse. |
| Backpressure closes / queue overflows | Sustained growth or repeated closes affect otherwise healthy clients. | Inspect slow consumers, network path, frame rates, and bounded queue settings. |
| Authorization denials/revocations | Abrupt change from established baseline, especially with reports of unexpected access. | Escalate to security; do not relax policy to restore availability. |

Avoid alerting on a single counter value without a rate/window, traffic context, replica identity, and known restart/reset behavior. Do not use the candidate conditions as an SLO or promise.

## 6. Incident runbooks

### A. Redis bridge not ready, degraded, or publish failures rising

1. Establish the affected API replica, start time, recent deploy/configuration change, and whether the path is presence, authorization invalidation, or document notification.
2. Inspect redis_bridge_ready, redis_bridge_degraded, Redis error/reconnect counters, publish-failure counters, invalid-message counters, and both ingress queue gauges.
3. Verify the Redis endpoint is the intended private service and that network/TLS/authentication configuration is valid. Never print credentials or include a credential-bearing URL in evidence.
4. Separate local from remote behavior. The publisher's local hub receives the event before attempting Redis publish; a Redis publish failure can therefore preserve same-instance delivery while remote replicas miss the hint.
5. For document collaboration, rely on the PostgreSQL sync/reconciliation path after connectivity returns. Check document sync failures/recoveries and confirm the client's canonical sequence using the authorized application path. Do not replay arbitrary Redis messages or treat Pub/Sub as a durable log.
6. For authorization invalidation, remember that remote Pub/Sub is best-effort. Periodic session/capability reauthorization is a fallback, not proof of instantaneous cluster-wide revocation during a partition. Escalate any suspected cross-site or privilege exposure to security.
7. Restore service only through the deployment owner's approved change procedure. After recovery, verify bridge readiness, queue drainage, and successful sync/authorization behavior. Preserve redacted before/after evidence.

Do not flush Redis, scan keys, edit leases manually, change channel prefixes, or run an ad-hoc publish against a shared service during triage.

### B. Presence appears stale or inconsistent

1. Determine whether the API is using process-local memory or Redis-backed presence. Compare the actual effective configuration with the expected mode.
2. Inspect heartbeat/leave/expiry counters, the active lease gauge appropriate to the selected adapter, presence snapshot histogram, and Redis errors/queue signals.
3. Check the configured lease and expiry-retention bounds and whether authenticated clients continue sending heartbeats.
4. Expiry callbacks are lazy: expired lease metadata is observed and notified when a site read/heartbeat sweeps it. Do not assume a background expiry scheduler exists.
5. Check for hidden availability state and multiple sessions per principal; one session leaving must not imply that every session is offline.
6. Avoid manually editing presence keys. A controlled client reconnect/heartbeat is preferable after the underlying cause is understood.

### C. SSE/WebSocket connection rejection, queue overflow, or backpressure

1. Identify whether the issue affects SSE, WebSocket, or both; they share the connection limiter.
2. Inspect active connection gauges, quota acquire/reject/release/renewal/expiry/store-error counters, connection-limit rejections, message rejections, backpressure closes, and queue overflows.
3. Check configured global/site/principal quotas, lease duration, proxy idle timeouts, client retry behavior, and observed connection churn. Compare configuration with the approved preview scope; do not increase limits blindly.
4. For slow consumers, retain bounded queues and allow the connection to close/reconnect rather than removing limits or allowing unbounded buffering.
5. Confirm disconnect/shutdown cleanup releases quota leases; expired leases are the crash-recovery safety net, not a substitute for healthy cleanup.
6. If rejection spikes are unexplained or appear targeted, escalate to security and retain redacted request/metric evidence.

### D. Collaborative documents do not converge after reconnect

1. Treat PostgreSQL as the canonical source. Redis notifications are lossy hints; duplicate, reordered, or dropped hints should be repaired through PostgreSQL sync/reconciliation.
2. Inspect document reconciliation, recovered-operation, reload-required, sync-failure counters and the document ingress queue.
3. Verify the affected user still has the required site capability and access to the draft. Do not bypass authorization or widen document topics to restore a connection.
4. Let the client perform the supported sync/join flow. If its replay cursor predates the retention floor, the supported outcome is a canonical reload snapshot, not speculative replay.
5. If the database path is unavailable, stop treating the live collaborative session as reliable. Do not use an in-memory or Redis payload as a substitute durable record.
6. Preserve redacted sequence/error evidence and escalate repeated data divergence to the collaboration and database owners. Do not manually edit operation history or idempotency tombstones.

## 7. Change, restart, and recovery discipline

- No production restart, failover, configuration change, migration, queue replay, or Redis mutation is authorized by this runbook alone.
- Before a planned change, record the exact application revision, adapter mode, dependency versions, approved topology, backup/restore checkpoint, operator, rollback path, and expected client impact.
- Confirm whether the process-local state will be lost. Redis-backed presence/quota leases expire, but that does not make every in-flight request or notification durable.
- After a restart, verify readiness, metrics token protection, bridge health, authorized presence snapshots, document sync, outbox/graph projection health, and the rollback decision.
- Database migrations are separate controlled changes. F1.9 collaboration uses migration 0014; F1.1–F1.4 durable-event and delivery work uses migrations 0010–0013. Do not apply migrations as an incident workaround.
- Test restoration in an isolated environment. Do not claim recovery until PostgreSQL, graph projections, and in-scope object storage have passed integrity checks.

## 8. Known gaps and production exit criteria

This runbook does not close any production gate. At minimum, the following remain required for the real-time subsystem:

- Named release/on-call, database, Redis, security, backup, and alert owners.
- Approved deployment topology, supported proxy/browser matrix, secret rotation, retention, and monitoring network/access policy.
- Distributed traces and centralized redacted logs with approved access, redaction, retention, and deletion controls.
- Redis Cluster slot/failover and network-partition qualification, including actual process restart and orchestrator node-loss/rolling-deploy drills.
- PostgreSQL failover, concurrency, recovery, and backup/restore rehearsal with measured RPO/RTO.
- Deployment-specific load/soak, reconnect storms, resource exhaustion, and capacity baselines.
- Independent tenant/site authorization and WebSocket/origin/security review, plus accessibility/browser acceptance.
- Release-owner approval against the exact candidate SHA and all applicable release evidence.

Until these are completed and accepted, keep VirgoScorpio Hub 0.5.1 at **NOT_PRODUCTION_CERTIFIED / NO-GO**. Keep realtime features disabled or limited to the reviewed isolated developer-preview environment.
