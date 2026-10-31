'use strict';

const { createRealtimeHub, realtimeError, SITE_ID_RE } = require('./event-hub');
const { createMemoryPresenceAdapter, createPresenceService, AVAILABILITY } = require('./presence');
const { createSseGateway } = require('./sse-gateway');
const eventContract = require('./event-contract');
const redisPresence = require('./redis-presence');
const redisRealtime = require('./redis-realtime');
const connectionQuota = require('./connection-quota');
const { createWebSocketGateway } = require('./websocket-gateway');
const realtimeProtocol = require('./realtime-protocol');

module.exports = {
  createRealtimeHub,
  createMemoryPresenceAdapter,
  createPresenceService,
  createSseGateway,
  createWebSocketGateway,
  realtimeError,
  SITE_ID_RE,
  AVAILABILITY,
  ...redisPresence,
  ...redisRealtime,
  ...connectionQuota,
  ...realtimeProtocol,
  ...eventContract
};
