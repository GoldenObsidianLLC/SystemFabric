import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const MAX_SOURCE = 256 * 1024;

/**
 * Construct an optional MCP server. The module only loads its MCP SDK when
 * explicitly imported, keeping the EnginEx core dependency-free.
 * No file-write or publish tools are exposed by this adapter.
 */
export function createMcpServer(configuration = {}) {
  const engine = configuration.engine || requireEngine();
  const ai = configuration.ai || engine.createAI({
    provider: configuration.provider,
    renderOptions: configuration.renderOptions || {},
    permissions: configuration.permissions || {}
  });
  const server = new McpServer(
    { name: 'enginex-ai', version: engine.version || '5.0.0', title: 'EnginEx AI Template Tools' },
    { maxToolInputElements: 10_000 }
  );

  const respond = async operation => {
    try {
      const result = await operation();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code || 'ERR_ENGINEX_MCP_TOOL', message: error.message }) }] };
    }
  };

  server.registerTool('enginex_describe', {
    title: 'Describe EnginEx capabilities',
    description: 'Return the versioned machine-readable language, helper, security and AI integration capabilities. Read-only and local.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async () => respond(() => ai.describe()));

  server.registerTool('enginex_validate_template', {
    title: 'Validate an EnginEx template',
    description: 'Parse and statically validate template syntax, helper names, feature usage, data-schema constraints, and heuristic output-security risks. Does not write files or call an AI provider.',
    inputSchema: z.object({
      source: z.string().max(MAX_SOURCE),
      filename: z.string().max(512).optional(),
      dataSchema: z.record(z.string(), z.unknown()).optional(),
      sampleData: z.unknown().optional()
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async args => respond(() => ai.validateTemplate(args)));

  server.registerTool('enginex_preview_template', {
    title: 'Preview an EnginEx template',
    description: 'Render a supplied template string against caller-supplied preview data using EnginEx safe mode. Only use synthetic or explicitly authorized data. No file writes. Partials/layouts resolve under the configured template root.',
    inputSchema: z.object({
      source: z.string().max(MAX_SOURCE),
      filename: z.string().max(512).optional(),
      sampleData: z.unknown().optional(),
      dataSchema: z.record(z.string(), z.unknown()).optional()
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async args => respond(() => ai.previewTemplate(args)));

  server.registerTool('enginex_explain_template', {
    title: 'Explain a template',
    description: 'Analyze a template and return a structured inventory of data references, helper calls, filters, partials, layouts, blocks, diagnostics and security review notes. Local and read-only.',
    inputSchema: z.object({ source: z.string().max(MAX_SOURCE), filename: z.string().max(512).optional(), purpose: z.string().max(2000).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async args => respond(() => ai.explainTemplate(args)));

  if (ai.providerConfigured) {
    server.registerTool('enginex_generate_template', {
      title: 'Generate an EnginEx template draft',
      description: 'Ask the configured model provider to generate a template draft from a description and data schema. The draft is validated before returning. It is not saved or published.',
      inputSchema: z.object({
        description: z.string().min(10).max(10_000),
        filename: z.string().max(512).optional(),
        dataSchema: z.record(z.string(), z.unknown()).optional(),
        layout: z.string().max(512).optional(),
        conventions: z.string().max(5000).optional()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false }
    }, async args => respond(() => ai.generateTemplate(args)));

    server.registerTool('enginex_repair_template', {
      title: 'Repair an EnginEx template draft',
      description: 'Ask the configured model provider to repair a supplied template using authoritative EnginEx diagnostics. Result is validated and never written automatically.',
      inputSchema: z.object({ source: z.string().max(MAX_SOURCE), filename: z.string().max(512).optional(), dataSchema: z.record(z.string(), z.unknown()).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false }
    }, async args => respond(() => ai.repairTemplate(args)));

    server.registerTool('enginex_optimize_template', {
      title: 'Propose a template optimization',
      description: 'Ask the configured model provider for a proposed, validated template revision. Optional test fixtures compare exact rendered output; performance gains still require benchmarking. Never writes or publishes.',
      inputSchema: z.object({
        source: z.string().max(MAX_SOURCE),
        filename: z.string().max(512).optional(),
        testCases: z.array(z.object({ name: z.string().optional(), locals: z.unknown() })).max(20).optional()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false }
    }, async args => respond(() => ai.optimizeTemplate(args)));
  }

  server.registerResource('capabilities', 'enginex://capabilities', {
    title: 'EnginEx capabilities', description: 'Machine-readable EnginEx feature and security manifest.', mimeType: 'application/json'
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ai.describe(), null, 2) }] }));

  server.registerResource('template-grammar', 'enginex://language/grammar', {
    title: 'EnginEx template grammar', description: 'Versioned machine-readable template grammar and constraints.', mimeType: 'application/json'
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ai.getGrammar(), null, 2) }] }));

  server.registerResource('security-model', 'enginex://docs/security', {
    title: 'EnginEx security model', description: 'Security boundaries and known caveats for template and AI integrations.', mimeType: 'text/markdown'
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: SECURITY_SUMMARY }] }));

  server.registerResource('manifest-schema', 'enginex://schema/template-manifest', {
    title: 'Template manifest schema', description: 'Schema for template metadata, helper allow-lists and security policy.', mimeType: 'application/schema+json'
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: JSON.stringify(ai.getManifestSchema(), null, 2) }] }));

  server.registerPrompt('enginex_create_template', {
    title: 'Create an EnginEx template',
    description: 'Create a safe EnginEx template draft based on requirements and a data contract.',
    argsSchema: z.object({ description: z.string().min(10).max(10_000), dataSchemaJson: z.string().max(20_000).optional() })
  }, ({ description, dataSchemaJson }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Create an EnginEx template using the restricted grammar. Do not use arbitrary JavaScript. Validate the output with enginex_validate_template before presenting it.\nRequirements:\n${description}\nData schema JSON (if supplied):\n${dataSchemaJson || 'Not supplied.'}` } }] }));

  server.registerPrompt('enginex_fix_template', {
    title: 'Fix an EnginEx template',
    description: 'Diagnose and minimally repair an EnginEx template.',
    argsSchema: z.object({ source: z.string().max(MAX_SOURCE), diagnosticsJson: z.string().max(20_000) })
  }, ({ source, diagnosticsJson }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Repair this EnginEx template with the smallest behavior-preserving change. Use only registered helpers and restricted syntax. Never write files or publish.\nTemplate:\n${source}\nDiagnostics:\n${diagnosticsJson}` } }] }));

  server.registerPrompt('enginex_security_review', {
    title: 'Review template security',
    description: 'Review an EnginEx template for contextual output, raw output, active HTML and helper boundary risks.',
    argsSchema: z.object({ source: z.string().max(MAX_SOURCE) })
  }, ({ source }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Review this template for HTML/URL/script/style context risks, raw output, active static HTML, excessive loops, partial path assumptions and helper capability risks. Treat parser diagnostics as authoritative for syntax but do not claim static analysis proves safety.\nTemplate:\n${source}` } }] }));

  return server;
}

function requireEngine() {
  // This path is only used when the adapter is imported directly by a consumer.
  // The package's public entry point injects the configured engine instance.
  // eslint-disable-next-line global-require
  return require('../index.js');
}

const SECURITY_SUMMARY = `# EnginEx security model\n\n- Safe expressions are interpreted by EnginEx and never evaluated as JavaScript.\n- Legacy <?njs ?> execution is an explicit unsafe compatibility feature and is not exposed in safe preview tools.\n- Ordinary output is HTML-escaped; this does not provide JavaScript or CSS contextual escaping.\n- Static HTML is not sanitized; template authors are trusted application contributors unless separately isolated.\n- Custom helpers execute application code and must be allow-listed and capability-limited.\n- AI-generated templates are untrusted drafts. Validate and preview before review; file writes and publication are disabled by default.\n- MCP preview accepts caller-supplied data only and does not query production systems by itself.\n- Any HTTP-hosted MCP deployment must add authentication, authorization, origin/host protections, rate limits and transport-level request limits.\n`;
