'use strict';

/**
 * Return true for a bounded JSON object accepted at the HTTP request seam.
 * Serialization failures fail closed; the limit is measured in UTF-8 bytes.
 */
function isBoundedJsonObject(value, maxBytes = 32_000) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 2) return false;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= maxBytes;
  } catch {
    return false;
  }
}

module.exports = { isBoundedJsonObject };
