# PostgreSQL and Memgraph Live Integration Evidence

**Technical integration gate: PASSED**

**Application source commit:** `fc95ea3628c88c9bc1eb29e5d07e36edb07fb31a`

**Current-main hosted CI run:** [SystemFabric CI — all five jobs successful](https://github.com/GoldenObsidianLLC/SystemFabric/actions/runs/41232584439)

**CI commit:** `fc95ea3628c88c9bc1eb29e5d07e36edb07fb31a`

**Local evidence generated:** 2026-10-31 (Windows x64, Node.js 26.12.1)

## Environment

- Local Windows x64 development environment, Node.js `26.12.1`.
- Dedicated PostgreSQL test database: `systemfabric_test`, reached through `TEST_DATABASE_URL`.
- Local Memgraph `memgraph/memgraph:3.13.1` and loopback Memurai/Redis service.
- Fresh migration verification used a generated disposable database named `systemfabric_fresh_0b58b856619f_test`; only that disposable database was dropped.
- The live graph-outage rehearsal used a separate disposable Memgraph `3.13.1` container and restored/removed it after the test.
- No production database, production graph, or external provider credentials were used.

## Verified results

1. **Fresh migrations and idempotency:** all 14 migrations applied to an empty disposable PostgreSQL database; a second migration pass skipped all 14; the disposable database was dropped.
2. **Live PostgreSQL/Memgraph/Redis integration:** `npm run test:integration:live` completed **22 tests, 22 passed, 0 failed, 0 skipped** against the dedicated `systemfabric_test` database and local services.
3. **PostgreSQL correctness:** the integration suite covered the v0008 upgrade fixture through the current schema, transaction rollback, concurrent outbox workers, poison-event dead-lettering, projection retries, and tenant/site selector isolation.
4. **Redis collaboration:** the integration suite exercised real Redis document relay recovery, bounded 2,000-message fan-out to 10 subscribers (20,000 expected and observed deliveries), site/document routing, cross-instance presence and SSE behavior, and authorization invalidation.
5. **Real Memgraph outage/recovery:** stopping the isolated graph container left the durable event pending and released its lease; after graph restart, the event replayed, projected the expected content, and was not delivered a second time.
6. **Canonical graph rebuild:** the live rebuild preserved existing graph state when a safety limit was exceeded, rebuilt canonical content/taxonomy/relationships, retained tombstones, removed stale nodes, and produced an identical second-run summary.

## Hosted CI confirmation

The current-main workflow run completed all five jobs successfully:

- Unit, security, dependency audit, and SBOM jobs on Node.js `22.23.4`.
- Unit, security, dependency audit, and SBOM jobs on Node.js `24.22.1`.
- PostgreSQL and Memgraph integration, including fresh migration verification, live integration, outage/recovery, and isolated graph rebuild.
- Browser editor and accessibility smoke tests.
- CodeQL security analysis.

The hosted CI job is test evidence, not a production deployment or a substitute for independent security review.

## Retained machine evidence

- `artifacts/evidence/fresh-migrations.json` — 14/14 migrations applied and 14/14 idempotently skipped.
- `artifacts/evidence/integration-live.json` — 22/22 local live integration tests, zero skips.
- This evidence summary and the linked hosted workflow run provide the retained execution record. Raw local logs are kept as ignored local artifacts and are not published because they are not part of the repository's retained evidence contract.

## Scope and caveats

This record supports the PostgreSQL/Memgraph live integration gate for the application source above. It does **not** close independent tenant-isolation review, real identity-provider, ClamAV corpus, cloud-provider, Stripe lifecycle, full manual browser/accessibility acceptance, plugin container isolation, representative load/soak, backup/restore, independent security review, or operations approval. Overall release classification remains `NOT_PRODUCTION_CERTIFIED`.
