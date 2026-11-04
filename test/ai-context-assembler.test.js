'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_AI_CONTEXT_CONTENT_IDS,
  MAX_AI_CONTEXT_CHARS,
  parseAIContextContentIds,
  buildAIPageContext
} = require('../packages/ai/src/context-assembler');

const pageA = '11111111-1111-4111-8111-111111111111';
const pageB = '22222222-2222-4222-8222-222222222222';

test('AI context content IDs are optional, bounded, normalized and unique', () => {
  assert.deepEqual(parseAIContextContentIds(undefined), []);
  assert.deepEqual(parseAIContextContentIds([pageA, pageB.toUpperCase()]), [pageA, pageB]);
  assert.equal(MAX_AI_CONTEXT_CONTENT_IDS, 5);
});

test('AI context content IDs reject malformed values, duplicates and excess entries', () => {
  for (const value of [null, 'not-an-array', [1], ['not-a-uuid'], [pageA, pageA.toUpperCase()],
    Array.from({ length: MAX_AI_CONTEXT_CONTENT_IDS + 1 }, (_, index) =>
      `0000000${index}-0000-4000-8000-000000000000`)]) {
    assert.throws(() => parseAIContextContentIds(value), {
      code: 'ERR_VIRGOSCORPIO_HUB_AI_CONTEXT_INVALID',
      statusCode: 400
    });
  }
});

test('AI page context labels selected source material as untrusted and includes only supplied text', () => {
  const context = buildAIPageContext({
    sources: [{ title: 'Release plan', text: 'Draft milestones and risks.' }],
    siteContext: 'Brand voice: direct and calm.'
  });
  assert.match(context, /Selected page 1 \(untrusted content\)/);
  assert.match(context, /Title: Release plan/);
  assert.match(context, /Draft milestones and risks\./);
  assert.match(context, /Additional site context \(untrusted content\)/);
  assert.match(context, /Brand voice: direct and calm\./);
  assert.doesNotMatch(context, /sourceId|siteId|content_items|documentId/);
});

test('AI page context strips control characters and enforces a strict aggregate ceiling', () => {
  const context = buildAIPageContext({
    sources: [{ title: 'Plan\u0000\u0001', text: 'A'.repeat(MAX_AI_CONTEXT_CHARS) }],
    siteContext: 'Extra text must be truncated.'
  });
  assert.ok(context.length <= MAX_AI_CONTEXT_CHARS);
  assert.match(context, /\[Context truncated to the configured limit\.\]$/);
  assert.doesNotMatch(context, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
});

test('AI page context accepts empty sources and rejects malformed context inputs', () => {
  assert.equal(buildAIPageContext(), '');
  assert.throws(() => buildAIPageContext({ siteContext: 42 }), {
    code: 'ERR_VIRGOSCORPIO_HUB_AI_CONTEXT_INVALID'
  });
  assert.throws(() => buildAIPageContext({ sources: 'not-an-array' }), {
    code: 'ERR_VIRGOSCORPIO_HUB_AI_CONTEXT_INVALID'
  });
});
