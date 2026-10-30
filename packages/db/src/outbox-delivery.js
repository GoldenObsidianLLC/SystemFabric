'use strict';

const { randomUUID } = require('node:crypto');
const { eventEnvelopeFromOutboxRow } = require('../../realtime/src/event-contract');

const CONSUMER_GROUP_PATTERN = /^[a-z][a-z0-9._-]{0,99}$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPLAYABLE_STATUSES = new Set(['dead', 'processed']);

function validateConsumerGroup(consumerGroup) {
  if (typeof consumerGroup !== 'string' || !CONSUMER_GROUP_PATTERN.test(consumerGroup)) {
    throw Object.assign(new TypeError('consumerGroup must be a lowercase identifier of 1-100 characters.'), {
      code: 'ERR_SYSTEMFABRIC_CONSUMER_GROUP_INVALID'
    });
  }
  return consumerGroup;
}

function validateEventTypes(eventTypes) {
  if (!Array.isArray(eventTypes) || eventTypes.length < 1 || eventTypes.length > 64 ||
      eventTypes.some(type => typeof type !== 'string' || type.length > 96 || !EVENT_TYPE_PATTERN.test(type)) ||
      new Set(eventTypes).size !== eventTypes.length) {
    throw Object.assign(new TypeError('eventTypes must contain 1-64 unique, valid event identifiers.'), {
      code: 'ERR_SYSTEMFABRIC_CONSUMER_EVENT_TYPES_INVALID'
    });
  }
  return Object.freeze([...eventTypes].sort());
}

function createOutboxDeliveryWorker({
  pool,
  consumerGroup,
  eventTypes,
  handler,
  workerId = `sf-delivery-${randomUUID()}`,
  batchSize = 25,
  dispatchBatchSize = 250,
  leaseMs = 30_000,
  maxAttempts = 10,
  onError = () => {}
}) {
  validateConsumerGroup(consumerGroup);
  const subscribedEventTypes = validateEventTypes(eventTypes);
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query is required.');
  if (typeof handler !== 'function') throw new TypeError('handler must be a function.');
  if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 100) throw new TypeError('workerId must be 1-100 characters.');
  for (const [name, value] of Object.entries({ batchSize, dispatchBatchSize, leaseMs, maxAttempts })) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  }
  if (typeof onError !== 'function') throw new TypeError('onError must be a function.');

  async function ensureConsumerGroup() {
    await pool.query(
      `INSERT INTO outbox_consumer_groups(consumer_group, event_types)
       VALUES ($1, $2::text[])
       ON CONFLICT (consumer_group) DO NOTHING`,
      [consumerGroup, subscribedEventTypes]
    );
    const configured = await pool.query(
      'SELECT event_types FROM outbox_consumer_groups WHERE consumer_group=$1',
      [consumerGroup]
    );
    const persisted = Array.isArray(configured.rows[0]?.event_types)
      ? [...configured.rows[0].event_types].sort()
      : [];
    if (persisted.length !== subscribedEventTypes.length ||
        persisted.some((type, index) => type !== subscribedEventTypes[index])) {
      throw Object.assign(new Error('The persisted event subscription for this consumer group does not match worker configuration.'), {
        code: 'ERR_SYSTEMFABRIC_CONSUMER_EVENT_TYPES_MISMATCH',
        consumerGroup
      });
    }
  }

  async function dispatchBatch() {
    const result = await pool.query(
      `INSERT INTO outbox_deliveries(event_id, consumer_group)
       SELECT e.id, $1
         FROM outbox_events e
         JOIN outbox_consumer_groups g
           ON g.consumer_group = $1 AND g.enabled = true
        WHERE e.event_type = ANY(g.event_types)
          AND NOT EXISTS (
          SELECT 1
            FROM outbox_deliveries existing
           WHERE existing.event_id = e.id
             AND existing.consumer_group = $1
        )
        ORDER BY e.created_at, e.id
        LIMIT $2
       ON CONFLICT (event_id, consumer_group) DO NOTHING
       RETURNING event_id`,
      [consumerGroup, dispatchBatchSize]
    );
    return result.rowCount || 0;
  }

  async function claimBatch() {
    const claimToken = `${workerId}:${randomUUID()}`;
    const result = await pool.query(
      `WITH candidates AS (
         SELECT d.event_id
           FROM outbox_deliveries d
           JOIN outbox_events e ON e.id = d.event_id
           JOIN outbox_consumer_groups g
             ON g.consumer_group = d.consumer_group AND g.enabled = true
          WHERE d.consumer_group = $1
            AND (
              (d.status = 'pending' AND d.available_at <= now())
              OR
              (d.status = 'processing' AND d.lease_expires_at < now())
            )
            AND NOT EXISTS (
              SELECT 1
                FROM outbox_events prior_event
                JOIN outbox_consumer_groups prior_group
                  ON prior_group.consumer_group = d.consumer_group
                 AND prior_event.event_type = ANY(prior_group.event_types)
                LEFT JOIN outbox_deliveries prior_delivery
                  ON prior_delivery.event_id = prior_event.id
                 AND prior_delivery.consumer_group = d.consumer_group
               WHERE prior_event.aggregate_type = e.aggregate_type
                 AND prior_event.aggregate_id = e.aggregate_id
                 AND ROW(prior_event.aggregate_version, prior_event.created_at, prior_event.id)
                   < ROW(e.aggregate_version, e.created_at, e.id)
                 AND (
                   prior_delivery.event_id IS NULL
                   OR prior_delivery.status <> 'processed'
                 )
            )
          ORDER BY e.created_at, e.id
          LIMIT $2
          FOR UPDATE OF d SKIP LOCKED
       )
       UPDATE outbox_deliveries d
          SET status = 'processing',
              locked_by = $3,
              locked_at = now(),
              lease_expires_at = now() + ($4::text || ' milliseconds')::interval,
              attempts = d.attempts + 1
         FROM candidates c
         JOIN outbox_events e ON e.id = c.event_id
        WHERE d.event_id = c.event_id
          AND d.consumer_group = $1
       RETURNING e.id, e.aggregate_type, e.aggregate_id, e.aggregate_version,
                 e.event_type, e.payload, e.schema_version, e.site_id, e.actor_id,
                 e.correlation_id, e.causation_id, e.classification, e.created_at,
                 d.attempts AS delivery_attempts`,
      [consumerGroup, batchSize, claimToken, leaseMs]
    );
    return { rows: result.rows, claimToken };
  }

  async function processOne(event, claimToken) {
    let envelope;
    try {
      envelope = eventEnvelopeFromOutboxRow(event);
      await handler({
        type: event.event_type,
        payload: event.payload,
        envelope,
        delivery: { consumerGroup, attempt: Number(event.delivery_attempts) }
      });
      const acknowledged = await pool.query(
        `UPDATE outbox_deliveries
            SET status = 'processed',
                processed_at = now(),
                locked_by = NULL,
                locked_at = NULL,
                lease_expires_at = NULL,
                last_error_code = NULL
          WHERE event_id = $1
            AND consumer_group = $2
            AND status = 'processing'
            AND locked_by = $3`,
        [event.id, consumerGroup, claimToken]
      );
      return acknowledged.rowCount
        ? { eventId: event.id, ok: true }
        : { eventId: event.id, ok: false, leaseLost: true };
    } catch (error) {
      const attempts = Number(event.delivery_attempts || 1);
      const dead = attempts >= maxAttempts;
      const delayMs = Math.min(3_600_000, 1000 * (2 ** Math.min(attempts, 12)));
      const code = String(error.code || 'ERR_OUTBOX_DELIVERY').slice(0, 100);
      const updated = await pool.query(
        `UPDATE outbox_deliveries
            SET status = $4,
                available_at = now() + ($5::text || ' milliseconds')::interval,
                locked_by = NULL,
                locked_at = NULL,
                lease_expires_at = NULL,
                last_error_code = $6
          WHERE event_id = $1
            AND consumer_group = $2
            AND status = 'processing'
            AND locked_by = $3`,
        [event.id, consumerGroup, claimToken, dead ? 'dead' : 'pending', delayMs, code]
      );
      try {
        onError({ eventId: event.id, consumerGroup, errorCode: code, dead, leaseLost: !updated.rowCount });
      } catch {}
      return updated.rowCount
        ? { eventId: event.id, ok: false, dead, errorCode: code }
        : { eventId: event.id, ok: false, leaseLost: true, errorCode: code };
    }
  }

  return Object.freeze({
    async runOnce() {
      await ensureConsumerGroup();
      const dispatched = await dispatchBatch();
      const claim = await claimBatch();
      const results = [];
      for (const event of claim.rows) results.push(await processOne(event, claim.claimToken));
      return { dispatched, claimed: claim.rows.length, results };
    },
    async run({ signal, pollMs = 1000 } = {}) {
      if (!Number.isInteger(pollMs) || pollMs < 0) throw new RangeError('pollMs must be a non-negative integer.');
      while (!signal?.aborted) {
        const result = await this.runOnce();
        if (result.claimed === 0 && result.dispatched === 0) {
          await new Promise(resolve => setTimeout(resolve, pollMs));
        }
      }
    }
  });
}

