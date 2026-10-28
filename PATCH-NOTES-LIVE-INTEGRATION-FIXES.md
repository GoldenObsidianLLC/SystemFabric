# SystemFabric 0.5.1 — Live Integration Fixes

This patch addresses the two failures from the live PostgreSQL/Memgraph integration run.

## Changes

1. `packages/graph/src/memgraph-store.js`: normalizes the related-content limit to a bounded integer and places only that integer literal in Cypher `LIMIT`. The previous parameterized numeric value was rejected by the installed Memgraph/driver combination.
2. `test/graph.test.js`: adds test coverage for fractional, over-limit, and malformed limit inputs, and asserts that no untrusted string is interpolated.
3. `database/migrations/0009_fix_content_item_slug_constraint.sql`: replaces the invalid PostgreSQL `content_items.slug` check expression. This is a new forward migration; previously applied migrations are deliberately not edited because `scripts/migrate.js` verifies their SHA-256 checksums.

## Apply

Extract the ZIP at the repository root, merging the included folders into the existing working tree. Then run:

```powershell
npm run check
npm run test:integration:live
```

The live integration script applies pending migrations to the dedicated database configured in `TEST_DATABASE_URL`. It must point to a disposable/local test database, never a production database. Migration `0009` changes the slug constraint on `content_items` only.

## Expected result

The Memgraph `findRelated` read should stop failing with `Limit on number of returned elements must be an integer`, and `saveDraft` should no longer trigger PostgreSQL's `invalid regular expression: invalid character range` for valid content slugs.

No live service execution is claimed by this patch package. The user must run the commands above against their local services and review the results.
