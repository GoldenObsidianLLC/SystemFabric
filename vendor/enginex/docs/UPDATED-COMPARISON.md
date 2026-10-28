# EnginEx 6.2.0 vs. Native PHP and Twig

## Executive summary

This report is a **local exploratory benchmark**, not a production certification. It measures one 132-byte HTML fixture on this environment: Node.js v22.16.0, PHP 8.4.24 CLI, Linux x64, Intel Xeon Platinum 8573C, and three logical CPUs exposed to the container. The package declares Node.js `>=22.23.4`, so this Node runtime is below the declared minimum. Twig is not installed; no Twig result is reported. PHP-FPM is not available; HTTP results use PHP's built-in development server.

The five-run CLI median results were:

- Native PHP template with CLI OPcache: **202,406 renders/sec**.
- EnginEx compiled synchronous renderer: **33,764 renders/sec**.
- EnginEx compiled renderer with a reused prepared immutable snapshot: **54,426 renders/sec**.
- EnginEx asynchronous interpreted renderer: **2,007 renders/sec**.
- Twig: **not measured** (Composer autoload/dependency absent).

For this tiny fixture, PHP was 6.00× faster than normal compiled EnginEx and 3.72× faster than prepared-data EnginEx by median throughput. Prepared-data rendering was 61.20% faster than normal compiled EnginEx in this run. The run-to-run throughput ranges are broad, especially for PHP, which indicates a noisy/contended shared environment; these ratios are preliminary and should be rerun on a dedicated machine with a supported Node.js version.

All measured implementations produced identical output: 132 bytes, single-render SHA-256 `119053e635c5bd70def068e4977842776459366b1ea453e037793e6e72f49f89`.

## CLI rendering benchmark

Method: five separately launched paired runs; 10,000 measured renders and 1,000 warm-ups per implementation per run; benchmark order rotates between runs; renderer output hash and size are checked. Values below are medians of the five successful results. The full per-run reports are retained in `bench/paired-runs/` and the aggregate is `bench/enginex-php-twig-comparison.json`.

| Implementation | Median renders/sec | Approx. time/render | Observed range | Status |
|---|---:|---:|---:|---|
| **Native PHP 8.4.24 CLI + OPcache** | **202,406** | **4.94 µs** | 130,777–445,429 renders/sec | Measured; high variance |
| EnginEx 6.2 compiled synchronous renderer | 33,764 | 29.62 µs | 21,887–49,721 renders/sec | Measured |
| EnginEx 6.2 compiled + prepared immutable data | 54,426 | 18.37 µs | 47,543–93,227 renders/sec | Measured; reuses one prevalidated snapshot |
| EnginEx 6.2 asynchronous interpreter | 2,007 | 498.18 µs | 1,743–2,640 renders/sec | Measured |
| Twig | — | — | — | Not measured; install `twig/twig` before comparing |

### Interpretation and limitations

The prepared-data mode avoids re-snapshotting the exact same immutable data for every render. This is legitimate only when data is unchanged and the caller can safely reuse an opaque prepared token. It is not equivalent to validating a fresh request object on every render.

The small sample produces wide run-to-run ranges. A stronger claim needs more repetitions on a dedicated machine, warm cache controls, CPU/process isolation, multiple fixture sizes, nested loops/partials/helpers, and confidence intervals. Do not combine this CLI result with HTTP numbers as a single speedup.

The earlier 6.1 report compared a separate benchmark workload and must not be used as an apples-to-apples version delta for this 6.2 run. This report is the current standalone 6.2 measurement artifact.

## HTTP smoke benchmark

This separate local test used 500 measured requests and 50 warm-ups per endpoint in one run at concurrency 1 and one run at concurrency 8. Node.js used the built-in HTTP server. PHP used its built-in development server, not PHP-FPM. Every available endpoint returned the same 132-byte fixture and identical SHA-256.

| Route | Requests/sec, concurrency 1 | p50 / p95 / p99 (ms), concurrency 1 | Requests/sec, concurrency 8 | p50 / p95 / p99 (ms), concurrency 8 |
|---|---:|---:|---:|---:|---:|
| EnginEx compiled, dynamic data | 591 | 1.377 / 3.910 / 6.320 | 776 | 9.925 / 16.860 / 18.818 |
| EnginEx prepared immutable data | 761 | 1.062 / 2.590 / 5.533 | 865 | 7.883 / 16.951 / 21.716 |
| EnginEx in-memory full-page cache | 1,021 | 0.819 / 1.777 / 5.452 | 1,046 | 6.780 / 13.450 / 20.080 |
| Native PHP page, built-in server | 545 | 1.657 / 2.749 / 4.336 | 556 | 12.501 / 25.820 / 35.457 |
| Twig page | — | — | — | — |

These are **single-run smoke results**, with very low request counts and a tiny fixture. They are illustrative only. The memory-cached EnginEx route avoids rendering, so it is an application-cache comparison—not a template-engine comparison. It would be misleading to conclude that EnginEx is faster than PHP-FPM from this test.

