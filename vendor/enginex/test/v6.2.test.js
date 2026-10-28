'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const engine = require('../index');

async function withViews(files, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enginex-62-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const target = path.join(root, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
    }
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('6.2 scalar constant folding preserves compiled/interpreted output', async () => {
  const source = [
    '<p>{{ 2 + 3 * 4 }}</p>',
    '<p>{{ "a" + "b" }}</p>',
    '<p>{{ null ?? "fallback" }}</p>',
    '<p>{{ 0 ? "yes" : "no" }}</p>',
    '{{#if 1 === 1}}<b>always</b>{{else}}<b>never</b>{{/if}}',
    '{{#unless false}}<i>visible</i>{{/unless}}',
    '{{#if 0 && unknownHelper()}}bad{{else}}safe{{/if}}'
  ].join('');
  const compiled = engine.compileSource(source, { root: process.cwd() });
  const fast = compiled.render({});
  const interpreted = await engine.renderSource(source, { root: process.cwd() });
  assert.equal(fast, interpreted);
  assert.match(fast, /14/);
  assert.match(fast, /<b>always<\/b>/);
  assert.doesNotMatch(fast, /never|bad/);
});

test('performance profiles are explicit and caller limits override profile defaults', async () => {
  const profiles = engine.getPerformanceProfiles();
  assert.ok(profiles['ai-preview']);
  await withViews({ 'page.html': '{{ value }}' }, async root => {
    const preview = await engine.load('page.html', { root, profile: 'ai-preview' });
    assert.equal(preview.render({ value: 'ok' }), 'ok');
    const override = await engine.load('page.html', { root, profile: 'ai-preview', maxOutputLength: 4 });
    assert.throws(() => override.render({ value: '12345' }), error => error.code === 'ERR_ENGINEX_OUTPUT_LIMIT');
  });
  assert.throws(() => engine.compileSource('x', { root: process.cwd(), profile: 'not-a-profile' }), /Unknown EnginEx performance profile/);
});

test('reactive model path updates render only dependent fragments using prepared snapshots', async () => {
  await withViews({
    'page.html': '<section data-enginex-fragment="count">{{#fragment "count"}}{{ count }}{{/fragment}}</section><section data-enginex-fragment="name">{{#fragment "name"}}{{ name }}{{/fragment}}</section>'
  }, async root => {
    const template = await engine.load('page.html', { root });
    const session = template.createIncrementalSession();
    const model = engine.createReactiveModel({ count: 1, name: 'Ada' });
    const first = model.renderInto(session);
    assert.equal(first.type, 'full');
    assert.match(first.html, />1</);
    model.set('count', 2);
    const update = model.renderInto(session);
    assert.equal(update.type, 'patches');
    assert.deepEqual(update.patches.map(p => p.id), ['count']);
    assert.equal(update.patches[0].html, '2');
    assert.equal(model.get('count'), 2);
    assert.equal(model.value.name, 'Ada');
    assert.throws(() => { model.value.count = 99; }, TypeError);
    assert.equal(model.get('count'), 2);
  });
});

test('reactive model rejects prototype paths and supports bounded array edits', () => {
  const model = engine.createReactiveModel({ products: [{ name: 'A' }] });
  assert.throws(() => model.set('__proto__.polluted', true), /prototype-sensitive/);
  model.set('products.1', { name: 'B' });
  assert.equal(model.get('products.1.name'), 'B');
  assert.deepEqual(model.drainChanges(), ['*']);
  assert.equal(model.delete('products.0'), true);
  assert.deepEqual(model.get('products').map(item => item.name), ['B']);
});

test('normalized render request unifies trace, profile and rendering contract', async () => {
  await withViews({ 'page.html': '<h1>{{ name }}</h1>' }, async root => {
    const request = engine.normalizeRenderRequest({ template: 'page.html', data: { name: 'Ada & Lee' }, options: { root }, mode: 'sync', profile: 'high-throughput' });
    assert.equal(request.schemaVersion, 1);
    assert.ok(request.traceId);
    const result = await engine.renderRequest({ template: 'page.html', data: { name: 'Ada & Lee' }, options: { root }, mode: 'sync' });
    assert.equal(result.html, '<h1>Ada &amp; Lee</h1>');
    assert.equal(result.mode, 'sync');
    assert.ok(result.requestId);
    assert.ok(result.traceId);
    await assert.rejects(engine.renderRequest({ template: '../secrets.html', data: {}, options: { root } }), /normalized relative path/);
    await assert.rejects(engine.renderRequest({ template: 'page.html', data: {}, options: { root, locals: {} } }), /Use request.data/);
  });
});

test('opt-in telemetry emits bounded render metrics and callbacks cannot break rendering', async () => {
  const observed = [];
  const source = engine.compileSource('<p>{{ value }}</p>', { root: process.cwd() });
  engine.resetTelemetry();
  assert.equal(source.render({ value: 'ok' }, { telemetry: true, traceId: 'trace-1', onMetric: metric => observed.push(metric) }), '<p>ok</p>');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].type, 'enginex.render');
  assert.equal(observed[0].mode, 'compiled-sync');
  assert.equal(observed[0].outputBytes, 9);
  const stats = engine.telemetryStats();
  assert.equal(stats.renders, 1);
  assert.equal(stats.errors, 0);
  assert.ok(stats.totalDurationMs >= 0);
  assert.equal(source.render({ value: 'ok' }, { telemetry: true, onMetric: () => { throw new Error('metrics failure'); } }), '<p>ok</p>');
  assert.equal(engine.telemetryStats().errors, 0);
});

