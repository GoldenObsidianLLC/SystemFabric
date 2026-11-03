'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { configureReleaseRedisIntegrationEnv } = require('../scripts/release-integration-env');

test('release integration forwards an approved loopback Redis URL to live Redis suites', () => {
  const source = {
    VIRGOSCORPIO_HUB_PRESENCE_REDIS_URL: 'redis://127.0.0.1:6379',
    VIRGOSCORPIO_HUB_RUN_REDIS_INTEGRATION: 'false',
    VIRGOSCORPIO_HUB_TEST_REDIS_URL: 'redis://stale.example:6379',
  };

  const result = configureReleaseRedisIntegrationEnv(source);

  assert.equal(result.VIRGOSCORPIO_HUB_RUN_REDIS_INTEGRATION, 'true');
  assert.equal(result.VIRGOSCORPIO_HUB_TEST_REDIS_URL, 'redis://127.0.0.1:6379');
  assert.equal(source.VIRGOSCORPIO_HUB_TEST_REDIS_URL, 'redis://stale.example:6379');
});

test('release integration accepts the local Redis Compose service hostname', () => {
  const result = configureReleaseRedisIntegrationEnv({
    VIRGOSCORPIO_HUB_PRESENCE_REDIS_URL: 'redis://redis:6379',
  });

  assert.equal(result.VIRGOSCORPIO_HUB_RUN_REDIS_INTEGRATION, 'true');
  assert.equal(result.VIRGOSCORPIO_HUB_TEST_REDIS_URL, 'redis://redis:6379');
});

test('release integration does not enable live Redis suites for a remote endpoint', () => {
  const result = configureReleaseRedisIntegrationEnv({
    VIRGOSCORPIO_HUB_PRESENCE_REDIS_URL: 'redis://cache.example.net:6379',
    VIRGOSCORPIO_HUB_RUN_REDIS_INTEGRATION: 'true',
    VIRGOSCORPIO_HUB_TEST_REDIS_URL: 'redis://127.0.0.1:6379',
  });

  assert.equal(result.VIRGOSCORPIO_HUB_RUN_REDIS_INTEGRATION, undefined);
  assert.equal(result.VIRGOSCORPIO_HUB_TEST_REDIS_URL, undefined);
});

test('release integration clears stale Redis test flags for malformed or absent configuration', () => {
  for (const configuredUrl of [undefined, 'not a redis url']) {
    const source = {
      VIRGOSCORPIO_HUB_PRESENCE_REDIS_URL: configuredUrl,
      VIRGOSCORPIO_HUB_RUN_REDIS_INTEGRATION: 'true',
      VIRGOSCORPIO_HUB_TEST_REDIS_URL: 'redis://127.0.0.1:6379',
    };

    const result = configureReleaseRedisIntegrationEnv(source);

    assert.equal(result.VIRGOSCORPIO_HUB_RUN_REDIS_INTEGRATION, undefined);
    assert.equal(result.VIRGOSCORPIO_HUB_TEST_REDIS_URL, undefined);
  }
});
