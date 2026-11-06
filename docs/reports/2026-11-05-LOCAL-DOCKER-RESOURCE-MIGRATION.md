# Local Docker Resource Migration Report — 5 November 2026

> **Status: PARTIAL — cold backups verified and restored into isolated Compose volumes; both new Hub databases have the current 18-migration schema, and local live integration, fresh-migration, Memgraph outage/replay, graph-rebuild, and Playwright browser-smoke checks pass. Legacy-resource retirement/rollback acceptance remains open.** This is a local development recovery exercise, not production backup/restore certification.

## Purpose and guardrails

Migrate the preserved pre-Compose PostgreSQL and Memgraph development resources into the stable virgoscorpio-hub Compose project without deleting, overwriting, or reinitializing the source volumes. The source containers and volumes remain available for rollback.

Work was performed from a clean Git worktree based on main commit `54b62e233e519aa0afa6c4170578def9c02e15fc`; the pre-existing developer worktree and its two local evidence artifacts were left untouched. The branch is `chore/docker-resource-migration-2026-11-05`. The local executable validation described below was run against code revision `aca463db5b7cdca9284a9a6ea1bab222a470f5cb`; the later PR follow-up on this branch records the validation results in Markdown only and does not alter application code, dependencies, Compose configuration, or database migrations.

## Source inventory and diagnosis

### PostgreSQL

- Source container: systemfabric-051-postgres-1, image postgres:18-alpine (server version 18.6).
- Source volume: systemfabric-051_systemfabric-postgres, approximately 74.9 MiB.
- Container exit code 127 was caused by an invalid bind mount, not a PostgreSQL executable error. The configured host path C:\Users\Justin Harlan\Documents\SystemFabric-0.5.1\docker\postgres\init\01-create-test-db.sh resolves to a directory, while the container expects a file at /docker-entrypoint-initdb.d/01-create-test-db.sh.
- PG_VERSION and pg_controldata confirmed a PostgreSQL 18 cluster at 18/docker. The source cluster had been interrupted; the restored copy completed WAL recovery and an immediate checkpoint before accepting connections.
- The legacy systemfabric database has no user tables. systemfabric_test contains 67 public tables and a 14-row systemfabric_schema_migrations ledger through 0014_collaborative_document_operations.sql. The inspected core tables sites, users, content_items, and outbox_events each contained zero rows. This does not prove every table is empty.

### Memgraph

- Source container: systemfabric-051-memgraph-1, image memgraph/memgraph:3.13.1.
- Source data volume: systemfabric-051_systemfabric-memgraph, approximately 13.68 MiB; separate anonymous configuration and log volumes were also inventoried.
- RETURN 1 succeeded. The inspected graph contained zero nodes and zero relationships.
- CREATE SNAPSHOT completed, returning /var/lib/memgraph/snapshots/20261105222807958106_timestamp_2001. The source container then stopped gracefully with exit code 0.
- The community image rejects SHOW DATABASES because multi-tenancy requires an enterprise/AI Platform/OEM license. This licensing restriction is not treated as a data-restore failure.

## Cold backups

Backup destination (outside the repository): %USERPROFILE%\Documents\VirgoScorpio-Hub Backups\2026-11-05.

All four archives passed full tar/gzip listing/integrity verification and SHA-256 comparison against the retained sidecar checksum files.

| Source | Archive size (bytes) | SHA-256 |
|---|---:|---|
| PostgreSQL data volume | 12,980,884 | AB107D53CA3D5D75C94087280E636435D6D2CFF446E693A76BD0B9EC6B585B38 |
| Memgraph data volume | 779,111 | C75BD8845096AC4794F9D7CC5F707F542418FA4B9E75B401E5071F4A1681C152 |
| Memgraph configuration volume | 12,331 | 26791BA8B76F883E0FAE206315FF19A1F552BB9E3295CBD9421EF2CD1B4C6BB4 |
| Memgraph log volume | 3,094 | 834649395EEA98E96AC32850BCDF2270D4B65DB6133C93590EB844E93CFA4B22 |

The PostgreSQL and Memgraph data archives were made from stopped, read-only-mounted source volumes. The separate Memgraph configuration/log archives are preserved for reference; the current Compose service uses the same pinned image defaults and does not mount those old anonymous volumes.

## Isolated Compose restore

The mainline Compose file now declares the stable project identity virgoscorpio-hub and explicit physical names:

- PostgreSQL: virgoscorpio-hub-postgres
- Memgraph: virgoscorpio-hub-memgraph
- Optional MinIO and ClamAV volumes also receive explicit stable names.

docker compose config --quiet passed. Compose create created the new named volumes and containers without starting them. The cold PostgreSQL and Memgraph data archives were extracted into those new volumes; read-only checks confirmed the PostgreSQL 18 control data and the Memgraph databases/WAL/snapshots directory structure.

### PostgreSQL restore result

