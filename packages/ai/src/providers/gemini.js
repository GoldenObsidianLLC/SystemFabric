'use strict';

const { postJson, trimBaseUrl } = require('./utils');

function createGeminiProvider({
  apiKey,
  baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  model = 'gemini-4-argon',
  timeoutMs = 30_000
} = {}) {
  if (!apiKey) throw Object.assign(new Error('GEMINI_API_KEY is required for gemini.'), { code: 'ERR_SYSTEMFABRIC_AI_NOT_CONFIGURED' });
  return Object.freeze({
    name: 'gemini', model,
    async generate({ system, input, schemaName, schema, maxOutputTokens = 6000 }) {
      const body = {
        model,
        input,
        system_instruction: system,
        generation_config: { max_output_tokens: maxOutputTokens },
        // SystemFabric uses stateless requests; do not persist an Interaction for retrieval.
        store: false
      };
      if (schema) body.response_format = { type: 'text', mime_type: 'application/json', schema };
      const result = await postJson(`${trimBaseUrl(baseUrl)}/interactions`, { 'x-goog-api-key': apiKey }, body, timeoutMs);
      let text = typeof result.output_text === 'string' ? result.output_text : '';
      if (!text) {
        const outputSteps = (result.steps || []).filter(step => step.type === 'model_output');
        text = outputSteps.flatMap(step => step.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n');
      }
      // Keep a tolerant parser for the standard Interactions API's raw response shape.
      if (!text) {
        text = (result.output || []).flatMap(item => item.content || []).filter(part => part.type === 'output_text' || part.type === 'text').map(part => part.text || '').join('\n');
      }
      if (!text) throw Object.assign(new Error('Gemini returned no text output.'), { code: 'ERR_SYSTEMFABRIC_AI_EMPTY_OUTPUT' });
      return text;
    }
  });
}

module.exports = { createGeminiProvider };
