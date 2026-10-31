# First Contribution Quickstart

This guide takes a new contributor from a fresh Windows or macOS/Linux checkout to the first reliable local checks. It is a development workflow, not a production deployment guide.

## 1. Prerequisites

Required for the basic setup:

- Git.
- Node.js **22.23.4 or later** and npm. The repository's `.nvmrc` pins 22.23.4; the package engine requires `>=22.23.4`.
- A terminal (PowerShell on Windows, or your preferred shell on macOS/Linux).

Check the installed versions:

```powershell
git --version
node --version
npm --version
```

Use Node.js 22.23.4 when reproducing CI or when troubleshooting runtime-specific behavior. A version manager such as nvm-windows can install and select that version:

```powershell
nvm install 22.23.4
nvm use 22.23.4
```

You do **not** need PostgreSQL, Memgraph, Docker, Chromium, or third-party provider credentials to install dependencies and run the basic unit/security checks.

## 2. Clone and install

Run these commands from the directory where you keep development projects:

```powershell
git clone https://github.com/GoldenObsidianLLC/SystemFabric.git
Set-Location SystemFabric
npm ci
```

`npm ci` installs the exact dependency graph from `package-lock.json`. It removes and recreates `node_modules`; do not use it in a directory where you have manually stored files inside `node_modules`.

Verify the checkout and package scripts:

```powershell
git status --short --branch
npm run
```

## 3. Optional local development configuration

You can run the unit suite without creating an environment file. When you need local API or database-backed development, create the ignored local `.env` file and development folders:

```powershell
npm run dev:setup
```

The setup script copies `.env.example` to `.env` only when `.env` does not already exist, preserves existing values, adds test-only database endpoints when they are missing, and creates local artifact/media/library folders. Review `.env` before using it. Its example values are development defaults, not production credentials.

Run the preflight check:

```powershell
npm run dev:doctor
```

The doctor checks the Node runtime, lockfile, required modules, Docker Compose availability, and database endpoint configuration. Missing or invalid `DATABASE_URL`, `TEST_DATABASE_URL`, or Memgraph URL settings are blockers; a configured endpoint that is temporarily unreachable is reported as a non-fatal service warning. Node, lockfile, module, Docker Compose, and missing-endpoint blockers cause a non-zero exit.

Never commit `.env`, secrets, provider credentials, signing keys, database dumps, or generated private data. The repository ignores local `.env`, `var/`, and test-output paths; still inspect `git status` before committing.

## 4. Run the first checks

From the repository root:

```powershell
npm run check
```

This runs the repository artifact/path and JavaScript syntax verification, followed by the SystemFabric unit/security tests. Most unit tests use deterministic mocks and do not contact PostgreSQL, Memgraph, Stripe, cloud storage, identity providers, mail providers, or external AI services.

You can also run the vendored rendering/runtime tests separately:

```powershell
npm --prefix vendor/enginex test
```

A successful unit run is useful contribution evidence, but it is not a production-readiness or security certification.

## 5. Know which tests need additional services

| Test or check | Additional requirement | Notes |
|---|---|---|
| `npm run check` | Node.js and installed npm dependencies | Basic artifact, syntax, and unit/security suite; no database service required. |
| `npm --prefix vendor/enginex test` | Node.js | Runs the vendored EnginEx suite. |
| `npm run test:e2e -- --workers=1` | Playwright and the configured Chrome browser | The current `playwright.config.js` selects Chromium with `channel: "chrome"`. The repository helper `npm run test:e2e:install` installs Playwright's Chromium binary; if the selected Chrome channel is unavailable, install the Chrome channel with `npx playwright install chrome` or install Google Chrome Stable. |
| `npm run test:integration:live` | Dedicated PostgreSQL test database and Memgraph | Requires `TEST_DATABASE_URL` and `MEMGRAPH_TEST_URL` or `MEMGRAPH_URL`. The database name must end in `test`. Redis-backed integration cases also run when the approved loopback `SYSTEMFABRIC_PRESENCE_REDIS_URL` is configured. |
| `npm run test:migrations:fresh` | Explicit `TEST_DATABASE_URL` and PostgreSQL access | Creates and drops a generated disposable database derived from the test URL. Use only a dedicated local/test server and database. |
| `npm audit` / `npm audit --omit=dev` | Internet access to npm advisories | Dependency advisory checks; not a complete security assessment. |
| `gitleaks dir --redact --verbose .` | Gitleaks installed | Scans the current working tree. A separate Git-history scan is needed for reachable commits. |

### Start the local database services

The repository's Compose file is for **local development and test services only**. It defines PostgreSQL and Memgraph (not Redis):

```powershell
docker compose up -d postgres memgraph
docker compose ps
```

