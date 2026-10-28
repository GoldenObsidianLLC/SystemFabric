'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');

const MODES = new Set(['sync', 'async', 'stream']);
const VALID_PROFILES = new Set(['standard-ssr', 'high-throughput', 'incremental-ui', 'streaming', 'ai-preview', 'constrained-runtime']);

/** Normalize integration inputs into one versioned, data-only request contract. */
function normalizeRenderRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Render request must be a plain object.');
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new TypeError('Unsupported render request schemaVersion.');
  if (typeof input.template !== 'string' || !input.template.trim()) throw new TypeError('Render request requires a template path.');
  const templateSegments = input.template.split('/');
  if (path.isAbsolute(input.template) || /^[A-Za-z]:/.test(input.template) || input.template.includes('\\') || input.template.includes('\0') ||
      input.template !== input.template.trim() || templateSegments.some(part => part === '' || part === '..' || part === '.')) {
    throw new TypeError('Render request template must be a normalized relative path without traversal segments or empty path segments.');
  }
  const mode = input.mode ?? 'sync';
  if (!MODES.has(mode)) throw new TypeError(`Unsupported render mode: ${String(mode)}.`);
  const options = input.options === undefined ? {} : input.options;
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Render request options must be an object.');
  if (options.locals !== undefined) throw new TypeError('Use request.data for locals; options.locals is not allowed in a normalized RenderRequest.');
  const profile = input.profile ?? options.profile ?? (mode === 'stream' ? 'streaming' : 'standard-ssr');
  if (!VALID_PROFILES.has(profile)) throw new TypeError(`Unknown EnginEx performance profile: ${String(profile)}.`);
  const requestId = normalizeIdentifier(input.requestId, 'requestId') || randomUUID();
  const traceId = normalizeIdentifier(input.traceId, 'traceId') || randomUUID();
  return Object.freeze({
    schemaVersion: 1,
    requestId,
    traceId,
    template: input.template,
    mode,
    profile,
    data: input.data === undefined ? Object.create(null) : input.data,
    options: Object.freeze({ ...options, profile, telemetry: options.telemetry ?? true, traceId })
  });
}

function normalizeIdentifier(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new TypeError(`${name} must contain 1-128 safe identifier characters.`);
  return value;
}

const RENDER_REQUEST_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'EnginEx RenderRequest',
  type: 'object',
  additionalProperties: false,
  required: ['template'],
  properties: {
    schemaVersion: { const: 1 },
    requestId: { type: 'string', maxLength: 128 },
    traceId: { type: 'string', maxLength: 128 },
    template: { type: 'string', minLength: 1, pattern: '^(?![A-Za-z]:)(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.?($|/))[^\\\\\\u0000]+$' },
    mode: { enum: ['sync', 'async', 'stream'] },
    profile: { enum: [...VALID_PROFILES] },
    data: {},
    options: { type: 'object' }
  }
});

module.exports = { normalizeRenderRequest, RENDER_REQUEST_SCHEMA, VALID_PROFILES: Object.freeze([...VALID_PROFILES]) };
