# Changelog

All notable project-level changes should be recorded here. This changelog does not imply that every listed item has been released or production-certified; CI and release-readiness evidence remain separate.

## Unreleased

### CI and request security

- Serialize live integration test files that share the dedicated PostgreSQL database and graph fixture, preventing cross-suite outbox/event cleanup races from making the Memgraph consumer-group test flaky.
- Separate explicitly authenticated bearer sessions from cookie sessions; cookie-authenticated writes always undergo same-origin and CSRF validation even when an invalid bearer header is also supplied.
- Pin CI runners to Ubuntu 24.04 and use full-commit SHA pins for current Node.js 24-compatible checkout, setup-node, and artifact-upload actions.

### Documentation and maintainability

- Restructure the project overview around capabilities, architecture, setup, testing, security, contribution, and release-readiness navigation.
- Add task-oriented documentation for architecture, development setup, testing, security boundaries, roadmap, and release evidence.
- Document README design standards and the influence of public README examples without copying their template text.
- Add structured issue and pull-request templates to encourage reproducible reports and clear validation notes.

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
