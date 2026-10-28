'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = require('../index');

function tempViews() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'enginex-v6-'));
}

test('compiled sync renderer is byte-identical to the interpreter for common syntax', async () => {
  const views = tempViews();
  fs.mkdirSync(path.join(views, 'partials'));
  fs.writeFileSync(path.join(views, 'partials', 'card.html'), '<b>{{ name }}</b>');
  fs.writeFileSync(path.join(views, 'page.html'), '<main><h1>{{ user.name }}</h1>{{#if products.length}}<ul>{{#each products as product, i}}<li>{{ i + 1 }}: {{ product.name }} — {{ product.price | formatNumber(\'en-US\', {minimumFractionDigits: 2, maximumFractionDigits: 2}) }}</li>{{/each}}</ul>{{else}}empty{{/if}}{{> "partials/card.html" user}}</main>');
  const locals = { user: { name: 'Ada & Lee' }, products: [{ name: 'Book', price: 8.5 }, { name: 'Pen', price: 2 }] };
  const compiled = await engine.load('page.html', { views });
  const fastOutput = compiled.render(locals);
  const interpretedOutput = await engine('page.html', { views, locals });
  assert.equal(fastOutput, interpretedOutput);
  assert.match(fastOutput, /Ada &amp; Lee/);
  assert.equal(compiled.rendererKind, 'compiled-sync');
});

test('compiled renderer supports layouts and context partials without render-time path lookup', async () => {
  const views = tempViews();
  fs.mkdirSync(path.join(views, 'layouts')); fs.mkdirSync(path.join(views, 'partials'));
  fs.writeFileSync(path.join(views, 'layouts', 'base.html'), '<html><title>{{#block "title"}}Default{{/block}}</title><main>{{#block "body"}}Body{{/block}}</main></html>');
  fs.writeFileSync(path.join(views, 'partials', 'card.html'), '<strong>{{ name }}</strong>');
  fs.writeFileSync(path.join(views, 'page.html'), '{{#extends "layouts/base.html"}}{{#block "title"}}Hi {{ user.name }}{{/block}}{{#block "body"}}<p>{{> "partials/card.html" user}}</p>{{/block}}{{/extends}}');
  const compiled = await engine.load('page.html', { views });
  const fast = compiled.render({ user: { name: 'Ada' } });
  const slow = await engine('page.html', { views, locals: { user: { name: 'Ada' } } });
  assert.equal(fast, slow);
  assert.equal(fast, '<html><title>Hi Ada</title><main><p><strong>Ada</strong></p></main></html>');
});

test('sync renderer rejects async helpers and renderAsync retains support', async () => {
  const views = tempViews(); fs.writeFileSync(path.join(views, 'page.html'), '{{ greet(user.name) }}');
  const loaded = await engine.load('page.html', { views, helpers: { greet: async name => `hi ${name}` } });
  assert.throws(() => loaded.render({ user: { name: 'Ada' } }), { code: 'ERR_ENGINEX_ASYNC_HELPER' });
  assert.equal(await loaded.renderAsync({ user: { name: 'Ada' } }), 'hi Ada');
});

test('compiled renderer does not treat template text as executable source', async () => {
  const loaded = engine.compileSource('<p>\" ; process.exit(1); //</p>');
  assert.equal(loaded.render({}), '<p>\" ; process.exit(1); //</p>');
});

test('fragment session emits only dependent fragments when data changes', async () => {
  const views = tempViews();
  fs.writeFileSync(path.join(views, 'page.html'), '<section data-enginex-fragment="notice">{{#fragment "notice"}}<b>{{ notifications.count }}</b>{{/fragment}}</section><section data-enginex-fragment="profile">{{#fragment "profile"}}<i>{{ user.name }}</i>{{/fragment}}</section>');
  const template = await engine.load('page.html', { views });
  assert.deepEqual(template.fragments.map(fragment => fragment.id), ['notice', 'profile']);
  const session = template.createIncrementalSession();
  const initial = session.render({ notifications: { count: 1 }, user: { name: 'Alex' } });
  assert.equal(initial.type, 'full');
  assert.match(initial.html, /<b>1<\/b>/);
  const patch = session.render({ notifications: { count: 2 }, user: { name: 'Alex' } });
  assert.equal(patch.type, 'patches');
  assert.deepEqual(patch.patches.map(item => item.id), ['notice']);
  assert.equal(patch.patches[0].html, '<b>2</b>');
});

