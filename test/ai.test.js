'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAIService } = require('../packages/ai/src/service');
const { createAIProviderFromEnv } = require('../packages/ai/src/provider-factory');
const { createAICancellationError } = require('../packages/ai/src/providers/utils');
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


test('AI service propagates caller cancellation and records a safe cancelled outcome', async () => {
  const controller = new AbortController();
  const auditEvents = [];
  let providerSignal = null;
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const provider = {
    name: 'mock',
    model: 'cancellation-test',
    async generate({ signal }) {
      providerSignal = signal;
      startedResolve();
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(createAICancellationError(signal.reason));
          return;
        }
        signal.addEventListener('abort', () => reject(createAICancellationError(signal.reason)), { once: true });
      });
    }
  };
  const ai = createAIService({
    provider,
    env: { AI_ALLOWED_PROVIDERS: 'mock' },
    audit: event => auditEvents.push(event)
  });

  const pending = ai.assistContent({ text: 'This request should be cancelled.', signal: controller.signal });
  await started;
  controller.abort(new Error('test client disconnected'));

  await assert.rejects(pending, {
    code: 'ERR_SYSTEMFABRIC_AI_CANCELLED',
    statusCode: 499
  });
  assert.equal(providerSignal, controller.signal, 'the exact task signal reaches the provider adapter');
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].succeeded, false);
  assert.equal(auditEvents[0].errorCode, 'ERR_SYSTEMFABRIC_AI_CANCELLED');
});

test('pre-cancelled AI requests do not invoke a provider', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const ai = createAIService({
    provider: { name: 'mock', model: 'cancellation-test', async generate() { calls += 1; return JSON.stringify({ text: 'unexpected' }); } },
    env: { AI_ALLOWED_PROVIDERS: 'mock' },
    audit: silentAudit()
  });

  await assert.rejects(
    ai.assistContent({ text: 'Do not send this.', signal: controller.signal }),
    { code: 'ERR_SYSTEMFABRIC_AI_CANCELLED', statusCode: 499 }
  );
  assert.equal(calls, 0);
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
