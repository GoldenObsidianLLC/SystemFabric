# Development Setup

## Prerequisites

- Git.
- Node.js `>=22.23.4` and npm.
- PostgreSQL and Memgraph only when running live database integration tests.
- A Chromium installation for the Playwright end-to-end suite.
- Provider accounts/credentials only for explicit live provider validation; ordinary unit tests should use deterministic mocks.

Check the runtime:

```powershell
node --version
npm --version
```

## Checkout and dependency install

```powershell
git clone https://github.com/GoldenObsidianLLC/SystemFabric.git
Set-Location SystemFabric
npm ci
```

Use `npm ci` for a clean installation from the committed lockfile. If a script or package changes dependencies, review and commit the corresponding lockfile change deliberately.

## Environment configuration

1. Inspect the repository's existing environment examples and configuration validation.
2. Create local-only environment files from the documented example when needed.
3. Keep `.env`, credentials, signing material, database dumps, and provider payloads out of Git.
4. Use distinct test credentials and test resources; never point integration setup at production data.
5. Do not echo secrets in logs or paste them into issues, chat, screenshots, or terminal transcripts.

Do not assume an optional integration is ready merely because an environment variable exists. Run the integration test and document its scope.

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

The live integration command requires a reachable PostgreSQL server with a dedicated `systemfabric_test` database and Memgraph. Follow the integration script's current configuration and avoid destructive operations against shared databases.

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
