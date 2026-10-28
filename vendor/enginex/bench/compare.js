'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const iterations = positiveInt(process.env.ENGINEX_BENCH_ITERATIONS, 20_000);
const warmup = positiveInt(process.env.ENGINEX_BENCH_WARMUP, Math.min(1_000, Math.floor(iterations / 10)));
const env = { ...process.env, ENGINEX_BENCH_ITERATIONS: String(iterations), ENGINEX_BENCH_WARMUP: String(warmup) };
const base = __dirname;
const specs = [
  { command: 'node', args: [path.join(base, 'render.js')], label: 'EnginEx compiled sync renderer' },
  { command: 'node', args: [path.join(base, 'render-prepared.js')], label: 'EnginEx compiled sync + prepared immutable data' },
  { command: 'node', args: [path.join(base, 'render-interpreted.js')], label: 'EnginEx async interpreted' },
  { command: 'php', args: ['-d', 'opcache.enable_cli=1', path.join(base, 'php-native-bench.php')], label: 'Native PHP' },
  { command: 'php', args: [path.join(base, 'twig-bench.php')], label: 'Twig' }
];
// Rotate benchmark order between replicated runs to reduce fixed order / thermal bias.
const orderSeed = positiveInt(process.env.ENGINEX_BENCH_ORDER_SEED, 1) - 1;
const ordered = specs.slice(orderSeed % specs.length).concat(specs.slice(0, orderSeed % specs.length));
const results = [];
for (const spec of ordered) {
  if (spec.command === 'php' && !commandExists('php')) {
    results.push({ implementation: spec.label, available: false, reason: 'php executable not found' });
  } else {
    results.push(run(spec.command, spec.args, spec.label));
  }
}
const renderedResults = results.filter(r => r.available !== false && r.outputHash);
const checksums = [...new Set(renderedResults.map(r => r.outputHash))];
const singleOutputChecksums = [...new Set(renderedResults.map(r => r.singleOutputHash).filter(Boolean))];
const outputLengths = [...new Set(renderedResults.map(r => r.outputBytes))];
const report = {
  note: 'Performance results are local measurements from this run only, not universal claims. The standard compiled path validates/snapshots data each render; prepared mode validates/freezes the same data once. Load/compile/preparation time is reported separately. Exact aggregate hashes verify byte-identical output across available implementations. Twig is reported unavailable when not installed.',
  workload: { iterations, warmup, orderSeed: orderSeed + 1 },
  outputEquivalent: renderedResults.length < 2 ? null : checksums.length === 1 && singleOutputChecksums.length === 1 && outputLengths.length === 1,
  outputVerification: { aggregateOutputHashesMatch: checksums.length === 1, singleOutputHashesMatch: singleOutputChecksums.length === 1, outputByteLengthsMatch: outputLengths.length === 1, singleOutputSha256: singleOutputChecksums[0] || null, outputBytesPerRender: outputLengths[0] || null },
  comparisons: buildComparisons(results),
  results
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (results.some(r => r.error) || report.outputEquivalent === false) process.exitCode = 1;
function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) return { implementation: label, available: false, reason: result.error.message };
  if (result.status !== 0) return { implementation: label, error: (result.stderr || result.stdout || `exit ${result.status}`).slice(0, 2000) };
  try { return JSON.parse(result.stdout); }
  catch { return { implementation: label, error: `Could not parse benchmark output: ${result.stdout.slice(0, 500)}` }; }
}
function buildComparisons(results) {
  const available = results.filter(row => row.available !== false && !row.error && Number.isFinite(row.rendersPerSecond));
  const fastest = available.reduce((best, row) => !best || row.rendersPerSecond > best.rendersPerSecond ? row : best, null);
  const byName = name => available.find(row => row.implementation === name);
  const compiled = byName('EnginEx compiled sync renderer');
  const prepared = byName('EnginEx compiled sync + prepared immutable data');
  const interpreted = byName('EnginEx async interpreted renderer');
  const php = byName('Native PHP template');
  const ratio = (numerator, denominator) => numerator && denominator ? Number((numerator.rendersPerSecond / denominator.rendersPerSecond).toFixed(3)) : null;
  return {
    fastestMeasured: fastest ? fastest.implementation : null,
    speedupRatios: {
      compiledEnginExVsInterpreted: ratio(compiled, interpreted),
      preparedEnginExVsInterpreted: ratio(prepared, interpreted),
      preparedEnginExVsRegularCompiled: ratio(prepared, compiled),
      nativePhpVsRegularCompiled: ratio(php, compiled),
      nativePhpVsPreparedEnginEx: ratio(php, prepared)
    },
    preparedThroughputPercentImprovement: compiled && prepared ? Number(((prepared.rendersPerSecond / compiled.rendersPerSecond - 1) * 100).toFixed(2)) : null,
    availableImplementations: available.map(row => row.implementation)
  };
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return !result.error && result.status === 0;
}
function positiveInt(value, fallback) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 1_000_000) : fallback; }
