'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { configureReleaseRedisIntegrationEnv } = require('../scripts/release-integration-env');

test('release integration forwards an approved loopback Redis URL to live Redis suites', () => {
  const source = {
    SYSTEMFABRIC_PRESENCE_REDIS_URL: 'redis://127.0.0.1:6379',
    SYSTEMFABRIC_RUN_REDIS_INTEGRATION: 'false',
    SYSTEMFABRIC_TEST_REDIS_URL: 'redis://stale.example:6379',
  };

  const result = configureReleaseRedisIntegrationEnv(source);

  assert.equal(result.SYSTEMFABRIC_RUN_REDIS_INTEGRATION, 'true');
  assert.equal(result.SYSTEMFABRIC_TEST_REDIS_URL, 'redis://127.0.0.1:6379');
  assert.equal(source.SYSTEMFABRIC_TEST_REDIS_URL, 'redis://stale.example:6379');
});

test('release integration accepts the local Redis Compose service hostname', () => {
  const result = configureReleaseRedisIntegrationEnv({
    SYSTEMFABRIC_PRESENCE_REDIS_URL: 'redis://redis:6379',
  });

  assert.equal(result.SYSTEMFABRIC_RUN_REDIS_INTEGRATION, 'true');
  assert.equal(result.SYSTEMFABRIC_TEST_REDIS_URL, 'redis://redis:6379');
});

test('release integration does not enable live Redis suites for a remote endpoint', () => {
  const result = configureReleaseRedisIntegrationEnv({
    SYSTEMFABRIC_PRESENCE_REDIS_URL: 'redis://cache.example.net:6379',
    SYSTEMFABRIC_RUN_REDIS_INTEGRATION: 'true',
    SYSTEMFABRIC_TEST_REDIS_URL: 'redis://127.0.0.1:6379',
  });

  assert.equal(result.SYSTEMFABRIC_RUN_REDIS_INTEGRATION, undefined);
  assert.equal(result.SYSTEMFABRIC_TEST_REDIS_URL, undefined);
});

test('release integration clears stale Redis test flags for malformed or absent configuration', () => {
  for (const configuredUrl of [undefined, 'not a redis url']) {
    const source = {
      SYSTEMFABRIC_PRESENCE_REDIS_URL: configuredUrl,
      SYSTEMFABRIC_RUN_REDIS_INTEGRATION: 'true',
      SYSTEMFABRIC_TEST_REDIS_URL: 'redis://127.0.0.1:6379',
    };

    const result = configureReleaseRedisIntegrationEnv(source);

    assert.equal(result.SYSTEMFABRIC_RUN_REDIS_INTEGRATION, undefined);
    assert.equal(result.SYSTEMFABRIC_TEST_REDIS_URL, undefined);
  }
});
