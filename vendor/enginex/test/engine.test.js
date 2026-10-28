'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const engine = require('../engine');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enginex-ultimate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, content) => {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return target;
  };
  return { root, write };
}

function opts(root, locals = {}, extra = {}) {
  return { views: root, locals, cache: false, ...extra };
}

test('renders text and HTML-escapes interpolation by default', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '<p title="{{ name }}">{{ name }}</p>');
  assert.equal(await engine('index.html', opts(root, { name: `Ada <script>alert('x')</script>` })),
    '<p title="Ada &lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;">Ada &lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;</p>');
});

test('supports nested properties, optional chaining, nullish coalescing and ternaries', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', `{{ user?.profile?.name ?? 'Anonymous' }}|{{ amount > 10 ? 'large' : 'small' }}|{{ user.missing ?? 'fallback' }}`);
  assert.equal(await engine('index.html', opts(root, { user: {}, amount: 11 })), 'Anonymous|large|fallback');
});

test('supports helper calls and filter pipelines with async helpers', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '{{ name | upper }} {{ formatCurrency(total, "USD", "en-US") }} {{ asyncPrefix(name) }}');
  const html = await engine('index.html', opts(root, { name: 'Ada', total: 12.5 }, {
    helpers: { asyncPrefix: async value => `hello ${value}` }
  }));
  assert.match(html, /^ADA \$12\.50 hello Ada$/);
});

test('supports arrays, objects, and short-circuit operators in expressions', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', `{{ [1, 2, 3][1] }}|{{ ({ label: 'safe', count: 2 }).label }}|{{ false && explode() }}|{{ true || explode() }}`);
  const html = await engine('index.html', opts(root, {}, { helpers: { explode() { throw new Error('should not run'); } } }));
  assert.equal(html, '2|safe|false|true');
});

test('does not expose Node globals or prototype-chain properties', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '{{ process.env.SECRET }}|{{ globalThis.process }}|{{ missing }}|{{ toString }}');
  assert.equal(await engine('index.html', opts(root)), '|||');
});

test('blocks prototype-sensitive property names', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '{{ user.constructor }}');
  await assert.rejects(engine('index.html', opts(root, { user: {} })), { code: 'ERR_ENGINEX_EXPRESSION_SYNTAX' });
});

test('does not invoke functions stored on locals', async t => {
  const { root, write } = await fixture(t);
  let invoked = false;
  await write('index.html', '{{ user.run() }}');
  await assert.rejects(engine('index.html', opts(root, { user: { run() { invoked = true; return 'unsafe'; } } })), {
    code: 'ERR_ENGINEX_UNSAFE_DATA'
  });
  assert.equal(invoked, false);
});

test('rejects accessor properties without invoking getters', async t => {
  const { root, write } = await fixture(t);
  let called = false;
  const user = {};
  Object.defineProperty(user, 'secret', { enumerable: true, get() { called = true; return 'secret'; } });
  await write('index.html', '{{ user.secret }}');
  await assert.rejects(engine('index.html', opts(root, { user })), { code: 'ERR_ENGINEX_UNSAFE_DATA' });
  assert.equal(called, false);
});

test('supports if/unless, else branches, each metadata, and nested loops', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', `{{#if user.active}}A{{else}}I{{/if}}|{{#unless user.tags.length}}empty{{else}}tags{{/unless}}|{{#each user.tags as tag, i}}[{{i}}:{{tag}}:{{@key}}:{{@first}}:{{@last}}:{{@root.site}}]{{else}}none{{/each}}`);
  assert.equal(await engine('index.html', opts(root, { site: 'web', user: { active: true, tags: ['a', 'b'] } })),
    'A|tags|[0:a:0:true:false:web][1:b:1:false:true:web]');
});

test('supports object, Map and Set iteration', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', `{{#each object as value, index}}{{index}}={{value}};{{/each}}|{{#each map as value, index}}{{@key}}={{value}};{{/each}}|{{#each set as value, index}}{{value}};{{/each}}`);
  assert.equal(await engine('index.html', opts(root, { object: { x: 1, y: 2 }, map: new Map([['k', 'v']]), set: new Set(['a', 'b']) })), '0=1;1=2;|k=v;|a;b;');
});

test('supports with aliases', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '{{#with user.profile as profile}}{{profile.name}} / {{this.name}}{{/with}}');
  assert.equal(await engine('index.html', opts(root, { user: { profile: { name: 'Grace' } } })), 'Grace / Grace');
});

test('partials are path-restricted and accept a context override', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', 'before {{> "partials/card" user}} after');
  await write('partials/card.html', '<b>{{ name }}</b> {{ @root.page }}');
  assert.equal(await engine('index.html', opts(root, { user: { name: 'Ada' }, page: 'home' })), 'before <b>Ada</b> home after');
});

