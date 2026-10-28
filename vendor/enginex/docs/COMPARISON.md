# EnginEx 6.2 vs. Native PHP and Twig

EnginEx is a Node.js template engine, not a general-purpose replacement for PHP. Native PHP templates execute the PHP language; EnginEx safe mode uses a restricted expression language and compiles validated templates into reusable JavaScript render functions. Twig is the closest PHP comparison because it is a dedicated template language.

- [Current performance comparison](UPDATED-COMPARISON.md)
- [Machine-readable CLI medians](../bench/enginex-php-twig-comparison.json)
- [Raw per-run CLI measurements](../bench/paired-runs/)
- [HTTP smoke, concurrency 1](../bench/http-comparison-v6.2-c1.json)
- [HTTP smoke, concurrency 8](../bench/http-comparison-v6.2-c8.json)

## Feature matrix

| Area | EnginEx 6.2 | Native PHP templates | Twig |
|---|---|---|---|
| Expression model | Restricted custom expression language | Full PHP | Dedicated expression language |
| Default HTML escaping | Escaped interpolation; trusted raw-output branding | Explicit, context-appropriate escaping required | HTML autoescaping is supported |
| Layouts and blocks | Built in | App/framework convention | Built in |
| Partials/includes | Built in | PHP `include`/framework convention | Built in |
| Compiled rendering | Reusable JavaScript renderer from validated AST | PHP bytecode caching through OPcache | Compiled templates and Twig cache, plus OPcache |
| Prepared data | Opaque immutable snapshots | Application-specific | Application-specific |
| Incremental fragments | Named fragments, dependencies, dirty bitsets, update patches | Not intrinsic | Not intrinsic to core Twig rendering |
| Reactive changes | `createReactiveModel()` path changes can drive incremental sessions | Application-specific | Application-specific |
| Async helpers | Async render path supports async helpers | Not native to ordinary synchronous PHP execution | Depends on integration |
| AI tooling | Optional AI facade, structured diagnostics and optional MCP/provider adapter | Requires separate tooling | Requires separate tooling |
| Machine-readable contract | RenderRequest v1 and JSON Schema | Application-specific | Application-specific |
| Context diagnostics | Conservative warning/strict mode; not a full context-sensitive encoder | Application-specific | Autoescape support with context-specific considerations |
| Resource budgets | Named profiles and output/render limits | Application-specific | Application-specific |
| Optional accelerators/transports | Wasm SIMD, SharedArrayBuffer workers, WebGPU, WebSocket/WebTransport/WebRTC adapters | Not built in | Not built in |
| Ecosystem maturity | New project; independent security review needed | Very mature | Established and mature |

## Performance snapshot

On the current local fixture, native PHP CLI with OPcache has a median of 202,406 renders/sec; EnginEx 6.2 compiled sync has 33,764; prepared immutable data has 54,426. Twig was not installed. These are exploratory CLI microbenchmark results with observed run-to-run variance, not production latency claims. See `UPDATED-COMPARISON.md` for HTTP smoke results and limitations.

The local HTTP benchmark uses Node's built-in server and PHP's built-in development server, not PHP-FPM. It does not establish that EnginEx outperforms a production PHP/Twig stack.

## Security boundaries

EnginEx's safe expression evaluator restricts the available syntax, but compiler-generated execution remains security-critical. The output-context analyzer warns about risky interpolation in script/style, inline event handlers, URL attributes, CSS style attributes, and raw output. It is not a sanitizer or a complete contextual-encoding engine. Static HTML may contain active content. Never execute untrusted PHP templates; configure Twig sandboxing carefully if template authors are untrusted.
