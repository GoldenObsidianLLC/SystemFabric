# EnginEx 7.0.0 migration guide

**Applies to:** VirgoScorpio Hub 0.6.0 and the EnginEx 7.0.0 renderer linked at vendor/enginex as a Git submodule.
**Compatibility:** breaking change from EnginEx 6.2.0.
**Security:** arbitrary JavaScript template execution has been removed.
**Canonical source:** [GoldenObsidianLLC/EnginEx](https://github.com/GoldenObsidianLLC/EnginEx), pinned by the Hub submodule gitlink.

## What changed

The standalone EnginEx 7.0.0 repository, linked from this project through the vendor/enginex submodule, no longer includes `vendor/enginex/engine-legacy.js`. The following legacy opt-ins now fail closed:

- `allowUnsafeCode: true` rejects with `ERR_ENGINEX_UNSAFE_API`.
- `engine.unsafe(...)` rejects with `ERR_ENGINEX_UNSAFE_API`.
- A template containing a legacy `<?njs ... ?>` block rejects with `ERR_ENGINEX_UNSAFE_CODE_DISABLED`.

The safe renderer remains available. It supports a restricted expression language, escaped interpolation, conditions, loops, partials, layouts, and explicitly registered helpers. No automatic converter is provided: arbitrary JavaScript can perform side effects and access process capabilities that cannot be safely inferred or mechanically translated.

## 1. Find legacy templates

Search template source and build inputs for `<?njs` and `allowUnsafeCode`. Include:

- application templates and partials;
- templates downloaded from older deployments;
- templates stored in the CMS database or plugin archives;
- build/precompile inputs and generated manifests.

Treat the results as untrusted until each use has been classified and reviewed. Do not temporarily turn on a legacy execution flag; EnginEx 7.0.0 no longer provides one.

## 2. Move computation to a host-owned view model

Keep business rules, I/O, permissions, and state changes in ordinary application services. Prepare a bounded view model for the template.

Before (legacy JavaScript, no longer supported):

```html
<?njs
const visible = products.filter(product => product.active);
for (const product of visible) {
  echo('<li>' + product.name + '</li>');
}
?>
```

After (host computes the visible collection; template only renders it):

```js
const visibleProducts = products
  .filter(product => product.active)
  .map(product => ({
    name: product.name,
    priceLabel: formatPrice(product.priceMinor)
  }));

const html = await engine('products/list.html', {
  views: './views',
  locals: { products: visibleProducts }
});
```

```html
<ul>
{{#each products as product}}
  <li>{{ product.name }} — {{ product.priceLabel }}</li>
{{/each}}
</ul>
```

Ordinary interpolation is HTML-escaped. Do not replace it with raw interpolation merely to preserve the output of old JavaScript blocks.

## 3. Use a narrowly allow-listed helper when formatting belongs at render time

Helpers are host-provided functions registered for one render. They should be deterministic, bounded, and free of filesystem, process, credential, generic module-loading, or unrestricted network access.

```js
const html = await engine('products/list.html', {
  views: './views',
  locals: { products },
  helpers: {
    formatPrice(priceMinor) {
      if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) {
        throw new TypeError('priceMinor must be a non-negative integer.');
      }
      return (priceMinor / 100).toFixed(2);
    }
  }
});
```

```html
<ul>
{{#each products as product}}
  <li>{{ product.name }} — {{ formatPrice(product.priceMinor) }}</li>
{{/each}}
</ul>
```

EnginEx permits direct calls only to explicitly registered helper names. Functions embedded in `locals` are not callable. Only mark a helper pure when it is actually deterministic and side-effect-free.

## 4. Replace common control flow

| Legacy purpose | Safe renderer approach |
|---|---|
| Conditional branch | `{{#if condition}}...{{else}}...{{/if}}` |
| Collection loop | `{{#each items as item, index}}...{{/each}}` |
| Property read | `{{ user.profile.name }}` |
| Fallback | `{{ user.name ?? 'Anonymous' }}` |
| Formatting/business calculation | Precompute a view-model field or register a narrow helper |
| Database/API/filesystem work | Keep it in an application service; pass authorized, bounded output data |
| Reusable markup | Partial or layout, not dynamic JavaScript |
| Trusted static markup | Use the explicit safe-HTML mechanism only after host-side sanitization and policy checks |

The restricted grammar is not a general-purpose JavaScript interpreter. Unsupported syntax should be redesigned, not worked around with string evaluation or generated source code.

## 5. Update integration and build artifacts

1. Remove `allowUnsafeCode` and `engine.unsafe()` calls from application and plugin code.
2. Rewrite each legacy block and add golden-output tests for representative inputs, including escaping and empty/null cases.
3. Regenerate precompiled AST manifests with EnginEx 7.0.0; do not load 6.x artifacts as if they were 7.x.
4. Run `npm ci --no-audit --no-fund`, `npm run check`, and the vendored package check:
   `npm run check --prefix vendor/enginex`.
5. Add a full-render comparison for each migrated template. Validate user-controlled strings as hostile data and check that no template gains access to new host capabilities.

## Operational note

EnginEx 7.0.0 removes the arbitrary-JavaScript template execution sink; it does not make every template or helper inherently safe. Static HTML can still contain dangerous markup, and application-provided helpers remain part of the trusted computing base. Continue to validate URLs, sanitize any deliberately supported rich HTML, keep helpers capability-limited, and preserve authorization checks in host services.

The VirgoScorpio Hub 0.6.0 candidate remains **NOT_PRODUCTION_CERTIFIED**. This migration guide documents the renderer compatibility change; it is not a production approval.
