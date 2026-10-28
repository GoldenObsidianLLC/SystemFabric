import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRequire } from 'node:module';
import { createMcpServer } from '../adapters/mcp-server.mjs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const engine = require('../index.js');
const views = process.env.ENGINEX_VIEWS || process.cwd();
let provider;
if (process.env.OPENAI_API_KEY && process.env.ENGINEX_AI_MODEL) {
  provider = engine.createOpenAIProvider({ model: process.env.ENGINEX_AI_MODEL });
}
const handle = serveStdio(() => {
  const ai = engine.createAI({ engine, provider, renderOptions: { views, strictPaths: true } });
  return createMcpServer({ engine, ai, provider, renderOptions: { views, strictPaths: true } });
});
console.error(`EnginEx MCP server ready (views root: ${path.resolve(views)}; provider: ${provider ? 'configured' : 'not configured'}).`);
process.on('SIGINT', () => { void handle.close(); });
