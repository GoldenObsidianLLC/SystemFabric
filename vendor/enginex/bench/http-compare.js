'use strict';
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const iterations = positiveInt(process.env.ENGINEX_HTTP_ITERATIONS, 1000);
const warmup = positiveInt(process.env.ENGINEX_HTTP_WARMUP, 100);
const concurrency = positiveInt(process.env.ENGINEX_HTTP_CONCURRENCY, 1);
const root = __dirname;
const phpAvailable = commandExists('php');

async function main() {
  const results = [];
  const nodePort = await freePort();
  const nodeChild = spawn(process.execPath, [path.join(root, 'http', 'node-server.js')], {
    env: { ...process.env, PORT: String(nodePort) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let nodeLog = '';
  nodeChild.stdout.on('data', chunk => { nodeLog += chunk.toString(); });
  nodeChild.stderr.on('data', chunk => { nodeLog += chunk.toString(); });
  try {
    await waitReady(`http://127.0.0.1:${nodePort}/health`, nodeChild, () => nodeLog);
    for (const [route, label] of [['/dynamic', 'EnginEx compiled dynamic data'], ['/prepared', 'EnginEx prepared immutable data'], ['/page-cache', 'EnginEx full-page memory cache']]) {
      results.push(await benchmarkUrl(`http://127.0.0.1:${nodePort}${route}`, label));
    }
  } finally { stopChild(nodeChild); }

  if (phpAvailable) {
    const phpPort = await freePort();
    // PHP's built-in server is used because PHP-FPM is not guaranteed to exist
    // in developer environments. This is deliberately labelled so the result
    // cannot be mistaken for a PHP-FPM production benchmark.
    const phpChild = spawn('php', ['-S', `127.0.0.1:${phpPort}`, path.join(root, 'http', 'php-router.php')], {
      cwd: path.join(root, '..'), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let phpLog = '';
    phpChild.stdout.on('data', chunk => { phpLog += chunk.toString(); });
    phpChild.stderr.on('data', chunk => { phpLog += chunk.toString(); });
    try {
      await waitReady(`http://127.0.0.1:${phpPort}/health`, phpChild, () => phpLog);
      results.push(await benchmarkUrl(`http://127.0.0.1:${phpPort}/native`, 'Native PHP page (PHP built-in server)'));
      const twig = await probe(`http://127.0.0.1:${phpPort}/twig`);
      if (twig.status === 200 && twig.headers.get('x-template-engine') === 'twig') {
        results.push(await benchmarkUrl(`http://127.0.0.1:${phpPort}/twig`, 'Twig page (PHP built-in server)'));
      } else {
        results.push({ implementation: 'Twig page (PHP built-in server)', available: false, reason: twig.status === 503 ? (twig.body || 'Twig not installed') : `Twig endpoint returned HTTP ${twig.status}` });
      }
    } finally { stopChild(phpChild); }
  } else {
    results.push({ implementation: 'Native PHP page', available: false, reason: 'php executable not found' });
    results.push({ implementation: 'Twig page', available: false, reason: 'php executable not found' });
  }

  const available = results.filter(row => row.available !== false && !row.error);
  const hashes = [...new Set(available.filter(row => row.outputBytes !== undefined).map(row => row.singleOutputSha256))];
  const aggregateHashes = [...new Set(available.filter(row => row.aggregateOutputSha256).map(row => row.aggregateOutputSha256))];
  const report = {
    title: 'EnginEx vs PHP vs Twig local HTTP benchmark',
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, php: phpAvailable ? phpVersion() : null, platform: process.platform, architecture: process.arch },
    workload: { iterations, warmup, concurrency, payload: 'same 132-byte HTML fixture; no database, CDN, TLS, compression, or external network latency' },
    topology: 'EnginEx uses Node.js built-in HTTP server; PHP uses PHP built-in server, not PHP-FPM. Use a production-like run with PHP-FPM and the same reverse proxy before drawing deployment conclusions.',
    outputEquivalent: hashes.length <= 1 && aggregateHashes.length <= 1,
    outputHashes: hashes,
    aggregateOutputHashes: aggregateHashes,
    results
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  const outPath = path.join(__dirname, 'http-comparison-latest-run.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  if (results.some(row => row.error) || report.outputEquivalent === false) process.exitCode = 1;
}

async function benchmarkUrl(url, implementation) {
  try {
    // A separate warm-up phase prevents one-time connection/cache setup from
    // dominating the timed request series.
    await runRequests(url, warmup, concurrency, false);
    const measured = await runRequests(url, iterations, concurrency, true);
    return { implementation, available: true, url: new URL(url).pathname, ...measured };
  } catch (error) { return { implementation, error: String(error.stack || error).slice(0, 2000) }; }
}

async function runRequests(url, total, parallel, collect) {
  let completed = 0;
  const latencies = [];
  const hash = createHash('sha256');
  let outputBytes = null;
  let singleOutputSha256 = null;
  let firstStatus = null;
  const started = performance.now();
  const workers = Array.from({ length: Math.min(parallel, total) }, async (_, worker) => {
    let index = worker;
    while (index < total) {
      const before = performance.now();
      const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
      const body = await response.text();
      const elapsed = performance.now() - before;
      if (firstStatus === null) firstStatus = response.status;
      if (response.status !== 200) throw new Error(`${url} returned HTTP ${response.status}: ${body.slice(0, 200)}`);
      if (outputBytes === null) {
        outputBytes = Buffer.byteLength(body);
        singleOutputSha256 = createHash('sha256').update(body).digest('hex');
      }
      if (collect) {
        latencies.push(elapsed);
        hash.update(body);
      }
      completed++;
      index += parallel;
    }
  });
  await Promise.all(workers);
  const elapsedMs = performance.now() - started;
  if (!collect) return { completed, elapsedMs };
  latencies.sort((a, b) => a - b);
  return {
    requests: completed,
    elapsedMs: round(elapsedMs, 3),
    requestsPerSecond: Math.round(completed / (elapsedMs / 1000)),
    latencyMs: { p50: quantile(latencies, 0.50), p95: quantile(latencies, 0.95), p99: quantile(latencies, 0.99) },
    status: firstStatus,
    outputBytes,
    singleOutputSha256,
    aggregateOutputSha256: hash.digest('hex')
  };
}

async function probe(url) { const res = await fetch(url); return { status: res.status, headers: res.headers, body: await res.text() }; }
async function waitReady(url, child, getLog) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before readiness: ${getLog()}`);
    try { const result = await probe(url); if (result.status === 200 && result.body === 'ok') return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${getLog()}`);
}
function stopChild(child) { if (child.exitCode === null) child.kill('SIGTERM'); }
function freePort() { return new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); }); }
function commandExists(command) { const { spawnSync } = require('node:child_process'); const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 }); return !result.error && result.status === 0; }
function phpVersion() { const { spawnSync } = require('node:child_process'); const result = spawnSync('php', ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8', timeout: 5000 }); return result.status === 0 ? result.stdout.trim() : 'unknown'; }
function quantile(values, q) { if (!values.length) return null; return Number(values[Math.min(values.length - 1, Math.ceil(q * values.length) - 1)].toFixed(3)); }
function round(value, places) { const scale = 10 ** places; return Math.round(value * scale) / scale; }
function positiveInt(value, fallback) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? Math.min(number, 1_000_000) : fallback; }
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
