# EnginEx 6.2.0 local validation report

Status: **validated locally for the recorded test environment; not production-certified**.

## Environment

- Node.js: `v22.16.0` (below the package's declared minimum `>=22.23.4`; release qualification must run on a supported patched runtime)
- PHP CLI: `8.4.24`
- OS/runtime: Linux x64, kernel `6.18.55`, container reports 3 logical CPUs and Intel Xeon Platinum 8573C
- Twig: not installed; Composer executable was not available
- PHP-FPM: not available in the local test environment
- WebGPU: not available for end-to-end testing in the Node.js environment

## Completed checks

- `npm run check`: all JavaScript syntax checks, **88 automated tests passed**, package integrity verifier passed (31 required artifact paths and version consistency).
- `npm run evals`: **8 of 8 deterministic AI-readiness evaluations passed**.
- CLI benchmark: five runs, each with 10,000 warm-up/steady-state fixture renders; all available outputs matched at 132 bytes and SHA-256 `119053e635c5bd70def068e4977842776459366b1ea453e037793e6e72f49f89`.
- Local HTTP smoke: 500 requests plus 50 warm-ups per available route at concurrency 1 and 8; all available routes returned the same 132-byte fixture and hash.
- Seeded dirty-dependency comparison against a brute-force reference passed.
- Strict output-context tests cover script/style, event-handler, URL-valued attributes, raw-output warnings, and the recognized `safeUrl(...)` / `jsonScript(...)` forms.

## Unfinished qualification gates

- Run the suite on a supported patched Node.js 22.23.4+ / 24.x / 26.x matrix.
- Install Twig and run the paired CLI and HTTP benchmarks.
- Compare against PHP-FPM + OPcache behind equivalent reverse-proxy settings.
- Run the MCP adapter end to end with its optional SDK dependencies.
- Run browser integration tests for WebGPU, SharedArrayBuffer cross-origin isolation, WebTransport, and WebRTC in supported environments.
- Perform larger randomized/fuzz, contention, memory/GC, and fault-injection tests.
- Obtain independent security review.
- Generate a standalone render-function module and a separately compiled asynchronous/streaming backend; this release still loads a validated AST manifest and compiles renderer functions at manifest-load time.

## Evidence classification

Performance artifacts are `LOCAL_MEASUREMENT_EXPLORATORY`. The CLI host had high run-to-run variance, and the configured Node.js runtime is below the declared minimum. The numbers are included to make the current state reproducible, not to claim PHP/Twig parity or production readiness. Twig and PHP-FPM performance are **not measured**.
