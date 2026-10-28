'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const runs = positiveInt(process.env.ENGINEX_BENCH_RUNS, 3, 7);
const iterations = positiveInt(process.env.ENGINEX_BENCH_ITERATIONS, 30000, 1000000);
const warmup = positiveInt(process.env.ENGINEX_BENCH_WARMUP, Math.min(1000, Math.floor(iterations / 10) || 1), 100000);
const outDir = path.join(__dirname, 'paired-runs');
fs.mkdirSync(outDir, { recursive: true });
const rawRuns = [];

for (let runIndex = 1; runIndex <= runs; runIndex++) {
  const runPath = path.join(outDir, `run-${String(runIndex).padStart(2, '0')}.json`);
  let report;
  if (process.env.ENGINEX_BENCH_AGGREGATE_ONLY === '1') {
    if (!fs.existsSync(runPath)) throw new Error(`Cannot aggregate: missing ${path.relative(root, runPath)}.`);
    report = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  } else {
    const env = {
      ...process.env,
      ENGINEX_BENCH_ITERATIONS: String(iterations),
      ENGINEX_BENCH_WARMUP: String(warmup),
      ENGINEX_BENCH_ORDER_SEED: String(runIndex)
    };
    const result = spawnSync(process.execPath, [path.join(__dirname, 'compare.js')], {
      cwd: root, env, encoding: 'utf8', timeout: 240000, maxBuffer: 5 * 1024 * 1024
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Benchmark run ${runIndex} failed: ${(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).slice(0, 3000)}`);
    }
    try { report = JSON.parse(result.stdout); }
    catch { throw new Error(`Benchmark run ${runIndex} emitted invalid JSON: ${result.stdout.slice(0, 500)}`); }
    report.runIndex = runIndex;
    fs.writeFileSync(runPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Completed paired benchmark ${runIndex}/${runs}\n`);
  }
  rawRuns.push({ ...report, rawReport: path.relative(root, runPath) });
}

const implementationNames = [...new Set(rawRuns.flatMap(run => run.results.map(row => row.implementation)))];
const summaryRows = implementationNames.map(implementation => {
  const rows = rawRuns.map(run => run.results.find(row => row.implementation === implementation)).filter(Boolean);
  const available = rows.filter(row => row.available !== false && !row.error && Number.isFinite(row.rendersPerSecond));
  if (!available.length) return {
    implementation,
    available: false,
    reason: rows.find(row => row.reason)?.reason || rows.find(row => row.error)?.error || 'No valid run result.'
  };
  const throughput = available.map(row => row.rendersPerSecond);
  const latency = available.map(row => row.meanMicroseconds ?? (row.elapsedMs * 1000 / row.iterations));
  const outputHashes = [...new Set(available.map(row => row.singleOutputHash).filter(Boolean))];
  const outputBytes = [...new Set(available.map(row => row.outputBytes).filter(Number.isFinite))];
  return {
    implementation,
    available: true,
    successfulRuns: available.length,
    medianRendersPerSecond: Math.round(median(throughput)),
    minRendersPerSecond: Math.round(Math.min(...throughput)),
    maxRendersPerSecond: Math.round(Math.max(...throughput)),
    medianMicrosecondsPerRender: Number(median(latency).toFixed(3)),
    medianElapsedMs: Number(median(available.map(row => row.elapsedMs)).toFixed(3)),
    iterationsPerRun: iterations,
    warmupPerRun: warmup,
    outputBytes: outputBytes.length === 1 ? outputBytes[0] : null,
    outputEquivalentAcrossRuns: outputHashes.length === 1,
    singleOutputSha256: outputHashes.length === 1 ? outputHashes[0] : null,
    sourceRuntimeVersions: [...new Set(available.map(row => row.runtime).filter(Boolean))]
  };
});

const measured = summaryRows.filter(row => row.available);
const outputHashes = [...new Set(measured.map(row => row.singleOutputSha256).filter(Boolean))];
const outputBytes = [...new Set(measured.map(row => row.outputBytes).filter(Number.isFinite))];
const equivalent = measured.length >= 2 && measured.every(row => row.outputEquivalentAcrossRuns) && outputHashes.length === 1 && outputBytes.length === 1;
const report = {
  title: 'EnginEx 6.2 paired CLI rendering benchmark',
  generatedAt: new Date().toISOString(),
  evidenceClass: 'LOCAL_MEASUREMENT_EXPLORATORY',
  status: 'NOT_PRODUCTION_CERTIFIED',
  methodology: {
    runs,
    iterationsPerRun: iterations,
    warmupPerRun: warmup,
    order: 'Implementation order is rotated between runs to reduce fixed order effects.',
    timing: 'Each child process performs warm-up then measures steady-state rendering; each implementation is a separate process.',
    equivalence: 'Single-render SHA-256 and output byte length are compared across implementations and runs.',
    caveats: [
      'This is a small local CLI microbenchmark, not a full HTTP or user-perceived page-load benchmark.',
      'Prepared-data EnginEx rendering reuses the same prevalidated immutable snapshot and is not semantically identical to per-render validation of changing data.',
      'PHP CLI OPcache is enabled when the PHP benchmark runs; this is not equivalent to PHP-FPM under a production web server.',
      'Twig is only measured if twig/twig is installed in this project; unavailable means not measured, not zero performance.',
      'The available Node.js runtime may be below the package engine range and must be recorded as an environment limitation if so.'
    ]
  },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: os.cpus()[0]?.model || 'unknown',
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    phpVersion: probe('php', ['-r', 'echo PHP_VERSION;']),
    twigInstalled: rawRuns.some(run => run.results.some(row => row.implementation === 'Twig' && row.available !== false && !row.error))
  },
  outputEquivalent: equivalent,
  rows: summaryRows,
  comparisons: makeRatios(summaryRows),
  rawRuns: rawRuns.map(run => ({ runIndex: run.runIndex, outputEquivalent: run.outputEquivalent, rawReport: run.rawReport, workload: run.workload }))
};
const reportPath = path.join(__dirname, 'enginex-php-twig-comparison.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Saved ${path.relative(root, reportPath)}\n`);
if (measured.some(row => !row.outputEquivalentAcrossRuns) || (outputHashes.length > 1) || (outputBytes.length > 1)) process.exitCode = 1;

function makeRatios(rows) {
  const byName = Object.fromEntries(rows.map(row => [row.implementation, row]));
  const ratio = (a, b) => a?.available && b?.available && b.medianRendersPerSecond > 0
    ? Number((a.medianRendersPerSecond / b.medianRendersPerSecond).toFixed(3)) : null;
  return {
    compiledEnginExVsInterpreted: ratio(byName['EnginEx compiled sync renderer'], byName['EnginEx async interpreted renderer']),
    preparedEnginExVsInterpreted: ratio(byName['EnginEx compiled sync + prepared immutable data'], byName['EnginEx async interpreted renderer']),
    nativePhpVsCompiledEnginEx: ratio(byName['Native PHP template'], byName['EnginEx compiled sync renderer']),
    nativePhpVsPreparedEnginEx: ratio(byName['Native PHP template'], byName['EnginEx compiled sync + prepared immutable data']),
    twigVsCompiledEnginEx: ratio(byName['Twig'], byName['EnginEx compiled sync renderer']),
    preparedThroughputImprovementPercent: byName['EnginEx compiled sync renderer']?.available && byName['EnginEx compiled sync + prepared immutable data']?.available
      ? Number(((byName['EnginEx compiled sync + prepared immutable data'].medianRendersPerSecond / byName['EnginEx compiled sync renderer'].medianRendersPerSecond - 1) * 100).toFixed(2)) : null
  };
}
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function positiveInt(value, fallback, max = 1000000) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}
function probe(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  return result.error || result.status !== 0 ? null : result.stdout.trim();
}