test('supports layout inheritance and child block overrides', async t => {
  const { root, write } = await fixture(t);
  await write('layouts/base.html', '<html><title>{{#block "title"}}Default title{{/block}}</title><main>{{#block "content"}}Default content{{/block}}</main></html>');
  await write('pages/profile.html', '{{#extends "../layouts/base"}}{{#block "title"}}Profile{{/block}}{{#block "content"}}Welcome {{ user.name }}{{/block}}{{/extends}}');
  assert.equal(await engine('pages/profile.html', opts(root, { user: { name: 'Ada' } })), '<html><title>Profile</title><main>Welcome Ada</main></html>');
});

test('blocks raw interpolation unless the value is explicitly branded safe HTML', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '{{{ content }}}');
  await assert.rejects(engine('index.html', opts(root, { content: '<b>x</b>' })), { code: 'ERR_ENGINEX_UNSAFE_RAW_OUTPUT' });
  assert.equal(await engine('index.html', opts(root, { content: engine.safeHtml('<b>trusted</b>') })), '<b>trusted</b>');
});

test('jsonScript safely escapes HTML-significant text for script-data context', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '<script type="application/json">{{{ jsonScript(data) }}}</script>');
  assert.equal(await engine('index.html', opts(root, { data: { value: '</script><script>alert(1)</script>' } })),
    '<script type="application/json">{"value":"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"}</script>');
});

test('safeUrl blocks javascript, data and protocol-relative URLs', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '{{ safeUrl(url) }}');
  assert.equal(await engine('index.html', opts(root, { url: 'javascript:alert(1)' })), '');
  assert.equal(await engine('index.html', opts(root, { url: 'https://example.com/a?x=1&y=2' })), 'https://example.com/a?x=1&amp;y=2');
});

test('legacy NJS blocks fail closed by default and never execute', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '<?njs globalThis.__enginexShouldNotRun = true; echo("bad"); ?>');
  delete globalThis.__enginexShouldNotRun;
  await assert.rejects(engine('index.html', opts(root)), { code: 'ERR_ENGINEX_UNSAFE_CODE_DISABLED' });
  assert.equal(globalThis.__enginexShouldNotRun, undefined);
});

test('explicit unsafe compatibility mode renders trusted NJS templates', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '<h1><?njs echo(window.name); ?></h1>');
  const html = await engine('index.html', opts(root, { name: 'Ada' }, { allowUnsafeCode: true }));
  assert.equal(html, '<h1>Ada</h1>');
});

test('strict paths reject traversal and external symlinks', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '{{> "../outside"}}');
  await fs.writeFile(path.join(path.dirname(root), 'outside.html'), 'outside');
  await assert.rejects(engine('index.html', opts(root)), { code: 'ERR_ENGINEX_PATH_OUTSIDE_ROOT' });
  await fs.rm(path.join(path.dirname(root), 'outside.html'), { force: true });
  if (process.platform !== 'win32') {
    const external = path.join(path.dirname(root), 'external-template.html');
    await fs.writeFile(external, 'outside');
    await fs.symlink(external, path.join(root, 'link.html'));
    await assert.rejects(engine('link.html', opts(root)), { code: 'ERR_ENGINEX_PATH_OUTSIDE_ROOT' });
    await fs.rm(external, { force: true });
  }
});

test('detects circular partials', async t => {
  const { root, write } = await fixture(t);
  await write('a.html', '{{> "b"}}');
  await write('b.html', '{{> "a"}}');
  await assert.rejects(engine('a.html', opts(root)), { code: 'ERR_ENGINEX_CIRCULAR_INCLUDE' });
});

test('enforces loop, output, and template size limits', async t => {
  const { root, write } = await fixture(t);
  await write('loop.html', '{{#each items as item}}{{item}}{{/each}}');
  await assert.rejects(engine('loop.html', opts(root, { items: [1, 2, 3] }, { maxLoopIterations: 2 })), { code: 'ERR_ENGINEX_LOOP_LIMIT' });
  await assert.rejects(engine('loop.html', opts(root, { items: ['abcdef'] }, { maxOutputLength: 3 })), { code: 'ERR_ENGINEX_OUTPUT_LIMIT' });
  await assert.rejects(engine('loop.html', opts(root, { items: [] }, { maxTemplateBytes: 3 })), { code: 'ERR_ENGINEX_TEMPLATE_LIMIT' });
});

test('rejects unsupported expressions instead of evaluating arbitrary JavaScript', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '{{ (() => 1)() }}');
  await assert.rejects(engine('index.html', opts(root)), { code: 'ERR_ENGINEX_EXPRESSION_SYNTAX' });
});

