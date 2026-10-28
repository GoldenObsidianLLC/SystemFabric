'use strict';

/**
 * Named resource profiles. These are guardrail presets, not performance claims.
 * Per-call limit options always override a profile's values.
 */
const PROFILES = Object.freeze({
  'standard-ssr': Object.freeze({}),
  'high-throughput': Object.freeze({
    maxRenderTimeMs: 3000,
    maxLoopIterations: 10000,
    maxIncludeDepth: 32,
    maxOutputLength: 4 * 1024 * 1024
  }),
  'incremental-ui': Object.freeze({
    maxRenderTimeMs: 1500,
    maxLoopIterations: 10000,
    maxIncludeDepth: 32,
    maxOutputLength: 2 * 1024 * 1024
  }),
  streaming: Object.freeze({
    maxRenderTimeMs: 30000,
    maxLoopIterations: 20000,
    maxIncludeDepth: 48,
    maxOutputLength: 32 * 1024 * 1024
  }),
  'ai-preview': Object.freeze({
    maxTemplateBytes: 512 * 1024,
    maxNodes: 20000,
    maxBlockDepth: 50,
    maxExpressionNodes: 1000,
    maxExpressionDepth: 50,
    maxDataNodes: 20000,
    maxDataProperties: 20000,
    maxLoopIterations: 5000,
    maxIncludeDepth: 24,
    maxOutputLength: 1024 * 1024,
    maxRenderTimeMs: 3000,
    cacheMaxEntries: 100
  }),
  'constrained-runtime': Object.freeze({
    maxTemplateBytes: 256 * 1024,
    maxNodes: 12000,
    maxBlockDepth: 40,
    maxExpressionNodes: 750,
    maxExpressionDepth: 40,
    maxDataDepth: 24,
    maxDataStringLength: 256 * 1024,
    maxDataNodes: 12000,
    maxDataProperties: 12000,
    maxLoopIterations: 2000,
    maxIncludeDepth: 16,
    maxOutputLength: 512 * 1024,
    maxRenderTimeMs: 1500,
    cacheMaxEntries: 100
  })
});

function getProfileLimits(profile = 'standard-ssr') {
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) {
    throw new TypeError(`Unknown EnginEx performance profile: ${String(profile)}. Available profiles: ${Object.keys(PROFILES).join(', ')}`);
  }
  return PROFILES[profile];
}

function describeProfiles() {
  return Object.freeze(Object.fromEntries(Object.entries(PROFILES).map(([name, limits]) => [name, Object.freeze({ ...limits })])));
}

module.exports = { PROFILES, getProfileLimits, describeProfiles };
