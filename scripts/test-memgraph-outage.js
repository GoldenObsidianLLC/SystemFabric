'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { loadEnvFile } = require('./load-env');
const { createPostgresPool } = require('../packages/db/src/postgres-store');
const { createOutboxWorker } = require('../packages/db/src/outbox-worker');
const {
  createMemgraphDriver,
  createMemgraphProjector,
} = require('../packages/graph/src/memgraph-store');

loadEnvFile(path.resolve(process.cwd(), '.env'));

const EXPECTED_MEMGRAPH_IMAGE = 'memgraph/memgraph:3.13.1';

function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      `Docker ${args[0]} failed: ${
        result.error?.message ||
        result.stderr?.trim() ||
        `exit code ${result.status}`
      }`
    );
  }

  return result.stdout.trim();
}

function isContainerRunning(containerId) {
  return docker([
    'inspect',
    '--format={{.State.Running}}',
    containerId,
  ]) === 'true';
}

function createGraphConnection(graphUrl) {
  const driver = createMemgraphDriver({
    url: graphUrl,
    username: process.env.MEMGRAPH_USERNAME || '',
    password: process.env.MEMGRAPH_PASSWORD || '',
  });

  return {
    driver,
    projector: createMemgraphProjector({ driver }),
  };
}

async function waitForGraph(driver, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await driver.verifyConnectivity();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }

  throw new Error(
    `${label} did not become available: ${lastError?.message || 'timeout'}`
  );
}

