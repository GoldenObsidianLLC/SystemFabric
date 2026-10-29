# PostgreSQL and Memgraph Live Integration Evidence

**Technical gate result: PASSED**  
**SystemFabric commit:** `4653c84f21e9652affeebbb36f5803cd7354d397`  
**GitHub Actions run:** [SystemFabric CI #14 — successful](https://github.com/GoldenObsidianLLC/SystemFabric/actions/runs/40949007893)  
**Integration job ID:** `123711815754`  
**Evidence generated from CI:** `2026-10-29T20:27:54Z`

## Environment

- GitHub-hosted Ubuntu runner.
- Node.js `22.23.4`.
- PostgreSQL `18-alpine`, with isolated `systemfabric_test` integration database.
- Memgraph `memgraph/memgraph:3.13.1` service for the live integration and outage/replay test.
- A separate temporary Memgraph container for the graph rebuild test.
- The CI run used isolated test resources and fixture credentials; it did not validate a production deployment or external identity, cloud-storage, or payment-provider account.

## Verified results

1. **Fresh migration run:** The live integration job applied migrations `0001` through `0009` to its isolated test database; the migration runner reported success for `0009_fix_content_item_slug_constraint.sql`.
2. **Supported upgrade fixture:** The integration suite upgraded a disposable database at schema version `0008` to migration `0009`, preserving existing content and checking accepted/rejected slug constraints.
3. **Live PostgreSQL/Memgraph/product tests:** `npm run test:integration:live` completed **8 tests, 8 passed, 0 failed, 0 skipped**.
4. **PostgreSQL correctness:** Integration coverage exercised site-scoped content reads, transaction rollback, concurrent outbox workers, poison-event dead-lettering, and transient projection failure/retry.
5. **Real Memgraph outage/recovery:** The test stopped and restarted the identified Memgraph test container, verified the persisted outbox event remained recoverable, replayed successfully after restart, and verified an already-processed event was not replayed again.
6. **Canonical graph projection rebuild:** The test verified that a safety-limit rejection preserves existing graph state, canonical content/taxonomy/relationship projections are rebuilt, deleted content and relationship tombstones are preserved, stale graph nodes are removed, and a second rebuild produces the same summary.

## Retained machine evidence

The workflow uploaded artifact **`systemfabric-live-integration-node-22.23.4`** (artifact ID `12930188574`). GitHub recorded SHA-256 digest `sha256:038f2c71d55e45ad2bcf11519a38b71ce8c9f1d427aba689307b3c82f43f1071`; retention expiry was `2027-01-27T20:26:14Z` at the time this record was produced. The artifact contains the CI-generated migration, TAP, integration summary, outage, and graph-rebuild logs. Open the successful [workflow run](https://github.com/GoldenObsidianLLC/SystemFabric/actions/runs/40949007893) to access the retained artifact.

## Scope and caveats

This record supports only the live PostgreSQL/Memgraph integration gate for the commit above. It is not an independent review and does not close tenant-isolation review, identity-provider, ClamAV corpus, live cloud-provider, live Stripe lifecycle, full browser/accessibility acceptance, plugin sandbox, load/backup/restore, independent security review, or operations approval gates. Keep the overall release state `NOT_PRODUCTION_CERTIFIED` until the remaining required evidence is collected and reviewed.