async function replayOutboxDeliveries({ pool, consumerGroup, eventIds, statuses = ['dead'] }) {
  validateConsumerGroup(consumerGroup);
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query is required.');
  if (!Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > 500 ||
      eventIds.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
    throw Object.assign(new TypeError('eventIds must contain 1-500 valid UUIDs.'), {
      code: 'ERR_SYSTEMFABRIC_REPLAY_EVENT_IDS_INVALID'
    });
  }
  if (!Array.isArray(statuses) || statuses.length < 1 ||
      statuses.some(status => !REPLAYABLE_STATUSES.has(status))) {
    throw Object.assign(new TypeError('Only dead or processed deliveries may be replayed.'), {
      code: 'ERR_SYSTEMFABRIC_REPLAY_STATUS_INVALID'
    });
  }
  const result = await pool.query(
    `UPDATE outbox_deliveries
        SET status = 'pending',
            attempts = 0,
            available_at = now(),
            locked_by = NULL,
            locked_at = NULL,
            lease_expires_at = NULL,
            last_error_code = NULL,
            processed_at = NULL
      WHERE consumer_group = $1
        AND event_id = ANY($2::uuid[])
        AND status = ANY($3::text[])
      RETURNING event_id`,
    [consumerGroup, eventIds, statuses]
  );
  return { replayed: result.rowCount || 0, eventIds: result.rows.map(row => row.event_id) };
}

module.exports = {
  CONSUMER_GROUP_PATTERN,
  EVENT_TYPE_PATTERN,
  createOutboxDeliveryWorker,
  replayOutboxDeliveries,
  validateConsumerGroup,
  validateEventTypes
};
