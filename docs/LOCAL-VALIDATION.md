# SystemFabric 0.5.1 — Local Validation Report

## Current source-level evidence

- SystemFabric unit/security suite: **105 passed, 0 failed** on Node.js 22.16.0.
- New unit coverage includes community route/input boundaries, idempotent checkout recovery, provider-aware Stripe session reconciliation, and inventory reservation/commit/release invariants. Provider lookups are mocked in unit tests.
- The live-PostgreSQL integration suites, including checkout reservation reconciliation and community workflows, are gated on `DATABASE_URL` and `SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION=true`; they have not been run against a live database in this packaging environment.
- `scripts/verify.js` performs required-file, manifest/version, migration-artifact, JSON parse, and JavaScript syntax checks.
- `npm run release:readiness` runs the source checks and writes `artifacts/release-readiness.json`, `artifacts/release-readiness.md`, and raw logs under `artifacts/evidence/`. Missing external evidence is explicitly reported as blocked; `npm run release:assert-ready` fails closed.

## Not validated here

- The active Node.js runtime is **22.16.0**, below the declared **22.23.4** minimum.
- No reviewed `package-lock.json` is included. Network/registry restrictions prevented generating and reviewing one in this environment; do not fabricate a lockfile.
- `npm ci` on the supported runtime and current GitHub Actions workflow runs have not been verified.
- PostgreSQL/Memgraph migrations, constraints, concurrency, outbox replay, dead-letter and outage/recovery behavior were not tested against live services here.
- Real OIDC/SAML/email/MFA, Stripe Checkout/webhooks, cloud provider permissions, media processing, and ClamAV daemon/malware corpus tests remain outstanding.
- Playwright/browser/accessibility checks, plugin runtime sandbox tests, dependency audit/SBOM/CodeQL evidence, load/soak, backup/restore and independent security review have not been completed in this environment.

## Interpretation

Passing local unit tests confirms only the tested source behavior on the current runtime. It does not certify production readiness, live integration correctness, or WordPress/WooCommerce/BuddyPress/Elementor parity. `RELEASE-GATE.md` and the generated readiness report are the release criteria.
