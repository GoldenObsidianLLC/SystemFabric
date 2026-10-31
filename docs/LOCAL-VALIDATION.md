# SystemFabric 0.5.1 — Local Validation Report

**Evidence date:** 2026-10-30
**Branch:** `feature/realtime-foundation-f1`
**Revision:** feature/realtime-foundation-f1, rebased onto the current origin/main; exact commit SHA is recorded by Git and the associated GitHub Actions run.
**Release classification:** `EXPANDED_DEVELOPER_PREVIEW_NOT_PRODUCTION_CERTIFIED`

## Verified locally

- **Supported runtime:** Node.js 26.12.1 on Windows x64; the declared minimum is >=22.23.4.
- **Clean dependency installation:** PASS — fresh isolated `npm ci --no-audit --no-fund` completed on Windows x64 / Node.js 26.12.1 on 2026-10-30; 167 packages installed and the KaTeX postinstall completed. Evidence: `artifacts/evidence/clean-npm-ci.json`. The validation directory was separate from the repository checkout; existing `node_modules` were not touched.
- **Artifact/syntax check:** PASS — 141 required repository paths; 123 JavaScript files syntax-checked.
- **SystemFabric unit/security suite:** PASS — 149 passed, 0 failed, 0 skipped, including regression coverage for cross-platform migration checksum stability.
- **Vendored EnginEx suite:** PASS — 88 passed, 0 failed, 0 skipped.
- **Fresh PostgreSQL migrations:** PASS — all 13 migrations applied to a newly created disposable local database derived only from `TEST_DATABASE_URL`; a second migration pass skipped all 13 as already applied; the disposable database was dropped. Evidence: `artifacts/evidence/fresh-migrations.json` and `fresh-migrations.log`.
- **Live PostgreSQL/Memgraph/product integration:** PASS — 16 passed, 0 failed, 0 skipped against the dedicated local `TEST_DATABASE_URL` database `systemfabric_test`, local Memgraph and local Memurai. Coverage includes community and checkout reservation workflows, tenant/site boundaries, transactions and rollback, outbox concurrency/retry/order/replay, migration upgrade fixture, graph projections, shared Redis presence and cross-instance SSE heartbeat/expiry fan-out. The primary `DATABASE_URL` database was not used for this suite.
- **Memgraph outage recovery:** PASS — the isolated test container was stopped, the durable event remained pending and its worker lease was released, Memgraph restarted, the event replayed, the projection verified, and duplicate replay avoided.
- **Graph projection rebuild:** PASS — canonical content/taxonomy/relationships rebuilt; deleted-content and relationship tombstones retained; stale nodes removed; safety limit preserved existing graph state; second rebuild produced an identical summary.
- **Library object reconciliation:** PASS — dry-run only, using the dedicated test database and an isolated temporary library directory. Zero files/candidates; `apply=false`; nothing deleted.
- **Playwright Chromium smoke tests:** PASS — 4/4 passed using one worker: sign-in labels and keyboard operation; Platform Hub form labels/status; editor widget/viewport/undo/preview; editor draft save/revision.
- **Dependency audit:** PASS — `npm audit --audit-level=high` reported 0 vulnerabilities on this run.
- **SBOM generation:** PASS — `npm run sbom` generated CycloneDX 1.5 with 162 components and 163 dependency records.
- **Redis/Memurai:** PASS — three live tests, 0 failures, 0 skips; multi-instance shared presence, site isolation, heartbeat-to-SSE fan-out and lazy expiry propagation.

The detailed local readiness snapshot is in `artifacts/release-readiness.json` and `artifacts/release-readiness.md`. Test logs are under `artifacts/evidence/`.

## Known execution adjustments

The first full readiness run exposed Windows memory pressure because Node's test runner and Playwright were launching too many workers concurrently. The readiness runner now serializes its Node test files, and the local Playwright configuration uses one worker. After those changes, the complete 149-test suite and all 16 live integration tests passed; the Playwright smoke suite passed 4/4. Migration SQL is normalized to LF before checksum generation and execution; this avoids false migration-drift alerts when Git converts working-copy line endings on Windows.

The SBOM script originally used the POSIX `mkdir -p` command. It was changed to a Node-based recursive directory creation so the script works from Windows CMD as well as CI shells.

## Still open — not evidenced as production-ready

- Current-revision GitHub Actions and CodeQL evidence for the pushed commit. Local tests were rerun after rebasing on current origin/main; production readiness still depends on the exact remote workflow results.
- Human dependency review of the corrected tracked `package-lock.json`, manual SBOM/provenance review, and CodeQL evidence.
- Current-revision GitHub Actions evidence for Node 22.23.4/24.22.1, live services, Playwright and CodeQL. The existing PostgreSQL/Memgraph external evidence file points to an older commit and is rejected by the readiness report as stale.
- Independent tenant-isolation/authorization review and a broader adversarial review of all routes, workers and long-lived real-time subscriptions.
- Real OIDC/SAML providers, outbound email, MFA recovery and proxy/session security E2E.
- Live ClamAV daemon, malicious-file corpus, scanner timeouts/false positives, and legacy asset rescanning/quarantine. `clamdscan` is not installed on this workstation.
- Live S3/GCS/Azure/S3-compatible permissions, lifecycle, encryption, retention and provider failure tests. Those provider credentials were not configured in this environment.
- Stripe test-mode webhook lifecycle, refunds, async/late events, subscription lifecycle and jurisdiction-specific tax/privacy/compliance acceptance. Stripe credentials were not configured here.
- Full visual editor acceptance, broad browser journeys, manual keyboard and screen-reader review, and WCAG acceptance. Four Playwright tests are smoke coverage, not a complete accessibility audit.
- Commerce and community product parity subsets (tax, shipping, coupons, refunds, fulfillment, membership lifecycle; group privacy, forums, spam/abuse, search, export and deletion).
- Complete plugin archive-to-signed-image pipeline and adversarial container isolation tests; independent pen test; managed WAF/reverse proxy/DDoS and real proxy-trust validation.
- Load/soak, queue saturation, provider/database outages under representative traffic, backup/restore with RPO/RTO, operational alerting, rollback rehearsal, incident-response exercise and explicit release approval.
- Manual SBOM/dependency/provenance review and CodeQL results. Zero npm audit findings and SBOM generation alone do not close this gate.

## Environment safety

Live SQL integration and the object reconciliation rehearsal targeted only `systemfabric_test` through `TEST_DATABASE_URL`. The primary `DATABASE_URL` database was not used for these tests. No primary-database migration was applied as part of this validation. The actual `.env` file was not modified. Credentials and provider secrets are not included in test logs or this report.

## Interpretation

This evidence demonstrates successful local source, database, graph, Redis and limited browser behavior on the current dirty working tree. It is not a clean release-candidate run, independent security sign-off or production certification. The authoritative readiness snapshot remains fail-closed: `NOT_PRODUCTION_CERTIFIED`.