## Feature comparison

| Feature | EnginEx 6.2 | Native PHP templates | Twig |
|---|---|---|---|
| Primary role | Node.js template engine | General-purpose PHP used to render HTML | Dedicated PHP template engine |
| Expression language | Restricted custom expression grammar | Full PHP expressions and statements | Dedicated expression language |
| Compiled rendering | Reusable JavaScript renderer generated from validated template AST | PHP execution with OPcache available | Templates compile to PHP and can be cached |
| Default HTML escaping | Escapes ordinary interpolation; raw output requires trusted branding | Must be applied explicitly and correctly by application | HTML autoescape supported and commonly enabled |
| Layout inheritance / blocks | Built in | Usually framework/application convention | Built in |
| Partials | Built in | Native `include` or framework conventions | Built in |
| Async helpers | Supported on async renderer; compiled sync path rejects Promise-returning helpers | Not native to ordinary synchronous PHP execution | Depends on integration and extension behavior |
| Incremental fragments | Named fragments, dependency graph, dirty bitsets and patch generation; client patch application remains application work | Not intrinsic | Not intrinsic to core Twig rendering |
| Change-aware data model | Opaque immutable reactive snapshot and changed-path reporting | Application-specific | Application-specific |
| Machine-readable request contract | Versioned RenderRequest API and JSON Schema | Application-specific | Application-specific |
| Output-context diagnostics | Warns/rejects several risky contexts; it is not a complete HTML parser or automatic universal contextual encoder | Application-specific | Automatic HTML escaping, with context still requiring care |
| AI tooling | Optional AI workflow, diagnostics, MCP/provider adapters | Separate tooling | Separate tooling |
| Resource profiles / telemetry | Named resource-ceiling profiles, opt-in render metrics and backend capability probes | Application-specific | Application-specific |
| Response cache | Optional explicit bounded TTL/LRU utility; application defines safe keys/invalidation | Framework/CDN/application concern | Framework/CDN/application concern |
| Optional acceleration / transports | Wasm SIMD scanner, SharedArrayBuffer worker scanner, WebGPU scanner, WebSocket/WebTransport/WebRTC adapters | Not built in | Not built in |
| Ecosystem maturity | New project; independent security audit required | Very mature | Established and mature |
| Measured performance in this environment | See CLI and HTTP tables above | CLI and PHP built-in server measured | Not measured |

## Correctness and security notes

- The restricted expression interpreter is the safer normal execution model; do not enable unsafe legacy `<?njs ... ?>` mode for untrusted templates.
- The output-context analyzer is conservative diagnostics, not a complete HTML/JavaScript/CSS parser or a sanitizer. `strictOutputContexts` rejects detected risky patterns; supported `safeUrl(...)` and `jsonScript(...)` forms are recognized, but applications must still follow the correct context and trust model.
- Static HTML is not sanitized. Registered helpers run application code and should be capability-limited.
- The AST manifest now carries grammar/compiler metadata and source hashes, but is **not** a standalone precompiled JavaScript render-function module. The trusted runtime compiles reusable functions when loading the manifest.
- WebGPU is optional and its API presence is not evidence of performance. Backend capability probes report support, while workload benchmarks decide suitability.
- SharedArrayBuffer browser usage requires the relevant isolation conditions; EnginEx reports whether shared memory is usable and supports fallback paths.

## Reproduce

```bash
# Full CLI experiment: 3 runs x 30k renders is expensive on this shared container.
ENGINEX_BENCH_RUNS=3 ENGINEX_BENCH_ITERATIONS=10000 ENGINEX_BENCH_WARMUP=1000 npm run bench:paired

# Re-aggregate already captured per-run reports without re-running the workload
ENGINEX_BENCH_AGGREGATE_ONLY=1 ENGINEX_BENCH_RUNS=5 ENGINEX_BENCH_ITERATIONS=10000 ENGINEX_BENCH_WARMUP=1000 node bench/paired-benchmark.js

# Local HTTP smoke runs, output written to the named raw reports
ENGINEX_HTTP_ITERATIONS=500 ENGINEX_HTTP_WARMUP=50 ENGINEX_HTTP_CONCURRENCY=1 node bench/http-compare.js > bench/http-comparison-v6.2-c1.json
ENGINEX_HTTP_ITERATIONS=500 ENGINEX_HTTP_WARMUP=50 ENGINEX_HTTP_CONCURRENCY=8 node bench/http-compare.js > bench/http-comparison-v6.2-c8.json

# Full tests and deterministic AI readiness evaluations
npm run check
npm run evals
```

For production-like comparisons, run identical fixture routes behind equivalent reverse proxies, with PHP-FPM + OPcache and Twig caching configured. Use `bench/http-client.js` for already-running staging endpoints. Twig remains unmeasured until `twig/twig` is installed and the benchmark is executed.
