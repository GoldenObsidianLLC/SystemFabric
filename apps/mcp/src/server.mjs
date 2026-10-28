import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { loadEnvFile } = require('../../../scripts/load-env.js');
const { createAIService } = require('../../../packages/ai/src/service.js');
const { createWidgetRegistry } = require('../../../packages/widgets/src/registry.js');
const { validatePageDocument } = require('../../../packages/domain/src/page-document.js');
const { renderPageDocument, rendererInfo } = require('../../../packages/render/src/index.js');
loadEnvFile(path.resolve(process.cwd(), '.env'));
const ai = createAIService();
const widgets = createWidgetRegistry();

function jsonText(value) { return JSON.stringify(value, null, 2); }
function createServer() {
  const server = new McpServer({ name: 'systemfabric', version: '0.3.0' });

  server.registerTool('systemfabric_status', {
    description: 'Return non-sensitive SystemFabric runtime and AI provider status.',
    inputSchema: z.object({})
  }, async () => ({ content: [{ type: 'text', text: jsonText({ service: 'SystemFabric', version: '0.3.0', renderer: rendererInfo, ai: ai.providerInfo(), persistenceTools: 'not exposed through MCP; use authenticated CMS APIs for persistence' }) }] }));

  server.registerTool('systemfabric_list_widgets', {
    description: 'List approved core widget types and their editor metadata.',
    inputSchema: z.object({})
  }, async () => ({ content: [{ type: 'text', text: jsonText({ apiVersion: 1, widgets: widgets.list() }) }] }));

  server.registerTool('systemfabric_validate_page_document', {
    description: 'Validate a SystemFabric page document JSON string against the v1 domain contract. Does not save or publish.',
    inputSchema: z.object({ documentJson: z.string().min(2).max(250_000) })
  }, async ({ documentJson }) => {
    try {
      const document = JSON.parse(documentJson);
      const result = validatePageDocument(document);
      return { content: [{ type: 'text', text: jsonText(result) }], isError: !result.valid };
    } catch {
      return { content: [{ type: 'text', text: 'Input is not valid JSON.' }], isError: true };
    }
  });

  server.registerTool('systemfabric_generate_page_draft', {
    description: 'Generate a validated SystemFabric page-document proposal. The result is an unsaved draft proposal and is never published automatically.',
    inputSchema: z.object({ prompt: z.string().min(1).max(12_000), siteContext: z.string().max(3_000).optional() })
  }, async ({ prompt, siteContext = '' }) => {
    try {
      const result = await ai.generatePageDraft({ prompt, siteContext, actor: 'mcp-client' });
      return { content: [{ type: 'text', text: jsonText(result) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Generation failed: ${error.code || 'ERR_SYSTEMFABRIC_AI'}` }], isError: true };
    }
  });

  server.registerTool('systemfabric_render_preview', {
    description: 'Render a validated SystemFabric page document to safe HTML for local preview. Does not persist the page.',
    inputSchema: z.object({ documentJson: z.string().min(2).max(250_000) })
  }, async ({ documentJson }) => {
    try {
      const document = JSON.parse(documentJson);
      const validation = validatePageDocument(document);
      if (!validation.valid) return { content: [{ type: 'text', text: jsonText(validation) }], isError: true };
      return { content: [{ type: 'text', text: renderPageDocument(document) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Preview failed: ${error.code || 'ERR_SYSTEMFABRIC_PREVIEW'}` }], isError: true };
    }
  });

  return server;
}

void serveStdio(createServer);
console.error('SystemFabric MCP stdio server started. No publish/delete tools are exposed.');
