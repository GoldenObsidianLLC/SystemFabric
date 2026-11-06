# Production Outbox Producer Audit — 6 November 2026

> **INTERNAL MAINTAINER ARCHITECTURE AUDIT.** This inventory verifies production event-writer implementation and repository consistency. It is not an independent security assessment, deployment certification or production approval.

## Revision and result

- Audited mainline: `d2f1564cbb570e8d4e55d33b64ca5f3993c9a01a` (VirgoScorpio Hub 0.6.2).
- Hosted verification: [mainline workflow #317](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42260276430) passed all six jobs.
- Result: all production PostgreSQL outbox producer families found by repository search use the canonical event envelope for their registered domain events. No additional production direct-writer gap was found.

## Production producer inventory

| Producer | Event family | Envelope and transaction behavior |
|---|---|---|
| `packages/db/src/postgres-store.js` — `writeOutbox()` | content upsert/publish/unpublish and content lifecycle events | Persists `site_id`, optional `actor_id`, `correlation_id`, `causation_id` and `site-private` classification; content mutations write the event in the same PostgreSQL transaction as the authoritative content state change. |
| `packages/db/src/relationship-store.js` — create/delete | `relationship.upsert`, `relationship.delete` | Persists `site_id`, optional actor/correlation metadata and `site-private` classification; relationship row and event are written in the same transaction. |
| `apps/api/src/server.js` — relationship routes | `relationship.upsert`, `relationship.delete` | API route-owned transaction writes the same site-scoped envelope fields and `site-private` classification. Regression tests assert both envelopes. |
| `apps/api/src/server.js` — `writeTaxonomyOutboxEvent()` | `taxonomy.upsert`, `taxonomy.delete` | One reusable writer handles taxonomy create/update/delete, persisting `site_id`, actor, request correlation and `site-private` classification. CRUD tests assert all three event rows. |

The reviewed registry in `packages/realtime/src/event-contract.js` maps content lifecycle, relationship and taxonomy domain events to `site-private`. The graph worker subscribes to those registered event types; graph projection/rebuild logic consumes the normalized envelope rather than treating arbitrary payload JSON as authorization scope.

## Direct inserts that are intentionally not production writers

- `scripts/test-memgraph-outage.js` creates a synthetic `content.upsert` fixture with schema version 1, explicit `site_id` and `site-private` classification.
- `test/integration/memgraph.integration.test.js` creates synthetic site-scoped content projection events with schema version 1 and `site-private` classification.
- `test/integration/postgres.integration.test.js` creates `integration.noop`, `integration.poison` and delivery-lease fixtures. Those unregistered test-only event types remain `internal`; the test asserts internal classification and removes the fixtures.
- Other integration tests use synthetic/internal events to exercise delivery, ordering, worker lease and poison-event behavior. These are test fixtures, not additional product mutation paths.

## Search and contract checks

The audit searched for direct `INSERT INTO outbox_events` statements, package-level `writeOutbox()` calls and append-style producer helpers across the mainline repository. Production writes resolve to the implementation points in the table above (three logical writer families: content, relationship and taxonomy; relationship has both package and API route transaction entry points). The contract registry explicitly covers all corresponding domain event names. Test harness inserts were reviewed separately to verify they either declare a site-private scope or remain internal as expected.

## Architecture observations and follow-up

- No migration is required: `site_id`, `actor_id`, `correlation_id`, `causation_id`, `schema_version` and `classification` already exist in the outbox schema.
- Content, relationship and taxonomy writers now agree on event classification and site identity. API route writers retain the transaction ownership appropriate to their handlers; package store writers own their package transactions.
- A future maintainability improvement could move repeated canonical insert/envelope assembly into a small shared `packages/db` helper. That refactor is intentionally deferred: current writers are transaction-correct and contract-aligned, so centralization should be undertaken only with targeted tests proving transaction ownership, optional actor/correlation behavior and aggregate idempotency remain unchanged.

## Release-gate relationship

The exact-SHA local readiness report for mainline `d2f1564cbb570e8d4e55d33b64ca5f3993c9a01a` remains NO-GO: 7 PASS, 1 PARTIAL, 2 BLOCKED, 14 MISSING_EVIDENCE. One BLOCKED row is the formal current-source PostgreSQL/Memgraph artifact contract; the other is the local Windows integration runner child-process crash described in the release-gate report. The isolated Redis load file passed 2/2 (20,000/20,000 deliveries, zero overflows), and isolated tenant suites passed 13/13. Hosted workflow #317 passed the database integration job. Independent tenant-isolation issue #14 and broader security assessment issue #25 remain open.

**Disposition: producer audit complete; no additional production writer patch is currently indicated. Hub 0.6.2 remains unreleased, NOT_PRODUCTION_CERTIFIED and NO-GO for production.**
