'use strict';

const { postJson, trimBaseUrl, makeOutputInstruction } = require('./utils');

function createAnthropicProvider({ apiKey, baseUrl = 'https://api.anthropic.com/v1', model = 'claude-sonnet-5', timeoutMs = 30_000 } = {}) {
  if (!apiKey) throw Object.assign(new Error('ANTHROPIC_API_KEY is required for anthropic.'), { code: 'ERR_SYSTEMFABRIC_AI_NOT_CONFIGURED' });
  return Object.freeze({
    name: 'anthropic', model,
    async generate({ system, input, schemaName, schema, maxOutputTokens = 6000 }) {
      const result = await postJson(`${trimBaseUrl(baseUrl)}/messages`, {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }, {
        model,
        max_tokens: maxOutputTokens,
        system: `${system}\n\n${schema ? makeOutputInstruction(schemaName, schema) : 'Return only the requested result.'}`,
        messages: [{ role: 'user', content: [{ type: 'text', text: input }] }]
      }, timeoutMs);
      const text = (result.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (!text) throw Object.assign(new Error('Anthropic returned no text output.'), { code: 'ERR_SYSTEMFABRIC_AI_EMPTY_OUTPUT' });
      return text;
    }
  });
}

module.exports = { createAnthropicProvider };
