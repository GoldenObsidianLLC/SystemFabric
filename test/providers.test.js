'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenAIResponsesProvider } = require('../packages/ai/src/providers/openai-responses');
const { createOpenAICompatibleProvider } = require('../packages/ai/src/providers/openai-compatible');
const { createAnthropicProvider } = require('../packages/ai/src/providers/anthropic');
const { createGeminiProvider } = require('../packages/ai/src/providers/gemini');
const { postJson } = require('../packages/ai/src/providers/utils');

const schema = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } };

test('OpenAI Responses adapter uses bearer auth and structured output format', async () => {
  let captured;
  const provider = createOpenAIResponsesProvider({
    apiKey: 'secret-key', baseUrl: 'https://example.invalid/v1', model: 'test-model', strictJsonSchema: true,
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return { ok: true, async json() { return { output_text: '{"text":"ok"}' }; } };
    }
  });
  const output = await provider.generate({ system: 'trusted task rules', input: 'hello', schemaName: 'test_schema', schema, maxOutputTokens: 123 });
  assert.equal(output, '{"text":"ok"}');
  assert.equal(captured.url, 'https://example.invalid/v1/responses');
  assert.equal(captured.options.headers.authorization, 'Bearer secret-key');
  assert.equal(captured.body.text.format.type, 'json_schema');
  assert.equal(captured.body.text.format.strict, true);
  assert.equal(captured.body.max_output_tokens, 123);
  assert.equal(captured.body.store, false);
});

test('OpenAI-compatible adapter uses configured base URL and JSON output mode', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"local"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const provider = createOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:11434/v1/', model: 'local-model', timeoutMs: 1000 });
    const output = await provider.generate({ system: 'Return JSON', input: 'hi', schemaName: 'text', schema });
    assert.equal(output, '{"text":"local"}');
    assert.equal(captured.url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.deepEqual(captured.body.response_format, { type: 'json_object' });
  } finally { global.fetch = originalFetch; }
});

test('Anthropic and Gemini adapters use headers rather than logging provider keys in URLs', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    const body = String(url).includes('/interactions')
      ? { steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"text":"gemini"}' }] }] }
      : { content: [{ type: 'text', text: '{"text":"claude"}' }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const anthropic = createAnthropicProvider({ apiKey: 'anthropic-secret', baseUrl: 'https://example.invalid/v1', model: 'test', timeoutMs: 1000 });
    assert.equal(await anthropic.generate({ system: 'Return JSON', input: 'hello', schemaName: 'test', schema }), '{"text":"claude"}');
    const gemini = createGeminiProvider({ apiKey: 'gemini-secret', baseUrl: 'https://example.invalid/v1beta', model: 'test', timeoutMs: 1000 });
    assert.equal(await gemini.generate({ system: 'Return JSON', input: 'hello', schemaName: 'test', schema }), '{"text":"gemini"}');
    assert.equal(calls[0].headers['x-api-key'], 'anthropic-secret');
    assert.equal(calls[1].headers['x-goog-api-key'], 'gemini-secret');
    assert.equal(calls[1].url, 'https://example.invalid/v1beta/interactions');
    assert.equal(calls[1].body.store, false);
    assert.deepEqual(calls[1].body.response_format, { type: 'text', mime_type: 'application/json', schema });
    assert.equal(calls[1].body.generation_config.max_output_tokens, 6000);
    assert.ok(!calls[1].url.includes('gemini-secret'));
  } finally { global.fetch = originalFetch; }
});


test('provider transport distinguishes caller cancellation from its own timeout', async () => {
  const controller = new AbortController();
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  let transportSignal;

  const pending = postJson(
    'https://example.invalid/v1/generate',
    {},
    { prompt: 'test' },
    5_000,
    {
      signal: controller.signal,
      fetchImpl: async (_url, options) => {
        transportSignal = options.signal;
        startedResolve();
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
    }
  );
  await started;
  controller.abort(new Error('test client disconnect'));

  await assert.rejects(pending, { code: 'ERR_SYSTEMFABRIC_AI_CANCELLED', statusCode: 499 });
  assert.equal(transportSignal.aborted, true);

  await assert.rejects(
    postJson(
      'https://example.invalid/v1/generate',
      {},
      { prompt: 'timeout test' },
      10,
      {
        fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        })
      }
    ),
    { code: 'ERR_SYSTEMFABRIC_AI_TIMEOUT' }
  );
});

test('OpenAI Responses provider forwards caller cancellation into its HTTP request', async () => {
  const controller = new AbortController();
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  let transportSignal;
  const provider = createOpenAIResponsesProvider({
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    fetchImpl: async (_url, options) => {
      transportSignal = options.signal;
      startedResolve();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
  });

  const pending = provider.generate({
    system: 'Return JSON',
    input: 'cancel this request',
    schemaName: 'test_schema',
    schema,
    signal: controller.signal
  });
  await started;
  controller.abort(new Error('caller disconnected'));

  await assert.rejects(pending, { code: 'ERR_SYSTEMFABRIC_AI_CANCELLED', statusCode: 499 });
  assert.equal(transportSignal.aborted, true);
});
