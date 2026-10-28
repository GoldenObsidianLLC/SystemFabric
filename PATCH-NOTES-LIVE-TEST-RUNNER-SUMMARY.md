# SystemFabric 0.5.1 — Live Test Runner Summary Fix

## Problem

On Node.js 26, `node --test` emits summary counters using the information symbol, for example `ℹ tests 5`, `ℹ pass 5`, and `ℹ skipped 0`. The live integration wrapper only recognized classic `# tests N` TAP lines, so it reported a false blocker after the test subprocess had completed successfully.

## Changes

- Added `scripts/parse-node-test-summary.js` to parse both classic TAP and Node.js information-symbol summaries.
- Updated `scripts/test-integration-live.js` to record pass/fail/cancelled/skipped/TODO counts and fail closed if the summary is incomplete or any test did not pass.
- Added regression tests for both summary formats and incomplete output.

## Apply

Extract this patch at the project root, preserving existing `.env`, dependencies, and databases.

## Validation

This patch should be followed by `npm run check` and `npm run test:integration:live` on the developer's local environment. This package itself does not claim to have run against their databases.
