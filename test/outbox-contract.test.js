'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  EVENT_SCHEMA_VERSION,
  eventEnvelopeFromOutboxRow,
  validateEventEnvelope
} = require('../packages/realtime/src/event-contract');

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const RESOURCE_ID = '33333333-3333-4333-8333-333333333333';

function makeOutboxRow(overrides = {}) {
  return {
    id: randomUUID(),
    aggregate_type: 'content',
    aggregate_id: RESOURCE_ID,
    aggregate_version: 7,
    event_type: 'content.publish',
    payload: { slug: 'launch', status: 'published' },
    schema_version: EVENT_SCHEMA_VERSION,
    site_id: SITE_ID,
    actor_id: ACTOR_ID,
    correlation_id: 'req_2026-10-30_abc123',
    causation_id: null,
    classification: 'site-private',
    created_at: new Date('2026-10-30T16:30:00.000Z'),
    ...overrides
  };
}

test('outbox rows normalize into the versioned site-scoped event envelope', () => {
  const row = makeOutboxRow();
  const event = eventEnvelopeFromOutboxRow(row);

  assert.equal(event.eventId, row.id);
  assert.equal(event.eventType, 'content.publish');
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.occurredAt, '2026-10-30T16:30:00.000Z');
  assert.equal(event.siteId, SITE_ID);
  assert.deepEqual(event.actor, { type: 'user', id: ACTOR_ID });
  assert.deepEqual(event.resource, { type: 'content', id: RESOURCE_ID, version: 7 });
  assert.equal(event.correlationId, row.correlation_id);
  assert.equal(event.classification, 'site-private');
  assert.deepEqual(event.payload, row.payload);
  assert.equal(event.idempotencyKey, 'content:' + RESOURCE_ID + ':7:content.publish');
});

test('system-originated events and internal worker messages remain unscoped', () => {
  const row = makeOutboxRow({
    aggregate_type: 'integration-outbox',
    event_type: 'integration.noop',
    site_id: null,
    actor_id: null,
    correlation_id: null,
    classification: 'internal',
    payload: { probe: 'ready' }
  });
  const event = eventEnvelopeFromOutboxRow(row);

  assert.equal(event.siteId, null);
  assert.deepEqual(event.actor, { type: 'system', id: null });
  assert.equal(event.classification, 'internal');
  assert.equal(event.eventId, row.id);
});

test('domain events fail closed when site scope or classification is missing', () => {
  assert.throws(
    () => eventEnvelopeFromOutboxRow(makeOutboxRow({ site_id: null, classification: 'internal' })),
    error => error.code === 'ERR_SYSTEMFABRIC_EVENT_CLASSIFICATION_MISMATCH' ||
      error.code === 'ERR_SYSTEMFABRIC_EVENT_SITE_REQUIRED'
  );

  assert.throws(
    () => eventEnvelopeFromOutboxRow(makeOutboxRow({ classification: 'internal' })),
    { code: 'ERR_SYSTEMFABRIC_EVENT_CLASSIFICATION_MISMATCH' }
  );
});

test('unsupported schema versions fail rather than being interpreted as v1', () => {
  assert.throws(
    () => eventEnvelopeFromOutboxRow(makeOutboxRow({ schema_version: 2 })),
    { code: 'ERR_SYSTEMFABRIC_EVENT_SCHEMA_UNSUPPORTED' }
  );
});

test('envelope validation rejects unsafe identifiers, invalid actors and invalid resources', () => {
  const base = eventEnvelopeFromOutboxRow(makeOutboxRow());

  assert.throws(
    () => validateEventEnvelope({ ...base, eventId: 'not-a-uuid' }),
    { code: 'ERR_SYSTEMFABRIC_EVENT_ID_INVALID' }
  );
  assert.throws(
    () => validateEventEnvelope({ ...base, actor: { type: 'user', id: null } }),
    { code: 'ERR_SYSTEMFABRIC_EVENT_ACTOR_INVALID' }
  );
  assert.throws(
    () => validateEventEnvelope({ ...base, resource: { type: 'content', id: RESOURCE_ID, version: 0 } }),
    { code: 'ERR_SYSTEMFABRIC_EVENT_RESOURCE_INVALID' }
  );
  assert.throws(
    () => validateEventEnvelope({ ...base, correlationId: 'bad\r\nheader' }),
    { code: 'ERR_SYSTEMFABRIC_EVENT_IDENTIFIER_INVALID' }
  );
});

test('event payloads are bounded and must be JSON objects', () => {
  const base = eventEnvelopeFromOutboxRow(makeOutboxRow());
  assert.throws(
    () => validateEventEnvelope({ ...base, payload: [] }),
    { code: 'ERR_SYSTEMFABRIC_EVENT_PAYLOAD_INVALID' }
  );
  assert.throws(
    () => validateEventEnvelope({ ...base, payload: { text: 'x'.repeat(70 * 1024) } }),
    { code: 'ERR_SYSTEMFABRIC_EVENT_PAYLOAD_TOO_LARGE' }
  );
});

test('public and site-private classifications require a valid site UUID', () => {
  const base = eventEnvelopeFromOutboxRow(makeOutboxRow());
  assert.throws(
    () => validateEventEnvelope({ ...base, eventType: 'announcement.created', classification: 'public', siteId: null }),
    { code: 'ERR_SYSTEMFABRIC_EVENT_SITE_REQUIRED' }
  );
  assert.throws(
    () => validateEventEnvelope({ ...base, siteId: null }),
    { code: 'ERR_SYSTEMFABRIC_EVENT_SITE_REQUIRED' }
  );
  assert.throws(
    () => validateEventEnvelope({ ...base, siteId: 'wrong-site-id' }),
    { code: 'ERR_SYSTEMFABRIC_EVENT_SITE_INVALID' }
  );
});


test('outbox worker passes the stable canonical envelope to consumers', async () => {
  const { createOutboxWorker } = require('../packages/db/src/outbox-worker');
  const row = makeOutboxRow();
  const statements = [];
  let applied = null;
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith('SELECT id,aggregate_type')) return { rows: [row] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  const pool = {
    async connect() { return client; },
    async query(sql, params) {
      statements.push(sql);
      assert.equal(params[0], row.id);
      return { rows: [], rowCount: 1 };
    }
  };
  const worker = createOutboxWorker({
    pool,
    projector: {
      async apply(input) { applied = input; }
    },
    workerId: 'contract-test-worker'
  });

  const result = await worker.runOnce();
  assert.equal(result.claimed, 1);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].eventId, row.id);
  assert.equal(applied.type, row.event_type);
  assert.deepEqual(applied.payload, row.payload);
  assert.equal(applied.envelope.eventId, row.id);
  assert.equal(applied.envelope.resource.id, row.aggregate_id);
  assert.ok(statements.some(sql => sql === 'COMMIT'));
});
