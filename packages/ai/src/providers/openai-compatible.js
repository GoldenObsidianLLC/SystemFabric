'use strict';

const { postJson, trimBaseUrl } = require('./utils');

function createOpenAICompatibleProvider({ apiKey = '', baseUrl, model, timeoutMs = 30_000, useStrictJsonSchema = false } = {}) {
  if (!baseUrl || !model) throw Object.assign(new Error('AI_BASE_URL and AI_MODEL are required for openai-compatible.'), { code: 'ERR_SYSTEMFABRIC_AI_NOT_CONFIGURED' });
  return Object.freeze({
    name: 'openai-compatible', model,
    async generate({ system, input, schemaName, schema, maxOutputTokens = 6000 }) {
      const body = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: input }
        ],
        max_tokens: maxOutputTokens,
        temperature: 0.2
      };
      if (schema) {
        body.response_format = useStrictJsonSchema
          ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
          : { type: 'json_object' };
      }
      const result = await postJson(`${trimBaseUrl(baseUrl)}/chat/completions`, apiKey ? { authorization: `Bearer ${apiKey}` } : {}, body, timeoutMs);
      const content = result.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map(part => typeof part.text === 'string' ? part.text : '').join('\n');
      throw Object.assign(new Error('OpenAI-compatible endpoint returned no text output.'), { code: 'ERR_SYSTEMFABRIC_AI_EMPTY_OUTPUT' });
    }
  });
}

module.exports = { createOpenAICompatibleProvider };
