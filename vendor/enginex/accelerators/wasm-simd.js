'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const SPECIAL_REPLACEMENTS = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' });

async function createWasmSimdAccelerator(options = {}) {
  const wasmPath = options.wasmPath || path.join(__dirname, 'wasm', 'scan-special.wasm');
  const bytes = await fs.readFile(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const { memory, scan_special: scanSpecial, __heap_base: heapBase } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof scanSpecial !== 'function') throw new Error('Invalid EnginEx SIMD WebAssembly module.');
  let inUse = false;

  function findSpecialAsciiPositions(text, callOptions = {}) {
    if (typeof text !== 'string') throw new TypeError('Input must be a string.');
    if (text.length < (callOptions.minBytes ?? options.minBytes ?? 65536)) return null;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return null;
    if (inUse) throw new Error('A Wasm SIMD instance cannot be used reentrantly.');
    inUse = true;
    try {
      const input = Buffer.from(text, 'ascii');
      const inputOffset = align16(Number(heapBase.value));
      const outputOffset = align16(inputOffset + input.length);
      const requiredBytes = outputOffset + input.length * Uint32Array.BYTES_PER_ELEMENT + 131072;
      const pageBytes = 65536;
      if (requiredBytes > memory.buffer.byteLength) memory.grow(Math.ceil((requiredBytes - memory.buffer.byteLength) / pageBytes));
      new Uint8Array(memory.buffer, inputOffset, input.length).set(input);
      const capacity = input.length;
      const count = scanSpecial(inputOffset, input.length, outputOffset, capacity);
      const positionsView = new Uint32Array(memory.buffer, outputOffset, Math.min(count, capacity));
      return Array.from(positionsView);
    } finally { inUse = false; }
  }

  function escapeHtmlAscii(text, callOptions = {}) {
    const positions = findSpecialAsciiPositions(text, callOptions);
    if (positions === null) return null;
    if (positions.length === 0) return text;
    const parts = [];
    let previous = 0;
    for (const position of positions) {
      parts.push(text.slice(previous, position), SPECIAL_REPLACEMENTS[text[position]]);
      previous = position + 1;
    }
    parts.push(text.slice(previous));
    return parts.join('');
  }

  return Object.freeze({ backend: 'wasm-simd128', findSpecialAsciiPositions, escapeHtmlAscii, memoryBytes: () => memory.buffer.byteLength });
}
function align16(value) { return (value + 15) & ~15; }
module.exports = { createWasmSimdAccelerator };
