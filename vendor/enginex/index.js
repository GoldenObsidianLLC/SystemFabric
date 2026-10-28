'use strict';

const engine = require('./engine');
const { createAI, AIIntegrationError } = require('./ai');
const { describe, getGrammar, getManifestSchema } = require('./lib/metadata');
const schemaTools = require('./lib/schema');
const { SharedWorkerPool } = require('./lib/shared-worker-pool');
const { DirtyBitSet, FragmentDependencyGraph, pathMatchesDependency } = require('./lib/dirty-bitset');
const { createResponseCache, ResponseCache } = require('./lib/response-cache');
const { getAccelerationCapabilities, probeAccelerationCapabilities } = require('./lib/backend-capabilities');

engine.describe = options => describe(engine, options || {});
engine.getGrammar = getGrammar;
engine.getManifestSchema = getManifestSchema;
engine.validateData = schemaTools.validateData;
engine.validateSchemaDefinition = schemaTools.validateSchemaDefinition;
engine.createAI = options => createAI({ ...(options || {}), engine });
engine.createOpenAIProvider = options => require('./providers/openai-responses').createOpenAIResponsesProvider(options);
engine.createMcpServer = async options => {
  const { createMcpServer } = await import('./adapters/mcp-server.mjs');
  return createMcpServer({ ...(options || {}), engine });
};
engine.ai = Object.freeze({ createAI, AIIntegrationError });
engine.createSharedWorkerPool = options => new SharedWorkerPool(options || {});
engine.createWasmSimdAccelerator = options => require('./accelerators/wasm-simd').createWasmSimdAccelerator(options || {});
engine.createWebGpuScanner = options => require('./accelerators/webgpu-scanner').createWebGpuScanner(options || {});
engine.attachWebSocketLivePreview = options => require('./transports/websocket-live-preview').attachWebSocketLivePreview(options || {});
engine.wrapRtcDataChannel = (channel, options) => require('./transports/webrtc-data-channel').wrapRtcDataChannel(channel, options || {});
engine.connectWebTransport = async (url, options) => {
  const transport = await import('./transports/webtransport-client.mjs');
  return transport.connectWebTransport(url, options || {});
};
engine.getAccelerationCapabilities = getAccelerationCapabilities;
engine.probeAccelerationCapabilities = probeAccelerationCapabilities;
engine.createResponseCache = options => createResponseCache(options || {});
engine.ResponseCache = ResponseCache;
engine.DirtyBitSet = DirtyBitSet;
engine.FragmentDependencyGraph = FragmentDependencyGraph;
engine.pathMatchesDependency = pathMatchesDependency;
engine.version = '6.2.0';
module.exports = engine;