test('explicit changedPaths can drive fragment invalidation without a full data diff', async () => {
  const views = tempViews();
  fs.writeFileSync(path.join(views, 'page.html'), '{{#fragment "one"}}{{ a.x }}{{/fragment}}{{#fragment "two"}}{{ b.y }}{{/fragment}}');
  const template = await engine.load('page.html', { views });
  const session = template.createIncrementalSession();
  session.render({ a: { x: 1 }, b: { y: 2 } });
  const next = session.render({ a: { x: 2 }, b: { y: 2 } }, { changedPaths: ['a.x'] });
  assert.deepEqual(next.patches.map(item => item.id), ['one']);
});

test('prepared data snapshots are opaque, immutable, reusable, and reject mutable Map/Set', async () => {
  const views = tempViews();
  fs.writeFileSync(path.join(views, 'page.html'), '<b>{{ user.name }}</b>');
  const template = await engine.load('page.html', { views });
  const original = { user: { name: 'Ada' } };
  const prepared = template.prepareData(original);
  original.user.name = 'Changed';
  assert.equal(template.renderPrepared(prepared), '<b>Ada</b>');
  assert.equal(template.renderPrepared(prepared), '<b>Ada</b>');
  assert.throws(() => template.renderPrepared(original), /prepareData/);
  assert.throws(() => template.prepareData({ things: new Map([['a', 1]]) }), { code: 'ERR_ENGINEX_PREPARED_DATA_TYPE' });
});


test('compiled snapshot fast path remains prototype-safe for polluted array prototypes', async () => {
  const original = Array.prototype.evil;
  try {
    Object.defineProperty(Array.prototype, 'evil', { configurable: true, value: 'polluted' });
    const compiled = engine.compileSource('<p>{{ user.evil ?? "safe" }}</p><p>{{ products[0] }}</p>');
    assert.equal(compiled.render({ user: {}, products: ['ok'] }), '<p>safe</p><p>ok</p>');
  } finally {
    if (original === undefined) delete Array.prototype.evil;
    else Object.defineProperty(Array.prototype, 'evil', { configurable: true, value: original });
  }
});

test('engine-owned loop scopes resolve aliases without exposing dangerous keys', () => {
  const compiled = engine.compileSource('{{#each items as item}}<b>{{ item.name }}</b>{{/each}}');
  assert.equal(compiled.render({ items: [{ name: 'one' }, { name: 'two' }] }), '<b>one</b><b>two</b>');
});


test('compiled static formatter specialization matches standard formatting and honors helper overrides', () => {
  const source = '{{ formatNumber(value, "en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2}) }}';
  const optimized = engine.compileSource(source);
  assert.equal(optimized.render({ value: 8.5 }), '8.50');
  const custom = engine.compileSource(source, { helpers: { formatNumber: (value, locale, options) => `${locale}:${options.minimumFractionDigits}:${value}` } });
  assert.equal(custom.render({ value: 8.5 }), 'en-US:2:8.5');
});

test('compiled static date and currency helpers preserve formatting semantics', () => {
  const compiled = engine.compileSource('{{ formatCurrency(value, "USD", "en-US") }}|{{ formatDate(date, "en-US", {year: "numeric", timeZone: "UTC"}) }}');
  assert.equal(compiled.render({ value: 12.5, date: '2024-01-02T00:00:00Z' }), '$12.50|2024');
});
