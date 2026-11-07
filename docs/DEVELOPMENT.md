# Development Setup

New contributors can start with the step-by-step [First Contribution Quickstart](CONTRIBUTOR-QUICKSTART.md). This page remains the broader development environment reference.

## Prerequisites

- Git.
- Node.js `>=22.23.4` and npm.
- PostgreSQL and Memgraph only when running live database integration tests.
- Playwright and the configured Chrome browser channel for the end-to-end suite; see [Contributor Quickstart](CONTRIBUTOR-QUICKSTART.md) for browser installation notes.
- Provider accounts/credentials only for explicit live provider validation; ordinary unit tests should use deterministic mocks.

Check the runtime:

```powershell
node --version
npm --version
```

## Checkout and dependency install

```powershell
git clone --recurse-submodules https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub.git
Set-Location VirgoScorpio-Hub
npm ci
```

EnginEx is a pinned Git submodule at `vendor/enginex`. The recursive clone checks out the exact commit recorded by VirgoScorpio Hub.

For an existing checkout, inspect `git submodule status --recursive` first. Initialize an uninitialized submodule with `git submodule update --init --recursive`. If a checkout differs from the pinned commit, inspect and preserve local submodule work before changing it; development bootstrap never resets or updates a submodule automatically.

Use `npm ci` for a clean installation from the committed lockfile. If a script or package changes dependencies, review and commit the corresponding lockfile change deliberately.

## Environment configuration

1. Inspect the repository's existing environment examples and configuration validation.
2. Create local-only environment files from the documented example when needed.
3. Keep `.env`, credentials, signing material, database dumps, and provider payloads out of Git.
4. Use distinct test credentials and test resources; never point integration setup at production data.
5. Do not echo secrets in logs or paste them into issues, chat, screenshots, or terminal transcripts.

Do not assume an optional integration is ready merely because an environment variable exists. Run the integration test and document its scope.

## Local database services

The repository `compose.yaml` declares local-only PostgreSQL 18 and Memgraph 3.13 services. Start both from the repository root with:

```powershell
docker compose up -d postgres memgraph
docker compose ps
docker compose logs --tail=100 postgres memgraph
```

The Compose project name and primary database volume names are explicit and independent of the checkout folder. PostgreSQL data persists in `virgoscorpio-hub-postgres`; Memgraph data persists in `virgoscorpio-hub-memgraph`. Do not use `docker compose down -v` for routine shutdown: `docker compose down` preserves named volumes, while `down -v` removes them. Back up and verify any existing database before changing volume names or mounts. See [Operations](OPERATIONS.md) for release backup/restore gates.

## Useful commands

```powershell
npm run check
npm --prefix vendor/enginex test
npm run test:e2e -- --workers=1
npm run test:integration:live
npm audit
npm audit --omit=dev
gitleaks dir --redact --verbose .
gitleaks git --redact --verbose --log-opts="--all"
```

The live integration command requires a reachable PostgreSQL server with a dedicated virgoscorpio_hub_test database and Memgraph. Follow the integration script's current configuration and avoid destructive operations against shared databases.

Run npm run dev:doctor after configuring .env. The preflight authenticates DATABASE_URL and TEST_DATABASE_URL independently with a bounded, read-only SELECT 1; it does not write to either database. The test URL must target a database name ending in test. PostgreSQL authentication, connection, and timeout failures are reported by safe error category only. Connection strings and credentials are never printed. Memgraph preflight checks its configured Bolt endpoint for TCP reachability.

## Working on a change

1. Identify the package, application entry point, tests, and docs affected by the change.
2. Make a focused patch; preserve existing licensing and third-party notices.
3. Add or update tests for behavior and failure modes.
4. Update docs when commands, configuration, security guarantees, or user-visible behavior change.
5. Run the narrow test first, then `npm run check` and other relevant suites.
6. Run `git diff --check`, inspect staged changes, and scan for accidental secrets.
7. State what was and was not validated in the pull request.

## Documentation discipline

Mark proposed, incomplete, mocked, and live-tested features distinctly. Avoid presenting a module, badge, screenshot, performance claim, or integration as generally available without current evidence. See [Documentation standards](DOCUMENTATION_STANDARDS.md).
