# VirgoScorpio Hub 0.6.2 — Taxonomy Site-Context and Outbox Internal Pre-Review

> **INTERNAL MAINTAINER PRE-REVIEW ONLY.** This is not an independent security assessment, certification or closure of issues #14 or #25.

## Scope and finding

Base mainline: aecc3d24df94399648311d561587ef42db91cab8.

Candidate: PR #76, taxonomy route site-context and domain-event envelope hardening.

The API taxonomy create, update and delete handlers previously inserted taxonomy.upsert/taxonomy.delete rows without site_id, actor_id, correlation_id or classification. Those event types are registered as site-private in the shared event contract, but the database defaults made these new rows site_id NULL and classification internal even though payload.siteId was present. The durable event envelope, not the payload alone, controls worker scope and classification. This prevented these domain events from meeting the canonical event contract for tenant-scoped graph projection.

The same taxonomy route family also did not use the shared siteIdFor resolver. It authorized and queried using the path site ID but silently ignored conflicting header, query or POST/PUT body selectors. The database operations remained path-site scoped; no cross-tenant disclosure was demonstrated from this omission. The candidate makes the route behavior consistent with shared request-context validation.

## Remediation

- Add a reusable writeTaxonomyOutboxEvent helper for all taxonomy event producers.
- Persist site_id from the returned term row, actor_id from the authenticated actor, correlation_id from the request ID and classification site-private.
- Retain existing aggregate_type, aggregate ID, aggregate version, event type and idempotency constraint.
- Reconcile path/header/query/body site selectors via siteIdFor before capability checks or tenant data reads/writes.
- Parse POST/PUT JSON once using the existing 64 KB bound.
- Add live create/update/delete tests with mismatch/no-mutation cases and exact event-envelope assertions.

## Adversarial regression

| Scenario | Result |
|---|---|
| GET path Site B / conflicting Site A header | HTTP 400, existing site-context mismatch code |
| POST path Site B / conflicting Site A body selector | HTTP 400; zero taxonomy rows persisted |
| PUT path Site B / conflicting Site A body selector | HTTP 400; label and version unchanged |
| DELETE path Site B / conflicting Site A header | HTTP 400; term remains active |
| Valid same-site create/update/delete | HTTP 201/200/200 |
| taxonomy.upsert v1 and v2 envelopes | Site B site_id, actor_id, correlation_id, site-private classification and payload.siteId |
| taxonomy.delete v3 envelope | Site B site_id, actor_id, correlation_id, site-private classification and payload.siteId |

## Local test evidence

- Database: fresh isolated virgoscorpio_hub_pr76_test; all 18 ordered migrations applied.
- Live PostgreSQL/Memgraph/Redis suite: 67/67 passed, zero failures, skips or TODOs.
- Pending/processing outbox rows after live suite: 0.
- Real Memgraph outage/replay: PASS; event remained pending during outage, replayed after restart, projected exactly once and left no pending/processing events. Memgraph was running afterward.
- Full repository check: 213 required paths, 219 JavaScript files syntax-checked; 517 Hub tests, 514 passed, zero failed, three Windows/platform-specific skips.
- git diff --check: PASS.

## Architecture and release impact

No migration, dependency, package version, public route or valid-response-shape change. The helper centralizes the taxonomy event envelope and avoids three copies of the outbox SQL. The route adopts the existing site-selector contract already used by relationships and other tenant-addressed API families.

This report and the local test run are maintainer evidence only. Issue #14 still requires an independent route/data-access review across API, workers, providers, storage, cache, realtime and privileged paths. Issue #25 still requires the broader independent security assessment. Formal exact-source release readiness must be regenerated after the candidate is finalized; the older 8 PASS / 1 PARTIAL / 1 BLOCKED / 14 MISSING_EVIDENCE counts remain tied to SHA 70ce31a23aa670afca1d89fb5c776e1ca36abd84.

**Disposition: PR #76 candidate only. Hub 0.6.2 remains NO-GO / NOT_PRODUCTION_CERTIFIED and unreleased.** No release tag, package publication, GitHub Release or production deployment is authorized.
