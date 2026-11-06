'use strict';

const DEFAULT_TIMEOUT_MS = 2500;
const SAFE_ERROR_CODES = new Set([
  '28P01', '3D000', '53300', '57014', '08001', '08006',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH'
]);

function parsePostgresEndpoint(connectionString) {
  if (typeof connectionString !== 'string' || !connectionString.trim()) return null;
  try {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return null;
    const port = Number(url.port || 5432);
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: url.hostname, port, database: decodeURIComponent(url.pathname.replace(/^\/+/, '')) };
  } catch {
    return null;
  }
}

function describePostgresFailure(code) {
  const safeCode = typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : null;
  switch (safeCode) {
    case '28P01': return 'authentication failed (SQLSTATE 28P01); check the local DATABASE_URL or TEST_DATABASE_URL credentials.';
    case '3D000': return 'the configured database does not exist (SQLSTATE 3D000); check the database name and local setup.';
    case '53300': return 'PostgreSQL rejected the connection because its connection limit was reached.';
    case '57014': return 'the read-only readiness query timed out; check database load and availability.';
    case '08001':
    case '08006': return `PostgreSQL connection failed (${code}); check the local service and network settings.`;
    case 'ECONNREFUSED': return 'connection refused; start the local PostgreSQL service and check its port.';
    case 'ECONNRESET': return 'the PostgreSQL connection was reset before the readiness query completed.';
    case 'ETIMEDOUT': return 'the PostgreSQL connection or readiness query timed out.';
    case 'ENOTFOUND': return 'the PostgreSQL host name could not be resolved.';
    case 'EHOSTUNREACH': return 'the PostgreSQL host is unreachable from this machine.';
    default: return 'PostgreSQL authentication/readiness check failed (unknown error).';
  }
}

/**
 * Verifies PostgreSQL credentials and query readiness without changing data.
 * PoolClass is injectable so the behavior can be tested without a live server.
 */
async function checkPostgresConnection(connectionString, {
  PoolClass,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requireTestDatabase = false
} = {}) {
  const endpoint = parsePostgresEndpoint(connectionString);
  if (!endpoint) {
    return { ok: false, reason: 'connection URL is missing, invalid, or not a PostgreSQL URL.' };
  }

  if (requireTestDatabase && !/(^|[_-])test$/i.test(endpoint.database)) {
    return { ok: false, host: endpoint.host, port: endpoint.port, reason: 'the TEST_DATABASE_URL database name must end in test; no connection was opened.' };
  }

  const boundedTimeout = Number.isInteger(timeoutMs) && timeoutMs >= 500 && timeoutMs <= 10_000
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
  let pool;
  try {
    const Pool = PoolClass || require('pg').Pool;
    pool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: boundedTimeout,
      query_timeout: boundedTimeout,
      statement_timeout: boundedTimeout
    });
    const result = await pool.query('SELECT 1 AS ready');
    if (result?.rows?.[0]?.ready !== 1) {
      return {
        ok: false,
        host: endpoint.host,
        port: endpoint.port,
        reason: 'the read-only readiness query returned an unexpected result.'
      };
    }
    return { ok: true, host: endpoint.host, port: endpoint.port };
  } catch (error) {
    const code = typeof error?.code === 'string' && SAFE_ERROR_CODES.has(error.code)
      ? error.code
      : null;
    return {
      ok: false,
      host: endpoint.host,
      port: endpoint.port,
      code,
      reason: describePostgresFailure(code)
    };
  } finally {
    if (pool && typeof pool.end === 'function') {
      await Promise.resolve(pool.end()).catch(() => {});
    }
  }
}

module.exports = { checkPostgresConnection, describePostgresFailure, parsePostgresEndpoint };