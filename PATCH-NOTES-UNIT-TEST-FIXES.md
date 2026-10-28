# SystemFabric 0.5.1 — cross-platform unit-test fixes

This patch addresses three failures reported by the Windows development run of `npm run check`.

## Changes

1. **Plugin archive inspector:** safely canonicalizes harmless leading `./` prefixes emitted by some tar implementations, tolerates the tar archive-root entry, requires exactly one canonical `package/package.json`, and extracts using the original archive member name. Unsafe absolute paths, backslashes, traversal segments and ambiguous duplicate manifests remain rejected.
2. **Library display names:** uses POSIX basename semantics for display-name normalization so the same input produces the same sanitized output on Windows and Unix-like systems. Backslashes are still replaced as unsafe characters in the final display name.
3. **Math fallback:** adds an explicit `katex: false` option to force the existing escaped fallback even if optional KaTeX is installed. The test now exercises the intended fallback deterministically instead of relying on whether the package happens to be installed.
4. **Regression test:** exercises npm archive inspection when tar output includes the leading `./` root and package path.

## Validation performed in the packaging environment

- `node --test test/domain-plugins-media.test.js test/platform-features.test.js`: **16 passed, 0 failed**.
- `node --test test/*.test.js`: **105 passed, 0 failed**.
- `node scripts/verify.js`: passed (112 required paths and 96 JavaScript files syntax-checked).

The packaging environment used Node.js 22.16.0, below SystemFabric's declared minimum of Node.js 22.23.4. These results are development checks, not supported-runtime certification. PostgreSQL/Memgraph live integration, Playwright E2E, provider calls, production security and release certification are not covered by these checks.
