# EnginEx AI-Native 6.2

EnginEx is a dependency-free Node.js HTML template engine with a restricted expression interpreter, nested template composition, bounded rendering, machine-readable grammar, JSON Schema-based data contracts, structured diagnostics, optional AI providers, and an optional Model Context Protocol (MCP) adapter.

> **Security position:** EnginEx parses a restricted expression language. The synchronous compiler uses `Function` only to compile statements it generates from validated AST nodes; raw template source is never concatenated into executable code. Treat the compiler as security-critical. This does not make arbitrary static HTML safe. Keep helpers capability-limited, and never enable unsafe legacy compatibility for untrusted templates.

## Highlights

- Zero mandatory runtime dependencies.
- Existing `{{ ... }}` interpolation, conditions, loops, aliases, filters, partials and layout inheritance.
- HTML escaping by default and a branded `safeHtml()` escape hatch for trusted/sanitized markup.
- Asynchronous helpers, asynchronous partial loading, async-iterator streaming, writable streams.
- Root path confinement and canonical path checks.
- Bounded AST cache, concurrent cold-load coalescing, compiled synchronous renderers, compile-time specialization for built-in date/number/currency formatters with static options, reusable immutable prepared-data snapshots, and a validated precompiled AST-manifest build pipeline.
- Machine-readable capability manifest and template grammar.
- Source analysis and diagnostics: helper use, data references, partials, layouts, blocks, active HTML / contextual output warnings.
- JSON Schema subset for runtime data contracts; unsupported schema keywords fail explicitly rather than being silently ignored.
- AI workflow interface for generation, synthetic sample data, preview, explanation, repair, optimization, fixture comparison and explicitly gated publication.
- Optional OpenAI Responses API provider using Structured Outputs.
- Optional MCP tools, resources and prompts; no file-write or publish tool is exposed over MCP.
- PHP/Twig render-only benchmark, local HTTP smoke benchmark with p50/p95/p99 latency, an external HTTP client for comparing staging endpoints behind equivalent reverse proxies/PHP-FPM, raw run artifacts, output hashes, profile command, and separate interpreter/compiled/prepared-data modes.
- Incremental fragments with dependency paths and scalable XOR/OR bitsets; a structurally shared reactive model can report changed paths without requiring a full deep diff on every update.
- Canonical `RenderRequest` v1 normalization, named resource profiles, opt-in render telemetry, context-sensitive output diagnostics, and package-integrity checks.
- Optional WebAssembly SIMD scanner/escape backend, SharedArrayBuffer worker scanner, browser WebGPU/WGSL scanner, WebSocket live-preview server adapter, WebTransport client, and WebRTC DataChannel wrapper. These are optional experiments, not assumed speedups.

## Requirements

Use the latest patched release in a supported Node.js line. The package sets `node >=22.23.4` as its baseline; run CI on the currently patched Node 22, 24, and 26 lines before production deployment. The source can be syntax-checked on older compatible Node 22 builds, but do not use an unpatched runtime in production.

## Install / run

This is a source package without mandatory dependencies:

```bash
npm test
npm run check
npm run evals
node examples/demo.js
npm run bench:http
```

For a deployment-like comparison of already-running staging routes behind equivalent reverse proxies (including PHP-FPM), provide at least two URLs that return the same deterministic HTML fixture:

```bash
ENGINEX_HTTP_URL=https://eng.example.test/bench \
PHP_HTTP_URL=https://php.example.test/bench \
TWIG_HTTP_URL=https://twig.example.test/bench \
npm run bench:http:external
```

This reports throughput, p50/p95/p99 latency, response size, and output hashes in `bench/http-external-comparison.json`. Use staging—not production—and ensure the routes exercise equivalent data access, caching, compression, and response semantics.

To render a template:

```js
const engine = require('./index');

const html = await engine('product-list.html', {
  views: './examples/views',
  locals: {
    siteName: 'Northstar Store',
    products: [
      { name: 'Notebook', price: 8.50 },
      { name: 'Pen', price: 2.25 }
    ]
  }
});
```

The original Express-compatible callback API is retained. The safe engine rejects `<?njs ... ?>` blocks. The separately named legacy adapter remains an explicitly unsafe compatibility feature.

