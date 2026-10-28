'use strict';

const WGSL_SOURCE = `
struct Params { wordCount: u32, byteLength: u32, };
@group(0) @binding(0) var<storage, read> inputWords: array<u32>;
@group(0) @binding(1) var<storage, read_write> masks: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;
fn special(c: u32) -> bool {
  return c == 38u || c == 60u || c == 62u || c == 34u || c == 39u;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.wordCount) { return; }
  let word = inputWords[i];
  let base = i * 4u;
  var mask = 0u;
  if (base < params.byteLength && special(word & 255u)) { mask = mask | 1u; }
  if (base + 1u < params.byteLength && special((word >> 8u) & 255u)) { mask = mask | 2u; }
  if (base + 2u < params.byteLength && special((word >> 16u) & 255u)) { mask = mask | 4u; }
  if (base + 3u < params.byteLength && special((word >> 24u) & 255u)) { mask = mask | 8u; }
  masks[i] = mask;
}
`;

/** Optional browser-side GPU scanner. Small and non-ASCII strings return null. */
async function createWebGpuScanner(options = {}) {
  const nav = options.navigatorObject || globalThis.navigator;
  if (!nav?.gpu) return null;
  const adapter = await nav.gpu.requestAdapter(options.adapterOptions);
  if (!adapter) return null;
  const device = await adapter.requestDevice(options.deviceDescriptor);
  const shader = device.createShaderModule({ code: options.shaderSource || WGSL_SOURCE });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
  const encoder = new TextEncoder();
  let disposed = false;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const minBytes = options.minBytes ?? 1024 * 1024;

  async function findSpecialAsciiPositions(text) {
    if (disposed) throw new Error('WebGPU scanner has been disposed.');
    if (typeof text !== 'string') throw new TypeError('Input must be a string.');
    if (text.length < minBytes || text.length === 0) return null;
    for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 0x7f) return null;
    if (text.length > maxBytes) throw new RangeError(`Input exceeds WebGPU scan limit (${maxBytes} bytes).`);

    const bytes = encoder.encode(text);
    const wordCount = Math.ceil(bytes.length / 4);
    const packed = new Uint8Array(wordCount * 4);
    packed.set(bytes);
    const params = new Uint32Array([wordCount, bytes.length]);
    const inputBuffer = device.createBuffer({ size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const maskBuffer = device.createBuffer({ size: wordCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const paramsBuffer = device.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const readBuffer = device.createBuffer({ size: wordCount * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      device.queue.writeBuffer(inputBuffer, 0, packed);
      device.queue.writeBuffer(paramsBuffer, 0, params);
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputBuffer } },
          { binding: 1, resource: { buffer: maskBuffer } },
          { binding: 2, resource: { buffer: paramsBuffer } }
        ]
      });
      const commandEncoder = device.createCommandEncoder();
      const pass = commandEncoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(wordCount / 64));
      pass.end();
      commandEncoder.copyBufferToBuffer(maskBuffer, 0, readBuffer, 0, wordCount * 4);
      device.queue.submit([commandEncoder.finish()]);
      await readBuffer.mapAsync(GPUMapMode.READ);
      const masks = new Uint32Array(readBuffer.getMappedRange().slice(0));
      readBuffer.unmap();
      const positions = [];
      for (let word = 0; word < masks.length; word++) {
        const mask = masks[word];
        for (let lane = 0; lane < 4; lane++) if (mask & (1 << lane)) positions.push(word * 4 + lane);
      }
      return positions;
    } finally {
      inputBuffer.destroy(); maskBuffer.destroy(); paramsBuffer.destroy(); readBuffer.destroy();
    }
  }

  return Object.freeze({
    backend: 'webgpu-wgsl',
    findSpecialAsciiPositions,
    async dispose() { if (!disposed) { disposed = true; device.destroy(); } }
  });
}

module.exports = { createWebGpuScanner, WGSL_SOURCE };
