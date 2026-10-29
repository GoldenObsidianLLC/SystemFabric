# Contributing to SystemFabric

Thank you for considering a contribution. Focused changes, reproducible tests, and clear documentation help keep SystemFabric maintainable and safe to evaluate.

## Before opening an issue

- Search existing issues and documentation first.
- For defects, include the affected version/commit, expected versus actual behavior, reproduction steps, and sanitized logs.
- Do not post credentials, private data, production dumps, session tokens, or exploitable security details publicly. Follow [SECURITY.md](SECURITY.md) for private reporting.

## Development workflow

1. Fork the repository or create a working branch from the current maintained branch.
2. Install the supported Node.js runtime and run `npm ci`.
3. Make a focused change and add or update automated tests.
4. Run the smallest relevant test first, then `npm run check`; run EnginEx, browser, or live integration suites when the change affects those areas.
5. Run `git diff --check` and inspect `git diff` before committing.
6. Update README/docs/configuration examples when behavior or setup changes.
7. Open a pull request describing the problem, solution, validation commands/results, risk, and remaining limitations.

Example validation commands:

```powershell
npm run check
npm --prefix vendor/enginex test
npm run test:e2e -- --workers=1
npm run test:integration:live
npm audit
gitleaks dir --redact --verbose .
```

Live integration tests require isolated PostgreSQL/Memgraph test resources. Do not run destructive setup against production data.

## Code and test expectations

- Validate untrusted input and authorization before side effects.
- Keep behavior bounded and fail closed when a required safety control is not configured.
- Use mocked external provider responses for deterministic unit tests. Never place real test/live credentials in fixtures.
- Add negative-path, authorization, recovery, and limit tests where applicable.
- Preserve compatibility and migration requirements, and document non-obvious trade-offs.
- Do not claim production support solely because an adapter or module exists.

## Documentation expectations

Read [Documentation standards](docs/DOCUMENTATION_STANDARDS.md). Prefer concise guides with accurate prerequisites, exact commands, useful diagrams/examples, and a clear boundary between implemented, mocked, live-tested, and planned behavior. Only add screenshots or badges backed by real assets/evidence.

## Commit and pull request checklist

- [ ] Change is scoped to a clear purpose.
- [ ] Tests relevant to the change were run and their results are stated.
- [ ] Docs, examples, and changelog are updated when appropriate.
- [ ] No secrets, generated user data, or unrelated artifacts are staged.
- [ ] License and third-party notices are preserved.
- [ ] Known limitations and operational impacts are stated.

## Attribution and licensing

By submitting a contribution, you agree that it may be distributed under the repository's applicable license, GPL-2.0-or-later for original SystemFabric materials, unless the maintainers agree to an alternate arrangement in writing. Preserve third-party licensing and copyright notices. See [LICENSE](LICENSE), [COPYRIGHT](COPYRIGHT), and [TRADEMARKS.md](TRADEMARKS.md). Contributions do not automatically grant permission to use project names or branding to imply official endorsement.
