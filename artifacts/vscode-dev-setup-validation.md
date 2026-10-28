# VS Code Development Setup — Packaging Validation

Date: 2026-10-27
Codebase: SystemFabric 0.5.1 hardening candidate

## Added to this workspace

- VS Code workspace file, recommended extensions, editor settings, launch profiles, and reusable test/readiness tasks.
- Dev Container pinned to Node.js 22.23.4, with browser runtime dependencies, PostgreSQL client tools, and the ClamAV client.
- Compose development services for PostgreSQL and Memgraph; PostgreSQL creates a separate `systemfabric_test` database on first initialization.
- Optional MinIO (S3-compatible) and ClamAV service profiles for local provider/scanner validation.
- Bootstrap and preflight scripts; the first network-enabled bootstrap generates `package-lock.json` if absent and installs Playwright Chromium.
- A strict live integration runner that checks actual DB/graph connectivity, applies migrations only to a test-named database, refuses implicit fallback to `DATABASE_URL`, rejects skipped integration tests, and writes machine-readable evidence and logs.
- A blocker-to-test guide mapping integration and production release gaps to explicit validation actions and evidence artifacts.

## Checks executed for this packaging pass

| Check | Result | Notes |
|---|---|---|
| Repository artifact/syntax check | PASS | 112 required paths; 96 JavaScript files syntax-checked |
| JavaScript syntax of setup scripts | PASS | Setup, bootstrap, doctor and live integration runner |
| JSON/workspace configuration parsing | PASS | 48 JSON/workspace files parsed |
| Compose and CI YAML parsing | PASS | Three YAML files parsed |
| PostgreSQL init shell syntax | PASS | `sh -n` passed |
| `.env` bootstrap smoke test | PASS | Run in an isolated temporary copy; confirmed test URLs are created |

## Environment limitations / remaining blockers

- This packaging environment runs Node.js 22.16.0, below the project minimum of 22.23.4.
- Docker and the Compose CLI are not installed here. The Dev Container image and Compose services could not be built or started.
- Dependency installation was attempted, but registry resolution timed out. No `package-lock.json` was produced; the lockfile must be generated on a network-enabled machine, reviewed, committed, and verified with clean `npm ci`.
- Dependencies are not installed in this packaging environment. The unit suite was not rerun as part of this setup pass.
- Live PostgreSQL/Memgraph migrations/integration, Playwright browser tests, MinIO/ClamAV, OIDC/SAML, real email, Stripe sandbox lifecycle, dependency audit/SBOM, load/soak, backup/restore, and independent security review were not executed here.

This document is setup-validation evidence only. It is not a production release approval and does not claim feature parity or that external gates have passed.