test('manifest embeds source hashes and reproducibility metadata', async () => {
  await withViews({ 'page.html': '<h1>{{ name }}</h1>' }, async root => {
    const manifest = await engine.buildManifest(root, { entry: 'page.html' });
    assert.equal(manifest.engineVersion, '6.2.0');
    assert.equal(manifest.grammarVersion, 'enginex-template-1');
    assert.equal(manifest.build.reproducible, true);
    assert.match(manifest.templates[0].sourceHash, /^[a-f0-9]{64}$/);
  });
});

test('output-context diagnostics warn for script, style, event-handler, URL and raw interpolation', () => {
  const diagnostics = engine.analyzeOutputContexts([
    '<script>const name = {{ name }};</script>',
    '<style>.x { color: {{ color }}; }</style>',
    '<button onclick="{{ handler }}">Click</button>',
    '<a href="{{ destination }}">Open</a>',
    '<div>{{{ trustedHtml }}}</div>'
  ].join(''));
  const codes = new Set(diagnostics.map(item => item.code));
  assert.ok(codes.has('WARN_ENGINEX_SCRIPT_CONTEXT'));
  assert.ok(codes.has('WARN_ENGINEX_STYLE_CONTEXT'));
  assert.ok(codes.has('WARN_ENGINEX_EVENT_HANDLER_CONTEXT'));
  assert.ok(codes.has('WARN_ENGINEX_URL_CONTEXT'));
  assert.ok(codes.has('WARN_ENGINEX_RAW_OUTPUT'));
  assert.ok(diagnostics.every(item => Number.isInteger(item.offset)));
});

test('strict output-context validation rejects risky interpolation contexts', async () => {
  await withViews({ 'unsafe.html': '<a href="{{ destination }}">Open</a>' }, async root => {
    await assert.rejects(
      engine.load('unsafe.html', { root, strictOutputContexts: true }),
      error => error.code === 'ERR_ENGINEX_UNSAFE_OUTPUT_CONTEXT'
    );
  });
});

test('context analysis handles a long template without repeated full-prefix scanning', () => {
  const source = `${'<p>static text</p>'.repeat(1000)}<p>{{ value }}</p>`;
  const diagnostics = engine.analyzeOutputContexts(source);
  assert.deepEqual(diagnostics, []);
});