test('supports streaming output without building one combined output string', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', 'A{{ name }}B{{#each values as value}}{{value}}{{/each}}Z');
  let result = '';
  for await (const chunk of engine.renderStream('index.html', opts(root, { name: '<n>', values: [1, 2] }))) result += chunk;
  assert.equal(result, 'A&lt;n&gt;B12Z');
});

test('supports writing to a Node writable stream', async t => {
  const { root, write } = await fixture(t);
  const { Writable } = require('node:stream');
  await write('index.html', 'hello {{ name }}');
  let output = '';
  const writable = new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } });
  await engine.renderTo('index.html', opts(root, { name: 'Ada' }), writable);
  assert.equal(output, 'hello Ada');
});

test('supports Express callback API and Promise API', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', 'Hi {{ name }}');
  assert.equal(await engine('index.html', opts(root, { name: 'Ada' })), 'Hi Ada');
  const result = await new Promise((resolve, reject) => engine('index.html', opts(root, { name: 'Lin' }), (error, html) => error ? reject(error) : resolve(html)));
  assert.equal(result, 'Hi Lin');
});

test('supports LRU caching, stats, and explicit invalidation', async t => {
  const { root, write } = await fixture(t);
  const file = await write('index.html', 'A {{ name }}');
  await engine('index.html', { views: root, locals: { name: 'X' }, cache: true });
  await engine('index.html', { views: root, locals: { name: 'Y' }, cache: true });
  assert.ok(engine.cacheStats().hits > 0);
  await fs.writeFile(file, 'B {{ name }}');
  // Force the mtime beyond coarse-resolution filesystems so this test always
  // exercises cache revalidation instead of depending on write timing.
  const updatedAt = new Date(Date.now() + 2_000);
  await fs.utimes(file, updatedAt, updatedAt);
  assert.equal(await engine('index.html', { views: root, locals: { name: 'Z' }, cache: 'mtime' }), 'B Z');
  engine.clearCache(file);
});

test('coalesces concurrent template compiles', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', 'Hi {{ name }}');
  const before = engine.cacheStats().parses;
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => engine('index.html', { views: root, locals: { name: index }, cache: true })));
  assert.deepEqual(results, Array.from({ length: 20 }, (_, index) => `Hi ${index}`));
  assert.ok(engine.cacheStats().parses - before <= 1);
});

test('supports multi-level layout inheritance with child overrides taking precedence', async t => {
  const { root, write } = await fixture(t);
  await write('layouts/base.html', '<main>{{#block "content"}}Base{{/block}}</main>');
  await write('layouts/section.html', '{{#extends "base"}}{{#block "content"}}Section: {{#block "inner"}}Default inner{{/block}}{{/block}}{{/extends}}');
  await write('pages/page.html', '{{#extends "../layouts/section"}}{{#block "inner"}}Child wins{{/block}}{{/extends}}');
  assert.equal(await engine('pages/page.html', opts(root)), '<main>Section: Child wins</main>');
});

test('async helpers are bounded by the configured render time budget', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '{{ slow() }}');
  await assert.rejects(engine('index.html', opts(root, {}, {
    maxRenderTimeMs: 20,
    helpers: { slow: () => new Promise(resolve => setTimeout(() => resolve('late'), 100)) }
  })), { code: 'ERR_ENGINEX_RENDER_TIMEOUT' });
});

test('precompile rejects legacy code instead of silently accepting an unsafe template', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '<?njs echo("not safe by default"); ?>');
  await assert.rejects(engine.precompile('index.html', { views: root, cache: false }), { code: 'ERR_ENGINEX_UNSAFE_CODE_DISABLED' });
});

test('rejects Proxies without invoking their traps', async t => {
  const { root, write } = await fixture(t);
  let trapInvoked = false;
  const proxy = new Proxy({}, {
    getPrototypeOf() { trapInvoked = true; throw new Error('trap should not run'); },
    ownKeys() { trapInvoked = true; throw new Error('trap should not run'); }
  });
  await write('index.html', '{{ data.value }}');
  await assert.rejects(engine('index.html', opts(root, { data: proxy })), { code: 'ERR_ENGINEX_UNSAFE_DATA' });
  assert.equal(trapInvoked, false);
});

test('enforces individual data-string limits', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', '{{ value }}');
  await assert.rejects(engine('index.html', opts(root, { value: 'four' }, { maxDataStringLength: 3 })), { code: 'ERR_ENGINEX_DATA_LIMIT' });
});

test('cacheMaxEntries zero is a valid no-storage setting', async t => {
  const { root, write } = await fixture(t);
  await write('index.html', 'no cache');
  assert.equal(await engine('index.html', opts(root, {}, { cacheMaxEntries: 0 })), 'no cache');
});
