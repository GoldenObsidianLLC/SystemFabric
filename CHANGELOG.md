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

### Release engineering and local validation

- Synchronize the Redis 6.3.1 dependency graph in package-lock.json; validate a fresh isolated npm ci and retain install evidence.
- Add npm run test:migrations:fresh to apply all 13 migrations to a disposable database derived only from TEST_DATABASE_URL, verify a second pass is idempotent, and drop only the generated test database.
- Add a Redis service to PostgreSQL/Memgraph CI and make the live integration runner explicitly opt into Redis tests only for a local Redis/Memurai endpoint; retain zero-skip integration evidence.
- Pin the CI Memgraph loopback port for the outage/restart test so the service remains reachable after Docker restarts its fixed-port container.
- Refresh release-readiness evidence and regenerate the CycloneDX SBOM after dependency and test-harness changes.
- Normalize SQL migration line endings before hashing/execution so Windows CRLF checkouts do not trigger false migration-drift failures; add LF/CRLF/CR regression tests.

### Security hygiene

- Replace fabricated Stripe-shaped test fixtures with clearly non-live test placeholders.
- Clean the affected local Git history and require a clean current-tree and history scan before public publication.

## 0.5.1

See the release tag and commit history for source changes associated with this baseline. Reconstruct a detailed release entry only from verified changes; do not infer release scope from test names or documentation alone.
