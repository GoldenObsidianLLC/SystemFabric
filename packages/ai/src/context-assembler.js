'use strict';

const { UUID_RE } = require('../../domain/src/identifiers');
const MAX_AI_CONTEXT_CONTENT_IDS = 5;
const MAX_AI_CONTEXT_CHARS = 3_000;
const TRUNCATION_MARKER = '\n[Context truncated to the configured limit.]';

function contextError(message) {
  return Object.assign(new TypeError(message), {
    code: 'ERR_VIRGOSCORPIO_HUB_AI_CONTEXT_INVALID',
    statusCode: 400
  });
}

function parseAIContextContentIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_AI_CONTEXT_CONTENT_IDS) {
    throw contextError(`contextContentIds must be an array containing at most ${MAX_AI_CONTEXT_CONTENT_IDS} page IDs.`);
  }

  const seen = new Set();
  return value.map((id, index) => {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw contextError(`contextContentIds[${index}] must be a valid UUID.`);
    }
    const normalized = id.toLowerCase();
    if (seen.has(normalized)) {
      throw contextError('contextContentIds must not contain duplicate page IDs.');
    }
    seen.add(normalized);
    return normalized;
  });
}

function sanitizeContextText(value, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw contextError(`${name} must be a string.`);
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim();
}

function buildAIPageContext({ siteContext = '', sources = [], maxChars = MAX_AI_CONTEXT_CHARS } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_AI_CONTEXT_CHARS) {
    throw contextError(`maxChars must be an integer between 1 and ${MAX_AI_CONTEXT_CHARS}.`);
  }
  if (!Array.isArray(sources)) throw contextError('sources must be an array.');

  const blocks = [];
  for (const [index, source] of sources.entries()) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw contextError(`sources[${index}] must be an object.`);
    }
    const title = sanitizeContextText(source.title, `sources[${index}].title`);
    const text = sanitizeContextText(source.text, `sources[${index}].text`);
    if (title || text) {
      blocks.push([
        `Selected page ${index + 1} (untrusted content):`,
        title ? `Title: ${title}` : '',
        text
      ].filter(Boolean).join('\n'));
    }
  }

  const suppliedContext = sanitizeContextText(siteContext, 'siteContext');
  if (suppliedContext) blocks.push(`Additional site context (untrusted content):\n${suppliedContext}`);

  const combined = blocks.join('\n\n');
  if (combined.length <= maxChars) return combined;
  if (maxChars <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, maxChars);
  return combined.slice(0, maxChars - TRUNCATION_MARKER.length).trimEnd() + TRUNCATION_MARKER;
}

module.exports = {
  MAX_AI_CONTEXT_CONTENT_IDS,
  MAX_AI_CONTEXT_CHARS,
  parseAIContextContentIds,
  buildAIPageContext
};
