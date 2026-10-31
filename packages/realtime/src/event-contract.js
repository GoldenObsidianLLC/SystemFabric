'use strict';

const EVENT_SCHEMA_VERSION = 1;
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPE_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const AGGREGATE_TYPE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CLASSIFICATIONS = new Set(['internal', 'site-private', 'public']);

// Domain event types are explicitly classified. Unknown event types are permitted
// only as internal worker/test messages until a classification is reviewed here.
const DOMAIN_EVENT_CLASSIFICATIONS = Object.freeze({
  'content.upsert': 'site-private',
  'content.publish': 'site-private',
  'content.unpublish': 'site-private',
  'content.delete': 'site-private',
  'content.submitted_for_review': 'site-private',
  'content.approved': 'site-private',
  'content.rejected': 'site-private',
  'content.scheduled': 'site-private',
  'content.archived': 'site-private',
  'content.unpublished': 'site-private',
  'relationship.upsert': 'site-private',
  'relationship.delete': 'site-private',
  'taxonomy.upsert': 'site-private',
  'taxonomy.delete': 'site-private'
});

function eventError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseOccurredAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_TIMESTAMP_INVALID', 'occurredAt must be a valid timestamp.');
  }
  return date.toISOString();
}

function normalizeOptionalIdentifier(value, name, maxLength = 128) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLength || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_IDENTIFIER_INVALID', name + ' must be a safe identifier.');
  }
  return value;
}

function validateEventEnvelope(input) {
  if (!isPlainObject(input)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_INVALID', 'The event envelope must be a plain object.');
  }

  if (typeof input.eventId !== 'string' || !UUID_RE.test(input.eventId)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_ID_INVALID', 'eventId must be a UUID.');
  }
  if (typeof input.eventType !== 'string' || input.eventType.length > 96 || !EVENT_TYPE_RE.test(input.eventType)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_TYPE_INVALID', 'eventType must be a bounded dotted identifier.');
  }

  const schemaVersion = Number(input.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_SCHEMA_UNSUPPORTED', 'The event schema version is not supported by this consumer.');
  }

  const occurredAt = parseOccurredAt(input.occurredAt);
  const classification = input.classification;
  if (!CLASSIFICATIONS.has(classification)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_CLASSIFICATION_INVALID', 'classification must be internal, site-private or public.');
  }

  const siteId = input.siteId === undefined || input.siteId === null ? null : input.siteId;
  if (siteId !== null && (typeof siteId !== 'string' || !UUID_RE.test(siteId))) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_SITE_INVALID', 'siteId must be a UUID when provided.');
  }
  if (classification !== 'internal' && !siteId) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_SITE_REQUIRED', 'Site-scoped and public domain events require siteId.');
  }

  const expectedClassification = DOMAIN_EVENT_CLASSIFICATIONS[input.eventType];
  if (expectedClassification && expectedClassification !== classification) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_CLASSIFICATION_MISMATCH', 'The event type does not match its required classification.');
  }
  if (!expectedClassification && classification !== 'internal') {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_CLASSIFICATION_MISMATCH', 'Unregistered event types must remain internal until their classification is reviewed.');
  }
  if (expectedClassification && !siteId) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_SITE_REQUIRED', 'Domain events require siteId.');
  }

  if (!isPlainObject(input.actor)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_ACTOR_INVALID', 'actor must be an object.');
  }
  const actorType = input.actor.type;
  const actorId = input.actor.id === undefined || input.actor.id === null ? null : input.actor.id;
  if (!['system', 'user'].includes(actorType)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_ACTOR_INVALID', 'actor.type must be system or user.');
  }
  if ((actorType === 'user' && (typeof actorId !== 'string' || !UUID_RE.test(actorId))) ||
      (actorType === 'system' && actorId !== null)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_ACTOR_INVALID', 'actor.id must be a UUID for users and null for system events.');
  }

  if (!isPlainObject(input.resource)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_RESOURCE_INVALID', 'resource must be an object.');
  }
  if (typeof input.resource.type !== 'string' || !AGGREGATE_TYPE_RE.test(input.resource.type)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_RESOURCE_INVALID', 'resource.type must be a bounded identifier.');
  }
  if (typeof input.resource.id !== 'string' || !UUID_RE.test(input.resource.id)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_RESOURCE_INVALID', 'resource.id must be a UUID.');
  }
  const resourceVersion = Number(input.resource.version);
  if (!Number.isSafeInteger(resourceVersion) || resourceVersion < 1) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_RESOURCE_INVALID', 'resource.version must be a positive safe integer.');
  }

  const correlationId = normalizeOptionalIdentifier(input.correlationId, 'correlationId');
  const causationId = normalizeOptionalIdentifier(input.causationId, 'causationId');
  if (causationId !== null && !UUID_RE.test(causationId)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_IDENTIFIER_INVALID', 'causationId must be a UUID.');
  }

  if (!isPlainObject(input.payload)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_PAYLOAD_INVALID', 'payload must be a plain JSON object.');
  }

  let payloadJson;
  try {
    payloadJson = JSON.stringify(input.payload);
  } catch {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_PAYLOAD_INVALID', 'payload must be serializable JSON.');
  }
  if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > MAX_EVENT_PAYLOAD_BYTES) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_PAYLOAD_TOO_LARGE', 'payload exceeds the 64 KiB event limit.');
  }

  const normalized = {
    eventId: input.eventId.toLowerCase(),
    eventType: input.eventType,
    schemaVersion,
    occurredAt,
    siteId: siteId ? siteId.toLowerCase() : null,
    actor: { type: actorType, id: actorId ? actorId.toLowerCase() : null },
    resource: {
      type: input.resource.type,
      id: input.resource.id.toLowerCase(),
      version: resourceVersion
    },
    correlationId,
    causationId: causationId ? causationId.toLowerCase() : null,
    classification,
    payload: JSON.parse(payloadJson)
  };

  normalized.idempotencyKey = [
    normalized.resource.type,
    normalized.resource.id,
    String(normalized.resource.version),
    normalized.eventType
  ].join(':');

  return Object.freeze(normalized);
}

/**
 * Convert a claimed PostgreSQL outbox row to the v1 event contract.
 * outbox_events.id is the stable eventId; the aggregate uniqueness constraint
 * remains the producer idempotency key. Legacy/non-domain worker messages may
 * be internal and unscoped, but classified domain events must have site scope.
 */
function eventEnvelopeFromOutboxRow(row) {
  if (!isPlainObject(row)) {
    throw eventError('ERR_SYSTEMFABRIC_EVENT_INVALID', 'An outbox row is required.');
  }

  const envelope = {
    eventId: row.id,
    eventType: row.event_type,
    schemaVersion: row.schema_version === undefined ? EVENT_SCHEMA_VERSION : Number(row.schema_version),
    occurredAt: row.created_at,
    siteId: row.site_id || null,
    actor: row.actor_id
      ? { type: 'user', id: row.actor_id }
      : { type: 'system', id: null },
    resource: {
      type: row.aggregate_type,
      id: row.aggregate_id,
      version: Number(row.aggregate_version)
    },
    correlationId: row.correlation_id || null,
    causationId: row.causation_id || null,
    classification: row.classification || 'internal',
    payload: row.payload
  };

  return validateEventEnvelope(envelope);
}

module.exports = {
  EVENT_SCHEMA_VERSION,
  MAX_EVENT_PAYLOAD_BYTES,
  DOMAIN_EVENT_CLASSIFICATIONS,
  validateEventEnvelope,
  eventEnvelopeFromOutboxRow,
  eventError,
  isPlainObject
};
