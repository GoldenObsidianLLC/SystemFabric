'use strict';

// Benchmarks already-running HTTP endpoints. Point each URL at the same small,
// deterministic HTML fixture rendered by a deployment-like app. This client
// does not start servers; it can therefore test PHP-FPM, Twig, and Node behind
// the same reverse proxy when those services are available.
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const iterations = positiveInt(process.env.ENGINEX_HTTP_ITERATIONS, 5000);
const warmup = positiveInt(process.env.ENGINEX_HTTP_WARMUP, 250);
const concurrency = positiveInt(process.env.ENGINEX_HTTP_CONCURRENCY, 8);
const endpoints = [
  ['EnginEx', process.env.ENGINEX_HTTP_URL],
  ['Native PHP/PHP-FPM', process.env.PHP_HTTP_URL],
  ['Twig/PHP-FPM', process.env.TWIG_HTTP_URL]
].filter(([, url]) => Boolean(url));

async function main() {
  if (endpoints.length < 2) {
    throw new Error('Provide at least two of ENGINEX_HTTP_URL, PHP_HTTP_URL, and TWIG_HTTP_URL.');
  }
  const results = [];
  for (const [label, url] of endpoints) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label}: URL must use HTTP or HTTPS.`);
    results.push(await benchmark(url, label));
  }
  const valid = results.filter(x => x.available);
  const hashes = [...new Set(valid.map(x => x.singleOutputSha256))];
  const aggregateHashes = [...new Set(valid.map(x => x.aggregateOutputSha256))];
  const report = {
    title: 'EnginEx vs native PHP/PHP-FPM vs Twig external HTTP comparison',
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    workload: { iterations, warmup, concurrency, sameFixtureRequired: true },
    notes: [
      'This client benchmarks endpoints you provide; it does not verify that their data, caching, security, compression, or server configuration are equivalent.',
      'For a valid comparison, route all implementations through equivalent reverse proxies and use byte-identical output for the same deterministic fixture.',
      'Use a staging environment, not a production service under load. Avoid including secrets or user-specific data.'
    ],
    outputEquivalent: hashes.length <= 1 && aggregateHashes.length <= 1 && valid.length === endpoints.length,
    outputHashes: hashes,
    aggregateOutputHashes: aggregateHashes,
    results
  };
  const output = JSON.stringify(report, null, 2) + '\n';
  process.stdout.write(output);
  const outPath = path.join(__dirname, 'http-external-comparison.json');
  fs.writeFileSync(outPath, output);
  if (valid.length !== endpoints.length || hashes.length > 1 || aggregateHashes.length > 1) process.exitCode = 1;
}

async function benchmark(url, implementation) {
  try {
    await requestBatch(url, warmup, concurrency, false);
    const measurement = await requestBatch(url, iterations, concurrency, true);
    return { implementation, available: true, url: sanitizeUrl(url), ...measurement };
  } catch (error) {
    return { implementation, available: false, error: String(error.stack || error).slice(0, 1500) };
  }
}

async function requestBatch(url, count, parallel, collect) {
  const latencies = [];
  const aggregate = createHash('sha256');
  let firstHash = null;
  let outputBytes = null;
  let status = null;
  const started = performance.now();
  const workers = Array.from({ length: Math.min(count, parallel) }, async (_, worker) => {
    for (let i = worker; i < count; i += parallel) {
      const before = performance.now();
      const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
      const body = await response.arrayBuffer();
      const elapsed = performance.now() - before;
      if (!response.ok) throw new Error(`${implementationSafe(url)} returned ${response.status}`);
      const bytes = Buffer.from(body);
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (status === null) status = response.status;
      if (outputBytes === null) { outputBytes = bytes.length; firstHash = hash; }
      if (collect) { latencies.push(elapsed); aggregate.update(bytes); }
    }
  });
  await Promise.all(workers);
  const elapsedMs = performance.now() - started;
  if (!collect) return { elapsedMs: round(elapsedMs, 3) };
  latencies.sort((a, b) => a - b);
  return {
    requests: count,
    elapsedMs: round(elapsedMs, 3),
    requestsPerSecond: Math.round(count / (elapsedMs / 1000)),
    latencyMs: { p50: quantile(latencies, .50), p95: quantile(latencies, .95), p99: quantile(latencies, .99) },
    status,
    outputBytes,
    singleOutputSha256: firstHash,
    aggregateOutputSha256: aggregate.digest('hex')
  };
}
function implementationSafe(url) { return new URL(url).origin; }
function sanitizeUrl(url) { const u = new URL(url); return `${u.origin}${u.pathname}`; }
function quantile(xs, q) { return xs.length ? Number(xs[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)].toFixed(3)) : null; }
function round(n, digits) { const f = 10 ** digits; return Math.round(n * f) / f; }
function positiveInt(value, fallback) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 1_000_000) : fallback; }
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
