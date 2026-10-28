'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAIService } = require('../packages/ai/src/service');
const { createAIProviderFromEnv } = require('../packages/ai/src/provider-factory');
const { validatePageDocument } = require('../packages/domain/src/page-document');

function silentAudit() { return () => {}; }

test('mock AI page generation returns a normalized, valid unsaved proposal', async () => {
  const ai = createAIService({ env: { AI_PROVIDER: 'mock', AI_MAX_PROMPT_CHARS: '12000' }, audit: silentAudit() });
  const result = await ai.generatePageDraft({ prompt: 'A home page for a small architecture studio' });
  assert.equal(result.status, 'draft-proposal');
  assert.equal(result.saved, false);
  assert.equal(result.published, false);
  assert.equal(validatePageDocument(result.document).valid, true);
  assert.ok(result.document.children.length > 0);
});

test('AI content task uses allow-listed operations', async () => {
  const ai = createAIService({ env: { AI_PROVIDER: 'mock' }, audit: silentAudit() });
  const result = await ai.assistContent({ text: 'Example text', operation: 'make-clearer' });
  assert.equal(result.text, 'Example text');
  assert.equal(result.saved, false);
  await assert.rejects(() => ai.assistContent({ text: 'x', operation: 'run-shell' }), { code: 'ERR_SYSTEMFABRIC_AI_OPERATION' });
});

test('AI input limits and required fields fail before provider invocation', async () => {
  const ai = createAIService({ env: { AI_PROVIDER: 'mock', AI_MAX_PROMPT_CHARS: '512' }, audit: silentAudit() });
  await assert.rejects(() => ai.generatePageDraft({ prompt: 'x'.repeat(600) }), { code: 'ERR_SYSTEMFABRIC_AI_INPUT_LIMIT' });
  await assert.rejects(() => ai.generateSeo({ title: '', content: 'text' }), { code: 'ERR_SYSTEMFABRIC_AI_INPUT_LIMIT' });
  await assert.rejects(() => ai.translate({ text: 'hi', targetLanguage: '' }), { code: 'ERR_SYSTEMFABRIC_AI_INPUT_LIMIT' });
});

test('unsupported provider and missing API key fail closed', () => {
  assert.throws(() => createAIProviderFromEnv({ AI_PROVIDER: 'not-real' }), { code: 'ERR_SYSTEMFABRIC_AI_PROVIDER_UNKNOWN' });
  assert.throws(() => createAIProviderFromEnv({ AI_PROVIDER: 'openai-responses' }), { code: 'ERR_SYSTEMFABRIC_AI_NOT_CONFIGURED' });
  assert.throws(() => createAIProviderFromEnv({ AI_PROVIDER: 'anthropic' }), { code: 'ERR_SYSTEMFABRIC_AI_NOT_CONFIGURED' });
});

test('provider status does not expose keys', () => {
  const ai = createAIService({ env: { AI_PROVIDER: 'mock', AI_API_KEY: 'do-not-leak' }, audit: silentAudit() });
  assert.ok(!JSON.stringify(ai.providerInfo()).includes('do-not-leak'));
});

test('page-draft requires a real non-empty prompt', async () => {
  const ai = createAIService({ env: { AI_PROVIDER: 'mock' }, audit: silentAudit() });
  await assert.rejects(() => ai.generatePageDraft({ prompt: '' }), { code: 'ERR_SYSTEMFABRIC_AI_INPUT_LIMIT' });
  await assert.rejects(() => ai.generatePageDraft({ prompt: '   ' }), { code: 'ERR_SYSTEMFABRIC_AI_INPUT_LIMIT' });
  await assert.rejects(() => ai.generatePageDraft({ prompt: undefined }), { code: 'ERR_SYSTEMFABRIC_AI_INPUT_LIMIT' });
});


test('external AI processing fails closed until explicitly enabled', async () => {
  let calls = 0;
  const provider = { name: 'anthropic', model: 'unit-test', async generate() { calls += 1; return JSON.stringify({ text: 'result' }); } };
  const disabled = createAIService({ provider, env: { AI_ALLOWED_PROVIDERS: 'anthropic', AI_ALLOW_EXTERNAL_CONTENT: 'false' }, audit: silentAudit() });
  await assert.rejects(() => disabled.assistContent({ text: 'private content' }), { code: 'ERR_SYSTEMFABRIC_AI_EXTERNAL_CONTENT_DISABLED', statusCode: 403 });
  assert.equal(calls, 0);
  const enabled = createAIService({ provider, env: { AI_ALLOWED_PROVIDERS: 'anthropic', AI_ALLOW_EXTERNAL_CONTENT: 'true' }, audit: silentAudit() });
  const result = await enabled.assistContent({ text: 'approved content' });
  assert.equal(result.text, 'result');
  assert.equal(calls, 1);
});
