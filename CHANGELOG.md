# Changelog

All notable project-level changes should be recorded here. This changelog does not imply that every listed item has been released or production-certified; CI and release-readiness evidence remain separate.

## Unreleased

### Documentation and maintainability

- Restructure the project overview around capabilities, architecture, setup, testing, security, contribution, and release-readiness navigation.
- Add task-oriented documentation for architecture, development setup, testing, security boundaries, roadmap, and release evidence.
- Document README design standards and the influence of public README examples without copying their template text.
- Add structured issue and pull-request templates to encourage reproducible reports and clear validation notes.

### Real-time and durable event foundation

- Add the bounded process-local event hub, lease-based presence service and authenticated SSE presence preview.
- Define a validated v1 durable event envelope for PostgreSQL outbox events, add migrations `0010_outbox_event_contract.sql` and `0011_outbox_legacy_classification_backfill.sql`, and carry site, actor, correlation, causation and classification metadata with stable event identity.
- Add migration `0012_durable_consumer_group_deliveries.sql` and a transport-neutral PostgreSQL delivery worker with independent consumer-group state, leased concurrent claims, per-aggregate ordering, exponential retry, dead-letter handling and bounded explicit-ID replay.
- Add migration `0013_consumer_group_event_filters.sql`; persist allow-listed event-type subscriptions so a consumer group receives only its intended event families.
- Migrate the Memgraph projection worker to `graph.projection.v1`; project content workflow state by monotonic `lock_version` aggregate sequence while retaining editorial revision `version` separately.
- Add unit/integration coverage for graph handler wiring, workflow status projection, event filters, group isolation, ordering, replay, lease recovery and actual Memgraph outage replay.
- Add Redis/Memurai-compatible shared presence leases with atomic Lua updates, per-site sorted-set indexes, hashed session keys, multi-session aggregation, hidden-state handling, capacity limits and lazy expiry callbacks.
- Add API bootstrap settings for memory or Redis presence, bounded reconnect behavior and fail-closed store errors; add live coverage proving two independent Redis clients share presence snapshots.
- Add cross-instance Redis Pub/Sub presence-refresh invalidation fan-out to authenticated SSE clients, including site validation, bounded inbound dispatch, authorization rechecks and lazy lease-expiry propagation. PostgreSQL remains the durable event source. WebSocket delivery, reconnect/replay, distributed connection quotas and production certification remain open.

### Release engineering and local validation

- Synchronize the Redis 6.3.1 dependency graph in package-lock.json; validate a fresh isolated npm ci and retain install evidence.
- Add npm run test:migrations:fresh to apply all 13 migrations to a disposable database derived only from TEST_DATABASE_URL, verify a second pass is idempotent, and drop only the generated test database.
- Add a Redis service to PostgreSQL/Memgraph CI and make the live integration runner explicitly opt into Redis tests only for a local Redis/Memurai endpoint; retain zero-skip integration evidence.
- Refresh release-readiness evidence and regenerate the CycloneDX SBOM after dependency and test-harness changes.
- Normalize SQL migration line endings before hashing/execution so Windows CRLF checkouts do not trigger false migration-drift failures; add LF/CRLF/CR regression tests.

### Security hygiene

- Replace fabricated Stripe-shaped test fixtures with clearly non-live test placeholders.
- Clean the affected local Git history and require a clean current-tree and history scan before public publication.

## 0.5.1

See the release tag and commit history for source changes associated with this baseline. Reconstruct a detailed release entry only from verified changes; do not infer release scope from test names or documentation alone.