## Compiled rendering and prepared data

For repeated renders, load once and reuse the compiled renderer. This avoids repeated template source reads and expression interpretation:

```js
const engine = require('./index');
const template = await engine.load('products/index.html', { views: './views' });
const html = template.render({ user: { name: 'Ada' }, products: [] });
```

The safe compiled renderer is synchronous and requires synchronous helpers. If any helper returns a Promise, it throws `ERR_ENGINEX_ASYNC_HELPER`; use the existing async renderer (`await engine('page.html', options)`) or `template.renderAsync(data)` when you need async helpers.

For repeated rendering with the exact same data snapshot, validate/copy it once and reuse the opaque prepared token:

```js
const prepared = template.prepareData(data);
const html = template.renderPrepared(prepared);
```

Prepared snapshots support primitives, arrays, and plain objects; `Map` and `Set` are rejected so the snapshot can remain immutable. Changes to the original input after `prepareData()` do not change the prepared snapshot. Prepare new data when the source data changes.

### Full-response caching

When a page is public and its output changes infrequently, caching the rendered HTML can save more work than optimizing the renderer. EnginEx provides an explicit, bounded string-only TTL/LRU cache; it does not guess which pages are safe to share.

```js
const pageCache = engine.createResponseCache({
  maxEntries: 200,
  maxBytes: 8 * 1024 * 1024,
  ttlMs: 15_000
});

const key = `catalog:v3:${locale}:${categoryId}:${sortOrder}`;
let html = pageCache.get(key);
if (html === undefined) {
  html = template.renderPrepared(preparedCatalogData);
  pageCache.set(key, html);
}
res.type('html').send(html);
```

The key must include all output-affecting dimensions, such as tenant, locale, authorization variant, sorting, and source-data revision. Do not use a shared public cache key for personalized HTML. Explicitly invalidate keys when data or templates change, and choose TTL based on an acceptable stale-data window.

### Build a reusable AST manifest

Compile and validate the template tree during build:

```bash
node bin/enginex.js build --root ./views --out ./dist/templates.json --entry index.html
```

Load the generated manifest once at process startup:

```js
const template = await engine.loadPrecompiled('./dist/templates.json');
const html = template.render(data);
```

The manifest contains a JSON representation of validated template ASTs and the resolved dependency graph. Loading it generates reusable renderer functions once; rendering then needs neither the original template files nor per-request template parsing. **This is a validated AST manifest, not portable V8 bytecode.** Use artifacts produced by your trusted build process and version them together with EnginEx. Manifest mode currently supports compiled synchronous rendering; source-backed `renderAsync()` and streaming APIs are not available in this mode.

## Incremental fragments

Mark dynamic regions with a fragment name and wrap them in a real DOM element using the same `data-enginex-fragment` id:

```html
<section data-enginex-fragment="notification">
  {{#fragment "notification"}}{{ notifications.count }}{{/fragment}}
</section>
```

`const session = template.createIncrementalSession()`; the first `session.render(data)` returns a full render, and later renders can return fragment patches when tracked dependencies change. For custom helper calls, mark helpers pure only when they are truly deterministic and side-effect-free; otherwise their fragment is invalidated conservatively. Server-rendered one-shot pages may not benefit much from incremental work.

## Optional accelerators and transport adapters

- `engine.createWasmSimdAccelerator()` loads the bundled Wasm SIMD ASCII scanner/escaper. It declines non-ASCII inputs so the normal JavaScript path preserves UTF-16 indexing. It is optional and must not be assumed faster; the bundled benchmark showed the native JavaScript escape routine faster for its 128 KiB test input.
- `engine.createSharedWorkerPool()` scans large ASCII buffers with a SharedArrayBuffer/Atomics worker pool. This is a specialized scanning tool, not a general template-rendering worker pool. Small inputs should stay on the JavaScript path.
- `engine.createWebGpuScanner()` uses a WGSL compute shader in compatible browser contexts; it returns `null` when WebGPU is unavailable. The Node.js validation environment did not have WebGPU.
- `engine.attachWebSocketLivePreview()` attaches to a host-supplied `ws`-compatible server and supports authorized full previews plus incremental sessions. It does not bundle a WebSocket server.
- `engine.connectWebTransport()` is a browser client for a host-implemented JSON-lines service. `engine.wrapRtcDataChannel()` wraps an already-negotiated WebRTC data channel; signaling and ICE are the host application's responsibility.

