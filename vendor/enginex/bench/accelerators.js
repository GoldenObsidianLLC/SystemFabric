'use strict';
const { performance } = require('node:perf_hooks');
const engine = require('../index');
const { createWasmSimdAccelerator } = require('../accelerators/wasm-simd');
const { createWebGpuScanner } = require('../accelerators/webgpu-scanner');

async function main() {
  const bytes = clamp(Number(process.env.ENGINEX_ACCEL_BYTES) || 1024 * 1024, 1024, 16 * 1024 * 1024);
  const iterations = clamp(Number(process.env.ENGINEX_ACCEL_ITERATIONS) || 20, 1, 1000);
  let source = 'plain text <tag title="hello & goodbye"> O\'Reilly </tag>\n';
  source = source.repeat(Math.ceil(bytes / source.length)).slice(0, bytes);
  const wasm = await createWasmSimdAccelerator({ minBytes: 0 });
  const expected = engine.escapeHtml(source);
  const native = measure(() => engine.escapeHtml(source), iterations);
  const simd = measure(() => wasm.escapeHtmlAscii(source, { minBytes: 0 }), iterations);
  const report = {
    note: 'Local microbenchmark only. Includes full escaping output construction; does not imply general renderer speedup. Worker scan compares index scanning and includes worker/SAB overhead. WebGPU is omitted when unavailable.',
    runtime: process.version,
    inputBytes: Buffer.byteLength(source),
    iterations,
    outputBytes: Buffer.byteLength(expected),
    outputEquivalent: native.last === simd.last && simd.last === expected,
    escaping: [summarize('Native JavaScript escapeHtml', native), summarize('Wasm SIMD ASCII escapeHtml', simd)],
    workerScan: null,
    webgpu: null
  };
  const pool = engine.createSharedWorkerPool({ size: 2, minBytes: 1024, maxBytes: 16 * 1024 * 1024 });
  try {
    const expectedPositions = findSpecialAsciiPositions(source);
    const workerScan = await measureAsync(() => pool.findSpecialAsciiPositions(source), Math.min(iterations, 10));
    report.workerScan = {
      nativeJavaScript: summarize('Native JS character scan', measure(() => findSpecialAsciiPositions(source), Math.min(iterations, 10))),
      sharedArrayBufferWorker: summarize('SharedArrayBuffer worker scan', workerScan),
      positionsEquivalent: JSON.stringify(workerScan.last) === JSON.stringify(expectedPositions),
      stats: pool.getStats()
    };
  } finally { await pool.close(); }
  const gpu = await createWebGpuScanner({ minBytes: 1024 });
  report.webgpu = gpu ? { available: true, backend: gpu.backend, note: 'GPU scan benchmark is device-specific; run in target browser/driver.' } : { available: false, reason: 'WebGPU is not available in this Node.js environment.' };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
function measure(fn, iterations) {
  let last;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) last = fn();
  const elapsedMs = performance.now() - start;
  return { elapsedMs: Number(elapsedMs.toFixed(3)), opsPerSecond: Math.round(iterations / (elapsedMs / 1000)), meanMs: Number((elapsedMs / iterations).toFixed(3)), last };
}
async function measureAsync(fn, iterations) {
  let last;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) last = await fn();
  const elapsedMs = performance.now() - start;
  return { elapsedMs: Number(elapsedMs.toFixed(3)), opsPerSecond: Math.round(iterations / (elapsedMs / 1000)), meanMs: Number((elapsedMs / iterations).toFixed(3)), last };
}
function findSpecialAsciiPositions(text) { const positions = []; for (let i = 0; i < text.length; i++) if ('&<>"\''.includes(text[i])) positions.push(i); return positions; }
function summarize(implementation, result) { const { last, ...metrics } = result; return { implementation, ...metrics }; }
function clamp(value, min, max) { if (!Number.isFinite(value)) return min; return Math.max(min, Math.min(max, Math.floor(value))); }
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
