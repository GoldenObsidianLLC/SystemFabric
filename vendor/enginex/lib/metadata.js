'use strict';

const fs = require('node:fs');
const path = require('node:path');

const grammarPath = path.join(__dirname, '..', 'schemas', 'template-grammar.json');
const manifestSchemaPath = path.join(__dirname, '..', 'schemas', 'template-manifest.schema.json');

function getGrammar() { return JSON.parse(fs.readFileSync(grammarPath, 'utf8')); }
function getManifestSchema() { return JSON.parse(fs.readFileSync(manifestSchemaPath, 'utf8')); }
function describe(engine, options = {}) {
  const helpers = engine.getBuiltinHelpers();
  const customHelpers = options.helpers && typeof options.helpers === 'object' ? Object.keys(options.helpers).filter(name => typeof options.helpers[name] === 'function').sort() : [];
  return {
    name: 'EnginEx',
    edition: 'AI-Native',
    version: engine.version,
    runtime: 'Node.js',
    dependencies: { coreRuntime: [], optionalAdapters: ['@modelcontextprotocol/server', 'zod'] },
    language: {
      grammarId: 'enginex-template-1',
      syntax: ['escaped-interpolation', 'trusted-raw-interpolation', 'conditionals', 'unless', 'loops', 'with-aliases', 'partials', 'layout-inheritance', 'named-blocks', 'filter-pipelines', 'inline-comments'],
      expressionEvaluation: 'restricted-parser-with-interpreter-and-compiler-generated-renderers',
      compiledSynchronousRendering: true,
      precompilationApi: true,
      incrementalFragments: true,
      arbitraryJavaScriptInSafeMode: false,
      asyncHelpers: true,
      streaming: true,
      fragmentDependencyTracking: true,
      scalarConstantFolding: true,
      canonicalRenderRequest: true,
      namedPerformanceProfiles: true,
      changeAwareReactiveModel: true,
      optInRenderTelemetry: true,
      outputContextDiagnostics: true,
      reproducibleSourceHashedManifest: true,
      accelerationBackends: ['wasm-simd128-optional', 'sharedarraybuffer-worker-scan-optional', 'webgpu-wgsl-optional'],
      transportAdapters: ['websocket-live-preview-optional', 'webtransport-client-optional', 'webrtc-data-channel-optional']
    },
    security: {
      htmlEscapingByDefault: true,
      rawHtmlRequiresTrustedBrand: true,
      pathRootRestrictedByDefault: true,
      prototypeSensitivePropertiesBlocked: true,
      dataAccessorsRejected: true,
      renderLimits: true,
      legacyJavaScript: 'explicit-unsafe-compatibility-mode-only',
      mcpToolsDefaultToReadOnly: true,
      templateWritesDefaultDisabled: true
    },
    helpers: { builtins: helpers, configured: customHelpers },
    ai: {
      templateValidation: true,
      structuredProviderContract: 'generateStructuredOutput(request)',
      jsonSchemaValidation: 'supported-subset-with-explicit-rejection-of-unsupported-keywords',
      mcp: 'optional-adapter'
    },
    limits: { defaultTemplateBytes: 2 * 1024 * 1024, maxOutputLength: 8 * 1024 * 1024, cacheMaxEntries: 500 },
    performanceProfiles: engine.getPerformanceProfiles(),
    renderRequestSchema: 'enginex://api/render-request-v1',
    grammarResource: 'enginex://language/grammar',
    securityResource: 'enginex://docs/security'
  };
}

module.exports = { getGrammar, getManifestSchema, describe };