Use adapters only when workload-specific measurements justify them. The current 6.2 exploratory CLI benchmark is captured in [the updated comparison and benchmark report](docs/UPDATED-COMPARISON.md): five-run medians were 33,764 renders/sec for compiled EnginEx, 54,426 for prepared immutable data, and 202,406 for native PHP CLI with OPcache. Twig was not installed. The environment's Node.js is below the package's declared minimum and the shared host showed substantial run-to-run variance, so these measurements are not production qualification or universal performance claims. The 500-request HTTP smoke tests use Node's and PHP's built-in development servers, not PHP-FPM, and are documented separately.


## EnginEx 6.2 runtime contracts

### Named performance profiles

Pass a profile when loading or rendering a template. Profiles define resource ceilings; explicit per-render limit values take precedence.

```js
const template = await engine.load('products.html', {
  views: './views',
  profile: 'high-throughput'
});
const html = template.render(data);
```

Available profiles are `standard-ssr`, `high-throughput`, `incremental-ui`, `streaming`, `ai-preview`, and `constrained-runtime`. They are guardrail presets, not claims that one profile is faster on every workload. Inspect values with `engine.getPerformanceProfiles()`.

The shared-memory scanner exposes a bounded pending-job queue; overload rejects with `ERR_ENGINEX_BACKPRESSURE` rather than permitting unbounded task growth. In browser contexts, `SharedArrayBuffer` is reported usable only when the page is cross-origin isolated; otherwise use transferable buffers/message passing.

### Canonical RenderRequest

Integrations can normalize HTTP, CLI, AI-preview, or service inputs into a single request contract:

```js
const result = await engine.renderRequest({
  template: 'products.html',
  mode: 'sync',
  profile: 'high-throughput',
  data: { name: 'Ada' },
  options: { root: './views' }
});
console.log(result.html, result.traceId);
```

`mode` is `sync`, `async`, or `stream`. The synchronous mode performs asynchronous loading once, then uses the synchronous compiled renderer. A stream result contains `stream`, an async iterable. Request paths must be normalized relative paths. `options.locals` is intentionally disallowed; use `data` so integrations share one contract.

### Change-aware reactive model

```js
const template = await engine.load('dashboard.html', { views: './views' });
const session = template.createIncrementalSession();
const model = engine.createReactiveModel({ notifications: { count: 1 }, title: 'Home' });

const initial = model.renderInto(session); // full HTML
model.set('notifications.count', 2);
const patchResult = model.renderInto(session); // only dependent fragments when tracked
```

The model uses immutable structural sharing and exposes an opaque prepared snapshot. Updates are explicit so mutations cannot silently bypass invalidation. For arbitrary external objects, continue using ordinary rendering and pass `changedPaths` only when the caller can accurately identify every affected path. If dependencies are uncertain, request a full render (`model.replace(data)` marks `*` dirty).

### Telemetry and output-context analysis

Telemetry is opt-in so the normal render path doesn't pay timing/callback overhead:

```js
const html = template.render(data, {
  telemetry: true,
  traceId: 'request-42',
  onMetric(metric) { /* enqueue to the host's metrics pipeline */ }
});
console.log(engine.telemetryStats());
```

Callbacks are isolated: a telemetry exception never breaks rendering. Aggregate metrics avoid template/user identifiers as metric labels. `engine.analyzeOutputContexts(source)` reports suspicious interpolations in script/style, event-handler, CSS-style, URL-valued attributes, and raw-output contexts. The analyzer is deliberately conservative; set `strictOutputContexts: true` to reject those patterns during source validation/loading. It is not a full HTML parser or a sanitizer. Prefer `jsonScript()` for script-data serialization, `safeUrl()` plus an application allow-list for URL values, and avoid dynamic event-handler/CSS source altogether.

### Reproducible build manifests

`enginex build` now embeds SHA-256 hashes of source templates and compiler/grammar version metadata in the validated AST manifest. Builds are deterministic for the same source tree and options. The manifest is still an AST artifact—not precompiled V8 bytecode or a standalone generated render-function module. The trusted application process compiles reusable functions once at manifest load. Only load artifacts from a trusted build pipeline.

