'use strict';

/**
 * Bounded TTL cache for already-rendered HTML strings.
 *
 * This is intentionally an explicit application-level primitive, not implicit
 * caching middleware: the application must provide a safe cache key that
 * includes every output-affecting dimension (tenant, locale, permissions,
 * variant, etc.). Never put personalized HTML in a public/shared cache unless
 * its key and authorization model make that safe.
 */
class ResponseCache {
  constructor({ maxEntries = 256, maxBytes = 16 * 1024 * 1024, ttlMs = 30_000 } = {}) {
    this.maxEntries = integerAtLeastZero(maxEntries, 'maxEntries');
    this.maxBytes = integerAtLeastZero(maxBytes, 'maxBytes');
    this.ttlMs = integerAtLeastZero(ttlMs, 'ttlMs');
    this.entries = new Map();
    this.bytes = 0;
    this.metrics = { hits: 0, misses: 0, sets: 0, evictions: 0, expirations: 0, bypasses: 0 };
  }

  get(key) {
    validateKey(key);
    const entry = this.entries.get(key);
    if (!entry) { this.metrics.misses++; return undefined; }
    if (entry.expiresAt <= Date.now()) {
      this.#deleteEntry(key, entry);
      this.metrics.misses++;
      this.metrics.expirations++;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.metrics.hits++;
    return entry.value;
  }

  set(key, value, { ttlMs = this.ttlMs } = {}) {
    validateKey(key);
    if (typeof value !== 'string') throw new TypeError('ResponseCache stores HTML strings only.');
    const ttl = integerAtLeastZero(ttlMs, 'ttlMs');
    const bytes = Buffer.byteLength(value, 'utf8');
    if (this.maxEntries === 0 || this.maxBytes === 0 || ttl === 0 || bytes > this.maxBytes) {
      this.metrics.bypasses++;
      return false;
    }
    const previous = this.entries.get(key);
    if (previous) this.#deleteEntry(key, previous);
    const entry = { value, bytes, expiresAt: Date.now() + ttl };
    this.entries.set(key, entry);
    this.bytes += bytes;
    this.metrics.sets++;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.#deleteEntry(oldestKey, this.entries.get(oldestKey));
      this.metrics.evictions++;
    }
    return this.entries.has(key);
  }

  delete(key) {
    validateKey(key);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.#deleteEntry(key, entry);
    return true;
  }

  clear() { this.entries.clear(); this.bytes = 0; }
  stats() { return Object.freeze({ ...this.metrics, entries: this.entries.size, bytes: this.bytes, maxEntries: this.maxEntries, maxBytes: this.maxBytes }); }

  #deleteEntry(key, entry) {
    if (!entry) return;
    if (this.entries.delete(key)) this.bytes -= entry.bytes;
  }
}

function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 2048 || key.includes('\0')) {
    throw new TypeError('ResponseCache keys must be non-empty strings of at most 2048 characters without NUL bytes.');
  }
}
function integerAtLeastZero(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer.`);
  return value;
}

function createResponseCache(options) { return new ResponseCache(options); }
module.exports = { ResponseCache, createResponseCache };
