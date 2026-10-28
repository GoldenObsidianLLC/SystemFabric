'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../index');
const { DirtyBitSet, FragmentDependencyGraph } = require('../lib/dirty-bitset');
const { createWasmSimdAccelerator } = require('../accelerators/wasm-simd');
const { createWebGpuScanner } = require('../accelerators/webgpu-scanner');

test('DirtyBitSet scales beyond 32 bits and XOR identifies changed flags', () => {
  const before = new DirtyBitSet(100).set(0).set(31).set(70);
  const after = before.clone().set(32).clear(31);
  assert.deepEqual(before.xor(after).indices(), [31, 32]);
  assert.equal(after.has(70), true);
});

test('fragment dependency graph invalidates exact, parent, and wildcard paths', () => {
  const graph = new FragmentDependencyGraph([
    { id: 'profile', dependencies: ['user.name'] },
    { id: 'cart', dependencies: ['cart.items.*.price'] },
    { id: 'volatile', dependencies: [], alwaysDirty: true }
  ]);
  assert.deepEqual(graph.select(['user.name']).map(x => x.id), ['profile', 'volatile']);
  assert.deepEqual(graph.select(['cart.items.0.price']).map(x => x.id), ['cart', 'volatile']);
  assert.deepEqual(graph.select(['user']).map(x => x.id), ['profile', 'volatile']);
});

test('Wasm SIMD scanner and escaping match JavaScript for large ASCII strings', async () => {
  const wasm = await createWasmSimdAccelerator({ minBytes: 1 });
  const source = 'text & <tag title="x"> \'y\' '.repeat(2000);
  const jsPositions = [];
  for (let i = 0; i < source.length; i++) if ('&<>"\''.includes(source[i])) jsPositions.push(i);
  assert.deepEqual(wasm.findSpecialAsciiPositions(source), jsPositions);
  assert.equal(wasm.escapeHtmlAscii(source), engine.escapeHtml(source));
  assert.equal(wasm.findSpecialAsciiPositions('héllo'), null);
});

test('WebGPU acceleration is an optional capability and cleanly declines when unavailable', async () => {
  const scanner = await createWebGpuScanner({ navigatorObject: {} });
  assert.equal(scanner, null);
});

test('SharedArrayBuffer worker pool scans large ASCII data accurately', async t => {
  const pool = engine.createSharedWorkerPool({ size: 2, minBytes: 64, maxBytes: 1024 * 1024 });
  t.after(() => pool.close());
  const source = 'plain & < > " \' '.repeat(2000);
  const actual = await pool.findSpecialAsciiPositions(source);
  const expected = [];
  for (let i = 0; i < source.length; i++) if ('&<>"\''.includes(source[i])) expected.push(i);
  assert.deepEqual(actual, expected);
  assert.ok(pool.getStats().workerChunks >= 1);
  assert.equal(await pool.findSpecialAsciiPositions('non-ASCII é fallback'), null);
});

test('built-in Intl formatter helpers keep stable output on repeated calls', async () => {
  const template = engine.compileSource("{{ value | formatCurrency('USD', 'en-US') }} / {{ number | formatNumber('en-US', {maximumFractionDigits: 1}) }}");
  const data = { value: 1234.5, number: 12.5 };
  const first = template.render(data);
  assert.equal(first, template.render(data));
  assert.match(first, /1,234\.50/);
  assert.match(first, /12\.5/);
});
