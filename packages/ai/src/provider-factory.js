'use strict';

const { createOpenAIResponsesProvider } = require('./providers/openai-responses');
const { createOpenAICompatibleProvider } = require('./providers/openai-compatible');
const { createAnthropicProvider } = require('./providers/anthropic');
const { createGeminiProvider } = require('./providers/gemini');
const { createMockProvider } = require('./providers/mock');
const { boundedInt } = require('./config');

function createAIProviderFromEnv(env = process.env) {
  const provider = (env.AI_PROVIDER || 'mock').toLowerCase();
  const timeoutMs = boundedInt(env.AI_TIMEOUT_MS, 30_000, 1_000, 180_000, 'AI_TIMEOUT_MS');
  switch (provider) {
    case 'mock': return createMockProvider();
    case 'openai-responses': return createOpenAIResponsesProvider({
      apiKey: env.OPENAI_API_KEY || env.AI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: env.OPENAI_MODEL || env.AI_MODEL || 'gpt-6-astra', timeoutMs,
      strictJsonSchema: env.AI_USE_STRICT_JSON_SCHEMA !== 'false'
    });
    case 'openai-compatible': return createOpenAICompatibleProvider({
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL,
      model: env.AI_MODEL,
      timeoutMs,
      useStrictJsonSchema: env.OPENAI_COMPATIBLE_STRICT_JSON_SCHEMA === 'true'
    });
    case 'anthropic': return createAnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY || env.AI_API_KEY,
      baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
      model: env.ANTHROPIC_MODEL || env.AI_MODEL || 'claude-sonnet-5', timeoutMs
    });
    case 'gemini': return createGeminiProvider({
      apiKey: env.GEMINI_API_KEY || env.AI_API_KEY,
      baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
      model: env.GEMINI_MODEL || env.AI_MODEL || 'gemini-4-argon', timeoutMs
    });
    default: throw Object.assign(new Error(`Unsupported AI_PROVIDER: ${provider}`), { code: 'ERR_SYSTEMFABRIC_AI_PROVIDER_UNKNOWN' });
  }
}

module.exports = { createAIProviderFromEnv };
