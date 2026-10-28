'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const engine = require('../index');
const { createOpenAIResponsesProvider } = require('../providers/openai-responses');

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enginex-ai-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const productSchema = {
  type: 'object', additionalProperties: false, required: ['user', 'products'],
  properties: {
    user: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
    products: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'price'], properties: { name: { type: 'string' }, price: { type: 'number', minimum: 0 } } } }
  }
};

test('AI capability manifest and grammar are available without providers', () => {
  const ai = engine.createAI();
  const manifest = ai.describe();
  assert.equal(manifest.name, 'EnginEx');
  assert.equal(manifest.version, '6.2.0');
  assert.equal(manifest.language.arbitraryJavaScriptInSafeMode, false);
  assert.ok(ai.getGrammar().productions.expression);
  assert.ok(ai.getManifestSchema().properties.security);
  assert.equal(ai.providerConfigured, false);
});

test('static source validation discovers helpers, partials, features, and rejects unknown helpers', () => {
  const ai = engine.createAI();
  const result = ai.validateTemplate({ source: '<h1>{{ user.name | upper }}</h1>{{> "card.html" user}}{{ unknownThing(user.name) }}' });
  assert.equal(result.valid, false);
  assert.ok(result.analysis.partials.includes('card.html'));
  assert.ok(result.analysis.filters.includes('upper'));
  assert.ok(result.diagnostics.some(item => item.code === 'ERR_ENGINEX_UNKNOWN_HELPER' && item.helper === 'unknownThing'));
});

test('AI preview renders inline safely and escapes model/user input', async t => {
  const root = await tempRoot(t);
  const ai = engine.createAI({ renderOptions: { views: root } });
  const result = await ai.previewTemplate({
    source: '<h1>{{ user.name }}</h1>',
    sampleData: { user: { name: '<script>alert(1)</script>' } },
    renderOptions: { views: root }
  });
  assert.equal(result.success, true);
  assert.equal(result.html, '<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>');
});

test('AI preview supports partials from the configured root without creating a temp source file', async t => {
  const root = await tempRoot(t);
  await fs.writeFile(path.join(root, 'card.html'), '<b>{{ name }}</b>');
  const ai = engine.createAI({ renderOptions: { views: root } });
  const result = await ai.previewTemplate({
    source: '{{> "card.html" person}}',
    sampleData: { person: { name: 'Ada' } },
    filename: 'index.html',
    renderOptions: { views: root }
  });
  assert.equal(result.success, true);
  assert.equal(result.html, '<b>Ada</b>');
});

test('data schema rejects unknown keys and accessor data without invoking getters', () => {
  const schema = { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1 } } };
  assert.equal(engine.validateData({ name: 'Ada' }, schema).valid, true);
  assert.equal(engine.validateData({ name: '', extra: 1 }, schema).valid, false);
  let called = false;
  const data = {};
  Object.defineProperty(data, 'name', { enumerable: true, get() { called = true; return 'secret'; } });
  const result = engine.validateData(data, schema);
  assert.equal(result.valid, false);
  assert.equal(called, false);
});

test('schema definition rejects refs and suspicious regex patterns', () => {
  assert.throws(() => engine.validateSchemaDefinition({ type: 'string', $ref: '#/defs/x' }), { code: 'ERR_ENGINEX_SCHEMA_DEFINITION' });
  assert.throws(() => engine.validateSchemaDefinition({ type: 'string', pattern: '(a+)+$' }), { code: 'ERR_ENGINEX_SCHEMA_DEFINITION' });
});

test('AI generation validates provider output and never publishes it automatically', async () => {
  const provider = {
    async generateStructuredOutput(request) {
      assert.equal(request.name, 'enginex_template_draft');
      return { template: '<h1>{{ user.name }}</h1>', rationale: ['Simple semantic heading'], requiredHelpers: [] };
    }
  };
  const ai = engine.createAI({ provider });
  const result = await ai.generateTemplate({ description: 'Render a user profile heading safely.', dataSchema: productSchema });
  assert.equal(result.valid, true);
  assert.equal(result.published, false);
  assert.equal(result.requiresHumanReview, true);
});

test('AI repair uses authoritative diagnostics and returns an uncommitted draft', async () => {
  const provider = { async generateStructuredOutput() { return { template: '<p>{{ name }}</p>', rationale: ['Removed unsupported JavaScript'], requiredHelpers: [] }; } };
  const ai = engine.createAI({ provider });
  const result = await ai.repairTemplate({ source: '<p>{{ name.toUpperCase() }}</p>', maxAttempts: 1 });
  assert.equal(result.valid, true);
  assert.equal(result.published, false);
  assert.equal(result.attempts.length, 1);
});

test('optimization reports equivalence only against provided fixtures', async t => {
  const root = await tempRoot(t);
  const provider = { async generateStructuredOutput() { return { template: '<h1>{{ name }}</h1>', rationale: ['No unnecessary structure'], expectedEffects: ['Maintainability'] }; } };
  const ai = engine.createAI({ provider, renderOptions: { views: root } });
  const result = await ai.optimizeTemplate({
    source: '<h1>{{ name }}</h1>',
    renderOptions: { views: root },
    testCases: [{ name: 'safe name', locals: { name: 'Ada' } }, { name: 'escaped name', locals: { name: '<b>' } }]
  });
  assert.equal(result.success, true);
  assert.equal(result.semanticEquivalence, 'matched-provided-fixtures-only');
  assert.equal(result.requiresBenchmark, true);
});