The Compose PostgreSQL initialization creates the application database and a separate test database. The default local endpoints are documented in `.env.example`; review and confirm your `DATABASE_URL`, `TEST_DATABASE_URL`, and Memgraph URL before running integration tests.

Then run:

```powershell
npm run dev:doctor
npm run test:integration:live
```

The live integration runner intentionally refuses to fall back from a missing `TEST_DATABASE_URL` to `DATABASE_URL`. It also requires the test database name to end in `test` and validates that the configured Memgraph endpoint is reachable. It applies migrations and writes test records. **Never point it at production or a shared database.**

For Redis-specific integration coverage, configure a separately managed local Redis or Redis-compatible service (for example, Memurai on Windows) and set `SYSTEMFABRIC_PRESENCE_REDIS_URL` to its loopback URL. The live runner restricts this integration URL to local/loopback hosts. The default Compose file does not start Redis.

**Important:** `.env.example` includes a loopback `SYSTEMFABRIC_PRESENCE_REDIS_URL` value, so `npm run dev:setup` copies a Redis endpoint into a new `.env`. The Compose file does not provide that Redis service. If you do not have Redis/Memurai listening on that loopback address, clear the value in your local `.env` before running the live integration suite to keep Redis-only cases disabled. Leave it set only when the local Redis-compatible service is running.

### Provider-backed tests

Ordinary unit tests mock external providers where applicable. Credentials are needed only for an explicit live-provider investigation, such as external AI, Stripe test mode, cloud object storage, OIDC/SAML identity, email delivery, or a malware-scanning service. Do not add credentials to test fixtures or commit them. Use isolated test accounts, least-privilege access, and the provider's test/sandbox mode.

## 6. Common setup problems

| Symptom | Safe next step |
|---|---|
| `npm ci` reports an unsupported Node engine | Check `node --version`; select Node.js 22.23.4 or later, then rerun `npm ci`. |
| `npm ci` reports a lockfile/package mismatch | Do not regenerate the lockfile just to silence the error. Fetch the maintained branch, inspect the dependency change, and ask in the relevant issue if the committed lockfile appears inconsistent. |
| A required module cannot be resolved | Confirm `npm ci` completed successfully in the repository root. Run `npm run dev:doctor` for the preflight summary. |
| Docker commands cannot connect | Start Docker Desktop/Engine, then check `docker compose version` and `docker compose ps`. |
| PostgreSQL or Memgraph is unreachable | Start the named Compose services; inspect `docker compose logs postgres memgraph`; confirm the endpoint and port in your local `.env`. |
| Live integration refuses to start | Confirm `TEST_DATABASE_URL` is explicitly set, points to an isolated database ending in `test`, and that `MEMGRAPH_TEST_URL` or `MEMGRAPH_URL` is configured. The runner will not silently target `DATABASE_URL`. |
| Playwright cannot launch its browser | Check the `channel: "chrome"` setting in `playwright.config.js`; install Chrome Stable / run `npx playwright install chrome`. The helper `npm run test:e2e:install` installs the separate bundled Chromium browser. |
| A local port is already in use | Check which local service owns port 5432 (PostgreSQL), 7687 (Memgraph), or 8787 (the API test server). Do not terminate an unknown process or point tests at a different/shared database without checking the configuration. |

When troubleshooting, retain the first meaningful error and the command that produced it. Redact tokens, passwords, connection strings, email addresses, private URLs, and customer or production data before sharing logs.

## 7. Open a useful issue or pull request

For a bug report, include:

- The affected version and full commit SHA (`git rev-parse HEAD`).
- Operating system, Node.js version, and npm version.
- The exact command or request that failed.
- Expected behavior and actual behavior.
- Minimal reproducible steps and sanitized error output.
- Which checks passed, failed, or were skipped; identify whether services/providers were mocked or live.

For a pull request, describe the reason for the change, main paths changed, tests run and results, any skipped checks, compatibility or migration impact, and remaining limitations. Run `git diff --check` and review `git status` and `git diff` before pushing.

Do not include `.env` files, credentials, access tokens, session cookies, private keys, production/customer data, unredacted database URLs, or database dumps. Do not publish potentially exploitable vulnerability details in a public issue; follow the root [Security policy](../SECURITY.md) for private reporting.

## 8. Know what a green check means

A successful `npm run check` confirms the configured local artifact/syntax checks and unit/security tests passed in that environment. It does not prove live provider connectivity, exhaustive tenant isolation, browser accessibility acceptance, load capacity, backup/restore, operational recovery, independent security review, or production readiness.

Read [Testing and Validation](TESTING.md), [Development Setup](DEVELOPMENT.md), [Contributing](../CONTRIBUTING.md), and [Release Readiness](RELEASE_READINESS.md) before taking on larger changes or interpreting CI results.

---

[Back to the documentation index](README.md)
