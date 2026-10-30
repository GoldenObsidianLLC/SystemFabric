'use strict';

const { createRealtimeHub, realtimeError, SITE_ID_RE } = require('./event-hub');
const { createMemoryPresenceAdapter, createPresenceService, AVAILABILITY } = require('./presence');
const { createSseGateway } = require('./sse-gateway');
const eventContract = require('./event-contract');
const redisPresence = require('./redis-presence');
const redisRealtime = require('./redis-realtime');

module.exports = {
  createRealtimeHub,
  createMemoryPresenceAdapter,
  createPresenceService,
  createSseGateway,
  realtimeError,
  SITE_ID_RE,
  AVAILABILITY,
  ...redisPresence,
  ...redisRealtime,
  ...eventContract
};
