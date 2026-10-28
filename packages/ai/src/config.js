'use strict';

function boundedInt(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    const error = new TypeError(`${name} must be an integer between ${min} and ${max}.`);
    error.code = 'ERR_SYSTEMFABRIC_CONFIG_LIMIT';
    throw error;
  }
  return parsed;
}

module.exports = { boundedInt };
