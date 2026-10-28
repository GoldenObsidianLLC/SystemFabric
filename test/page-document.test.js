'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePageDocument, normalizeGeneratedDocument } = require('../packages/domain/src/page-document');
const { renderPageDocument, rendererInfo, MAX_RENDERED_OUTPUT_BYTES } = require('../packages/render/src');

function fixture(text = 'Hello SystemFabric') {
  return {
    schemaVersion: 1, documentId: 'page-test', type: 'page', title: 'Test Page',
    children: [{ id: 'section-1', type: 'section', props: { className: 'sf-hero' }, children: [
      { id: 'heading-1', type: 'widget.heading', props: { text, level: 1 }, children: [] },
      { id: 'text-1', type: 'widget.text', props: { text: 'A simple introduction.' }, children: [] },
      { id: 'button-1', type: 'widget.button', props: { text: 'Explore', url: '/explore' }, children: [] }
    ] }]
  };
}

test('valid v1 page document passes validation', () => {
  const result = validatePageDocument(fixture());
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.nodeCount, 4);
});

test('rejects unsafe URL, duplicate IDs, and unsupported properties', () => {
  const doc = fixture();
  doc.children[0].children[2].props.url = 'javascript:alert(1)';
  doc.children[0].children[1].id = 'heading-1';
  doc.children[0].children[0].props.style = 'background:url(javascript:alert(1))';
  const result = validatePageDocument(doc);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('relative path or http(s)')));
  assert.ok(result.errors.some(e => e.includes('duplicated')));
  assert.ok(result.errors.some(e => e.includes('style is not allowed')));
});

test('normalization replaces generated identifiers and removes irrelevant null props', () => {
  const input = {
    schemaVersion: 1, documentId: 'draft', type: 'page', title: 'AI page', children: [
      { id: 'm1', type: 'widget.heading', props: { text: 'Hello', level: 2, url: null, assetId: null, alt: null, className: null }, children: [] }
    ]
  };
  const normalized = normalizeGeneratedDocument(input);
  assert.notEqual(normalized.documentId, 'draft');
  assert.notEqual(normalized.children[0].id, 'm1');
  assert.deepEqual(normalized.children[0].props, { text: 'Hello', level: 2 });
  assert.equal(validatePageDocument(normalized).valid, true);
});

test('EnginEx renderer escapes text and outputs a safe page', () => {
  const html = renderPageDocument(fixture('<script>alert(1)</script>'));
  assert.equal(rendererInfo.name, 'enginex-ai-native');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('href="/explore"'));
  assert.ok(html.includes('<main>'));
});

test('renderer rejects invalid document rather than best-effort rendering', () => {
  const doc = fixture();
  doc.children[0].children[2].props.url = 'data:text/html,hi';
  assert.throws(() => renderPageDocument(doc), { code: 'ERR_SYSTEMFABRIC_INVALID_DOCUMENT' });
});


test('renderer rejects excessive output size', () => {
  const doc = fixture('x'.repeat(20_000));
  doc.children[0].children[0].props.text = 'x'.repeat(20_000);
  const extra = Array.from({ length: 100 }, (_, index) => ({ id: `extra-text-${index}`, type: 'widget.text', props: { text: '&'.repeat(20_000) }, children: [] }));
  doc.children[0].children.push(...extra);
  assert.throws(() => renderPageDocument(doc), error => error.code === 'ERR_SYSTEMFABRIC_RENDER_OUTPUT_LIMIT' && error.statusCode === 413);
  assert.equal(MAX_RENDERED_OUTPUT_BYTES, 2 * 1024 * 1024);
});


test('advanced core widgets validate and render text safely', () => {
  const { renderPageDocument } = require('../packages/render/src/index');
  const document = { schemaVersion: 1, documentId: 'advanced-page', type: 'page', title: 'Advanced widgets', children: [
    { id: 'list-one', type: 'widget.list', props: { items: ['One', '<script>alert(1)</script>'], ordered: true }, children: [] },
    { id: 'quote-one', type: 'widget.quote', props: { text: 'A quote', cite: 'Editor' }, children: [] },
    { id: 'divider-one', type: 'widget.divider', props: {}, children: [] },
    { id: 'spacer-one', type: 'widget.spacer', props: { height: '24px' }, children: [] }
  ] };
  assert.equal(validatePageDocument(document).valid, true);
  const html = renderPageDocument(document);
  assert.match(html, /<ol/); assert.match(html, /&lt;script&gt;/); assert.match(html, /<blockquote>/); assert.match(html, /<hr/); assert.match(html, /height:24px/);
  const bad = structuredClone(document); bad.children[3].props.height = 'url(javascript:alert(1))';
  assert.equal(validatePageDocument(bad).valid, false);
});

test('query loop documents are bounded and render only the supplied published rows', () => {
  const document = { schemaVersion: 1, documentId: 'query-page', type: 'page', title: 'Latest articles', children: [
    { id: 'query-loop-1', type: 'widget.query-loop', props: { source: 'latest-published', contentType: 'post', limit: 2, columns: 2, emptyText: 'Nothing published yet.' }, children: [] }
  ] };
  assert.equal(validatePageDocument(document).valid, true);
  const invalid = structuredClone(document); invalid.children[0].props.limit = 1000;
  assert.equal(validatePageDocument(invalid).valid, false);
  const html = renderPageDocument(document, { dynamicData: { 'query-loop-1': [
    { title: '<script>unsafe</script>', url: '/public/demo/pages/one', excerpt: 'First excerpt' },
    { title: 'Second article', url: 'javascript:alert(1)', excerpt: '<b>Second excerpt</b>' },
    { title: 'Should not render', url: '/third', excerpt: '' }
  ] }, designTokens: { colors: { brand: '#123456' }, spacing: { medium: '16px' }, fontFamilies: { body: 'Inter, system-ui' } } });
  assert.match(html, /--sf-colors-brand:#123456/);
  assert.match(html, /href="\/public\/demo\/pages\/one"/);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(html, /href="\/"/);
  assert.doesNotMatch(html, /Should not render/);
  assert.match(html, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.throws(() => renderPageDocument(document, { designTokens: { colors: { brand: 'red;}</style><script>alert(1)</script>' } } }));
});

test('generated query-loop nodes receive safe defaults and stable node validation', () => {
  const normalized = normalizeGeneratedDocument({ schemaVersion: 1, documentId: 'draft', type: 'page', title: 'Query', children: [
    { id: 'loop', type: 'widget.query-loop', props: {}, children: [] }
  ] });
  assert.equal(validatePageDocument(normalized).valid, true);
  assert.equal(normalized.children[0].props.contentType, 'post');
  assert.equal(normalized.children[0].props.limit, 3);
});