test('publication is disabled by default, requires two permissions and a host approval', async t => {
  const root = await tempRoot(t);
  const defaultAI = engine.createAI({ renderOptions: { views: root } });
  await assert.rejects(defaultAI.publishTemplate({ filename: 'template.html', source: '<p>hi</p>' }), { code: 'ERR_ENGINEX_AI_PERMISSION' });
  const ai = engine.createAI({
    renderOptions: { views: root },
    permissions: { publish: true, writeFiles: true },
    approvePublish: async () => true
  });
  const result = await ai.publishTemplate({ filename: 'template.html', source: '<p>approved</p>' });
  assert.equal(result.published, true);
  assert.equal(await fs.readFile(path.join(root, 'template.html'), 'utf8'), '<p>approved</p>');
});

test('publishing rejects path traversal', async t => {
  const root = await tempRoot(t);
  const ai = engine.createAI({ renderOptions: { views: root }, permissions: { publish: true, writeFiles: true }, approvePublish: async () => true });
  await assert.rejects(ai.publishTemplate({ filename: '../escape.html', source: '<p>hi</p>' }), { code: 'ERR_ENGINEX_AI_PATH_REJECTED' });
});

test('OpenAI provider uses Responses API JSON Schema and returns structured JSON', async () => {
  let outgoing;
  const provider = createOpenAIResponsesProvider({
    apiKey: 'test-secret-not-logged', model: 'test-model', maxRetries: 0,
    fetch: async (url, options) => {
      outgoing = { url: String(url), options, body: JSON.parse(options.body) };
      return { ok: true, async json() { return { output_text: JSON.stringify({ template: '<p>Hello</p>', rationale: [], requiredHelpers: [] }) }; } };
    }
  });
  const response = await provider.generateStructuredOutput({ name: 'test', system: 'Generate JSON.', schema: { type: 'object', properties: { template: { type: 'string' } }, required: ['template'], additionalProperties: false }, input: { description: 'test' } });
  assert.equal(response.template, '<p>Hello</p>');
  assert.equal(outgoing.body.text.format.type, 'json_schema');
  assert.equal(outgoing.options.headers.authorization, 'Bearer test-secret-not-logged');
});

test('raw output and active static HTML are flagged for separate security review', () => {
  const ai = engine.createAI();
  const result = ai.validateTemplate({ source: '<script>alert(1)</script><div onclick="x()">{{{ content }}}</div>' });
  assert.ok(result.diagnostics.some(item => item.code === 'ENGINEX_ACTIVE_HTML_REVIEW'));
  assert.ok(result.diagnostics.some(item => item.code === 'ENGINEX_RAW_OUTPUT_REVIEW'));
});


test('scope-aware analysis ignores loop and with aliases and checks declared root locals', () => {
  const ai = engine.createAI();
  const schema = {
    type: 'object', additionalProperties: false, required: ['products', 'siteName'],
    properties: {
      products: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false } },
      siteName: { type: 'string' }
    }
  };
  const good = ai.validateTemplate({
    source: '<h1>{{ siteName }}</h1>{{#each products as product, i}}<b>{{ i }} {{ product.name }}</b>{{/each}}',
    dataSchema: schema
  });
  assert.equal(good.valid, true, JSON.stringify(good.diagnostics));
  assert.deepEqual(good.analysis.dataReferences, ['products', 'siteName']);
  const bad = ai.validateTemplate({ source: '<p>{{ prodcuts }}</p>', dataSchema: schema });
  assert.equal(bad.valid, false);
  assert.ok(bad.diagnostics.some(item => item.code === 'ERR_ENGINEX_SCHEMA_UNKNOWN_REFERENCE' && item.reference === 'prodcuts'));
  const rootBad = ai.validateTemplate({ source: '<p>{{ @root.missingRoot }}</p>', dataSchema: schema });
  assert.equal(rootBad.valid, false);
  assert.ok(rootBad.diagnostics.some(item => item.code === 'ERR_ENGINEX_SCHEMA_UNKNOWN_REFERENCE' && item.reference === 'missingRoot'));
});

test('quoted attribute helper escapes quotes and markup before trusted interpolation', async () => {
  const html = await engine.renderSource('<input value="{{{ htmlAttr(input) }}}">', {
    locals: { input: '" onfocus="alert(1) <tag> &' }
  });
  assert.equal(html, '<input value="&quot; onfocus=&quot;alert(1) &lt;tag&gt; &amp;">');
});

test('deterministic malformed-template fuzz cases never escape as non-diagnostics', () => {
  const ai = engine.createAI();
  let seed = 0x12345678;
  const next = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed; };
  const alphabet = ['<div>', '{{', '}}', '{{#if x}}', '{{/each}}', "'", '(', ')', '😀', '\u0000', '{{ foo(', '\n', '{{!--', '--}}'];
  for (let i = 0; i < 300; i++) {
    let source = '';
    const chunks = 1 + (next() % 15);
    for (let j = 0; j < chunks; j++) source += alphabet[next() % alphabet.length];
    const result = ai.validateTemplate({ source });
    assert.equal(typeof result.valid, 'boolean');
    assert.ok(Array.isArray(result.diagnostics));
  }
});
