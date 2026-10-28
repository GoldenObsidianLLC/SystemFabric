'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const engine = process.env.ENGINEX_ENGINE_MODULE
  ? require(path.resolve(process.env.ENGINEX_ENGINE_MODULE))
  : require('../index');
const iterations = positiveInt(process.env.ENGINEX_BENCH_ITERATIONS, 20_000);
const warmup = positiveInt(process.env.ENGINEX_BENCH_WARMUP, Math.min(1_000, Math.floor(iterations / 10)));
const views = path.join(__dirname, 'views');
const options = { views, cache: true, locals: {
  user: { name: 'Ada & Lee' },
  products: [
    { name: 'Notebook', price: 8.5 },
    { name: 'Pen & pencil', price: 2.25 },
    { name: 'Monitor', price: 1234.5 }
  ]
} };
async function main() {
  let html = '';
  for (let index = 0; index < warmup; index++) html = await engine('sample.html', options);
  const hash = crypto.createHash('sha256');
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index++) { html = await engine('sample.html', options); hash.update(html); }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  process.stdout.write(JSON.stringify({
    implementation: 'EnginEx async interpreted renderer', version: engine.version, runtime: process.version,
    mode: 'warm-AST-cache', iterations, warmup, elapsedMs: Number(elapsedMs.toFixed(3)),
    rendersPerSecond: Math.round(iterations / (elapsedMs / 1000)),
    meanMicroseconds: Number((elapsedMs * 1000 / iterations).toFixed(3)),
    outputBytes: Buffer.byteLength(html), outputHash: hash.digest('hex'),
    singleOutputHash: crypto.createHash('sha256').update(html).digest('hex'), cache: engine.cacheStats()
  }));
}
function positiveInt(value, fallback) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 1_000_000) : fallback; }
main().catch(error => { console.error(error); process.exitCode = 1; });
