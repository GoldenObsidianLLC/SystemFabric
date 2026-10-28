# Changelog

## 6.2.0 — 2026-10-27

- Added a canonical, versioned `RenderRequest` normalization API shared by integration entry points.
- Added named resource profiles (`standard-ssr`, `high-throughput`, `incremental-ui`, `streaming`, `ai-preview`, `constrained-runtime`) with explicit per-option overrides.
- Added an immutable change-aware reactive model with structural sharing; incremental sessions can render its opaque prepared snapshots without repeating the full safety snapshot.
- Added opt-in render telemetry with low-cardinality aggregate counters and guarded per-render callbacks.
- Added scalar constant folding and compile-time elimination of statically known `if`/`unless` branches, while retaining runtime evaluation for nonconstant expressions and custom helpers.
- Added source hashes to precompiled AST manifests and an integrity-aware package verification script.
- Added evidence-gated paired benchmark tooling with rotating execution order, retained raw runs, host/runtime fingerprints, output-hash equivalence, median/min/max summary and explicit exploratory evidence status.
- Added output-context diagnostics for script/style, URL-valued attributes, inline event handlers, CSS style attributes and raw output; `strictOutputContexts` rejects detected risk patterns while recognizing the built-in `safeUrl(...)` / `jsonScript(...)` patterns. This is diagnostics, not a full contextual encoder/sanitizer.
- Added a machine-readable RenderRequest JSON Schema, stricter normalized relative-path checks, asynchronous WebGPU capability probing, and explicit bounded worker-queue backpressure.
- Added randomized seeded dirty-dependency conformance tests, a claims register, rollback manifest and architecture conformance notes.
- No performance claim is promoted without correctness equivalence and a reproducible run record; the current PHP/Twig comparison remains exploratory and Twig/PHP-FPM are unmeasured.

## 6.1.0 — Static formatter specialization and HTTP performance tooling

- Added compile-time formatter specialization for `formatNumber`, `formatCurrency`, and `formatDate` helper calls and filter pipelines when locale/options are static literals. Custom helper overrides and dynamic arguments retain the general helper path.
- Added an explicit bounded TTL/LRU `ResponseCache` for rendered HTML strings. Cache keys and invalidation remain application-owned to avoid accidentally sharing personalized output.
- Added local HTTP benchmark endpoints and a harness reporting request throughput, p50/p95/p99 latency, status, response bytes, and SHA-256 parity at concurrency 1 and 8. Added an external endpoint client that can measure equivalent staging routes behind PHP-FPM and a shared reverse proxy.
- Added CPU profiling command and preserved raw baseline/current benchmark runs. The current local CLI fixture shows median compiled throughput improved 53.66% and prepared-data throughput improved 67.23% versus the archived 6.0.0 engine, while PHP remains faster in the CLI render-only comparison.
- Expanded the test suite to 73 passing tests, including static formatter equivalence/custom override behavior, response-cache limits/TTL/LRU, and HTTP output parity smoke coverage.
- Twig and PHP-FPM remain unmeasured here because neither Twig nor PHP-FPM was available; local HTTP figures use PHP's built-in development server and must not be treated as production deployment comparisons.

## 6.0.0 — Compiled renderer, incremental updates, and optional acceleration

- Added a compiler-generated synchronous render fast path with specialized indexed array loops; existing async interpreter/API remains available for async helpers and streaming.
- Added `prepareData()` / `renderPrepared()` opaque immutable snapshots to avoid repeated input snapshotting for unchanged plain-object/array data.
- Added build/load APIs and `enginex build` CLI for a validated JSON AST manifest with a resolved partial/layout dependency graph. Renderer functions are generated during manifest load; this is not V8 bytecode.
- Added named fragment blocks, dependency-path analysis, scalable `DirtyBitSet` operations, XOR dirty-set transitions and incremental patch sessions.
- Cached Intl formatter instances and helper maps across renders; reduced per-chunk deadline-check overhead while retaining periodic render-budget checks.
- Added optional Wasm SIMD ASCII scanning/escaping, SharedArrayBuffer/Atomics worker scanning, and a WebGPU/WGSL ASCII scanner.
- Added optional WebSocket live preview with authorization, payload/rate/output limits and incremental sessions; added a WebTransport client and WebRTC DataChannel wrapper.
- Expanded the benchmark suite to compare compiled, prepared-data and interpreted EnginEx rendering against native PHP/OPcache and Twig when installed; added byte-hash parity and accelerator benchmarks.
- Expanded coverage to 67 passing tests across compiled rendering, prepared data, AST manifests, dependency bitsets, accelerator output parity, and transport adapters. Added three repeatable 10,000-render comparison runs and a 128 KiB accelerator smoke test. Optional acceleration backends remain disabled by default because measured overhead can outweigh their benefit.

## 5.0.0 — AI-Native integration layer

- Added a versioned machine-readable template grammar and runtime capability manifest.
- Added source analysis, helper/partial/layout inventories and security-review diagnostics.
- Added a dependency-free JSON Schema subset validator with explicit rejection of unsupported keywords.
- Added in-memory source rendering so preview does not need temporary template files.
- Added provider-neutral AI facade for generation, sample data, preview, explanation, repair, optimization, fixture equivalence, and explicitly gated publication.
- Added optional OpenAI Responses API Structured Outputs provider using native Fetch.
- Added optional MCP tools/resources/prompts; no write or publish tool is exposed through MCP.
- Added threat model, secure publishing policy, deterministic fuzz tests, live-provider evaluation script, and PHP/Twig benchmark harness.
- Added scope-aware static data-reference analysis and optional strict schema checks for undeclared root locals.
- Added explicitly quoted-attribute output helper (`htmlAttr`) and regression tests for escaping behavior.
- Added CI matrix for Node.js 22.23.4, 24.x, and 26.x; added a project license and made benchmark output equivalence a failing condition when a comparison is available.
- Retained the previous safe-mode rendering features and isolated unsafe legacy compatibility.

## 4.0.0 — Safe renderer foundation

- Added a safe-by-default expression parser/interpreter; expressions are not evaluated as JavaScript.
- Added output escaping, raw-output trust branding, layout inheritance, filters, helpers, streaming, path checks, data snapshotting, resource limits, bounded cache, Express callback API and opt-in unsafe legacy adapter.
