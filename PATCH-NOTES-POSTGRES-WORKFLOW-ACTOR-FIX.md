# SystemFabric 0.5.1 — PostgreSQL workflow actor fix

## Problem

The live PostgreSQL integration test reached `saveDraft` and failed with `ReferenceError: actorId is not defined`. `saveDraft` accepts the actor as `authorId`, but the workflow event writer was passed an undeclared shorthand property `actorId`.

## Changes

- Pass `actorId: authorId` when recording the `draft_saved` workflow event.
- Strengthen `test/integration/postgres.integration.test.js` to create a temporary test author, pass the `authorId` to `saveDraft`, assert the persisted workflow event has the correct `actor_id`, and clean up the user.

## Apply and test

Extract this patch at the repository root, merging the included repository-relative paths. Then run:

```powershell
npm run check
npm run test:integration:live
```

The live integration runner must continue to use the dedicated disposable database configured by `TEST_DATABASE_URL`; do not run these migrations against production.

## Evidence boundary

This patch addresses the reported `actorId is not defined` error. It has not been run against the user's live PostgreSQL/Memgraph services; rerun the integration suite to validate the fix.
