'use strict';

const RECONNECT_POLICY = Object.freeze({
  minDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 8,
  jitter: 'full',
  resumeMode: 'snapshot-refresh',
  eventReplay: false
});

function createConnectionReadyPayload({ heartbeatMs = 15_000 } = {}) {
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 5_000 || heartbeatMs > 60_000) {
    throw new RangeError('heartbeatMs must be between 5000 and 60000.');
  }
  return Object.freeze({
    type: 'connection.ready',
    protocolVersion: 1,
    heartbeatMs,
    recovery: RECONNECT_POLICY
  });
}

module.exports = { RECONNECT_POLICY, createConnectionReadyPayload };
