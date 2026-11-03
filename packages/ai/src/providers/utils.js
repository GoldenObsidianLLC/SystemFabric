'use strict';

function trimBaseUrl(value) { return String(value || '').replace(/\/+$/, ''); }

function createAICancellationError(cause) {
  const error = new Error('AI task was cancelled because the requesting client disconnected.');
  error.code = 'ERR_VIRGOSCORPIO_HUB_AI_CANCELLED';
  error.statusCode = 499;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function parseJson(text, providerName) {
  if (typeof text !== 'string') throw new Error(`${providerName} returned no text content.`);
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {
    const error = new Error(`${providerName} returned malformed JSON; output rejected.`);
    error.code = 'ERR_VIRGOSCORPIO_HUB_AI_INVALID_JSON';
    throw error;
  }
}

/**
 * POST one stateless JSON request to an AI provider.
 *
 * The provider timeout and the caller's cancellation signal are composed into
 * one AbortController. Caller cancellation is distinguished from a provider
 * timeout so task audits can record the correct outcome without exposing
 * provider response bodies or request credentials.
 */
async function postJson(url, headers, body, timeoutMs, { signal, fetchImpl = fetch } = {}) {
  if (signal !== undefined && (
    !signal ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  )) {
    throw Object.assign(new Error('AI request cancellation signal is invalid.'), {
      code: 'ERR_VIRGOSCORPIO_HUB_AI_SIGNAL_INVALID',
      statusCode: 500
    });
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof fetchImpl !== 'function') {
    throw Object.assign(new Error('AI provider request configuration is invalid.'), {
      code: 'ERR_VIRGOSCORPIO_HUB_AI_CONFIG',
      statusCode: 500
    });
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => {
    if (!controller.signal.aborted) controller.abort(signal?.reason);
  };

  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('AI request timed out'));
  }, timeoutMs);

  try {
    if (signal?.aborted) throw createAICancellationError(signal.reason);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`AI provider request failed with HTTP ${response.status}.`);
      error.code = 'ERR_VIRGOSCORPIO_HUB_AI_PROVIDER_HTTP';
      error.status = response.status;
      throw error;
    }
    const result = await response.json();
    if (signal?.aborted) throw createAICancellationError(signal.reason);
    return result;
  } catch (error) {
    if (timedOut) {
      const timeout = new Error('AI provider request timed out.');
      timeout.code = 'ERR_VIRGOSCORPIO_HUB_AI_TIMEOUT';
      timeout.cause = error;
      throw timeout;
    }
    if (signal?.aborted) throw createAICancellationError(error || signal.reason);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

function makeOutputInstruction(schemaName, schema) {
  return `Return only one JSON object named by this task. Do not use Markdown fences. Output must match the supplied schema (${schemaName}). Do not add keys. Schema: ${JSON.stringify(schema)}`;
}

module.exports = {
  trimBaseUrl,
  parseJson,
  postJson,
  makeOutputInstruction,
  createAICancellationError
};