test('strict output-context mode permits the explicit safeUrl and jsonScript helper patterns', async () => {
  await withViews({
    'page.html': '<a href="{{ safeUrl(destination) }}">Open</a><script>const label = {{{ jsonScript(label) }}};</script>'
  }, async root => {
    const template = await engine.load('page.html', { root, strictOutputContexts: true });
    const html = template.render({ destination: 'javascript:alert(1)', label: '</script><script>alert(1)</script>' });
    assert.match(html, /href=""/);
    assert.ok(html.includes('\\u003c/script\\u003e'));
    assert.ok(!engine.analyzeOutputContexts('<a href="{{ safeUrl(destination) }}">Open</a>').some(item => item.code === 'WARN_ENGINEX_URL_CONTEXT'));
  });
});

test('render request schema and runtime reject non-normalized paths consistently', () => {
  const templatePattern = new RegExp(engine.renderRequestSchema.properties.template.pattern);
  for (const template of ['pages//home.html', 'pages/./home.html', 'pages/../home.html', 'pages/home.html\0.js', 'C:/secret.html']) {
    assert.throws(() => engine.normalizeRenderRequest({ template }), /normalized relative path/);
    assert.equal(templatePattern.test(template), false, `schema unexpectedly accepts ${JSON.stringify(template)}`);
  }
  assert.equal(templatePattern.test('pages/home.html'), true);
});


test('shared worker pool exposes explicit bounded-queue backpressure', async () => {
  const pool = engine.createSharedWorkerPool({ size: 1, maxQueuedJobs: 0 });
  try {
    await assert.rejects(pool._run({ start: 0, end: 1 }), error => error.code === 'ERR_ENGINEX_BACKPRESSURE' && error.retryable === true);
    assert.equal(pool.getStats().maxQueuedJobs, 0);
    assert.equal(pool.getStats().queuedJobs, 0);
  } finally {
    await pool.close();
  }
});


test('backend capability reporting distinguishes API availability from probed features', async () => {
  const capabilities = engine.getAccelerationCapabilities();
  assert.equal(typeof capabilities.wasm, 'boolean');
  assert.equal(typeof capabilities.sharedArrayBufferAvailable, 'boolean');
  assert.equal(typeof capabilities.sharedArrayBufferUsable, 'boolean');
  assert.equal(capabilities.webgpuAdapterProbed, false);
  const probed = await engine.probeAccelerationCapabilities({});
  assert.equal(probed.webgpuAdapterProbed, true);
  assert.equal(probed.webgpuAdapterAvailable, false);
  assert.deepEqual(probed.webgpuFeatures, []);
});


test('dirty dependency graph matches a seeded brute-force reference under randomized paths', () => {
  let seed = 0xC0FFEE;
  const random = max => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const roots = ['user', 'cart', 'products', 'notifications', 'settings'];
  const paths = [];
  for (let index = 0; index < 180; index++) {
    const rootName = roots[random(roots.length)];
    const middle = ['name', 'count', 'items', 'price', 'meta', '*'][random(6)];
    const leaf = ['value', 'title', 'id', 'active', '*'][random(5)];
    paths.push(random(4) === 0 ? rootName : (random(2) === 0 ? `${rootName}.${middle}` : `${rootName}.${middle}.${leaf}`));
  }
  const uniquePaths = [...new Set(paths)];
  const fragments = uniquePaths.map((dependency, index) => ({ id: `f-${index}`, dependencies: [dependency] }));
  const graph = new engine.FragmentDependencyGraph(fragments);
  for (let sample = 0; sample < 80; sample++) {
    const changed = [];
    const count = 1 + random(4);
    for (let j = 0; j < count; j++) {
      const rootName = roots[random(roots.length)];
      changed.push(random(3) === 0 ? rootName : `${rootName}.${['name', 'count', 'items', 'price', 'meta', 'other'][random(6)]}`);
    }
    const expected = fragments.filter(fragment => changed.some(path => engine.pathMatchesDependency(fragment.dependencies[0], path))).map(fragment => fragment.id).sort();
    const actual = graph.select(changed).map(fragment => fragment.id).sort();
    assert.deepEqual(actual, expected, `dirty dependency mismatch for ${JSON.stringify(changed)}`);
  }
});
