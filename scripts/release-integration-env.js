'use strict';

const LOCAL_REDIS_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', 'redis']);

/**
 * Enables live Redis integration only when the configured presence endpoint is
 * an explicitly local Redis service. The document-collaboration suites consume
 * SYSTEMFABRIC_TEST_REDIS_URL, so keep it aligned with the approved presence
 * endpoint instead of allowing those suites to silently skip.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment
 * @returns {Record<string, string | undefined>}
 */
function configureReleaseRedisIntegrationEnv(environment = process.env) {
  const result = { ...environment };

  // Do not inherit stale opt-in flags from a caller's environment.
  delete result.SYSTEMFABRIC_RUN_REDIS_INTEGRATION;
  delete result.SYSTEMFABRIC_TEST_REDIS_URL;

  const raw = result.SYSTEMFABRIC_PRESENCE_REDIS_URL;
  if (typeof raw !== 'string' || !raw.trim()) return result;

  try {
    const parsed = new URL(raw);
    if (!['redis:', 'rediss:'].includes(parsed.protocol)) return result;
    if (!LOCAL_REDIS_HOSTS.has(parsed.hostname.toLowerCase())) return result;

    result.SYSTEMFABRIC_RUN_REDIS_INTEGRATION = 'true';
    result.SYSTEMFABRIC_TEST_REDIS_URL = raw;
  } catch {
    // Invalid optional configuration leaves the explicit live suites disabled.
  }

  return result;
}

module.exports = { configureReleaseRedisIntegrationEnv };
