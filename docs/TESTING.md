# Testing and Validation

## Test matrix

Run commands from the repository root in a Windows PowerShell terminal unless a workflow specifies otherwise.

| Layer | Command | Dependencies | Evidence boundary |
|---|---|---|---|
| Artifact and syntax checks + SystemFabric unit tests | `npm run check` | Node.js and installed npm dependencies | Validates configured paths/syntax and the unit suite; not a production certification. |
| Vendored EnginEx tests | `npm --prefix vendor/enginex test` | Node.js | Exercises the vendored runtime's own suite; does not certify the full application. |
| Browser/end-to-end tests | `npm run test:e2e -- --workers=1` | Playwright and Chromium | Smoke tests only; supplement with accessibility and cross-browser acceptance. |
| Live DB integrations | `npm run test:integration:live` | PostgreSQL test DB `systemfabric_test` and Memgraph | Exercises selected real database integration paths; it does not cover the full operational lifecycle. |
| Dependency audit | `npm audit` | Network access to npm advisories | Reports known dependency advisories in the selected dependency tree; it is not a complete security audit. |
| Production dependency audit | `npm audit --omit=dev` | Network access to npm advisories | Audits runtime dependencies only. |
| Working-tree secret scan | `gitleaks dir --redact --verbose .` | Gitleaks | Scans current files; historical data needs a separate scan. |
| Git history secret scan | `gitleaks git --redact --verbose --log-opts="--all"` | Gitleaks and Git history | Scans refs reachable locally; also verify the actual remote refs before publication. |

## Choosing tests for a contribution

Use the [contributor map](ARCHITECTURE.md#contributor-map-where-to-change-code) to identify the source area and related tests.

| Change type | Example command | Test boundary |
|---|---|---|
| API or package logic | `node --test test/api.test.js` | Focused unit/API tests; dependencies may be mocked. |
| Complete configured unit suite | `npm run check` | Artifact, syntax, and unit checks. |
| Admin/browser behavior | `npm run test:e2e -- --workers=1` | Playwright browser tests; API responses may be mocked. |
| PostgreSQL or Memgraph integration | `npm run test:integration:live` | Real, isolated database services required. |

Run commands from the repository root.

The live integration runner requires `TEST_DATABASE_URL` pointing to a dedicated test database whose name ends in `test`, plus `MEMGRAPH_TEST_URL` or `MEMGRAPH_URL`. It applies migrations and runs database-backed tests, so never use production resources.

The Playwright configuration currently selects the Chrome browser channel. Install the configured browser before running the suite. `npm run test:e2e:install` installs Chromium, which is not the same as the selected Chrome channel.

AI and other external-provider unit tests use mocked responses where configured. A passing mocked test does not prove connectivity to a live provider. Live provider validation requires separate credentials, infrastructure, and evidence.

See [Development setup](DEVELOPMENT.md) and [Contributing](../CONTRIBUTING.md) for prerequisites and the contribution workflow.

## Test design guidance

- Unit tests should be deterministic and mock external boundaries unless they are explicitly tagged/configured for live use.
- Never use actual provider credentials in fixtures. Use clearly fake, non-secret placeholders and fake provider responses.
- Test negative paths: missing credentials, malformed input, authorization failures, timeouts, ambiguous provider outcomes, and bounded retries.
- Live integration tests must use dedicated disposable test resources and should state what they mutate.
- Browser smoke tests do not replace manual keyboard, screen-reader, focus, contrast, or cross-browser accessibility acceptance.
- Concurrency tests are valuable evidence for selected races but do not substitute for a representative load test.

## Recording results

In a PR or release note, include the exact commands run, whether services were live or mocked, environment constraints, and the commit under test. Do not paste secret values or private production data into test logs.

## Release interpretation

A green workflow means the configured jobs passed for that commit. It does not mean all required release-readiness evidence exists. The current baseline deliberately retains `NOT_PRODUCTION_CERTIFIED` until remaining gates are satisfied; see [Release readiness](RELEASE_READINESS.md).