## Machine-readable capabilities

```js
const engine = require('./index');
console.log(engine.describe());
console.log(engine.getGrammar());
console.log(engine.getManifestSchema());
```

Useful APIs:

- `engine.normalizeRenderRequest(request)` / `engine.renderRequest(request)` — normalize route, CLI, and tool inputs to the versioned RenderRequest contract. The JSON Schema is available at `schemas/render-request.schema.json` and through the `./render-request-schema` package export.
- `engine.getAccelerationCapabilities()` / `engine.probeAccelerationCapabilities()` — distinguish API availability from probed WebGPU adapter features; capability detection alone is not a speed claim.
- `engine.analyzeOutputContexts(source)` — conservative diagnostics for risky output contexts; it is not a full HTML parser or sanitizer.
- `engine.analyzeSource(source, options)` / `engine.validateSource(source, options)` — local parsing and analysis, with no model call.
- `engine.renderSource(source, options)` — render in memory while resolving partials/layouts from the configured root.
- `engine.validateData(data, schema)` — validate data against the EnginEx-supported JSON Schema subset.
- `engine.createAI({ provider, renderOptions, permissions })` — create an AI workflow facade.

`describe()` is generated from the running package capabilities and helper registry, not from a separate marketing-only declaration.

## AI workflow

The core engine does not need an AI provider. Supply any adapter that implements:

```js
const provider = {
  async generateStructuredOutput({ name, schema, system, input, signal }) {
    // Call your model provider and return a plain object matching `schema`.
  }
};
```

Then use the AI facade:

```js
const engine = require('./index');
const provider = engine.createOpenAIProvider({ model: process.env.ENGINEX_AI_MODEL });
const ai = engine.createAI({
  provider,
  renderOptions: { views: './views', strictPaths: true }
});

const draft = await ai.generateTemplate({
  description: 'A responsive product card with a name, price, and accessible action link.',
  dataSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['product'],
    properties: {
      product: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'price'],
        properties: {
          name: { type: 'string' },
          price: { type: 'number', minimum: 0 }
        }
      }
    }
  }
});

if (!draft.valid) {
  console.error(draft.validation.diagnostics);
} else {
  const preview = await ai.previewTemplate({
    source: draft.template,
    sampleData: { product: { name: 'Notebook', price: 8.5 } },
    renderOptions: { views: './views' }
  });
  console.log(preview.html);
}
```

The provider receives the generation request and schema. Do not send confidential production records to a model unless your organization has explicitly approved that processing. Generated templates are drafts and are never saved automatically.

### Available AI methods

- `validateTemplate({ source, dataSchema?, sampleData?, helpers?, filename? })`
- `previewTemplate({ source, sampleData?, dataSchema?, renderOptions? })`
- `explainTemplate({ source, dataSchema?, purpose? })`
- `generateTemplate({ description, dataSchema, layout?, conventions? })`
- `generateSampleData({ dataSchema, purpose? })`
- `repairTemplate({ source, ... })`
- `optimizeTemplate({ source, testCases? })`
- `verifyEquivalence({ original, proposed, testCases })`
- `publishTemplate({ filename, source, actor? })`

Optimization output is a proposal. The API reports exact-output comparisons only for test fixtures supplied by the caller. It does not claim unmeasured performance gains or universal semantic equivalence.

### Data schema support

