'use strict';

function trimBaseUrl(value) { return String(value || '').replace(/\/+$/, ''); }
function parseJson(text, providerName) {
  if (typeof text !== 'string') throw new Error(`${providerName} returned no text content.`);
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {
    const error = new Error(`${providerName} returned malformed JSON; output rejected.`);
    error.code = 'ERR_SYSTEMFABRIC_AI_INVALID_JSON';
    throw error;
  }
}
async function postJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('AI request timed out')), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`AI provider request failed with HTTP ${response.status}.`);
      error.code = 'ERR_SYSTEMFABRIC_AI_PROVIDER_HTTP';
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError' || error.message === 'AI request timed out') {
      const timeout = new Error('AI provider request timed out.');
      timeout.code = 'ERR_SYSTEMFABRIC_AI_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function makeOutputInstruction(schemaName, schema) {
  return `Return only one JSON object named by this task. Do not use Markdown fences. Output must match the supplied schema (${schemaName}). Do not add keys. Schema: ${JSON.stringify(schema)}`;
}

module.exports = { trimBaseUrl, parseJson, postJson, makeOutputInstruction };