- The restored PostgreSQL 18.6 server started from the new volume, completed crash/WAL recovery, wrote its end-of-recovery checkpoint, and reported that it was ready to accept connections.
- Docker Compose reports the container healthy based on pg_isready. This is only transport/readiness health, not an application identity check.
- The restored cluster retains the legacy `systemfabric` superuser and `systemfabric` / `systemfabric_test` databases. A separate `virgoscorpio_hub` login role now exists with local `CREATEDB` capability and credentials aligned with the documented Compose development configuration. A host-side Node.js connection from the project runtime succeeds. The `virgoscorpio_hub` application database and dedicated `virgoscorpio_hub_test` database are owned by this role.
- The new application database has the exact ordered `virgoscorpio_hub_schema_migrations` ledger for 0001–0018 and 69 public base tables. A second `npm run migrate` pass skipped all 18 migrations as already applied. The dedicated test database was created empty; `npm run test:integration:live` applied the same 18 migrations and left the test fixture cleanup clean (zero `outbox_events` and zero `content_items` rows).
- The legacy `systemfabric_test` database still contains 67 public tables and its separate `systemfabric_schema_migrations` ledger through 0014. It was not copied or upgraded. Keep both legacy databases unchanged as rollback/reference material; the new Hub test schema was built fresh rather than mixing incompatible migration ledgers.
- `npm run test:migrations:fresh` passed against a uniquely generated local disposable database bound to source revision `aca463db5b7cdca9284a9a6ea1bab222a470f5cb`: 18/18 migrations applied, the exact ordered ledger verified, 18/18 migrations skipped on the idempotent second pass, and only the generated `virgoscorpio_hub_fresh_276875c1e263_test` database was dropped.
- `npm run test:integration:live` passed 65/65 PostgreSQL/Memgraph/product/tenant-isolation tests with zero failures, cancellations, skips or TODOs on Node.js 26.12.1. It used `virgoscorpio_hub_test` and graph endpoint `127.0.0.1:7687`. The evidence JSON was retained outside the repository to preserve the tracked historical supplemental artifact.

### Memgraph restore result

- The restored Memgraph 3.13.1 container starts from the new virgoscorpio-hub-memgraph volume.
- `mgconsole RETURN 1` succeeds; node and relationship counts both return zero, matching the source inventory.
- `npm run test:integration:memgraph-outage` passed against the restored Compose container: a real graph outage left the event pending and released its worker lease; after Memgraph restarted, the event replayed successfully, the expected projection appeared, and the processed event was not replayed again. The Compose Memgraph container was running again after the test.
- `npm run test:graph:rebuild` passed using a separate disposable Memgraph 3.13.1 container: canonical content, taxonomy and relationships rebuilt; deleted content and relationship tombstones were preserved; stale graph nodes were removed; and a second rebuild produced the same summary. The disposable container was removed by the test cleanup.
- `npm run dev:doctor` passed all 9 preflight checks with zero warnings/blockers; `npm run migrate` against the application database skipped all 18 already-applied migrations.
- The container emits the existing `vm.max_map_count` warning (262144 vs. the documented 524288 recommendation). This did not prevent startup or the live recovery tests. It remains a host/runtime tuning note, not a claim of production qualification.

## Preservation and rollback

- No legacy volume was deleted, renamed, pruned, or mounted read-write by the backup helper.
- The original PostgreSQL container remains present and exited with the diagnosed bind-mount error; its volume remains intact.
- The original Memgraph container remains present and stopped gracefully after snapshot/backup; its data, config, and log volumes remain intact.
- All restore experiments target the new explicitly named Compose volumes. The existing original volumes are the rollback source until application-level acceptance is complete.
- Backup archives and SHA-256 sidecars remain outside the repository. No database dump, credential, or customer data was added to Git.

## Validation disposition

| Check | Result | Notes |
|---|---|---|
| Compose configuration | PASS | `docker compose config --quiet`. |
| PostgreSQL application schema | PASS | 18/18 exact migration records; 69 public base tables; migration re-entry skipped 18/18. |
| PostgreSQL test schema | PASS | Fresh `virgoscorpio_hub_test` database; 18/18 migrations applied; 69 public base tables. |
| Fresh migration/idempotency harness | PASS | 18/18 applied, 18/18 skipped on second pass, exact ledger verified, generated database dropped; result bound to `aca463db5b7cdca9284a9a6ea1bab222a470f5cb`. |
| Live PostgreSQL/Memgraph integration | PASS | 65/65 tests, zero failures, zero skips, zero TODOs. |
| Memgraph outage/replay | PASS | Durable event recovered after restart; no duplicate replay. |
| Graph projection rebuild | PASS | Canonical projection, tombstone, stale-node cleanup and idempotent second rebuild verified using a disposable container. |
| Development preflight | PASS | `npm run dev:doctor`: 9 passed, zero service warnings, zero blockers. |
| Local Playwright API/browser smoke | PASS | 9/9 tests using `virgoscorpio_hub_test`, loopback Memurai `redis://127.0.0.1:6379`, and API server `127.0.0.1:8787`; the runner closed the temporary API server afterward. |
| Legacy-resource retirement / rollback decision | PENDING | Original containers and volumes remain preserved; do not prune or delete them until an explicit rollback window and acceptance decision. |