async function main() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  const graphUrl =
    process.env.MEMGRAPH_TEST_URL || process.env.MEMGRAPH_URL;
  const containerId = process.env.MEMGRAPH_TEST_CONTAINER_ID;

  assert.ok(
    testDatabaseUrl,
    'TEST_DATABASE_URL is required; refusing to use DATABASE_URL implicitly'
  );

  assert.ok(
    graphUrl,
    'MEMGRAPH_TEST_URL or MEMGRAPH_URL is required'
  );

  assert.ok(
    containerId,
    'MEMGRAPH_TEST_CONTAINER_ID must identify the dedicated Memgraph test container'
  );

  const databaseUrl = new URL(testDatabaseUrl);
  const databaseName = decodeURIComponent(
    databaseUrl.pathname.replace(/^\/+/, '')
  );

  assert.match(
    databaseName,
    /(?:^|[_-])test$/i,
    'Refusing to run against a database whose name does not end in test'
  );

  assert.ok(
    new Set(['127.0.0.1', 'localhost', 'postgres', '[::1]'])
      .has(databaseUrl.hostname.toLowerCase()),
    'Refusing to use a remote PostgreSQL endpoint for this destructive test'
  );

  const graphEndpoint = new URL(graphUrl);

  assert.ok(
    new Set(['127.0.0.1', 'localhost', '[::1]', 'memgraph'])
      .has(graphEndpoint.hostname.toLowerCase()),
    'Refusing to use a remote Memgraph endpoint for this destructive test'
  );

  assert.match(
    containerId,
    /^[a-f0-9]{12,64}$/i,
    'The Memgraph container ID must be a Docker container ID'
  );

  const image = docker([
    'inspect',
    '--format={{.Config.Image}}',
    containerId,
  ]);

  assert.equal(
    image,
    EXPECTED_MEMGRAPH_IMAGE,
    'Safety stop: refusing to stop a container that is not the expected Memgraph test image'
  );

  assert.ok(
    isContainerRunning(containerId),
    'The dedicated Memgraph test container must already be running'
  );

  let pool;
  let driver;
  let projector;
  let eventId;
  let contentId;
  let siteId;
  let cleanupError;

  try {
    pool = createPostgresPool({
      DATABASE_URL: testDatabaseUrl,
      DATABASE_POOL_MAX: '4',
    });

    ({ driver, projector } = createGraphConnection(graphUrl));

    await waitForGraph(driver, 'Memgraph startup');

    const existing = await pool.query(
      `SELECT count(*)::int AS count
         FROM outbox_events
        WHERE status IN ('pending', 'processing')`
    );

    assert.equal(
      existing.rows[0].count,
      0,
      'The isolated test database must not have unrelated pending outbox events'
    );

    contentId = randomUUID();
    siteId = randomUUID();

    const payload = {
      id: contentId,
      siteId,
      contentType: 'page',
      slug: `outage-${randomUUID().slice(0, 8)}`,
      locale: 'en',
      status: 'published',
      title: 'Memgraph Outage Recovery Fixture',
      version: 1,
    };

    const inserted = await pool.query(
      `INSERT INTO outbox_events(
         aggregate_type,
         aggregate_id,
         aggregate_version,
         event_type,
         payload
       )
       VALUES (
         'integration-memgraph-outage',
         $1,
         1,
         'content.upsert',
         $2::jsonb
       )
       RETURNING id`,
      [contentId, JSON.stringify(payload)]
    );

    eventId = inserted.rows[0].id;

    const createWorker = currentProjector => createOutboxWorker({
      pool,
      projector: currentProjector,
      workerId: `it-outage-${randomUUID()}`,
      batchSize: 1,
      maxAttempts: 3,
      onError: error => {
        console.log(
          `Projection attempt failed: ${error.errorCode}`
        );
      },
    });

    const firstWorker = createWorker(projector);

    console.log(
      `Stopping isolated Memgraph container ${containerId.slice(0, 12)}.`
    );

    docker(['stop', '--time', '2', containerId]);

    assert.equal(
      isContainerRunning(containerId),
      false,
      'Docker must confirm Memgraph has actually stopped'
    );

    console.log('Memgraph is stopped; attempting to process the persisted event.');

    const first = await firstWorker.runOnce();

    assert.equal(first.claimed, 1);
    assert.equal(first.results.length, 1);
    assert.equal(first.results[0].id, eventId);
    assert.equal(first.results[0].ok, false);
    assert.equal(first.results[0].dead, false);

    const failed = await pool.query(
      `SELECT status, attempts, last_error_code, locked_by, lease_expires_at
         FROM outbox_events
        WHERE id = $1`,
      [eventId]
    );

    assert.equal(failed.rows[0].status, 'pending');
    assert.equal(failed.rows[0].attempts, 1);
    assert.ok(failed.rows[0].last_error_code);
    assert.equal(failed.rows[0].locked_by, null);
    assert.equal(failed.rows[0].lease_expires_at, null);

    console.log(
      'PASS: the real graph outage left the event pending and released its worker lease.'
    );

    console.log('Restarting Memgraph.');

    docker(['start', containerId]);

    await waitForGraph(driver, 'Memgraph recovery');

    // Create a fresh driver after the outage, simulating a worker process
    // establishing a new connection after its graph dependency recovers.
    await driver.close();
    driver = null;
    projector = null;

    ({ driver, projector } = createGraphConnection(graphUrl));

    await waitForGraph(driver, 'Fresh graph connection');

    const retryReady = await pool.query(
      `UPDATE outbox_events
          SET available_at = now() - interval '1 second'
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [eventId]
    );

    assert.equal(retryReady.rowCount, 1);

    const recoveryWorker = createWorker(projector);
    const second = await recoveryWorker.runOnce();

    assert.equal(second.claimed, 1);
    assert.equal(second.results[0].id, eventId);
    assert.equal(second.results[0].ok, true);

    const recovered = await pool.query(
      `SELECT status, attempts, last_error_code, processed_at, locked_by
         FROM outbox_events
        WHERE id = $1`,
      [eventId]
    );

    assert.equal(recovered.rows[0].status, 'processed');
    assert.equal(recovered.rows[0].attempts, 2);
    assert.equal(recovered.rows[0].last_error_code, null);
    assert.ok(recovered.rows[0].processed_at);
    assert.equal(recovered.rows[0].locked_by, null);

    const session = driver.session();

    try {
      const projected = await session.run(
        `MATCH (n:Content {id: $id, siteId: $siteId})
         RETURN n.version AS version, n.slug AS slug`,
        { id: contentId, siteId }
      );

      assert.equal(projected.records.length, 1);
      assert.equal(projected.records[0].get('version'), 1);
      assert.equal(projected.records[0].get('slug'), payload.slug);
    } finally {
      await session.close();
    }

    // A processed event must not be replayed a second time.
    const third = await recoveryWorker.runOnce();

    assert.equal(third.claimed, 0);

    console.log('PASS: the persisted event replayed after Memgraph restarted.');
    console.log('PASS: the expected content projection exists in Memgraph.');
    console.log('PASS: the processed event was not replayed again.');
    console.log('REAL MEMGRAPH OUTAGE RESULT: PASS');
  } finally {
    // Always attempt to restore the graph service before releasing resources.
    try {
      if (!isContainerRunning(containerId)) {
        console.log('Cleanup: restarting the Memgraph container.');
        docker(['start', containerId]);
      }
    } catch (error) {
      cleanupError = error;
      console.error(`Memgraph restart cleanup failed: ${error.message}`);
    }

    if (driver && contentId && siteId && !cleanupError) {
      try {
        await waitForGraph(driver, 'Memgraph cleanup', 20_000);

        const session = driver.session();

        try {
          await session.run(
            `MATCH (n:Content {id: $id, siteId: $siteId})
             DETACH DELETE n`,
            { id: contentId, siteId }
          );
        } finally {
          await session.close();
        }
      } catch (error) {
        cleanupError = error;
        console.error(`Graph fixture cleanup failed: ${error.message}`);
      }
    }

    if (pool && eventId) {
      await pool.query(
        'DELETE FROM outbox_events WHERE id = $1',
        [eventId]
      ).catch(error => {
        cleanupError ||= error;
        console.error(`Outbox fixture cleanup failed: ${error.message}`);
      });
    }

    if (driver) {
      await driver.close().catch(error => {
        cleanupError ||= error;
      });
    }

    if (pool) {
      await pool.end().catch(error => {
        cleanupError ||= error;
      });
    }

    if (cleanupError) {
      throw cleanupError;
    }
  }
}

main().catch(error => {
  console.error(`REAL MEMGRAPH OUTAGE TEST FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
