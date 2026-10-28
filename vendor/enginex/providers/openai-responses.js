'use strict';

/**
 * Optional provider adapter using the OpenAI Responses API and Structured Outputs.
 * The core engine does not import this file or require an API key.
 * See https://developers.openai.com/api/docs/guides/structured-outputs
 */

class ProviderError extends Error {
  constructor(message, { code = 'ERR_ENGINEX_PROVIDER', status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProviderError';
    this.code = code;
    if (status) this.status = status;
  }
}

function createOpenAIResponsesProvider(configuration = {}) {
  const endpoint = new URL(configuration.baseURL || 'https://api.openai.com/v1/responses');
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
    throw new TypeError('Provider baseURL must use HTTPS (localhost is allowed for development).');
  }
  const fetchImpl = configuration.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible implementation is required.');
  const model = configuration.model;
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('Specify an explicit OpenAI model name.');
  const timeoutMs = Number.isSafeInteger(configuration.timeoutMs) ? Math.max(1_000, Math.min(configuration.timeoutMs, 180_000)) : 60_000;
  const maxRetries = Number.isSafeInteger(configuration.maxRetries) ? Math.max(0, Math.min(configuration.maxRetries, 3)) : 1;
  const apiKeyProvider = configuration.apiKey || (() => process.env.OPENAI_API_KEY);

  async function generateStructuredOutput(request) {
    if (!request || typeof request.system !== 'string' || !request.schema || !request.input) {
      throw new TypeError('Provider request must include system, schema, and input.');
    }
    const apiKey = typeof apiKeyProvider === 'function' ? apiKeyProvider() : apiKeyProvider;
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new ProviderError('OpenAI API key is not configured. Set OPENAI_API_KEY or pass apiKey.', { code: 'ERR_ENGINEX_PROVIDER_AUTH' });
    const body = {
      model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: request.system }] },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(request.input) }] }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: normalizeSchemaName(request.name || 'enginex_output'),
          strict: true,
          schema: request.schema
        }
      }
    };
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const signal = combineSignals(request.signal, AbortSignal.timeout(timeoutMs));
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal
        });
      } catch (cause) {
        if (request.signal && request.signal.aborted) throw new ProviderError('Provider request was aborted.', { code: 'ERR_ENGINEX_PROVIDER_ABORTED', cause });
        lastError = new ProviderError('OpenAI request failed before a response was received.', { code: 'ERR_ENGINEX_PROVIDER_NETWORK', cause });
        if (attempt < maxRetries) { await delay(backoff(attempt)); continue; }
        throw lastError;
      }
      if (!response.ok) {
        const bodyText = await safeText(response, 2_000);
        const retryable = response.status === 429 || response.status >= 500;
        lastError = new ProviderError(`OpenAI returned HTTP ${response.status}${bodyText ? `: ${bodyText}` : ''}`, {
          code: response.status === 401 || response.status === 403 ? 'ERR_ENGINEX_PROVIDER_AUTH' : 'ERR_ENGINEX_PROVIDER_HTTP',
          status: response.status
        });
        if (retryable && attempt < maxRetries) { await delay(backoff(attempt)); continue; }
        throw lastError;
      }
      let payload;
      try { payload = await response.json(); }
      catch (cause) { throw new ProviderError('OpenAI returned invalid JSON.', { code: 'ERR_ENGINEX_PROVIDER_RESPONSE', cause }); }
      const outputText = extractOutputText(payload);
      if (typeof outputText !== 'string') {
        const refusal = findRefusal(payload);
        if (refusal) throw new ProviderError(`The provider refused the request: ${refusal.slice(0, 500)}`, { code: 'ERR_ENGINEX_PROVIDER_REFUSAL' });
        throw new ProviderError('OpenAI response did not contain structured output text.', { code: 'ERR_ENGINEX_PROVIDER_RESPONSE' });
      }
      let parsed;
      try { parsed = JSON.parse(outputText); }
      catch (cause) { throw new ProviderError('Structured output was not valid JSON.', { code: 'ERR_ENGINEX_PROVIDER_INVALID_JSON', cause }); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ProviderError('Structured output must be a JSON object.', { code: 'ERR_ENGINEX_PROVIDER_INVALID_JSON' });
      }
      return parsed;
    }
    throw lastError || new ProviderError('Provider request failed.', {});
  }

  return Object.freeze({ name: 'openai-responses', model, generateStructuredOutput });
}

function normalizeSchemaName(value) {
  const name = String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return name || 'enginex_output';
}
function extractOutputText(payload) {
  if (typeof payload.output_text === 'string') return payload.output_text;
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return undefined;
}
function findRefusal(payload) {
  for (const item of payload.output || []) for (const content of item.content || []) if (content.type === 'refusal') return content.refusal || content.text || 'Request refused';
  return null;
}
function combineSignals(first, second) {
  if (!first) return second;
  if (first.aborted) return first;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second]);
  const controller = new AbortController();
  const abortFirst = () => controller.abort(first.reason);
  const abortSecond = () => controller.abort(second.reason);
  first.addEventListener('abort', abortFirst, { once: true });
  second.addEventListener('abort', abortSecond, { once: true });
  return controller.signal;
}
function backoff(attempt) { return Math.min(4_000, 250 * (2 ** attempt)) + Math.floor(Math.random() * 100); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function safeText(response, max) { try { return (await response.text()).slice(0, max).replace(/[\r\n]+/g, ' '); } catch { return ''; } }

module.exports = { createOpenAIResponsesProvider, ProviderError };
