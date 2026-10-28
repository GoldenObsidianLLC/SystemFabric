# EnginEx flaky-test fixes

This patch changes tests only; it does not change EnginEx runtime behavior.

## `vendor/enginex/test/engine.test.js`

The mtime-cache test writes a changed template and immediately expects the mtime-based cache to detect it. On filesystems with coarse timestamp resolution, two writes can share a signature. The test now applies an explicit future mtime after rewriting the template so it deterministically tests revalidation.

## `vendor/enginex/test/transports.test.js`

The WebSocket preview test used fixed 0–20 ms sleeps before asserting outgoing messages. Under load, rendering can take longer than those sleeps. The mock socket now emits a `sent` event, and the test awaits each expected message with a 2-second timeout instead of relying on short timing sleeps.

## Validation performed on the supplied source snapshot

- `node --test test/engine.test.js test/transports.test.js`: 36 passed, 0 failed.
- `node --test test/*.test.js`: 88 passed, 0 failed.

Validation runtime: Node.js v22.16.0 in the patch-building environment. Re-run the suite on the target project and CI runtime before treating that run as release evidence.
