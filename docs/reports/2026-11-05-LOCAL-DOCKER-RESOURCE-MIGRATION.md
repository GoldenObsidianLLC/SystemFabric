# Local Docker Resource Migration Report — 5 November 2026

> **Status: PARTIAL — cold backups verified and copied into isolated Compose volumes; PostgreSQL identity/schema migration and application-level validation remain pending.** This is a local development recovery exercise, not production backup/restore certification.

## Purpose and guardrails

Migrate the preserved pre-Compose PostgreSQL and Memgraph development resources into the stable virgoscorpio-hub Compose project without deleting, overwriting, or reinitializing the source volumes. The source containers and volumes remain available for rollback.

Work was performed from a clean Git worktree based on main commit 54b62e233e519aa0afa6c4170578def9c02e15fc; the pre-existing developer worktree and its two local evidence artifacts were left untouched. The new worktree branch is chore/docker-resource-migration-2026-11-05.

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
- The restored cluster contains the legacy systemfabric superuser and systemfabric/systemfabric_test databases. The new Compose defaults expect a virgoscorpio_hub role/database, which do not exist yet. PostgreSQL logs therefore record failed health probes for role virgoscorpio_hub even though pg_isready is healthy.
- The legacy systemfabric database has no user tables. The separate systemfabric_test database has 67 public tables and a legacy systemfabric_schema_migrations ledger for versions 0001–0014. Current mainline uses a different migration-ledger name (virgoscorpio_hub_schema_migrations) and its migration runner deliberately refuses to initialize a non-empty database without its own initialized ledger. Copying the old 14-migration test schema directly into the new test database would therefore be the wrong upgrade path and could produce a misleading/blocked migration state.
- Keep systemfabric_test intact as a legacy comparison/reference database; do not copy it into the new test database. Provision the Compose-compatible local development role with CREATEDB capability (the standard Compose POSTGRES_USER is a local development superuser) and create a fresh virgoscorpio_hub application database. Apply the current 18 migrations to that empty app database. Then set TEST_DATABASE_URL to a local database name ending in _test; scripts/test-integration-live.js will create the missing local test database under the same role, run the live integration suite against the restored PG/Memgraph services, and apply all 18 migrations. scripts/test-fresh-migrations.js will create a separate random disposable database, apply all 18 migrations, verify the exact ledger and idempotent second pass, and drop only that generated database. Keep systemfabric and systemfabric_test unchanged until acceptance is complete.

### Memgraph restore result

- The restored Memgraph 3.13.1 container starts from the new virgoscorpio-hub-memgraph volume.
- mgconsole RETURN 1 succeeds; node and relationship counts both return zero, matching the source inventory.
- The container emits the existing vm.max_map_count warning (262144 vs. the documented 524288 recommendation). This did not prevent startup or the basic query checks. It remains a host/runtime tuning note, not a claim of production qualification.

## Preservation and rollback

- No legacy volume was deleted, renamed, pruned, or mounted read-write by the backup helper.
- The original PostgreSQL container remains present and exited with the diagnosed bind-mount error; its volume remains intact.
- The original Memgraph container remains present and stopped gracefully after snapshot/backup; its data, config, and log volumes remain intact.
- All restore experiments target the new explicitly named Compose volumes. The existing original volumes are the rollback source until application-level acceptance is complete.
- Backup archives and SHA-256 sidecars remain outside the repository. No database dump, credential, or customer data was added to Git.

## Remaining validation

- [ ] Provision the local Compose-compatible virgoscorpio_hub role with CREATEDB capability and create a fresh virgoscorpio_hub app database; keep legacy systemfabric/systemfabric_test databases unchanged.
- [ ] Apply the current 18 migrations to the empty application database via scripts/migrate.js and verify migration checksums/schema objects.
- [ ] Run scripts/test-integration-live.js with DATABASE_URL and TEST_DATABASE_URL pointing to the restored local server; verify all live PostgreSQL/Memgraph suites without skips.
- [ ] Run scripts/test-fresh-migrations.js with local TEST_DATABASE_URL; verify 18/18 apply, 18/18 idempotent skips, exact ledger, and drop of only its generated disposable database.
- [ ] Validate representative object/table state and application startup against the new DATABASE_URL.
- [ ] Run the live PostgreSQL/Memgraph integration suite against the restored project services, including graph projection rebuild, outage/replay, and canonical rebuild checks.
- [ ] Verify the API/browser smoke paths that depend on the database.
- [ ] Record Compose image digests, final service health, exact commands/results, and the rollback decision. Retain the legacy resources through an agreed rollback window.

This local restore does not satisfy the formal production load/backup/restore gate (issue #24) or the formal PostgreSQL/Memgraph evidence gate. Those require the approved release topology, exact candidate SHA, documented RPO/RTO, reviewer, and independently accepted production-oriented evidence. VirgoScorpio Hub remains NOT_PRODUCTION_CERTIFIED / NO-GO.