The built-in validator supports a security-conscious subset of JSON Schema: `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, basic length/item/property/numeric limits, `uniqueItems`, `pattern` with anti-abuse checks, and a small set of standard formats. `$ref`, combinators, conditional schema keywords and unknown keywords are rejected. For a project needing complete Draft 2020-12 compliance, install a full validator such as Ajv at the application layer and validate before calling EnginEx. The generated template grammar itself is a separate machine-readable JSON resource.

## OpenAI provider

Install no OpenAI SDK to use the included adapter; it uses Node's built-in `fetch` and Responses API. Set `OPENAI_API_KEY` and pass an explicit model name:

```js
const provider = engine.createOpenAIProvider({
  model: process.env.ENGINEX_AI_MODEL,
  timeoutMs: 60000,
  maxRetries: 1
});
```

Model identifiers change over time, so the package intentionally does not hard-code a default model. See the [OpenAI Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs). Provider use can incur costs and transmit prompt/schema/input content to that provider.

## MCP integration

MCP is optional and does not add a runtime dependency to the rendering engine. Install the current MCP server SDK and Zod v4:

```bash
npm install @modelcontextprotocol/server zod
```

Run the stdio server:

```bash
ENGINEX_VIEWS=./views \
OPENAI_API_KEY=... \
ENGINEX_AI_MODEL=your-approved-model \
npm run mcp
```

Tools: `enginex_describe`, `enginex_validate_template`, `enginex_preview_template`, `enginex_explain_template`; when a provider is configured, generation/repair/optimization tools are added. Resources: `enginex://capabilities`, `enginex://language/grammar`, `enginex://docs/security`, and `enginex://schema/template-manifest`. Prompts include create, fix, and security review.

The MCP adapter does not expose a file-write or publish tool. The stdio adapter is intended for local hosts. If you deploy MCP over HTTP, add authentication, authorization, TLS, origin/host validation, request size limits, rate limits, audit logging, and explicit tenant isolation. Never expose an unauthenticated template-preview service to the public internet.

## Publication permissions

File writes and publication are disabled by default. `publishTemplate` requires both `permissions.publish: true` and `permissions.writeFiles: true`, a host-provided `approvePublish` callback that returns literal `true`, a safe template validation result, an existing destination directory inside the canonical root, and a path that is not a symlink. Keep this in a trusted administrative process and review generated HTML before deployment.

## Output context and active HTML

Ordinary interpolation is intended for HTML text and quoted attribute values, but it is **not** a universal encoder for JavaScript, CSS, URL policy, HTML tag names, or attribute names. For quoted attributes, `htmlAttr(value)` returns branded HTML-escaped output and must be used as `{{{ htmlAttr(value) }}}` to avoid a second escaping pass, for example:

```html
<input value="{{{ htmlAttr(user.displayName) }}}">
```

For URL values, apply `safeUrl` and then output the result through normal escaped interpolation; URL allow-listing and HTML escaping solve different problems. Keep tag/attribute names static, avoid interpolating into `<script>` or `<style>`, and use `jsonScript()` for JSON data blocks. Static `<script>` tags and event-handler attributes are not sanitized. Security diagnostics are heuristic warnings, not an HTML sanitizer or proof of safety.

Triple braces only accept engine-branded safe HTML from `engine.safeHtml()` or designated safe helpers. `safeHtml()` is a trust assertion, not a sanitizer: do not wrap untrusted HTML with it.

## Legacy compatibility

Trusted historical `<?njs ... ?>` files can be rendered only with `allowUnsafeCode: true` through `engine-legacy.js`. That mode executes arbitrary JavaScript in the Node.js process and is not a sandbox. Do not enable it for templates authored by users or an AI model. Migrate behavior to named helpers and safe template expressions before deployment.

## Tests, evals, benchmarks

```bash
npm test                 # unit, security and provider-mock tests
npm run check            # syntax + tests
npm run evals            # deterministic generation-quality/security cases, no API call
npm run bench:node       # EnginEx steady-state render benchmark
npm run bench:compare    # EnginEx vs native PHP; Twig runs if installed
```

Benchmark output includes output checksums so you can verify that each implementation emits the same bytes for the shared fixture. Timing depends on machine, versions, runtime configuration, warmup, output and workload. The scripts do not assert that EnginEx is faster than PHP or Twig.

## PHP comparison

Native PHP templates can execute all PHP code and therefore require explicit context-appropriate escaping. Twig is a more direct comparison: a dedicated template language with automatic HTML escaping and layout inheritance. PHP's OPcache stores precompiled bytecode; use it in performance comparisons. Compare under equivalent output, escaping, cache warmup and concurrency conditions. See `docs/COMPARISON.md` and `bench/`.

## Security reporting and maintenance

See `SECURITY.md`, `THREAT_MODEL.md`, and `CONTRIBUTING.md`. Before publishing this package publicly, replace the placeholder project security-reporting instructions with a monitored address or private advisory URL, define a supported Node.js release matrix, and run external security review/fuzzing. Do not market the package as independently audited until that review has happened.
