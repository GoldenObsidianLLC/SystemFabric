# EnginEx 6.2 architecture and conformance status

## Adopted patterns

1. **Canonical template semantics.** The validated AST remains the rendering contract; compiled and interpreted paths are checked against output-equivalence fixtures.
2. **Evidence-gated optimization.** Paired local measurements, raw run records, source hashes, environment fingerprints, and an optimization claims register accompany performance statements.
3. **Versioned request contract.** `RenderRequest` v1 is normalized at the boundary and also published as `schemas/render-request.schema.json`.
4. **Named execution profiles.** Profiles define resource limits rather than asserting universal performance.
5. **Change-aware incremental updates.** `createReactiveModel()` uses immutable snapshots/structural sharing and reports changed paths; dependency graph results are checked against a seeded brute-force reference test.
6. **Capability-driven backends.** Static capability detection is separate from WebGPU adapter/feature probing; availability isn't treated as evidence of speed.
7. **Bounded queues.** Shared worker scanning has an explicit pending-job limit and emits `ERR_ENGINEX_BACKPRESSURE` when the queue is full.
8. **Output-context analysis.** The analyzer reports script/style, event-handler, URL, CSS style-attribute, and raw-output contexts. Strict mode rejects detected risky cases; the built-in `safeUrl(...)` and raw `jsonScript(...)` forms are recognized.
9. **Operational observability.** Optional render metrics include low-cardinality mode counters and trace IDs.
10. **Release verification and rollback documentation.** The package integrity check covers required modules and version consistency; rollback plans and a claims register are retained.

## Intentionally retained reference paths

- Compiled synchronous JavaScript is the fast path for synchronous templates.
- Source-backed async rendering and streaming remain available for asynchronous helpers and large output.
- The JavaScript renderer is the baseline when an optional SIMD, shared-memory, or GPU backend is unavailable or not measured to be faster.
- Incremental rendering falls back to a full render when dependency certainty is not sufficient.

## Not yet complete / not claimed

- The build command emits a source-hashed validated AST manifest, not a standalone JavaScript module of render functions. Runtime compilation still occurs when that manifest is loaded.
- Async helpers and streaming do not yet have a separately generated compiled render-function backend.
- `analyzeOutputContexts()` is a conservative scanner, not a full HTML parser, sanitizer, or universal context-sensitive encoder. It is a safety diagnostic layer.
- Randomized dirty-path tests are deterministic, seeded unit/property-style tests, not a proof of correctness for all workloads. High-contention shared-memory tests and broad fuzzing remain to be done.
- The browser WebGPU path and transport adapters were not end-to-end tested in this Node.js environment.
- A release archive does not constitute an independent security audit. Do not describe EnginEx as audited or production-certified until those gates are completed.

## Optimization evidence requirements

A candidate must include baseline and optimized artifact hashes, correctness/security results, raw benchmark runs, environment fingerprint, statistical summary, regression report, and a rollback procedure. Backend promotions must be per workload/backend tuple; do not add independent percentage gains together or enable a backend solely because the feature is available.