### Compose image and health record

| Service | Image | Registry digest | Local image ID | Final status |
|---|---|---|---|---|
| PostgreSQL | `postgres:18-alpine` | `postgres@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5` | `sha256:57b23a0326ee442e83b3d3fa027c5a148be0a392d7c91d1ca4e1e70131ee859a` | Running / healthy |
| Memgraph | `memgraph/memgraph:3.13.1` | `memgraph/memgraph@sha256:bd3fe13228f40881365486729c78110dde6e04f3c1f102c84720d31f38b693f8` | `sha256:829dbceb931e760b5206ebe7a8aa921aa71e0c4e56864fe265e57abe2f08033b` | Running; live query, outage/replay and rebuild checks passed |

Hosted PR #72 and push workflows both passed all six jobs on exact head `aca463db5b7cdca9284a9a6ea1bab222a470f5cb`. This includes the hosted browser/editor smoke and CodeQL jobs; those hosted checks do not turn the local restore into production evidence.

Validation commands (with `DATABASE_URL`, `TEST_DATABASE_URL`, `MEMGRAPH_URL`, and `MEMGRAPH_TEST_URL` scoped to the local Compose services): `npm run test:migrations:fresh`, `npm run test:integration:live`, `npm run test:integration:memgraph-outage`, `npm run test:graph:rebuild`, `npm run dev:doctor`, `npm run migrate`, and `npm run test:e2e`. The E2E process also requires `VIRGOSCORPIO_HUB_TEST_REDIS_URL` to be explicitly set to the loopback test Redis/Memurai endpoint; no external Redis endpoint was used.

Retain the legacy resources and cold backups. No source volume/container retirement or production rollback decision has been made.

This local restore does not satisfy the formal production load/backup/restore gate (issue #24) or the formal PostgreSQL/Memgraph evidence gate. Those require the approved release topology, exact candidate SHA, documented RPO/RTO, reviewer, and independently accepted production-oriented evidence. VirgoScorpio Hub remains NOT_PRODUCTION_CERTIFIED / NO-GO.


## Mainline merge and application-level restore acceptance — 5 November 2026

PR #72 is merged into `main` as `70ce31a23aa670afca1d89fb5c776e1ca36abd84`. Mainline workflow [#301](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42135144431) passed all six hosted jobs. The local acceptance work was repeated on that exact source SHA after aligning only the ignored local `.env` database URLs with the checked-in development template; the first readiness invocation had exposed stale credentials (`28P01`) and is retained as diagnostic history only.

| Acceptance check | Result |
|---|---|
| `npm run test:migrations:fresh` | PASS — 18/18 applied; exact migration ledger verified; 18/18 idempotent skips; generated disposable DB dropped. Evidence binds source SHA `70ce31a23aa670afca1d89fb5c776e1ca36abd84`. |
| `npm run test:integration:live` | PASS — 65/65, zero failures, zero skips, zero TODOs against `virgoscorpio_hub_test`. |
| API runtime restore smoke | PASS — actual API composition returned `/health` HTTP 200 for 0.6.2; its own PostgreSQL pool read `virgoscorpio_hub` with 18 migration records, 69 public base tables, and one site. The API listener used an ephemeral loopback port and was closed after the check. |
| `npm run dev:doctor` | PASS — 9/9. Note: the current doctor only checks PostgreSQL TCP reachability; authenticated `SELECT 1` preflight is a follow-up engineering improvement. |
| `npm run release:readiness` | 8 PASS, 1 PARTIAL, 1 BLOCKED, 14 MISSING_EVIDENCE; exact source SHA and clean tree. Integration stage passed 65/65. |
| Local Playwright / hosted browser smoke | PASS — prior local 9/9 on the same PR #72 application code tree; merged mainline workflow #301 browser/editor smoke passed. Manual accessibility acceptance is still open. |

New exact-revision evidence files and checksums are retained outside the repository at `%USERPROFILE%\Documents\VirgoScorpio-Hub Backups\2026-11-05\release-acceptance-70ce31a`. Historical tracked `fresh-migrations.json` and `integration-live.json` artifacts were restored byte-for-byte after the harnesses; no local credentials, customer data, or generated test evidence was added to Git. The local application database smoke query did not write data. The original legacy containers/volumes and cold backups remain preserved.

This acceptance is a developer-environment recovery check only. It does not prove legacy application/customer data restoration, production-topology RPO/RTO, full object-storage restoration, or production disaster recovery. Production remains NO-GO / `NOT_PRODUCTION_CERTIFIED`.
