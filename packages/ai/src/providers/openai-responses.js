'use strict';

const { postJson, trimBaseUrl } = require('./utils');

function createOpenAIResponsesProvider({ apiKey, baseUrl = 'https://api.openai.com/v1', model = 'gpt-6-astra', timeoutMs = 30_000, strictJsonSchema = true, fetchImpl } = {}) {
  if (!apiKey) throw Object.assign(new Error('OPENAI_API_KEY is required for openai-responses.'), { code: 'ERR_SYSTEMFABRIC_AI_NOT_CONFIGURED' });
  const post = fetchImpl ? async (url, headers, body, ms) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw Object.assign(new Error(`AI provider request failed with HTTP ${response.status}.`), { code: 'ERR_SYSTEMFABRIC_AI_PROVIDER_HTTP', status: response.status });
      return await response.json();
    } finally { clearTimeout(timer); }
  } : postJson;
  return Object.freeze({
    name: 'openai-responses', model,
    async generate({ system, input, schemaName, schema, maxOutputTokens = 6000 }) {
      const text = { format: { type: 'text' } };
      if (schema && strictJsonSchema) text.format = { type: 'json_schema', name: schemaName, strict: true, schema };
      const result = await post(`${trimBaseUrl(baseUrl)}/responses`, { authorization: `Bearer ${apiKey}` }, {
        model,
        store: false,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: system }] },
          { role: 'user', content: [{ type: 'input_text', text: input }] }
        ],
        text,
        max_output_tokens: maxOutputTokens
      }, timeoutMs);
      if (typeof result.output_text === 'string') return result.output_text;
      const parts = [];
      for (const item of result.output || []) for (const content of item.content || []) if (content.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
      if (parts.length === 0) throw Object.assign(new Error('OpenAI Responses returned no text output.'), { code: 'ERR_SYSTEMFABRIC_AI_EMPTY_OUTPUT' });
      return parts.join('\n');
    }
  });
}

module.exports = { createOpenAIResponsesProvider };
