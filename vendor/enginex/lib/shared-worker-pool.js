'use strict';

const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const SPECIALS = new Set([38, 60, 62, 34, 39]);

/**
 * Shared-memory worker pool for bulk ASCII byte scanning. The input and result
 * bitmap live in SharedArrayBuffers; only bounded task descriptors cross the
 * worker message channel. This is intentionally not used for tiny template renders.
 */
class SharedWorkerPool {
  constructor(options = {}) {
    const cpus = Math.max(1, (os.availableParallelism?.() || os.cpus().length) - 1);
    this.size = clamp(options.size ?? Math.min(4, cpus), 1, 8);
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.minBytes = options.minBytes ?? 256 * 1024;
    this.maxQueuedJobs = clamp(options.maxQueuedJobs ?? this.size * 16, 0, 100000);
    this.closed = false;
    this.nextId = 1;
    this.workers = [];
    this.stats = { scans: 0, scannedBytes: 0, workerChunks: 0 };
    this._workerPath = options.workerPath || path.join(__dirname, '..', 'workers', 'shared-scan-worker.js');
    for (let i = 0; i < this.size; i++) this._spawn();
  }

  _spawn() {
    const slot = { worker: new Worker(this._workerPath), busy: false, current: null };
    slot.worker.on('message', message => {
      const pending = slot.current;
      if (!pending || pending.id !== message.id) return;
      slot.current = null;
      slot.busy = false;
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.error || 'Shared worker task failed.'));
      this._dispatch();
    });
    slot.worker.on('error', error => {
      const pending = slot.current;
      slot.current = null;
      slot.busy = false;
      if (pending) pending.reject(error);
      // The exit handler owns replacement to avoid spawning twice for one failure.
      this._dispatch();
    });
    slot.worker.on('exit', code => {
      if (slot.current) slot.current.reject(new Error(`Shared worker exited with code ${code}.`));
      this.workers = this.workers.filter(item => item !== slot);
      if (!this.closed) this._spawn();
    });
    this.workers.push(slot);
  }

  async findSpecialAsciiPositions(text) {
    if (this.closed) throw new Error('SharedWorkerPool is closed.');
    if (typeof text !== 'string') throw new TypeError('Input must be a string.');
    // UTF-8 byte positions are not JS string indices for non-ASCII input.
    for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 0x7f) return null;
    if (text.length < this.minBytes || text.length === 0) return scanJs(text);
    if (text.length > this.maxBytes) throw new RangeError(`Input exceeds shared scan limit (${this.maxBytes} bytes).`);

    await this._waitUntilReady();
    const inputBuffer = new SharedArrayBuffer(text.length);
    new Uint8Array(inputBuffer).set(Buffer.from(text, 'ascii'));
    const bitmapBuffer = new SharedArrayBuffer(text.length);
    const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
    const chunkSize = Math.ceil(text.length / this.workers.length);
    const jobs = [];
    for (let start = 0; start < text.length; start += chunkSize) {
      jobs.push(this._run({
        inputBuffer, bitmapBuffer, controlBuffer,
        start, end: Math.min(text.length, start + chunkSize)
      }));
    }
    await Promise.all(jobs);
    const bitmap = new Uint8Array(bitmapBuffer);
    const positions = [];
    for (let index = 0; index < bitmap.length; index++) if (bitmap[index]) positions.push(index);
    const control = new Int32Array(controlBuffer);
    this.stats.scans++;
    this.stats.scannedBytes += Atomics.load(control, 0);
    this.stats.workerChunks += Atomics.load(control, 2);
    return positions;
  }

  async _run(payload) {
    const pending = { ...payload, id: this.nextId++, resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
    if (!this._queue) this._queue = [];
    if (this._queue.length >= this.maxQueuedJobs) {
      const error = new Error(`Shared worker queue is full (maxQueuedJobs=${this.maxQueuedJobs}).`);
      error.code = 'ERR_ENGINEX_BACKPRESSURE';
      error.retryable = true;
      throw error;
    }
    this._queue.push(pending);
    this._dispatch();
    return promise;
  }

  _dispatch() {
    if (!this._queue) return;
    for (const slot of this.workers) {
      if (slot.busy) continue;
      const pending = this._queue.shift();
      if (!pending) break;
      slot.busy = true;
      slot.current = pending;
      slot.worker.postMessage({
        id: pending.id,
        inputBuffer: pending.inputBuffer,
        bitmapBuffer: pending.bitmapBuffer,
        controlBuffer: pending.controlBuffer,
        start: pending.start,
        end: pending.end
      });
    }
  }

  async _waitUntilReady() {
    while (this.workers.length === 0 || this.workers.every(slot => slot.worker.threadId === -1)) {
      if (this.closed) throw new Error('SharedWorkerPool is closed.');
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const queued = this._queue || [];
    this._queue = [];
    for (const task of queued) task.reject(new Error('SharedWorkerPool closed before task execution.'));
    await Promise.all(this.workers.map(slot => slot.worker.terminate().catch(() => {})));
    this.workers = [];
  }

  getStats() { return { ...this.stats, workers: this.workers.length, queuedJobs: this._queue?.length || 0, maxQueuedJobs: this.maxQueuedJobs, closed: this.closed }; }
}

function scanJs(text) {
  const positions = [];
  for (let index = 0; index < text.length; index++) if (SPECIALS.has(text.charCodeAt(index))) positions.push(index);
  return positions;
}
function clamp(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Value must be an integer between ${min} and ${max}.`);
  return value;
}

module.exports = { SharedWorkerPool };
