'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { loadEnvFile } = require('../../../scripts/load-env');
const { createAIService } = require('../../../packages/ai/src/service');
const { createPostgresPool, createPostgresStore, extractPageText } = require('../../../packages/db/src/postgres-store');
const { parseAIContextContentIds, buildAIPageContext, MAX_AI_CONTEXT_CHARS } = require('../../../packages/ai/src/context-assembler');
const { createAITaskStore } = require('../../../packages/db/src/ai-task-store');
const { createIdentityService } = require('../../../packages/auth/src/service');
const { createAuthRouteHandlers } = require('./auth-routes');
const { handleSiteMembershipRoute } = require('./site-membership-routes');
const { createContentTypeRouteHandler } = require('./content-type-routes');
const { createAITaskRouteHandlers } = require('./ai-task-routes');
const { parseCookies, safeCsrfCookie } = require('./auth-cookies');
const { createSamlAuthenticator } = require('../../../packages/auth/src/saml');
const { verifyPluginArtifactSignature, trustedKeysFromEnv, digestForArtifact } = require('../../../packages/plugins/src/provenance');
const { createRemotePluginRunner } = require('../../../packages/plugins/src/remote-runner');
const { createLocalMediaStore } = require('../../../packages/media/src/local-store');
const { createS3MediaStore } = require('../../../packages/media/src/s3-store');
const { createLibraryStore } = require('../../../packages/library/src/file-store');
const { createClamDScanScanner } = require('../../../packages/security/src/malware-scanner');
const { createCloudStorageAdapterFromEnv } = require('../../../packages/cloud/src/storage-adapters');
const { createFirewall } = require('../../../packages/security/src/firewall');
const { handlePlatformRoute } = require('./platform-routes');
const { verifyStripeSignature, digestWebhookBody, normalizeStripeRefundStatus, retrieveStripeSubscription } = require('../../../packages/billing/src/stripe');
const { releaseOrderStockReservations, commitOrderStockReservations } = require('../../../packages/commerce/src/stock-reservations');
const { validatePluginManifest, validatePinnedImageDigest } = require('../../../packages/plugins/src/manifest');
const { createWidgetRegistry } = require('../../../packages/widgets/src/registry');
const { validatePageDocument } = require('../../../packages/domain/src/page-document');
const { validateDesignTokens } = require('../../../packages/domain/src/design-system');
const { validateMenuItems } = require('../../../packages/domain/src/navigation');
const { renderPageDocument, rendererInfo } = require('../../../packages/render/src');
const { createRequestMetrics, createRealtimeMetrics } = require('../../../packages/observability/src/metrics');
const { createTraceContext } = require('../../../packages/observability/src/trace-context');
const { createStructuredLogger } = require('../../../packages/observability/src/structured-logger');
const { initializeTracing, runWithServerSpan, setHttpStatus } = require('../../../packages/observability/src/tracing');
const { initializeLogExport } = require('../../../packages/observability/src/otel-logs');
const { createRealtimeHub } = require('../../../packages/realtime/src/event-hub');
const { createMemoryPresenceAdapter, createPresenceService } = require('../../../packages/realtime/src/presence');
const { createRedisPresenceService } = require('../../../packages/realtime/src/redis-presence');
const { createRedisRealtimeBridge } = require('../../../packages/realtime/src/redis-realtime');
const { createSseGateway } = require('../../../packages/realtime/src/sse-gateway');
const { createWebSocketGateway } = require('../../../packages/realtime/src/websocket-gateway');
const { createMemoryRealtimeConnectionLimiter, createRedisRealtimeConnectionLimiter } = require('../../../packages/realtime/src/connection-quota');
const { boundedInt } = require('../../../packages/ai/src/config');
const VIRGOSCORPIO_HUB_VERSION = require('../../../package.json').version;

const MAX_BODY_DEFAULT = 1_048_576;
const MAX_MEDIA_BODY = 16 * 1024 * 1024;
const MAX_LIBRARY_BODY_DEFAULT = 72 * 1024 * 1024;
const { UUID_RE: ID_RE } = require('../../../packages/domain/src/identifiers');
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8', 'content-length': body.length,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'
  });
  res.end(body);
  return true;
}
function sendHtml(res, statusCode, html, csp) {
  const body = Buffer.from(html);
  res.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN' });
  res.end(body);
}
function sameSecret(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  // These are opaque bearer/configuration secrets, not human passwords. Compare
  // their UTF-8 bytes directly; no password-derived hash is stored or required.
  const left = Buffer.from(candidate, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
function parseBearer(req) { const header = req.headers.authorization; return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null; }
function normalizeSlug(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180);
}
async function readRawBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) throw fail(413, 'ERR_VIRGOSCORPIO_HUB_BODY_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw fail(413, 'ERR_VIRGOSCORPIO_HUB_BODY_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readForm(req, maxBytes) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) throw fail(415, 'ERR_VIRGOSCORPIO_HUB_FORM_CONTENT_TYPE', 'Expected application/x-www-form-urlencoded.');
  const raw = (await readRawBody(req, maxBytes)).toString('utf8');
  const params = new URLSearchParams(raw); const result = Object.create(null);
  for (const key of ['SAMLResponse', 'RelayState']) { const values = params.getAll(key); if (values.length > 1) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_SAML_FORM', `Duplicate ${key} form fields are not allowed.`); if (values.length === 1) result[key] = values[0]; }
  if (!result.SAMLResponse || !result.RelayState) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_SAML_FORM', 'SAMLResponse and RelayState are required.');
  return result;
}
async function readJson(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) { const error = new Error(`Request body exceeds ${maxBytes} bytes.`); error.statusCode = 413; error.code = 'ERR_VIRGOSCORPIO_HUB_BODY_TOO_LARGE'; throw error; }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) { const error = new Error(`Request body exceeds ${maxBytes} bytes.`); error.statusCode = 413; error.code = 'ERR_VIRGOSCORPIO_HUB_BODY_TOO_LARGE'; throw error; }
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('Request body must be valid JSON.'); error.statusCode = 400; error.code = 'ERR_VIRGOSCORPIO_HUB_INVALID_JSON'; throw error; }
}
function createRateLimiter(env) {
  const buckets = new Map();
  const windowMs = boundedInt(env.RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 3_600_000, 'RATE_LIMIT_WINDOW_MS');
  const maxRequests = boundedInt(env.RATE_LIMIT_MAX_REQUESTS, 60, 1, 10_000, 'RATE_LIMIT_MAX_REQUESTS');
  let lastSweep = 0;
  return function allow(key) {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, entry] of buckets) if (entry.resetAt <= now) buckets.delete(k);
      // Bound attacker-controlled key cardinality so rate limiting cannot itself exhaust memory.
      while (buckets.size >= 10_000 && !buckets.has(key)) buckets.delete(buckets.keys().next().value);
      lastSweep = now;
    }
    const entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      if (buckets.size >= 10_000 && !buckets.has(key)) buckets.delete(buckets.keys().next().value);
      buckets.set(key, { count: 1, resetAt: now + windowMs }); return { allowed: true, remaining: maxRequests - 1 };
    }
    if (entry.count >= maxRequests) return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
    entry.count += 1; return { allowed: true, remaining: maxRequests - entry.count };
  };
}
function fail(statusCode, code, message, details) {
  const error = new Error(message); error.statusCode = statusCode; error.code = code; if (details) error.details = details; return error;
}
function validateSaveDraftBody(body) {
  if (!body || typeof body !== 'object' || !body.document || typeof body.document !== 'object') throw fail(400, 'ERR_VIRGOSCORPIO_HUB_DOCUMENT_REQUIRED', 'document is required.');
  const validation = validatePageDocument(body.document);
  if (!validation.valid) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_INVALID_DOCUMENT', 'Page document failed validation.', validation.errors);
  const slug = normalizeSlug(body.slug || body.document.title);
  if (body.id !== undefined && (typeof body.id !== 'string' || !ID_RE.test(body.id))) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_ID', 'id must be a valid UUID when provided.');
  if (body.siteId !== undefined && (typeof body.siteId !== 'string' || !ID_RE.test(body.siteId))) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_SITE_ID', 'siteId must be a valid UUID.');
  if (body.locale !== undefined && (typeof body.locale !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(body.locale))) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_LOCALE', 'locale must be a valid language tag.');
  if (!slug) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_SLUG', 'A valid page slug is required.');
  if (body.aiGenerated === true && body.reviewed !== true) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_REVIEW_REQUIRED', 'Set reviewed=true after reviewing the AI proposal.');
  return { document: body.document, slug, locale: typeof body.locale === 'string' ? body.locale.slice(0, 20) : 'en', id: body.id, siteId: body.siteId, expectedVersion: body.expectedVersion === undefined ? undefined : Number(body.expectedVersion), note: typeof body.note === 'string' ? body.note.slice(0, 2000) : null };
}
function htmlCspPreview() { return "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'none'; connect-src 'none'"; }
function htmlCspAdmin() { return "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"; }

function createApiServer({ env = process.env, aiService, aiTaskStore: injectedAITaskStore, contentStore, pool, identityService, pluginRunner, stripeFetch = fetch, realtimeHub: injectedRealtimeHub, presenceService: injectedPresenceService, realtimeBridge: injectedRealtimeBridge, realtimeMetrics: injectedRealtimeMetrics, realtimeConnectionLimiter: injectedRealtimeConnectionLimiter, publishDocumentOperation: injectedDocumentPublisher, realtimeHeartbeatMs = 15_000, logger = console, otelLogger = null, structuredLogger: suppliedStructuredLogger = null } = {}) {
  if (env.NODE_ENV === 'production') {
    const missing = [];
    if (!env.DATABASE_URL && !pool) missing.push('DATABASE_URL');
    if (env.SESSION_COOKIE_SECURE !== 'true') missing.push('SESSION_COOKIE_SECURE=true');
    if (env.REQUIRE_VERIFIED_EMAIL !== 'true') missing.push('REQUIRE_VERIFIED_EMAIL=true');
    if (!env.VIRGOSCORPIO_HUB_MFA_ENCRYPTION_KEY) missing.push('VIRGOSCORPIO_HUB_MFA_ENCRYPTION_KEY (32-byte base64url key)');
    if (env.VIRGOSCORPIO_HUB_METRICS_ENABLED === 'true' && (!env.VIRGOSCORPIO_HUB_METRICS_TOKEN || env.VIRGOSCORPIO_HUB_METRICS_TOKEN.length < 32)) missing.push('VIRGOSCORPIO_HUB_METRICS_TOKEN (at least 32 characters when metrics are enabled)');
    if ((env.AI_PROVIDER || 'mock') === 'mock' && env.VIRGOSCORPIO_HUB_ALLOW_MOCK_AI_IN_PRODUCTION !== 'true') missing.push('a reviewed AI_PROVIDER or VIRGOSCORPIO_HUB_ALLOW_MOCK_AI_IN_PRODUCTION=true for an explicitly mock-only deployment');
    if (env.VIRGOSCORPIO_HUB_PLUGIN_EXECUTION_ENABLED === 'true' && (!env.VIRGOSCORPIO_HUB_PLUGIN_TRUSTED_PUBLIC_KEYS || !env.VIRGOSCORPIO_HUB_PLUGIN_RUNNER_URL || !env.VIRGOSCORPIO_HUB_PLUGIN_RUNNER_TOKEN || env.VIRGOSCORPIO_HUB_PLUGIN_RUNNER_TOKEN.length < 32)) missing.push('plugin trusted public keys, runner URL, and strong runner token when plugin execution is enabled');
    if (missing.length) throw new Error(`VirgoScorpio Hub is not production-ready: configure ${missing.join(', ')} and complete deployment review before starting.`);
  }

  const structuredLogger = suppliedStructuredLogger || createStructuredLogger({
    logger,
    otelLogger,
    service: 'virgoscorpio-hub-api',
    environment: env.NODE_ENV || 'development',
    accessLogsEnabled: env.VIRGOSCORPIO_HUB_HTTP_ACCESS_LOGS_ENABLED === 'true'
  });
  const devToken = env.VIRGOSCORPIO_HUB_API_TOKEN;
  const realtimeBridge = injectedRealtimeBridge || null;
  if (injectedDocumentPublisher !== undefined && injectedDocumentPublisher !== null && typeof injectedDocumentPublisher !== 'function') {
    throw new TypeError('publishDocumentOperation must be a function when provided.');
  }
  let realtimeHub = null;
  const maxBody = boundedInt(env.MAX_REQUEST_BYTES, MAX_BODY_DEFAULT, 1_024, 16 * 1024 * 1024, 'MAX_REQUEST_BYTES');
  const maxMediaBody = Math.max(maxBody, MAX_MEDIA_BODY);
  const allowRequest = createRateLimiter(env);
  const ai = aiService || createAIService({
    env,
    audit: event => structuredLogger.emit(event.succeeded ? 'info' : 'warn', 'virgoscorpio_hub.ai.audit', {
      component: 'ai',
      operation: event.action,
      outcome: event.succeeded ? 'success' : 'failure',
      elapsedMs: event.elapsedMs,
      code: event.errorCode
    })
  });
  const registry = createWidgetRegistry();
  let localPool = pool || null; let store = contentStore || null;
  if (!store && env.DATABASE_URL) { localPool = localPool || createPostgresPool(env); store = createPostgresStore({ pool: localPool }); }
  const aiTaskStore = injectedAITaskStore || (localPool ? createAITaskStore({ pool: localPool }) : null);
  async function getAvailableAITaskStore() {
    if (!aiTaskStore) return null;
    if (typeof aiTaskStore.isAvailable !== 'function') return aiTaskStore;
    try {
      return await aiTaskStore.isAvailable() ? aiTaskStore : null;
    } catch (error) {
      structuredLogger.emit('warn', 'virgoscorpio_hub.ai.task_store_unavailable', {
        component: 'ai',
        operation: 'task_store_availability',
        code: error?.code || 'ERR_VIRGOSCORPIO_HUB_AI_TASKS_UNAVAILABLE'
      });
      return null;
    }
  }
  const identity = identityService || (localPool ? createIdentityService({
    pool: localPool,
    env,
    onAuthorizationChange: async change => {
      try {
        if (realtimeBridge) await realtimeBridge.invalidateAuthorization(change);
        else realtimeHub?.invalidateAuthorization?.(change);
      } catch (error) {
        structuredLogger.emit('error', 'virgoscorpio_hub.realtime.authorization_invalidation_failed', { component: 'realtime', code: error?.code || 'ERR_REALTIME_INVALIDATION' });
        realtimeHub?.invalidateAuthorization?.(change);
      }
    }
  }) : null);
  // Use a shared PostgreSQL-backed SAML cache so request IDs are validated and consumed across replicas.
  const samlAuth = env.SAML_ENABLED === 'true' ? createSamlAuthenticator({ env, pool: localPool }) : null;
  const mediaStore = localPool ? (env.MEDIA_DRIVER === 's3' ? createS3MediaStore({ pool: localPool, env }) : createLocalMediaStore({ pool: localPool, root: env.MEDIA_ROOT || path.resolve(process.cwd(), 'var', 'media') })) : null;
  const maxLibraryFileBytes = boundedInt(env.VIRGOSCORPIO_HUB_LIBRARY_MAX_FILE_BYTES, 50 * 1024 * 1024, 1024, 50 * 1024 * 1024, 'VIRGOSCORPIO_HUB_LIBRARY_MAX_FILE_BYTES');
  const maxLibraryBody = boundedInt(env.VIRGOSCORPIO_HUB_LIBRARY_MAX_BODY_BYTES, MAX_LIBRARY_BODY_DEFAULT, 16 * 1024 * 1024, 80 * 1024 * 1024, 'VIRGOSCORPIO_HUB_LIBRARY_MAX_BODY_BYTES');
  const libraryStorageAdapter = createCloudStorageAdapterFromEnv({ env });
  const malwareScanner = String(env.LIBRARY_MALWARE_SCANNER || '').toLowerCase() === 'clamdscan' ? createClamDScanScanner({ executable: env.CLAMDSCAN_PATH || 'clamdscan', timeoutMs: Number(env.LIBRARY_MALWARE_SCAN_TIMEOUT_MS || 20000), maxBytes: maxLibraryFileBytes }) : null;
  const libraryStore = localPool ? createLibraryStore({ pool: localPool, root: env.LIBRARY_ROOT || path.resolve(process.cwd(), 'var', 'library'), maxFileBytes: maxLibraryFileBytes, storageAdapter: libraryStorageAdapter, malwareScanner, requireMalwareScan: env.NODE_ENV === 'production' }) : null;
  const firewall = createFirewall({ pool: localPool, env, cacheTtlMs: boundedInt(env.VIRGOSCORPIO_HUB_FIREWALL_CACHE_MS, 5000, 500, 60_000, 'VIRGOSCORPIO_HUB_FIREWALL_CACHE_MS') });
  const sandboxRunner = pluginRunner || createRemotePluginRunner({
    url: env.VIRGOSCORPIO_HUB_PLUGIN_RUNNER_URL, token: env.VIRGOSCORPIO_HUB_PLUGIN_RUNNER_TOKEN,
    timeoutMs: boundedInt(env.PLUGIN_TIMEOUT_MS, 8000, 100, 30_000, 'PLUGIN_TIMEOUT_MS'),
    allowHttpInternal: env.PLUGIN_RUNNER_ALLOW_HTTP_INTERNAL === 'true'
  });
  const secureCookies = env.NODE_ENV === 'production' || env.SESSION_COOKIE_SECURE === 'true';
  const authRoutes = createAuthRouteHandlers({
    identity, samlAuth, env, secureCookies, maxBody, allowRequest,
    sendJson, fail, readJson, readForm, sameSecret
  });
  const contentTypeRouteHandler = createContentTypeRouteHandler({ normalizeSlug });
  const requestMetrics = createRequestMetrics();
  const realtimeMetrics = injectedRealtimeMetrics || createRealtimeMetrics();
  const realtimeEnabled = env.VIRGOSCORPIO_HUB_REALTIME_ENABLED === 'true';
  const configuredPresenceStore = String(env.VIRGOSCORPIO_HUB_PRESENCE_STORE || 'memory').toLowerCase();
  if (!['memory', 'redis'].includes(configuredPresenceStore)) {
    throw new Error('VIRGOSCORPIO_HUB_PRESENCE_STORE must be memory or redis.');
  }
  if (realtimeEnabled && env.NODE_ENV === 'production' && (!injectedRealtimeHub || typeof injectedRealtimeHub.invalidateAuthorization !== 'function' || !injectedPresenceService || !injectedRealtimeConnectionLimiter)) {
    throw new Error('Real-time services in production require injected distributed event, presence and connection-quota adapters with authorization invalidation support; in-memory preview adapters are not production-safe.');
  }
  if (realtimeEnabled && configuredPresenceStore === 'redis' && !injectedPresenceService) {
    throw new Error('The Redis presence store requires an asynchronously connected presenceService to be injected.');
  }
  if (realtimeEnabled && configuredPresenceStore === 'redis' && !injectedRealtimeBridge) {
    throw new Error('The Redis presence store requires an attached cross-instance realtimeBridge for Pub/Sub fan-out.');
  }
  if (realtimeEnabled && configuredPresenceStore === 'redis' && !injectedRealtimeConnectionLimiter) {
    throw new Error('Redis-backed real-time requires a distributed connection-quota adapter; memory quotas are not valid for multi-instance mode.');
  }
  if (realtimeEnabled && configuredPresenceStore === 'redis' &&
      typeof realtimeBridge?.publishDocumentOperation !== 'function') {
    throw new Error('Redis-backed real-time requires a realtimeBridge with publishDocumentOperation().');
  }
  if (realtimeEnabled && env.NODE_ENV === 'production' &&
      (realtimeBridge
        ? typeof realtimeBridge.publishDocumentOperation !== 'function'
        : typeof injectedDocumentPublisher !== 'function')) {
    throw new Error('Production real-time requires a document publisher backed by the distributed realtime bridge.');
  }
  realtimeHub = injectedRealtimeHub || (realtimeEnabled && env.NODE_ENV !== 'production'
    ? createRealtimeHub({
      authorizeSubscribe: async ({ principal, sessionId, siteId, topic }) => {
        if (topic === 'presence') {
          if (principal.isDeveloper) return env.NODE_ENV !== 'production';
          if (!identity || !sessionId || typeof identity.isSessionActive !== 'function') return false;
          if (!(await identity.isSessionActive({ userId: principal.id, sessionId }))) return false;
          return Boolean(await identity.authorizeSite(principal.id, siteId, 'content:read'));
        }
        const documentMatch = /^document:([0-9a-f-]{36})$/i.exec(topic);
        if (!documentMatch || !store) return false;
        const document = await store.getById({ siteId, id: documentMatch[1] }).catch(() => null);
        if (!document || document.content_type !== 'page' || document.status !== 'draft') return false;
        if (principal.isDeveloper) return env.NODE_ENV !== 'production';
        if (!identity || !sessionId || typeof identity.isSessionActive !== 'function') return false;
        if (!(await identity.isSessionActive({ userId: principal.id, sessionId }))) return false;
        if (await identity.authorizeSite(principal.id, siteId, 'content:edit')) return true;
        return document.created_by === principal.id &&
          Boolean(await identity.authorizeSite(principal.id, siteId, 'content:edit:own'));
      },
      metrics: realtimeMetrics
    })
    : null);
  const presence = injectedPresenceService || (realtimeEnabled && env.NODE_ENV !== 'production' && configuredPresenceStore === 'memory'
    ? createPresenceService({
      adapter: createMemoryPresenceAdapter({ metrics: realtimeMetrics }),
      metrics: realtimeMetrics
    })
    : null);
  const realtimeConnectionLimiter = injectedRealtimeConnectionLimiter || (realtimeEnabled && env.NODE_ENV !== 'production'
    ? createMemoryRealtimeConnectionLimiter({
      limits: {
        maxGlobal: boundedInt(env.VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS, 10_000, 1, 100_000, 'VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS'),
        maxPerSite: boundedInt(env.VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS_PER_SITE, 500, 1, 100_000, 'VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS_PER_SITE'),
        maxPerPrincipal: boundedInt(env.VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS_PER_PRINCIPAL, 4, 1, 1_000, 'VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS_PER_PRINCIPAL')
      },
      leaseMs: boundedInt(env.VIRGOSCORPIO_HUB_REALTIME_CONNECTION_LEASE_MS, 45_000, 5_000, 300_000, 'VIRGOSCORPIO_HUB_REALTIME_CONNECTION_LEASE_MS'),
      metrics: realtimeMetrics
    }) : null);
  const documentPublisher = injectedDocumentPublisher
    || (realtimeBridge && typeof realtimeBridge.publishDocumentOperation === 'function'
      ? input => realtimeBridge.publishDocumentOperation(input)
      : realtimeHub
        ? async ({ siteId, contentId, sequence, originConnectionId = null, operation }) => {
          const local = await realtimeHub.publish({
            siteId,
            topic: 'document:' + contentId,
            payload: {
              kind: 'document.operation',
              sequence,
              originConnectionId,
              operation
            }
          });
          return { ...local, relayPublished: null, degraded: false };
        }
        : null);
  const realtimeGateway = realtimeHub ? createSseGateway({ hub: realtimeHub, metrics: realtimeMetrics, connectionLimiter: realtimeConnectionLimiter }) : null;
  const realtimeWebSocketGateway = realtimeHub && presence ? createWebSocketGateway({
    hub: realtimeHub,
    presence,
    store,
    authorizeDocument: authorizeCollaborationDocument,
    connectionLimiter: realtimeConnectionLimiter,
    publishPresence: realtimeBridge ? input => realtimeBridge.publish(input) : input => realtimeHub.publish(input),
    publishDocumentOperation: documentPublisher,
    heartbeatMs: realtimeHeartbeatMs,
    metrics: realtimeMetrics
  }) : null;
  const realtimeBridgeReady = realtimeBridge ? Promise.resolve().then(() => realtimeBridge.attach(realtimeHub)) : Promise.resolve();

  async function authenticate(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    const bearer = parseBearer(req);
    if (identity) {
      // A valid explicit bearer credential is non-ambient authentication; browser
      // cookies are handled separately and always receive CSRF checks on writes.
      // Authenticate the candidate credential through the identity store; only
      // the returned server-side session record can establish bearer identity.
      const bearerSession = await identity.authenticate(bearer || '');
      if (bearerSession) {
        return { mode: 'session', sessionToken: bearer, sessionId: bearerSession.sessionId, expiresAt: bearerSession.expiresAt, user: bearerSession.user, memberships: bearerSession.memberships };
      }
      const cookieSessionToken = cookies.vsh_session;
      if (cookieSessionToken) {
        const cookieSession = await identity.authenticate(cookieSessionToken);
        if (cookieSession) {
          if (UNSAFE_METHODS.has(req.method)) {
            const origin = req.headers.origin;
            const expectedOrigin = `${secureCookies ? 'https' : (req.socket.encrypted ? 'https' : 'http')}://${req.headers.host}`;
            if (typeof origin !== 'string' || origin !== expectedOrigin) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_CSRF', 'A matching same-origin Origin header is required for cookie-authenticated writes.');
            const header = req.headers['x-csrf-token'];
            if (!header || !safeCsrfCookie(cookies.vsh_csrf, header) || !(await identity.validateCsrf(cookieSessionToken, header))) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_CSRF', 'A valid CSRF token is required.');
          }
          return { mode: 'session', sessionToken: cookieSessionToken, sessionId: cookieSession.sessionId, expiresAt: cookieSession.expiresAt, user: cookieSession.user, memberships: cookieSession.memberships };
        }
      }
    }
    if (env.NODE_ENV !== 'production' && devToken && sameSecret(bearer, devToken)) {
      return { mode: 'development-token', user: { id: null, email: 'developer@localhost', displayName: 'Local Developer', status: 'active' }, memberships: [], isDeveloper: true };
    }
    return null;
  }
  async function siteIdFor({ req, url, body, actor, required = true, routeSiteId }) {
    const querySiteIds = url.searchParams.getAll('siteId');
    if (querySiteIds.length > 1) {
      throw fail(400, 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH', 'Provide a siteId query parameter only once.');
    }
    const selectorEntries = [
      ['route', routeSiteId],
      ['header', req.headers['x-virgoscorpio-hub-site-id']],
      ['query', querySiteIds[0]],
      ['body', body?.siteId],
    ].filter(([, value]) => value !== undefined && value !== null && value !== '');
    if (selectorEntries.some(([, value]) => typeof value !== 'string')) {
      throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_SITE_ID', 'siteId must be a valid UUID.');
    }
    const distinctSiteIds = new Set(selectorEntries.map(([, value]) => value.toLowerCase()));
    if (distinctSiteIds.size > 1) {
      throw fail(400, 'ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH', 'All site selectors in the request must identify the same site.');
    }
    const fromRequest = selectorEntries[0]?.[1];
    let siteId = typeof fromRequest === 'string' ? fromRequest : '';
    if (!siteId && actor.isDeveloper) siteId = env.VIRGOSCORPIO_HUB_DEFAULT_SITE_ID || '';
    if (!siteId && actor.memberships.length === 1) siteId = actor.memberships[0].siteId;
    if (!siteId && !required) return null;
    if (!siteId && actor.memberships.length > 1) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_SITE_REQUIRED', 'Select a site using x-virgoscorpio-hub-site-id or siteId.');
    if (!siteId) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_SITE_REQUIRED', 'A siteId is required for this operation.');
    if (!ID_RE.test(siteId)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_SITE_ID', 'siteId must be a valid UUID.');

    if (!actor.isDeveloper && !(await identity.authorizeSite(actor.user.id, siteId, 'content:read'))) {
      // Read membership directly; the requested capability is checked by route-specific authorization below.
      const hasMembership = actor.memberships.some(item => item.siteId === siteId);
      if (!hasMembership) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_TENANT_FORBIDDEN', 'You are not a member of this site.');
    }
    return siteId;
  }
  async function requireCapability(actor, siteId, capability) {
    if (actor.isDeveloper) return true;
    if (!identity || !(await identity.authorizeSite(actor.user.id, siteId, capability))) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', `The ${capability} capability is required for this site.`);
    return true;
  }
  async function requireRealtimeCapability(actor, siteId) {
    try {
      return await requireCapability(actor, siteId, 'content:read');
    } catch (error) {
      try { realtimeMetrics.increment('authorization_denials_total'); } catch {}
      throw error;
    }
  }
  async function authorizeCollaborationDocument({ principal, sessionId, siteId, contentId }) {
    if (!store || typeof store.getById !== 'function') return false;
    const document = await store.getById({ siteId, id: contentId }).catch(() => null);
    if (!document || document.content_type !== 'page' || document.status !== 'draft') return false;
    if (principal?.isDeveloper === true) return env.NODE_ENV !== 'production';
    if (!identity || !sessionId || typeof identity.isSessionActive !== 'function') return false;
    if (!(await identity.isSessionActive({ userId: principal?.id, sessionId }))) return false;
    if (await identity.authorizeSite(principal.id, siteId, 'content:edit')) return true;
    return document.created_by === principal.id &&
      Boolean(await identity.authorizeSite(principal.id, siteId, 'content:edit:own'));
  }
  async function canEditContent(actor, siteId, content) {
    if (actor.isDeveloper) return;
    if (await identity.authorizeSite(actor.user.id, siteId, 'content:edit')) return;
    if (content?.created_by === actor.user.id && await identity.authorizeSite(actor.user.id, siteId, 'content:edit:own')) return;
    throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'You cannot edit this content.');
  }
  async function ensureSiteCapabilityForAI(actor, url, body, capability = 'ai:use') {
    const siteId = await siteIdFor({ req: { headers: {}, }, url, body, actor, required: false });
    if (siteId) await requireCapability(actor, siteId, capability);
    else if (!actor.isDeveloper) {
      const allowed = actor.memberships.some(m => m.capabilities.includes(capability) || m.capabilities.includes('site:manage'));
      if (!allowed) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', `The ${capability} capability is required.`);
    }
    return siteId;
  }
  const aiTaskRoutes = createAITaskRouteHandlers({
    getTaskStore: getAvailableAITaskStore,
    getProviderInfo: () => ai.providerInfo(),
    ensureSiteCapability: (actor, url) => ensureSiteCapabilityForAI(actor, url, {}, 'ai:use'),
    sendJson,
    fail
  });
  async function prepareAIPageDraftContext({ actor, siteId, body }) {
    const contentIds = parseAIContextContentIds(body.contextContentIds);
    if (contentIds.length === 0) {
      return {
        body,
        siteContext: body.siteContext || '',
        inputChars: String(body.prompt || '').length + String(body.siteContext || '').length
      };
    }
    if (!siteId) {
      throw fail(400, 'ERR_VIRGOSCORPIO_HUB_AI_CONTEXT_SITE_REQUIRED', 'A siteId is required when selecting saved pages as AI context.');
    }
    if (!store) {
      throw fail(503, 'ERR_VIRGOSCORPIO_HUB_AI_CONTEXT_UNAVAILABLE', 'Saved-page context requires the site-scoped content store.');
    }

    let canReadAll = actor.isDeveloper === true;
    let canReadOwn = false;
    if (!canReadAll) {
      if (!identity || !actor.user?.id) {
        throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'An authenticated site member is required to use saved-page context.');
      }
      canReadAll = await identity.authorizeSite(actor.user.id, siteId, 'content:read');
      if (!canReadAll) canReadOwn = await identity.authorizeSite(actor.user.id, siteId, 'content:read:own');
      if (!canReadAll && !canReadOwn) {
        throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'Reading saved-page AI context requires content:read or content:read:own.');
      }
    }

    if (canReadAll && typeof store.getById !== 'function') {
      throw fail(503, 'ERR_VIRGOSCORPIO_HUB_AI_CONTEXT_UNAVAILABLE', 'The content store does not support site-scoped page reads.');
    }
    if (!canReadAll && typeof store.getByIdForOwner !== 'function') {
      throw fail(503, 'ERR_VIRGOSCORPIO_HUB_AI_CONTEXT_UNAVAILABLE', 'The content store does not support owner-scoped page reads.');
    }

    const sources = [];
    for (const id of contentIds) {
      const source = canReadAll
        ? await store.getById({ siteId, id })
        : await store.getByIdForOwner({ siteId, id, actorId: actor.user.id });
      const siteMatches = source && String(source.site_id).toLowerCase() === String(siteId).toLowerCase();
      const ownerMatches = canReadAll || (source && String(source.created_by).toLowerCase() === String(actor.user.id).toLowerCase());
      if (!source || !siteMatches || !ownerMatches || source.content_type !== 'page') {
        throw fail(404, 'ERR_VIRGOSCORPIO_HUB_AI_CONTEXT_SOURCE_NOT_FOUND', 'One or more selected pages were not found or are not readable.');
      }
      sources.push({
        title: source.title,
        text: extractPageText(source.body, MAX_AI_CONTEXT_CHARS)
      });
    }

    const siteContext = buildAIPageContext({ siteContext: body.siteContext || '', sources });
    return {
      body: { ...body, dataClassification: 'confidential' },
      siteContext,
      inputChars: String(body.prompt || '').length + siteContext.length
    };
  }
  const AI_PROVIDERS = new Set(['mock', 'openai-responses', 'openai-compatible', 'anthropic', 'gemini']);
  const DATA_CLASSIFICATION_RANK = Object.freeze({ public: 0, internal: 1, confidential: 2 });
  async function getSiteAIPolicy(siteId) {
    if (!localPool) return null;
    await localPool.query('INSERT INTO site_ai_policies(site_id) VALUES($1) ON CONFLICT(site_id) DO NOTHING', [siteId]);
    const result = await localPool.query('SELECT site_id,enabled,allow_external_content,allowed_providers,max_data_classification,daily_request_limit,daily_input_chars_limit,require_human_review,updated_by,updated_at FROM site_ai_policies WHERE site_id=$1', [siteId]);
    return result.rows[0] || null;
  }
  async function reserveAIUsage({ actor, siteId, body, action, inputChars }) {
    if (!siteId || !localPool) {
      if (env.NODE_ENV === 'production') throw fail(503, 'ERR_VIRGOSCORPIO_HUB_AI_GOVERNANCE_UNAVAILABLE', 'AI governance requires a site-scoped PostgreSQL policy.');
      return { siteId: null, policy: null };
    }
    const policy = await getSiteAIPolicy(siteId);
    if (!policy || !policy.enabled) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_AI_DISABLED', 'AI assistance is disabled for this site.');
    const provider = ai.providerInfo().provider;
    const globalAllow = new Set(String(env.AI_ALLOWED_PROVIDERS || 'mock').split(',').map(item => item.trim()).filter(Boolean));
    const siteAllow = Array.isArray(policy.allowed_providers) ? policy.allowed_providers : [];
    if (!AI_PROVIDERS.has(provider) || !globalAllow.has(provider) || !siteAllow.includes(provider)) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_AI_PROVIDER_NOT_ALLOWED', 'The configured AI provider is not allowed by both the global and site-level policies.');
    if (provider !== 'mock' && (env.AI_ALLOW_EXTERNAL_CONTENT !== 'true' || !policy.allow_external_content)) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_AI_EXTERNAL_CONTENT_DISABLED', 'External AI content processing requires explicit global and site-level approval.');
    const classification = body.dataClassification || 'public';
    if (!Object.hasOwn(DATA_CLASSIFICATION_RANK, classification)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_AI_CLASSIFICATION_INVALID', 'dataClassification must be public, internal, or confidential.');
    if (DATA_CLASSIFICATION_RANK[classification] > DATA_CLASSIFICATION_RANK[policy.max_data_classification]) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_AI_CLASSIFICATION_BLOCKED', `The site policy does not permit sending ${classification} data to the configured AI provider.`);
    const chars = Math.max(0, Math.min(100_000_000, Number(inputChars) || 0));
    const reserved = await localPool.query(
      `INSERT INTO ai_usage_daily(site_id,usage_date,requests,input_chars) VALUES($1,current_date,1,$2)
       ON CONFLICT(site_id,usage_date) DO UPDATE SET requests=ai_usage_daily.requests+1,input_chars=ai_usage_daily.input_chars+EXCLUDED.input_chars,updated_at=now()
       WHERE ai_usage_daily.requests < $3 AND ai_usage_daily.input_chars + EXCLUDED.input_chars <= $4
       RETURNING requests,input_chars`,
      [siteId, chars, policy.daily_request_limit, Number(policy.daily_input_chars_limit)]
    );
    if (!reserved.rows[0]) throw fail(429, 'ERR_VIRGOSCORPIO_HUB_AI_DAILY_BUDGET_EXCEEDED', 'The site has reached its daily AI request or input-character budget.');
    return { siteId, policy, provider, model: ai.providerInfo().model, chars, action, classification, userId: actor.user?.id || null };
  }
  async function recordAIUsage(context, { status, error, outputChars = 0, elapsedMs = 0, requestId }) {
    if (!localPool || !context?.siteId) return;
    try {
      await localPool.query(`INSERT INTO ai_run_audit(site_id,actor_id,provider,model,action,status,latency_ms,input_chars,output_chars,error_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [context.siteId, context.userId, context.provider || ai.providerInfo().provider, context.model || ai.providerInfo().model, context.action, status, Math.max(0, Math.min(2_147_483_647, Math.floor(elapsedMs))), context.chars || 0, Math.max(0, Number(outputChars) || 0), error ? String(error.code || 'ERR_VIRGOSCORPIO_HUB_AI_FAILURE').slice(0,100) : null]);
    } catch (auditError) {
      structuredLogger.emit('error', 'virgoscorpio_hub.ai.audit_persist_failed', {
        component: 'ai', operation: 'audit_persist',
        code: auditError.code || 'ERR_VIRGOSCORPIO_HUB_AI_AUDIT_FAILED'
      });
    }
  }
  async function runGovernedAI({ actor, siteId, body, action, inputChars, requestId, signal, run }) {
    const started = Date.now();
    let context = null;
    let taskStore = null;
    let task = null;
    let taskStatus = 'queued';
    const providerInfo = ai.providerInfo();
    const cancellationError = cause => Object.assign(
      new Error('AI task was cancelled because the requesting client disconnected.'),
      { code: 'ERR_VIRGOSCORPIO_HUB_AI_CANCELLED', statusCode: 499, ...(cause ? { cause } : {}) }
    );
    const throwIfCancelled = () => {
      if (signal?.aborted) throw cancellationError(signal.reason);
    };
    const persistTaskFailure = async failure => {
      if (!task || !taskStore || taskStatus === 'succeeded' || taskStatus === 'failed' ||
          taskStatus === 'cancelled' || taskStatus === 'blocked') return;
      const status = failure.code === 'ERR_VIRGOSCORPIO_HUB_AI_CANCELLED'
        ? 'cancelled'
        : failure.statusCode === 403 || failure.statusCode === 429 ? 'blocked' : 'failed';
      try {
        await taskStore.finish({
          taskId: task.id,
          siteId,
          status,
          outputChars: 0,
          latencyMs: Date.now() - started,
          errorCode: failure.code || 'ERR_VIRGOSCORPIO_HUB_AI_FAILURE'
        });
        taskStatus = status;
      } catch (taskError) {
        structuredLogger.emit('error', 'virgoscorpio_hub.ai.task_state_persist_failed', {
          component: 'ai',
          operation: 'task_terminal_transition',
          code: taskError.code || 'ERR_VIRGOSCORPIO_HUB_AI_TASK_STATE_FAILED'
        });
      }
    };
    try {
      throwIfCancelled();
      taskStore = await getAvailableAITaskStore();
      if (taskStore && siteId) {
        task = await taskStore.create({
          siteId,
          actorId: actor.user?.id || null,
          requestId,
          taskType: action,
          inputChars: Math.max(0, Math.floor(Number(inputChars) || 0))
        });
      }
      context = await reserveAIUsage({ actor, siteId, body, action, inputChars });
      throwIfCancelled();
      if (task) {
        await taskStore.start({
          taskId: task.id,
          siteId,
          provider: context.provider || providerInfo.provider,
          model: context.model || providerInfo.model
        });
        taskStatus = 'running';
      }
      const result = await run(signal);
      throwIfCancelled();
      const outputChars = typeof result === 'string' ? result.length : JSON.stringify(result).length;
      let persistedTaskId = task?.id;
      if (task) {
        try {
          await taskStore.finish({
            taskId: task.id,
            siteId,
            status: 'succeeded',
            outputChars,
            latencyMs: Date.now() - started
          });
        } catch (taskError) {
          // A completed provider result must not be turned into a failed generation
          // merely because its optional status metadata could not be finalized.
          persistedTaskId = undefined;
          structuredLogger.emit('error', 'virgoscorpio_hub.ai.task_state_persist_failed', {
            component: 'ai',
            operation: 'task_success_transition',
            code: taskError.code || 'ERR_VIRGOSCORPIO_HUB_AI_TASK_STATE_FAILED'
          });
        }
        taskStatus = 'succeeded';
      }
      await recordAIUsage(context, { status: 'succeeded', outputChars, elapsedMs: Date.now() - started, requestId });
      if (identity && context.siteId && actor.user.id) await identity.audit({ siteId: context.siteId, actorId: actor.user.id, action: `ai.${action}`, targetType: 'ai-run', requestId, details: { provider: context.provider, model: context.model, classification: context.classification, inputChars: context.chars, outputChars } });
      return { result, taskId: persistedTaskId };
    } catch (error) {
      const failure = signal?.aborted && error.code !== 'ERR_VIRGOSCORPIO_HUB_AI_CANCELLED'
        ? cancellationError(error)
        : error;
      if (context) await recordAIUsage(context, { status: failure.statusCode === 403 || failure.statusCode === 429 ? 'blocked' : 'failed', error: failure, elapsedMs: Date.now() - started, requestId });
      await persistTaskFailure(failure);
      throw failure;
    }
  }
  async function runGovernedAIForRequest({ req, res, ...options }) {
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded && !controller.signal.aborted) {
        controller.abort(new Error('The HTTP client disconnected before the AI task completed.'));
      }
    };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);
    if (req.aborted || res.destroyed) abortOnDisconnect();
    try {
      return await runGovernedAI({
        ...options,
        signal: controller.signal,
        run: () => options.run(controller.signal)
      });
    } finally {
      req.removeListener('aborted', abortOnDisconnect);
      res.removeListener('close', abortOnDisconnect);
    }
  }

  async function getPlugin(siteId, pluginId) {
    const result = await localPool.query('SELECT * FROM plugin_installs WHERE site_id=$1 AND id=$2', [siteId, pluginId]);
    return result.rows[0] || null;
  }
  // Shared by legacy page/revision/workflow read handlers that still live in
  // the API composition module. The extracted custom content-type route family
  // keeps its own equivalent policy helper behind its explicit context.
  async function getContentReadScope(actor, siteId) {
    if (actor.isDeveloper) return { ownOnly: false };
    if (await identity.authorizeSite(actor.user.id, siteId, 'content:read')) return { ownOnly: false };
    if (await identity.authorizeSite(actor.user.id, siteId, 'content:read:own')) return { ownOnly: true };
    return null;
  }
  async function hasContentRead(actor, siteId) {
    return (await getContentReadScope(actor, siteId)) !== null;
  }
  async function handler(req, res) {
    const requestId = typeof req.headers['x-request-id'] === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : randomUUID();
    const traceContext = createTraceContext({
      requestId,
      incomingTraceparent: req.headers.traceparent,
      trustRemote: env.VIRGOSCORPIO_HUB_TRACE_CONTEXT_TRUST_REMOTE === 'true'
    });
    res.setHeader('x-request-id', requestId); res.setHeader('x-trace-id', traceContext.traceId); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('x-frame-options', 'SAMEORIGIN'); res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('cross-origin-opener-policy', 'same-origin'); res.setHeader('x-permitted-cross-domain-policies', 'none');
    if (env.NODE_ENV === 'production' && secureCookies) res.setHeader('strict-transport-security', `max-age=${boundedInt(env.VIRGOSCORPIO_HUB_HSTS_MAX_AGE, 15552000, 0, 63072000, 'VIRGOSCORPIO_HUB_HSTS_MAX_AGE')}; includeSubDomains`);
    return runWithServerSpan(traceContext, async requestSpan => {
      const started = Date.now();
      const originalWriteHead = res.writeHead;
      res.writeHead = function (statusCode, ...args) {
        setHttpStatus(requestSpan, statusCode);
        return originalWriteHead.call(this, statusCode, ...args);
      };
      res.once('finish', () => {
        setHttpStatus(requestSpan, res.statusCode);
        const pathname = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return '/other'; } })();
        const durationMs = Date.now() - started;
        requestMetrics.record({ method: req.method, pathname, statusCode: res.statusCode, durationMs });
        structuredLogger.requestCompleted({ requestId, method: req.method, route: requestMetrics.normalizeRoute(pathname), statusCode: res.statusCode, elapsedMs: durationMs });
      });
      try {
      const url = new URL(req.url, 'http://localhost');
      const firewallSite = url.pathname.match(/\/sites\/([0-9a-f-]{36})(?:\/|$)/i)?.[1] || null;
      const firewallResult = await firewall.evaluate({ ip: req.socket.remoteAddress || 'unknown', path: url.pathname, userAgent: String(req.headers['user-agent'] || '').slice(0, 500), siteId: firewallSite });
      if (firewallResult.action === 'deny') return sendJson(res, 403, { error: 'Request blocked by VirgoScorpio Hub firewall policy.', code: 'ERR_VIRGOSCORPIO_HUB_FIREWALL_DENY', requestId });
      if (firewallResult.action === 'challenge') return sendJson(res, 403, { error: 'This request requires an additional verification step.', code: 'ERR_VIRGOSCORPIO_HUB_FIREWALL_CHALLENGE', requestId });
      if (firewallResult.action === 'rate_limit') return sendJson(res, 429, { error: 'Firewall rate limit exceeded.', code: 'ERR_VIRGOSCORPIO_HUB_FIREWALL_RATE_LIMIT', requestId });
      if (url.pathname === '/metrics') {
        if (env.VIRGOSCORPIO_HUB_METRICS_ENABLED !== 'true') return sendJson(res, 404, { error: 'Not found.', code: 'ERR_VIRGOSCORPIO_HUB_NOT_FOUND', requestId });
        if (!sameSecret(parseBearer(req), env.VIRGOSCORPIO_HUB_METRICS_TOKEN)) return sendJson(res, 401, { error: 'Metrics authorization required.', code: 'ERR_VIRGOSCORPIO_HUB_METRICS_UNAUTHORIZED', requestId });
        const output = Buffer.from(requestMetrics.renderPrometheus() + realtimeMetrics.renderPrometheus());
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': output.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(output);
      }
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { status: 'ok', service: 'virgoscorpio-hub-api', version: VIRGOSCORPIO_HUB_VERSION, renderer: rendererInfo, ai: ai.providerInfo(), features: ['sessions','tenant-memberships','password-reset','email-verification','totp-mfa','oidc-sso','saml-sso-optional','drafts','revision-history','publication-workflows','visual-builder','taxonomy-relationships','media-library','document-library','file-library','video-assets','icon-library','math-formulas','media-optimization-optional','mega-menus','commerce','paid-memberships','community','firewall-rules','cloud-storage-adapters','ai-governance','plugin-provenance','sandboxed-plugins','mcp','ai-assistance'], requestId });
      if (req.method === 'GET' && url.pathname === '/platform') {
        const file = path.resolve(__dirname, '../../admin/platform.html');
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Platform console not found.', requestId });
        return sendHtml(res, 200, fs.readFileSync(file, 'utf8'), htmlCspAdmin());
      }
      if (req.method === 'GET' && url.pathname === '/admin') {
        const file = path.resolve(__dirname, '../../admin/index.html');
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Admin console not found.', requestId });
        const html = fs.readFileSync(file, 'utf8').replace('id="saml-link" class="oidc-link hidden"', `id="saml-link" class="oidc-link${samlAuth ? '' : ' hidden'}"`);
        return sendHtml(res, 200, html, htmlCspAdmin());
      }
      if (req.method === 'GET' && ['/reset-password','/verify-email','/accept-invitation'].includes(url.pathname)) {
        const file = path.resolve(__dirname, '../../admin/account.html');
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Account page not found.', requestId });
        return sendHtml(res, 200, fs.readFileSync(file), htmlCspAdmin());
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/katex/')) {
        const relative = url.pathname.slice('/assets/katex/'.length);
        if (!/^(?:katex\.min\.css|fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2?|ttf))$/.test(relative)) return sendJson(res, 404, { error: 'Asset not found.', requestId });
        const root = path.resolve(__dirname, '../../admin/assets/katex');
        const file = path.resolve(root, relative);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return sendJson(res, 404, { error: 'Asset not found.', requestId });
        const content = fs.readFileSync(file); const css = relative.endsWith('.css');
        res.writeHead(200, { 'content-type': css ? 'text/css; charset=utf-8' : 'font/' + (relative.endsWith('.woff2') ? 'woff2' : relative.endsWith('.woff') ? 'woff' : 'ttf'), 'content-length': content.length, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
        return res.end(content);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const name = url.pathname.slice('/assets/'.length);
        if (!/^[a-z0-9._-]+\.(?:js|css)$/i.test(name)) return sendJson(res, 404, { error: 'Asset not found.', requestId });
        const file = path.resolve(__dirname, '../../admin/assets', name);
        const base = path.resolve(__dirname, '../../admin/assets') + path.sep;
        if (!file.startsWith(base) || !fs.existsSync(file)) return sendJson(res, 404, { error: 'Asset not found.', requestId });
        const content = fs.readFileSync(file);
        res.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'content-length': content.length, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' }); return res.end(content);
      }
      if (req.method === 'GET' && url.pathname === '/ready') {
        if (!localPool) return sendJson(res, 200, { status: 'degraded-local-mode', database: 'not-configured', graph: env.MEMGRAPH_ENABLED === 'true' ? 'configured' : 'disabled', requestId });
        try { await localPool.query('SELECT 1'); return sendJson(res, 200, { status: 'ready', database: 'reachable', requestId }); }
        catch { return sendJson(res, 503, { status: 'not-ready', database: 'unreachable', requestId }); }
      }

      if (await authRoutes.handlePublic({ req, res, url, requestId })) return;

      // Per-IP limits cover both successful and failed authentication and all authenticated routes.
      const clientKey = req.socket.remoteAddress || 'unknown'; const limit = allowRequest(clientKey);
      res.setHeader('x-ratelimit-remaining', String(limit.remaining));
      if (!limit.allowed) { res.setHeader('retry-after', String(limit.retryAfterSeconds)); return sendJson(res, 429, { error: 'Request rate limit exceeded.', code: 'ERR_VIRGOSCORPIO_HUB_RATE_LIMIT', requestId }); }

      // Public published-page delivery only reads immutable published snapshots, never drafts.
      const publicPageMatch = url.pathname.match(/^\/public\/([a-z0-9][a-z0-9-]{0,62})\/pages\/(.+)$/);
      if (req.method === 'GET' && publicPageMatch) {
        if (!store) return sendJson(res, 503, { error: 'Published page delivery requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const site = await store.getSiteBySlug(publicPageMatch[1]); if (!site) return sendJson(res, 404, { error: 'Page not found.', requestId });
        const slug = decodeURIComponent(publicPageMatch[2]).replace(/^\/+|\/+$/g, '');
        const locale = url.searchParams.get('locale') || site.default_locale || 'en';
        const page = await store.getPublishedBySlug({ siteId: site.id, slug, locale });
        if (!page) return sendJson(res, 404, { error: 'Page not found.', requestId });
        const dynamicData = Object.create(null);
        const queryNodes = [];
        const visit = nodes => { for (const node of Array.isArray(nodes) ? nodes : []) { if (node?.type === 'widget.query-loop') queryNodes.push(node); visit(node?.children); } };
        visit(page.body?.children);
        // Queries are always tenant-scoped and read only published snapshots. Each loop has a hard limit of 12.
        for (const node of queryNodes) {
          const rows = await store.listPublished({ siteId: site.id, contentType: node.props.contentType, locale, limit: node.props.limit, excludeId: page.id });
          dynamicData[node.id] = rows.map(item => ({
            title: item.title,
            excerpt: item.excerpt,
            url: `/public/${site.slug}/pages/${encodeURIComponent(item.slug)}`
          }));
        }
        let designTokens = {};
        if (localPool) {
          const design = await localPool.query('SELECT tokens FROM site_design_systems WHERE site_id=$1', [site.id]);
          if (design.rows[0]?.tokens) {
            const checked = validateDesignTokens(design.rows[0].tokens);
            if (!checked.valid) throw fail(500, 'ERR_VIRGOSCORPIO_HUB_DESIGN_SYSTEM_CORRUPT', 'Published design tokens failed validation.');
            designTokens = design.rows[0].tokens;
          }
        }
        return sendHtml(res, 200, renderPageDocument(page.body, { dynamicData, designTokens }), "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' https:; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'none'; connect-src 'none'");
      }
      const mediaPublicMatch = url.pathname.match(/^\/media\/([0-9a-f-]{36})$/i);
      if (req.method === 'GET' && mediaPublicMatch) {
        if (!mediaStore) return sendJson(res, 404, { error: 'Media not found.', requestId });
        const asset = await mediaStore.readPublic(mediaPublicMatch[1]);
        if (!asset) return sendJson(res, 404, { error: 'Media not found.', requestId });
        res.writeHead(200, { 'content-type': asset.mime_type, 'content-length': asset.data.length, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-site', 'content-disposition': 'inline' });
        return res.end(asset.data);
      }
      const publicSearchMatch = url.pathname.match(/^\/api\/v1\/public\/([a-z0-9][a-z0-9-]{0,62})\/search$/);
      if (req.method === 'GET' && publicSearchMatch) {
        if (!store) return sendJson(res, 503, { error: 'Search requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const site = await store.getSiteBySlug(publicSearchMatch[1]); if (!site) return sendJson(res, 404, { error: 'Site not found.', requestId });
        const query = url.searchParams.get('q') || ''; if (!query.trim() || query.length > 500) return sendJson(res, 400, { error: 'q is required and must be at most 500 characters.', requestId });
        return sendJson(res, 200, { results: await store.search({ siteId: site.id, query, locale: url.searchParams.get('locale') || null, limit: url.searchParams.get('limit') || 20 }), requestId });
      }

      const libraryVariantMatch = url.pathname.match(/^\/library\/public\/([0-9a-f-]{36})\/variants\/([a-z0-9][a-z0-9_-]{0,60})$/i);
      if (req.method === 'GET' && libraryVariantMatch) {
        if (!libraryStore) return sendJson(res, 404, { error: 'Asset variant not found.', code: 'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND', requestId });
        const variant = await libraryStore.readPublicVariant({ assetId: libraryVariantMatch[1], variantKey: libraryVariantMatch[2] });
        if (!variant) return sendJson(res, 404, { error: 'Asset variant not found.', code: 'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND', requestId });
        res.writeHead(200, { 'content-type': variant.mime_type, 'content-length': variant.data.length, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-site', 'content-disposition': 'inline' });
        return res.end(variant.data);
      }
      const libraryPublicMatch = url.pathname.match(/^\/library\/public\/([0-9a-f-]{36})$/i);
      if (req.method === 'GET' && libraryPublicMatch) {
        if (!libraryStore) return sendJson(res, 404, { error: 'Asset not found.', code: 'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND', requestId });
        const asset = await libraryStore.readPublic(libraryPublicMatch[1]);
        if (!asset) return sendJson(res, 404, { error: 'Asset not found.', code: 'ERR_VIRGOSCORPIO_HUB_LIBRARY_NOT_FOUND', requestId });
        const disposition = /^(?:image|video|audio|font)\//.test(asset.mime_type) ? 'inline' : 'attachment';
        res.writeHead(200, { 'content-type': asset.mime_type, 'content-length': asset.data.length, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-site', 'content-disposition': disposition });
        return res.end(asset.data);
      }
      const publicProductsMatch = url.pathname.match(/^\/api\/v1\/public\/([a-z0-9][a-z0-9-]{0,62})\/products$/);
      if (req.method === 'GET' && publicProductsMatch) {
        if (!localPool) return sendJson(res, 503, { error: 'Storefront requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const site = await localPool.query('SELECT id,slug FROM sites WHERE slug=$1', [publicProductsMatch[1]]);
        if (!site.rows[0]) return sendJson(res, 404, { error: 'Store not found.', requestId });
        const result = await localPool.query("SELECT id,slug,name,description,product_type,currency,price_minor,compare_at_price_minor,sku,stock_status,requires_shipping,weight_grams,images,attributes,version,updated_at FROM commerce_products WHERE site_id=$1 AND status='published' ORDER BY created_at DESC LIMIT $2", [site.rows[0].id, Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50))]);
        return sendJson(res, 200, { siteSlug: site.rows[0].slug, products: result.rows, requestId });
      }
      const publicPlansMatch = url.pathname.match(/^\/api\/v1\/public\/([a-z0-9][a-z0-9-]{0,62})\/membership-plans$/);
      if (req.method === 'GET' && publicPlansMatch) {
        if (!localPool) return sendJson(res, 503, { error: 'Membership plans require PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const site = await localPool.query('SELECT id,slug FROM sites WHERE slug=$1', [publicPlansMatch[1]]); if (!site.rows[0]) return sendJson(res, 404, { error: 'Site not found.', requestId });
        const plans = await localPool.query('SELECT id,slug,name,description,price_minor,currency,interval_unit,interval_count FROM membership_plans WHERE site_id=$1 AND active=true ORDER BY price_minor', [site.rows[0].id]);
        return sendJson(res, 200, { siteSlug: site.rows[0].slug, plans: plans.rows, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/billing/stripe/webhook') {
        if (!localPool || !env.STRIPE_WEBHOOK_SECRET) return sendJson(res, 503, { error: 'Payment webhook is not configured.', code: 'ERR_VIRGOSCORPIO_HUB_BILLING_DISABLED', requestId });
        const rawBody = await readRawBody(req, 2 * 1024 * 1024);
        if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET)) return sendJson(res, 400, { error: 'Stripe signature is invalid or outside its timestamp tolerance.', code: 'ERR_VIRGOSCORPIO_HUB_BILLING_SIGNATURE', requestId });
        let event; try { event = JSON.parse(rawBody.toString('utf8')); } catch { return sendJson(res, 400, { error: 'Webhook body must be JSON.', code: 'ERR_VIRGOSCORPIO_HUB_BILLING_WEBHOOK_JSON', requestId }); }
        if (typeof event.id !== 'string' || typeof event.type !== 'string' || !event.data?.object) return sendJson(res, 400, { error: 'Webhook event structure is invalid.', code: 'ERR_VIRGOSCORPIO_HUB_BILLING_WEBHOOK_INVALID', requestId });
        const client = await localPool.connect();
        try {
          await client.query('BEGIN');
          const inserted = await client.query("INSERT INTO billing_webhook_events(provider,provider_event_id,event_type,payload_digest,status) VALUES('stripe',$1,$2,$3,'received') ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING provider_event_id", [event.id,event.type,digestWebhookBody(rawBody)]);
          if (!inserted.rows[0]) { await client.query('ROLLBACK'); return sendJson(res,200,{received:true,duplicate:true,requestId}); }
          const object = event.data.object;
          if (['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
            const md = object.metadata || {};
            const orderSiteId = ID_RE.test(md.site_id || '') ? md.site_id : null;
            const orderId = ID_RE.test(md.order_id || '') ? md.order_id : null;
            const sessionId = typeof object.id === 'string' && object.id.length > 0 ? object.id : null;
            if (sessionId && (event.type !== 'checkout.session.completed' || ['paid','no_payment_required'].includes(object.payment_status))) {
              // A checkout event may arrive before the API saves provider_session_id.
              // In that case, use the complete site/order metadata tuple only while the
              // local order is still unlinked. A different linked session must never
              // pay this order, even when its metadata names the same order.
              const paidOrder = await client.query(
                `UPDATE commerce_orders
                    SET status='paid',provider='stripe',provider_session_id=$3,
                        provider_payment_id=$4,updated_at=now()
                  WHERE provider='stripe' AND status IN ('pending_payment','processing')
                    AND (provider_session_id=$3 OR (provider_session_id IS NULL AND site_id=$1 AND id=$2))
                  RETURNING id,site_id`,
                [orderSiteId, orderId, sessionId, typeof object.payment_intent === 'string' ? object.payment_intent : null]
              );
              if (paidOrder.rows[0]) await commitOrderStockReservations(client, {
                siteId: paidOrder.rows[0].site_id,
                orderId: paidOrder.rows[0].id
              });
            }
            if (
              md.purchase_type === 'membership' &&
              ID_RE.test(md.site_id || '') &&
              ID_RE.test(md.user_id || '') &&
              ID_RE.test(md.membership_plan_id || '') &&
              (event.type !== 'checkout.session.completed' || ['paid','no_payment_required'].includes(object.payment_status))
            ) {
              const customerId = typeof object.customer === 'string' ? object.customer : null;
              const subscriptionId = typeof object.subscription === 'string'
                ? object.subscription
                : object.subscription && typeof object.subscription.id === 'string'
                  ? object.subscription.id
                  : null;
              const candidates = await client.query(
                `SELECT id,provider_subscription_id
                   FROM paid_memberships
                  WHERE site_id=$1 AND user_id=$2 AND plan_id=$3
                    AND (provider_subscription_id=$4 OR status='pending')
                  ORDER BY CASE WHEN provider_subscription_id=$4 THEN 0 ELSE 1 END,created_at DESC
                  LIMIT 2 FOR UPDATE`,
                [md.site_id, md.user_id, md.membership_plan_id, subscriptionId]
              );
              const exact = candidates.rows.find(row => row.provider_subscription_id === subscriptionId);
              const existing = exact || (
                candidates.rows.length === 1 && candidates.rows[0].provider_subscription_id === null
                  ? candidates.rows[0]
                  : null
              );
              if (existing) {
                // Never let a delayed Checkout event revive a membership whose
                // authoritative subscription event already moved it past pending.
                await client.query(
                  `UPDATE paid_memberships
                      SET status=CASE WHEN status='pending' THEN 'active' ELSE status END,
                          provider='stripe',provider_customer_id=COALESCE($2,provider_customer_id),
                          provider_subscription_id=COALESCE($3,provider_subscription_id),
                          updated_at=now()
                    WHERE id=$1`,
                  [existing.id, customerId, subscriptionId]
                );
              } else {
                await client.query(
                  `INSERT INTO paid_memberships(
                     site_id,user_id,plan_id,status,provider,provider_customer_id,provider_subscription_id
                   ) VALUES($1,$2,$3,'active','stripe',$4,$5)`,
                  [md.site_id, md.user_id, md.membership_plan_id, customerId, subscriptionId]
                );
              }
            }
          }
          if (['checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)) {
            const md = object.metadata || {};
            const orderSiteId = ID_RE.test(md.site_id || '') ? md.site_id : null;
            const orderId = ID_RE.test(md.order_id || '') ? md.order_id : null;
            const sessionId = typeof object.id === 'string' && object.id.length > 0 ? object.id : null;
            if (sessionId) {
              // Match the provider's exact session, or the signed metadata tuple when
              // the session ID has not yet been persisted. Never let a mismatched
              // session ID or incomplete site binding release another order's stock.
              const found = await client.query(
                `UPDATE commerce_orders
                    SET status='failed',provider='stripe',provider_session_id=COALESCE(provider_session_id,$1),updated_at=now()
                  WHERE provider='stripe' AND status='pending_payment'
                    AND (provider_session_id=$1 OR (provider_session_id IS NULL AND site_id=$2 AND id=$3))
                  RETURNING id,site_id`,
                [sessionId, orderSiteId, orderId]
              );
              for (const row of found.rows) await releaseOrderStockReservations(client, {
                siteId: row.site_id,
                orderId: row.id,
                status: 'released'
              });
            }
          }
          if (['refund.created', 'refund.updated', 'refund.failed'].includes(event.type)) {
            const md = object.metadata || {};
            const siteId = ID_RE.test(md.site_id || '') ? md.site_id : null;
            const orderId = ID_RE.test(md.order_id || '') ? md.order_id : null;
            const refundId = ID_RE.test(md.refund_id || '') ? md.refund_id : null;
            const providerRefundId = typeof object.id === 'string' && /^re_[A-Za-z0-9]+$/.test(object.id)
              ? object.id
              : null;
            const paymentIntentId = typeof object.payment_intent === 'string'
              ? object.payment_intent
              : object.payment_intent && typeof object.payment_intent.id === 'string'
                ? object.payment_intent.id
                : null;
            const amountMinor = Number.isSafeInteger(object.amount) && object.amount > 0
              ? object.amount
              : null;
            const currency = typeof object.currency === 'string' && /^[a-zA-Z]{3}$/.test(object.currency)
              ? object.currency.toUpperCase()
              : null;
            const providerStatus = event.type === 'refund.failed' ? 'failed' : object.status;
            const refundStatus = normalizeStripeRefundStatus(providerStatus);

            // All refund mutations acquire locks in the same order as the API:
            // order first, refund row second. This prevents an API retry and a
            // webhook from deadlocking while each tries to update the other row.
            // Provider IDs alone are never used as tenant selectors.
            if (siteId && orderId && refundId && providerRefundId && paymentIntentId && amountMinor && currency) {
              const boundOrder = await client.query(
                `SELECT id,site_id,total_minor,status
                   FROM commerce_orders
                  WHERE site_id=$1 AND id=$2 AND provider='stripe' AND provider_payment_id=$3
                  FOR UPDATE`,
                [siteId, orderId, paymentIntentId]
              );
              const order = boundOrder.rows[0];
              if (order) {
                const applied = await client.query(
                `UPDATE commerce_refunds
                    SET provider_refund_id=COALESCE(provider_refund_id,$1),
                        status=CASE WHEN status IN ('succeeded','failed','cancelled') THEN status ELSE $7 END,
                        updated_at=now()
                  WHERE site_id=$2 AND order_id=$3 AND provider='stripe'
                    AND amount_minor=$4 AND upper(currency)=$5
                    AND (provider_refund_id=$1 OR (provider_refund_id IS NULL AND id=$6))
                  RETURNING id,site_id,order_id,status`,
                [providerRefundId, siteId, orderId, amountMinor, currency, refundId, refundStatus]
              );
              const refund = applied.rows[0];
              if (refund?.status === 'succeeded') {
                await client.query(
                  `UPDATE commerce_orders
                      SET status='refunded',updated_at=now()
                    WHERE site_id=$1 AND id=$2 AND provider='stripe'
                      AND status IN ('paid','processing','fulfilled')
                      AND (SELECT COALESCE(SUM(r.amount_minor),0)
                             FROM commerce_refunds r
                            WHERE r.site_id=$1 AND r.order_id=$2
                              AND r.provider='stripe' AND r.status='succeeded') >= total_minor`,
                  [refund.site_id, refund.order_id]
                );
                }
              }
            }
          }
          const isSubscriptionLifecycleEvent = event.type.startsWith('customer.subscription.');
          const isSubscriptionInvoiceEvent = [
            'invoice.paid',
            'invoice.payment_succeeded',
            'invoice.payment_failed',
            'invoice.payment_action_required'
          ].includes(event.type);
          if (isSubscriptionLifecycleEvent || isSubscriptionInvoiceEvent) {
            // Snapshot events are immutable and can arrive out of order. Use the
            // event only to identify the tenant-bound subscription; after locking
            // that membership row, retrieve the provider's current subscription
            // before changing access state.
            const invoiceDetails = object.parent?.subscription_details ||
              object.subscription_details || {};
            const subscriptionReference = isSubscriptionLifecycleEvent
              ? object.id
              : (invoiceDetails.subscription || object.subscription);
            const subscriptionId = typeof subscriptionReference === 'string'
              ? subscriptionReference
              : subscriptionReference && typeof subscriptionReference.id === 'string'
                ? subscriptionReference.id
                : null;
            const md = isSubscriptionLifecycleEvent
              ? (object.metadata || {})
              : (invoiceDetails.metadata || {});

            if (
              /^sub_[A-Za-z0-9]+$/.test(subscriptionId || '') &&
              md.purchase_type === 'membership' &&
              ID_RE.test(md.site_id || '') &&
              ID_RE.test(md.user_id || '') &&
              ID_RE.test(md.membership_plan_id || '')
            ) {
              const candidates = await client.query(
                `SELECT id,provider_subscription_id
                   FROM paid_memberships
                  WHERE site_id=$1 AND user_id=$2 AND plan_id=$3 AND provider='stripe'
                    AND (provider_subscription_id=$4 OR (provider_subscription_id IS NULL AND status='pending'))
                  ORDER BY (provider_subscription_id=$4) DESC,created_at DESC
                  LIMIT 2
                  FOR UPDATE`,
                [md.site_id, md.user_id, md.membership_plan_id, subscriptionId]
              );
              const exact = candidates.rows.find(row => row.provider_subscription_id === subscriptionId);
              const target = exact || (
                candidates.rows.length === 1 && candidates.rows[0].provider_subscription_id === null
                  ? candidates.rows[0]
                  : null
              );
              if (!target) {
                // Stripe may deliver customer.subscription.created before the
                // Checkout Session completion has persisted its local membership.
                // Roll back the webhook receipt and return a retryable response so
                // the event is not permanently acknowledged without updating access.
                throw fail(
                  503,
                  'ERR_VIRGOSCORPIO_HUB_MEMBERSHIP_NOT_READY',
                  'The tenant-bound membership record is not ready for this subscription event. Retry the webhook.'
                );
              }

              {
                // Retrieve while holding the row lock. This serializes concurrent
                // webhook handlers so a delayed snapshot cannot roll back a newer
                // provider state. A provider read failure throws and rolls back the
                // event receipt, allowing Stripe to retry instead of losing it.
                const current = await retrieveStripeSubscription({
                  secretKey: env.STRIPE_SECRET_KEY,
                  subscriptionId,
                  fetchImpl: stripeFetch
                });
                const currentMetadata = current.metadata || {};
                const bindingMatches = current.id === subscriptionId &&
                  currentMetadata.purchase_type === 'membership' &&
                  currentMetadata.site_id === md.site_id &&
                  currentMetadata.user_id === md.user_id &&
                  currentMetadata.membership_plan_id === md.membership_plan_id;

                const status = current.status === 'canceled'
                  ? 'cancelled'
                  : ['active', 'trialing'].includes(current.status)
                    ? 'active'
                    : current.status === 'past_due'
                      ? 'past_due'
                      : current.status === 'paused'
                        ? 'paused'
                        : ['unpaid', 'incomplete_expired'].includes(current.status)
                          ? 'expired'
                          : current.status === 'incomplete'
                            ? 'pending'
                            : null;
                // Stripe API 2025-03-31.basil moved billing periods from the
                // Subscription object to each Subscription Item. Keep support for
                // older API versions and summarize mixed intervals using the
                // subscription's latest start and earliest end.
                const subscriptionItems = Array.isArray(current.items?.data)
                  ? current.items.data
                  : [];
                const itemPeriodStarts = subscriptionItems
                  .map(item => item?.current_period_start)
                  .filter(value => Number.isSafeInteger(value) && value > 0);
                const itemPeriodEnds = subscriptionItems
                  .map(item => item?.current_period_end)
                  .filter(value => Number.isSafeInteger(value) && value > 0);
                const periodStart = Number.isSafeInteger(current.current_period_start) && current.current_period_start > 0
                  ? current.current_period_start
                  : itemPeriodStarts.length ? Math.max(...itemPeriodStarts) : 0;
                const periodEnd = Number.isSafeInteger(current.current_period_end) && current.current_period_end > 0
                  ? current.current_period_end
                  : itemPeriodEnds.length ? Math.min(...itemPeriodEnds) : 0;
                const cancelAtPeriodEnd = typeof current.cancel_at_period_end === 'boolean'
                  ? current.cancel_at_period_end
                  : null;

                if (bindingMatches && status) {
                  await client.query(
                    `UPDATE paid_memberships
                        SET provider='stripe',provider_subscription_id=$4,status=$5,
                            cancel_at_period_end=COALESCE($6,cancel_at_period_end),
                            current_period_start=COALESCE(to_timestamp(NULLIF($7,0)),current_period_start),
                            current_period_end=COALESCE(to_timestamp(NULLIF($8,0)),current_period_end),
                            updated_at=now()
                      WHERE id=$1 AND site_id=$2 AND user_id=$3 AND plan_id=$9
                        AND provider='stripe'
                        AND (provider_subscription_id IS NULL OR provider_subscription_id=$4)
                      RETURNING id`,
                    [
                      target.id,
                      md.site_id,
                      md.user_id,
                      subscriptionId,
                      status,
                      cancelAtPeriodEnd,
                      periodStart,
                      periodEnd,
                      md.membership_plan_id
                    ]
                  );
                }
              }
            }
          }
          await client.query("UPDATE billing_webhook_events SET status='processed',processed_at=now() WHERE provider='stripe' AND provider_event_id=$1",[event.id]);
          await client.query('COMMIT'); return sendJson(res,200,{received:true,requestId});
        } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; } finally { client.release(); }
      }

      const publicProductPath = url.pathname.match(/^\/api\/v1\/public\/sites\/([0-9a-f-]{36})\/products(?:\/([a-z0-9][a-z0-9-]{0,180}))?$/i);
      if (req.method === 'GET' && publicProductPath) {
        if (!localPool) return sendJson(res, 503, { error: 'Public product catalog requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const siteId = publicProductPath[1];
        if (!ID_RE.test(siteId)) return sendJson(res, 400, { error: 'Site identifier is invalid.', code: 'ERR_VIRGOSCORPIO_HUB_INVALID_ID', requestId });
        if (publicProductPath[2]) {
          const found = await localPool.query("SELECT id,slug,name,description,product_type,currency,price_minor,compare_at_price_minor,sku,stock_status,requires_shipping,weight_grams,images,attributes,created_at,updated_at FROM commerce_products WHERE site_id=$1 AND slug=$2 AND status='published' LIMIT 1", [siteId, publicProductPath[2]]);
          if (!found.rows[0]) return sendJson(res, 404, { error: 'Product not found.', code: 'ERR_VIRGOSCORPIO_HUB_PRODUCT_NOT_FOUND', requestId });
          return sendJson(res, 200, { product: found.rows[0], requestId });
        }
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 24));
        const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0));
        const found = await localPool.query("SELECT id,slug,name,description,product_type,currency,price_minor,compare_at_price_minor,sku,stock_status,requires_shipping,weight_grams,images,attributes,created_at,updated_at FROM commerce_products WHERE site_id=$1 AND status='published' ORDER BY created_at DESC LIMIT $2 OFFSET $3", [siteId, limit, offset]);
        return sendJson(res, 200, { products: found.rows, limit, offset, requestId });
      }
      const publicPlansPath = url.pathname.match(/^\/api\/v1\/public\/sites\/([0-9a-f-]{36})\/membership-plans$/i);
      if (req.method === 'GET' && publicPlansPath) {
        if (!localPool) return sendJson(res, 503, { error: 'Public membership plans require PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        if (!ID_RE.test(publicPlansPath[1])) return sendJson(res, 400, { error: 'Site identifier is invalid.', code: 'ERR_VIRGOSCORPIO_HUB_INVALID_ID', requestId });
        const found = await localPool.query('SELECT id,slug,name,description,price_minor,currency,interval_unit,interval_count FROM membership_plans WHERE site_id=$1 AND active=true ORDER BY price_minor,name LIMIT 100', [publicPlansPath[1]]);
        return sendJson(res, 200, { plans: found.rows, requestId });
      }

      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'Authentication required.', code: 'ERR_VIRGOSCORPIO_HUB_UNAUTHORIZED', requestId });
      const actor = { ...auth, isDeveloper: auth.mode === 'development-token' };

      const presenceMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/presence$/i);
      const presenceHeartbeatMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/presence\/heartbeat$/i);
      const realtimeEventsMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/realtime\/events$/i);

      function presencePrincipal() {
        const principalId = actor.user.id || (actor.isDeveloper ? 'local-developer' : null);
        const sessionId = actor.sessionId || (actor.isDeveloper ? 'local-developer-session' : null);
        if (!principalId || !sessionId) throw fail(401, 'ERR_VIRGOSCORPIO_HUB_PRESENCE_PRINCIPAL_REQUIRED', 'A persistent authenticated session is required.');
        return { principalId, sessionId };
      }

      if (req.method === 'GET' && presenceMatch) {
        if (!presence) return sendJson(res, 503, { error: 'Real-time presence is not configured.', code: 'ERR_VIRGOSCORPIO_HUB_REALTIME_DISABLED', requestId });
        const siteId = presenceMatch[1];
        if (!ID_RE.test(siteId)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_SITE_ID', 'siteId must be a valid UUID.');
        await requireRealtimeCapability(actor, siteId);
        const { principalId } = presencePrincipal();
        const members = await presence.list({ siteId, viewerId: principalId });
        return sendJson(res, 200, { presence: members, requestId });
      }

      if (req.method === 'POST' && presenceHeartbeatMatch) {
        if (!presence) return sendJson(res, 503, { error: 'Real-time presence is not configured.', code: 'ERR_VIRGOSCORPIO_HUB_REALTIME_DISABLED', requestId });
        const siteId = presenceHeartbeatMatch[1];
        if (!ID_RE.test(siteId)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_SITE_ID', 'siteId must be a valid UUID.');
        await requireRealtimeCapability(actor, siteId);
        const { principalId, sessionId } = presencePrincipal();
        const limit = allowRequest('realtime-presence:' + siteId + ':' + principalId);
        if (!limit.allowed) {
          res.setHeader('retry-after', String(limit.retryAfterSeconds));
          return sendJson(res, 429, { error: 'Presence heartbeat rate limit exceeded.', code: 'ERR_VIRGOSCORPIO_HUB_REALTIME_RATE_LIMIT', requestId });
        }
        const body = await readJson(req, 8_192);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'availability')) {
          throw fail(400, 'ERR_VIRGOSCORPIO_HUB_PRESENCE_BODY_INVALID', 'Only the availability field is accepted.');
        }
        const saved = await presence.heartbeat({ siteId, principalId, sessionId, availability: body.availability === undefined ? 'active' : body.availability });
        if (realtimeBridge || realtimeHub) await (realtimeBridge || realtimeHub).publish({ siteId, topic: 'presence', payload: { kind: 'presence.refresh' } });
        return sendJson(res, 200, { presence: saved, requestId });
      }

      if (req.method === 'DELETE' && presenceHeartbeatMatch) {
        if (!presence) return sendJson(res, 503, { error: 'Real-time presence is not configured.', code: 'ERR_VIRGOSCORPIO_HUB_REALTIME_DISABLED', requestId });
        const siteId = presenceHeartbeatMatch[1];
        if (!ID_RE.test(siteId)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_SITE_ID', 'siteId must be a valid UUID.');
        await requireRealtimeCapability(actor, siteId);
        const { principalId, sessionId } = presencePrincipal();
        await presence.leave({ siteId, principalId, sessionId });
        if (realtimeBridge || realtimeHub) await (realtimeBridge || realtimeHub).publish({ siteId, topic: 'presence', payload: { kind: 'presence.refresh' } });
        return sendJson(res, 200, { left: true, requestId });
      }

      if (req.method === 'GET' && realtimeEventsMatch) {
        if (!realtimeGateway) return sendJson(res, 503, { error: 'Real-time event delivery is not configured.', code: 'ERR_VIRGOSCORPIO_HUB_REALTIME_DISABLED', requestId });
        const siteId = realtimeEventsMatch[1];
        if (!ID_RE.test(siteId)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_SITE_ID', 'siteId must be a valid UUID.');
        await requireRealtimeCapability(actor, siteId);
        const requestedTopics = url.searchParams.getAll('topic');
        if (requestedTopics.length > 1 || (requestedTopics.length === 1 && requestedTopics[0] !== 'presence')) {
          throw fail(400, 'ERR_VIRGOSCORPIO_HUB_REALTIME_TOPIC_INVALID', 'The initial real-time preview supports only the presence topic.');
        }
        const { principalId } = presencePrincipal();
        const limit = allowRequest('realtime-connect:' + siteId + ':' + principalId);
        if (!limit.allowed) {
          res.setHeader('retry-after', String(limit.retryAfterSeconds));
          return sendJson(res, 429, { error: 'Real-time connection rate limit exceeded.', code: 'ERR_VIRGOSCORPIO_HUB_REALTIME_RATE_LIMIT', requestId });
        }
        return await realtimeGateway.handle(req, res, {
          principal: { id: principalId, isDeveloper: actor.isDeveloper },
          sessionId: actor.sessionId || null,
          expiresAt: actor.expiresAt || null,
          siteId,
          topic: 'presence'
        });
      }

      const platformHandled = await handlePlatformRoute({ req, res, url, actor, siteIdFor, requireCapability, readJson, sendJson, fail, requestId, localPool, libraryStore, firewall, env, identity, maxBody, maxLibraryBody, maxOptimizerBytes: maxLibraryFileBytes, store });
      if (platformHandled) return;

      if (await authRoutes.handleAuthenticated({ req, res, url, actor, requestId })) return;

      if (await aiTaskRoutes.handle({ req, res, url, actor, requestId })) return;
      if (req.method === 'GET' && url.pathname === '/api/v1/widgets') return sendJson(res, 200, { apiVersion: 1, widgets: registry.list(), requestId });

      if (req.method === 'GET' && url.pathname === '/api/v1/sites') {
        if (actor.isDeveloper) return sendJson(res, 200, { sites: env.VIRGOSCORPIO_HUB_DEFAULT_SITE_ID ? [{ id: env.VIRGOSCORPIO_HUB_DEFAULT_SITE_ID, slug: 'local', name: 'Local Site', defaultLocale: 'en' }] : [], requestId });
        return sendJson(res, 200, { sites: await identity.listSites(actor.user.id), requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/sites') {
        if (actor.isDeveloper) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'Site creation requires an authenticated site owner.');
        const body = await readJson(req, Math.min(maxBody, 16_384));
        const site = await identity.createSite({ actorId: actor.user.id, slug: normalizeSlug(body.slug), name: body.name });
        await identity.audit({ siteId: site.id, actorId: actor.user.id, action: 'site.created', targetType: 'site', targetId: site.id, requestId });
        return sendJson(res, 201, { site, requestId });
      }

      const designSystemMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/design-system$/i);
      if (designSystemMatch && ['GET','PUT'].includes(req.method)) {
        if (!localPool) return sendJson(res, 503, { error: 'Design systems require PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const siteId = designSystemMatch[1]; await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'site:manage');
        if (req.method === 'GET') {
          const result = await localPool.query('SELECT version,tokens,updated_at FROM site_design_systems WHERE site_id=$1', [siteId]);
          return sendJson(res, 200, { designSystem: result.rows[0] || { version: 0, tokens: {} }, requestId });
        }
        const body = await readJson(req, Math.min(maxBody, 64_000)); const validation = validateDesignTokens(body.tokens || {});
        if (!validation.valid) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_DESIGN_TOKENS_INVALID', 'Design tokens failed validation.', validation.errors);
        const client = await localPool.connect();
        try {
          await client.query('BEGIN');
          const current = await client.query('SELECT version FROM site_design_systems WHERE site_id=$1 FOR UPDATE', [siteId]);
          const version = current.rows[0]?.version || 0; const expected = body.expectedVersion === undefined ? version : Number(body.expectedVersion);
          if (!Number.isInteger(expected) || expected !== version) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_VERSION_CONFLICT', 'The design system changed since it was loaded.', { expectedVersion: expected, currentVersion: version });
          const saved = await client.query(`INSERT INTO site_design_systems(site_id,version,tokens,updated_by,updated_at) VALUES($1,1,$2::jsonb,$3,now())
            ON CONFLICT(site_id) DO UPDATE SET version=site_design_systems.version+1,tokens=EXCLUDED.tokens,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING version,tokens,updated_at`, [siteId, JSON.stringify(body.tokens || {}), actor.user.id]);
          await client.query('COMMIT'); await identity?.audit({ siteId, actorId: actor.user.id, action: 'design_system.updated', targetType: 'design_system', requestId, details: { version: saved.rows[0].version } });
          return sendJson(res, 200, { designSystem: saved.rows[0], requestId });
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
      }

      const reusableCollectionMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/reusable-components$/i);
      const reusableItemMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/reusable-components\/([0-9a-f-]{36})$/i);
      if ((reusableCollectionMatch && ['GET','POST'].includes(req.method)) || (reusableItemMatch && ['PUT','DELETE'].includes(req.method))) {
        if (!localPool) return sendJson(res, 503, { error: 'Reusable components require PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const siteId = reusableCollectionMatch?.[1] || reusableItemMatch[1]; await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'content:edit');
        if (req.method === 'GET') {
          const result = await localPool.query('SELECT id,slug,name,version,document,created_at,updated_at FROM reusable_components WHERE site_id=$1 ORDER BY name', [siteId]);
          return sendJson(res, 200, { components: result.rows, requestId });
        }
        if (req.method === 'DELETE') {
          const deleted = await localPool.query('DELETE FROM reusable_components WHERE site_id=$1 AND id=$2 RETURNING id', [siteId, reusableItemMatch[2]]);
          if (!deleted.rows[0]) throw fail(404, 'ERR_VIRGOSCORPIO_HUB_COMPONENT_NOT_FOUND', 'Reusable component not found.');
          return sendJson(res, 200, { deleted: true, requestId });
        }
        const body = await readJson(req, Math.min(maxBody, 1_000_000)); const validation = validatePageDocument(body.document);
        if (!validation.valid) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_INVALID_DOCUMENT', 'Reusable component document failed validation.', validation.errors);
        if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(String(body.slug || '')) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 180) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_COMPONENT_METADATA_INVALID', 'A safe slug and component name are required.');
        if (req.method === 'POST') {
          const saved = await localPool.query('INSERT INTO reusable_components(site_id,slug,name,document,created_by,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$5) RETURNING id,slug,name,version,document,created_at,updated_at', [siteId, body.slug, body.name.trim(), JSON.stringify(body.document), actor.user.id]);
          return sendJson(res, 201, { component: saved.rows[0], requestId });
        }
        const expected = Number(body.expectedVersion);
        const saved = await localPool.query('UPDATE reusable_components SET slug=$3,name=$4,document=$5::jsonb,version=version+1,updated_by=$6,updated_at=now() WHERE site_id=$1 AND id=$2 AND version=$7 RETURNING id,slug,name,version,document,updated_at', [siteId, reusableItemMatch[2], body.slug, body.name.trim(), JSON.stringify(body.document), actor.user.id, expected]);
        if (!saved.rows[0]) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_VERSION_CONFLICT', 'The reusable component changed or was removed since it was loaded.');
        return sendJson(res, 200, { component: saved.rows[0], requestId });
      }

      const templateCollectionMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/templates$/i);
      const templateItemMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/templates\/([0-9a-f-]{36})$/i);
      if ((templateCollectionMatch && ['GET','POST'].includes(req.method)) || (templateItemMatch && ['PUT','DELETE'].includes(req.method))) {
        if (!localPool) return sendJson(res, 503, { error: 'Site templates require PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const siteId = templateCollectionMatch?.[1] || templateItemMatch[1]; await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'site:manage');
        if (req.method === 'GET') { const result = await localPool.query('SELECT id,slug,name,template_type,version,active,document,created_at,updated_at FROM site_templates WHERE site_id=$1 ORDER BY template_type,name', [siteId]); return sendJson(res, 200, { templates: result.rows, requestId }); }
        if (req.method === 'DELETE') { const deleted = await localPool.query('DELETE FROM site_templates WHERE site_id=$1 AND id=$2 AND active=false RETURNING id', [siteId, templateItemMatch[2]]); if (!deleted.rows[0]) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_TEMPLATE_ACTIVE_OR_MISSING', 'Only an inactive template can be deleted.'); return sendJson(res, 200, { deleted: true, requestId }); }
        const body = await readJson(req, Math.min(maxBody, 1_000_000)); const validation = validatePageDocument(body.document);
        if (!validation.valid) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_INVALID_DOCUMENT', 'Template document failed validation.', validation.errors);
        if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(String(body.slug || '')) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 180 || !['single','archive','header','footer','404','search','page'].includes(body.templateType)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_TEMPLATE_METADATA_INVALID', 'Template slug, name, or type is invalid.');
        const client = await localPool.connect();
        try {
          await client.query('BEGIN');
          let result;
          if (req.method === 'POST') {
            result = await client.query('INSERT INTO site_templates(site_id,slug,name,template_type,document,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5::jsonb,false,$6,$6) RETURNING id,slug,name,template_type,version,active,document,updated_at', [siteId, body.slug, body.name.trim(), body.templateType, JSON.stringify(body.document), actor.user.id]);
          } else {
            const current = await client.query('SELECT template_type,version FROM site_templates WHERE site_id=$1 AND id=$2 FOR UPDATE', [siteId, templateItemMatch[2]]);
            if (!current.rows[0] || Number(body.expectedVersion) !== current.rows[0].version) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_VERSION_CONFLICT', 'The template changed or was removed since it was loaded.');
            const type = body.templateType || current.rows[0].template_type;
            if (body.active === true) await client.query('UPDATE site_templates SET active=false,updated_at=now() WHERE site_id=$1 AND template_type=$2 AND active=true', [siteId, type]);
            result = await client.query('UPDATE site_templates SET slug=$3,name=$4,template_type=$5,document=$6::jsonb,active=$7,version=version+1,updated_by=$8,updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING id,slug,name,template_type,version,active,document,updated_at', [siteId, templateItemMatch[2], body.slug, body.name.trim(), type, JSON.stringify(body.document), body.active === true, actor.user.id]);
          }
          await client.query('COMMIT'); return sendJson(res, req.method === 'POST' ? 201 : 200, { template: result.rows[0], requestId });
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
      }

      const termsCollectionMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/terms$/i);
      const termItemMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/terms\/([0-9a-f-]{36})$/i);
      if ((termsCollectionMatch && ['GET', 'POST'].includes(req.method)) || (termItemMatch && ['PUT', 'DELETE'].includes(req.method))) {
        if (!localPool) throw fail(503, 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', 'Taxonomy management requires PostgreSQL.');
        const siteId = termsCollectionMatch?.[1] || termItemMatch[1];
        await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'content:edit');
        if (req.method === 'GET') {
          const taxonomy = url.searchParams.get('taxonomy');
          if (taxonomy && !/^[a-z][a-z0-9_-]{0,62}$/.test(taxonomy)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_TAXONOMY_INVALID', 'taxonomy must be a lowercase identifier.');
          const values = taxonomy ? [siteId, taxonomy] : [siteId];
          const result = await localPool.query(`SELECT id,site_id,taxonomy,slug,label,version,metadata,created_at,updated_at FROM taxonomy_terms WHERE site_id=$1 AND deleted_at IS NULL ${taxonomy ? 'AND taxonomy=$2' : ''} ORDER BY taxonomy,label LIMIT 500`, values);
          return sendJson(res, 200, { terms: result.rows, requestId });
        }
        if (req.method === 'POST') {
          const body = await readJson(req, Math.min(maxBody, 64_000));
          const taxonomy = String(body.taxonomy || 'category').toLowerCase();
          const slug = normalizeSlug(body.slug || body.label);
          if (!/^[a-z][a-z0-9_-]{0,62}$/.test(taxonomy) || !slug || slug.length > 180 || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 180) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_TAXONOMY_INVALID', 'taxonomy, slug and label are required and must be valid.');
          const metadata = body.metadata === undefined ? {} : body.metadata;
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 16_000) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_TAXONOMY_METADATA_INVALID', 'metadata must be a JSON object up to 16 KB.');
          const client = await localPool.connect();
          try {
            await client.query('BEGIN');
            const result = await client.query('INSERT INTO taxonomy_terms(site_id,taxonomy,slug,label,metadata) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,site_id,taxonomy,slug,label,version,metadata', [siteId, taxonomy, slug, body.label.trim(), JSON.stringify(metadata)]);
            const term = result.rows[0];
            await client.query(`INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('taxonomy-term',$1,$2,'taxonomy.upsert',$3::jsonb) ON CONFLICT(aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`, [term.id, term.version, JSON.stringify({ id: term.id, siteId: term.site_id, taxonomy: term.taxonomy, slug: term.slug, label: term.label, metadata: term.metadata, version: term.version, status: 'active' })]);
            await client.query('COMMIT');
            if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'taxonomy.created', targetType: 'taxonomy-term', targetId: term.id, requestId, details: { taxonomy, slug } });
            return sendJson(res, 201, { term, requestId });
          } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') throw fail(409, 'ERR_VIRGOSCORPIO_HUB_TAXONOMY_CONFLICT', 'A term with this slug already exists in the taxonomy.'); throw error; }
          finally { client.release(); }
        }
        const termId = termItemMatch[2];
        const client = await localPool.connect();
        try {
          await client.query('BEGIN');
          const selected = await client.query('SELECT id,site_id,taxonomy,slug,label,version,metadata FROM taxonomy_terms WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [siteId, termId]);
          const existing = selected.rows[0];
          if (!existing) throw fail(404, 'ERR_VIRGOSCORPIO_HUB_TAXONOMY_TERM_NOT_FOUND', 'Taxonomy term not found.');
          if (req.method === 'PUT') {
            const body = await readJson(req, Math.min(maxBody, 64_000));
            if (!Number.isInteger(Number(body.expectedVersion)) || Number(body.expectedVersion) !== existing.version) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_VERSION_CONFLICT', 'Taxonomy term changed since it was loaded. Reload before retrying.');
            const label = body.label === undefined ? existing.label : body.label;
            const slug = body.slug === undefined ? existing.slug : normalizeSlug(body.slug);
            const metadata = body.metadata === undefined ? existing.metadata : body.metadata;
            if (typeof label !== 'string' || !label.trim() || label.length > 180 || !slug || slug.length > 180 || !metadata || typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 16_000) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_TAXONOMY_INVALID', 'Term label, slug or metadata is invalid.');
            const updated = await client.query('UPDATE taxonomy_terms SET slug=$3,label=$4,metadata=$5::jsonb,version=version+1 WHERE site_id=$1 AND id=$2 RETURNING id,site_id,taxonomy,slug,label,version,metadata', [siteId, termId, slug, label.trim(), JSON.stringify(metadata)]);
            const term = updated.rows[0];
            await client.query(`INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('taxonomy-term',$1,$2,'taxonomy.upsert',$3::jsonb) ON CONFLICT(aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`, [term.id, term.version, JSON.stringify({ id: term.id, siteId: term.site_id, taxonomy: term.taxonomy, slug: term.slug, label: term.label, metadata: term.metadata, version: term.version, status: 'active' })]);
            await client.query('COMMIT');
            if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'taxonomy.updated', targetType: 'taxonomy-term', targetId: term.id, requestId });
            return sendJson(res, 200, { term, requestId });
          }
          const updated = await client.query('UPDATE taxonomy_terms SET version=version+1,deleted_at=now() WHERE site_id=$1 AND id=$2 RETURNING id,site_id,taxonomy,slug,label,version,metadata', [siteId, termId]);
          const term = updated.rows[0];
          await client.query(`INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('taxonomy-term',$1,$2,'taxonomy.delete',$3::jsonb) ON CONFLICT(aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`, [term.id, term.version, JSON.stringify({ id: term.id, siteId: term.site_id, taxonomy: term.taxonomy, slug: term.slug, label: term.label, metadata: term.metadata, version: term.version, status: 'deleted' })]);
          await client.query('COMMIT');
          if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'taxonomy.deleted', targetType: 'taxonomy-term', targetId: term.id, requestId });
          return sendJson(res, 200, { deleted: true, termId, requestId });
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') throw fail(409, 'ERR_VIRGOSCORPIO_HUB_TAXONOMY_CONFLICT', 'A term with this slug already exists.'); throw error; }
        finally { client.release(); }
      }

      const relationshipsCollectionMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/relationships$/i);
      const relationshipItemMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/relationships\/([0-9a-f-]{36})$/i);
      if ((relationshipsCollectionMatch && ['GET', 'POST'].includes(req.method)) || (relationshipItemMatch && req.method === 'DELETE')) {
        if (!localPool) throw fail(503, 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', 'Relationship management requires PostgreSQL.');
        const siteId = relationshipsCollectionMatch?.[1] || relationshipItemMatch[1];
        await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'content:edit');
        if (req.method === 'GET') {
          const result = await localPool.query('SELECT id,source_id,target_id,kind,metadata,version,created_at,deleted_at FROM content_relationships WHERE site_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 500', [siteId]);
          return sendJson(res, 200, { relationships: result.rows, requestId });
        }
        if (req.method === 'POST') {
          const body = await readJson(req, Math.min(maxBody, 32_000));
          if (!ID_RE.test(String(body.sourceId || '')) || !ID_RE.test(String(body.targetId || '')) || body.sourceId === body.targetId || !['HAS_TERM','PARENT_OF','RELATED_TO','LOCALIZED_AS','NAVIGATES_TO'].includes(body.kind)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_RELATIONSHIP_INVALID', 'sourceId, targetId and an approved relationship kind are required.');
          const client = await localPool.connect();
          try {
            await client.query('BEGIN');
            const src = await client.query(`SELECT id,'content'::text AS node_type FROM content_items WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL UNION ALL SELECT id,'term'::text AS node_type FROM taxonomy_terms WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL LIMIT 1`, [siteId, body.sourceId]);
            const dst = await client.query(`SELECT id,'content'::text AS node_type FROM content_items WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL UNION ALL SELECT id,'term'::text AS node_type FROM taxonomy_terms WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL LIMIT 1`, [siteId, body.targetId]);
            if (!src.rows[0] || !dst.rows[0]) throw fail(404, 'ERR_VIRGOSCORPIO_HUB_RELATIONSHIP_ENDPOINT_NOT_FOUND', 'Both relationship endpoints must exist in the selected site.');
            const sourceType = src.rows[0].node_type; const targetType = dst.rows[0].node_type;
            if (body.kind === 'HAS_TERM' && (sourceType !== 'content' || targetType !== 'term')) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_RELATIONSHIP_TYPE', 'HAS_TERM must connect content to a taxonomy term.');
            if (body.kind === 'PARENT_OF' && sourceType !== targetType) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_RELATIONSHIP_TYPE', 'PARENT_OF endpoints must both be content or both be taxonomy terms.');
            if (!['HAS_TERM','PARENT_OF'].includes(body.kind) && (sourceType !== 'content' || targetType !== 'content')) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_RELATIONSHIP_TYPE', 'This relation kind must connect content records.');
            const metadata = body.metadata === undefined ? {} : body.metadata;
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 16_000) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_RELATIONSHIP_METADATA', 'metadata must be a JSON object up to 16 KB.');
            const inserted = await client.query('INSERT INTO content_relationships(site_id,source_id,target_id,kind,metadata) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,site_id,source_id,target_id,kind,metadata,version,created_at', [siteId, body.sourceId, body.targetId, body.kind, JSON.stringify(metadata)]);
            const rel = inserted.rows[0];
            await client.query(`INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('relationship',$1,$2,'relationship.upsert',$3::jsonb) ON CONFLICT(aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`, [rel.id, rel.version, JSON.stringify({ relationshipId: rel.id, siteId, sourceId: rel.source_id, targetId: rel.target_id, sourceType, targetType, kind: rel.kind, version: rel.version })]);
            await client.query('COMMIT');
            if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'relationship.created', targetType: 'relationship', targetId: rel.id, requestId, details: { kind: rel.kind } });
            return sendJson(res, 201, { relationship: rel, requestId });
          } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') throw fail(409, 'ERR_VIRGOSCORPIO_HUB_RELATIONSHIP_EXISTS', 'This relationship already exists.'); throw error; }
          finally { client.release(); }
        }
        const relationshipId = relationshipItemMatch[2]; const client = await localPool.connect();
        try {
          await client.query('BEGIN');
          const found = await client.query('SELECT * FROM content_relationships WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [siteId, relationshipId]);
          const rel = found.rows[0]; if (!rel) throw fail(404, 'ERR_VIRGOSCORPIO_HUB_RELATIONSHIP_NOT_FOUND', 'Relationship not found.');
          const src = await client.query("SELECT id,'content'::text AS node_type FROM content_items WHERE site_id=$1 AND id=$2 UNION ALL SELECT id,'term'::text AS node_type FROM taxonomy_terms WHERE site_id=$1 AND id=$2 LIMIT 1", [siteId, rel.source_id]);
          const dst = await client.query("SELECT id,'content'::text AS node_type FROM content_items WHERE site_id=$1 AND id=$2 UNION ALL SELECT id,'term'::text AS node_type FROM taxonomy_terms WHERE site_id=$1 AND id=$2 LIMIT 1", [siteId, rel.target_id]);
          const version = rel.version + 1;
          await client.query('UPDATE content_relationships SET version=$3,deleted_at=now() WHERE site_id=$1 AND id=$2', [siteId, relationshipId, version]);
          await client.query(`INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('relationship',$1,$2,'relationship.delete',$3::jsonb) ON CONFLICT(aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`, [rel.id, version, JSON.stringify({ relationshipId: rel.id, siteId, sourceId: rel.source_id, targetId: rel.target_id, sourceType: src.rows[0]?.node_type || 'content', targetType: dst.rows[0]?.node_type || (rel.kind === 'HAS_TERM' ? 'term' : 'content'), kind: rel.kind, version })]);
          await client.query('COMMIT');
          if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'relationship.deleted', targetType: 'relationship', targetId: rel.id, requestId });
          return sendJson(res, 200, { deleted: true, relationshipId, requestId });
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
      }

      const menuCollectionMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/menus$/i);
      const menuItemMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/menus\/([a-z0-9][a-z0-9-]{0,100})$/i);
      if ((menuCollectionMatch && ['GET','POST'].includes(req.method)) || (menuItemMatch && ['PUT','DELETE'].includes(req.method))) {
        if (!localPool) return sendJson(res, 503, { error: 'Navigation menus require PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const siteId = menuCollectionMatch?.[1] || menuItemMatch[1]; await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'site:manage');
        if (req.method === 'GET') { const result = await localPool.query('SELECT id,slug,name,version,items,presentation,created_at,updated_at FROM navigation_menus WHERE site_id=$1 ORDER BY name', [siteId]); return sendJson(res, 200, { menus: result.rows, requestId }); }
        if (req.method === 'DELETE') { const deleted = await localPool.query('DELETE FROM navigation_menus WHERE site_id=$1 AND slug=$2 RETURNING slug', [siteId, menuItemMatch[2]]); if (!deleted.rows[0]) throw fail(404, 'ERR_VIRGOSCORPIO_HUB_MENU_NOT_FOUND', 'Navigation menu not found.'); return sendJson(res, 200, { deleted: true, requestId }); }
        const body = await readJson(req, Math.min(maxBody, 256_000)); const validation = validateMenuItems(body.items || []);
        if (!validation.valid) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_MENU_INVALID', 'Navigation menu failed validation.', validation.errors);
        if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(String(body.slug || '')) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 180) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_MENU_METADATA_INVALID', 'Menu slug and name are required.');
        const presentation = body.presentation === undefined ? {} : body.presentation;
        if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation) || Buffer.byteLength(JSON.stringify(presentation)) > 16_384) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_MENU_PRESENTATION_INVALID', 'presentation must be a small JSON object.');
        const expected = req.method === 'PUT' ? Number(body.expectedVersion) : null;
        const saved = req.method === 'POST'
          ? await localPool.query('INSERT INTO navigation_menus(site_id,slug,name,items,presentation,updated_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6) RETURNING id,slug,name,version,items,presentation,updated_at', [siteId, body.slug, body.name.trim(), JSON.stringify(body.items || []), JSON.stringify(presentation), actor.user.id])
          : await localPool.query('UPDATE navigation_menus SET name=$3,items=$4::jsonb,presentation=$5::jsonb,version=version+1,updated_by=$6,updated_at=now() WHERE site_id=$1 AND slug=$2 AND version=$7 RETURNING id,slug,name,version,items,presentation,updated_at', [siteId, menuItemMatch[2], body.name.trim(), JSON.stringify(body.items || []), JSON.stringify(presentation), actor.user.id, expected]);
        if (!saved.rows[0]) throw fail(req.method === 'POST' ? 409 : 409, 'ERR_VIRGOSCORPIO_HUB_VERSION_CONFLICT', 'Menu already exists or changed since it was loaded.');
        return sendJson(res, req.method === 'POST' ? 201 : 200, { menu: saved.rows[0], requestId });
      }

      const aiPolicyMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/ai-policy$/i);
      if (aiPolicyMatch && ['GET','PUT'].includes(req.method)) {
        if (!localPool) throw fail(503, 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', 'AI governance configuration requires PostgreSQL.');
        const siteId = aiPolicyMatch[1]; await requireCapability(actor, siteId, 'site:manage');
        if (req.method === 'GET') {
          const policy = await getSiteAIPolicy(siteId);
          return sendJson(res, 200, { policy, availableProviders: [...AI_PROVIDERS], classificationLevels: Object.keys(DATA_CLASSIFICATION_RANK), requestId });
        }
        const body = await readJson(req, Math.min(maxBody, 32_000));
        const allowedProviders = body.allowedProviders;
        if (!Array.isArray(allowedProviders) || allowedProviders.length < 1 || allowedProviders.length > AI_PROVIDERS.size || allowedProviders.some(provider => typeof provider !== 'string' || !AI_PROVIDERS.has(provider)) || new Set(allowedProviders).size !== allowedProviders.length) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_AI_POLICY_INVALID', 'allowedProviders must contain unique supported provider names.');
        if (typeof body.enabled !== 'boolean' || typeof body.allowExternalContent !== 'boolean' || !Object.hasOwn(DATA_CLASSIFICATION_RANK, body.maxDataClassification)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_AI_POLICY_INVALID', 'enabled, allowExternalContent and maxDataClassification are required.');
        if (body.requireHumanReview !== undefined && body.requireHumanReview !== true) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_AI_REVIEW_REQUIRED', 'Human review is mandatory for AI-generated content.');
        const dailyRequests = Number(body.dailyRequestLimit); const dailyChars = Number(body.dailyInputCharsLimit);
        if (!Number.isInteger(dailyRequests) || dailyRequests < 1 || dailyRequests > 100_000 || !Number.isInteger(dailyChars) || dailyChars < 1000 || dailyChars > 100_000_000) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_AI_POLICY_INVALID', 'dailyRequestLimit must be 1–100000 and dailyInputCharsLimit must be 1000–100000000.');
        if (body.allowExternalContent && env.AI_ALLOW_EXTERNAL_CONTENT !== 'true') throw fail(409, 'ERR_VIRGOSCORPIO_HUB_AI_EXTERNAL_APPROVAL_REQUIRED', 'Set AI_ALLOW_EXTERNAL_CONTENT=true in deployment configuration before enabling external content processing for a site.');
        const globalAllow = new Set(String(env.AI_ALLOWED_PROVIDERS || 'mock').split(',').map(item => item.trim()).filter(Boolean));
        if (allowedProviders.some(provider => !globalAllow.has(provider))) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_AI_PROVIDER_GLOBAL_POLICY', 'A site policy cannot grant a provider that the global deployment allowlist excludes.');
        const updated = await localPool.query(`INSERT INTO site_ai_policies(site_id,enabled,allow_external_content,allowed_providers,max_data_classification,daily_request_limit,daily_input_chars_limit,require_human_review,updated_by,updated_at)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,true,$8,now())
          ON CONFLICT(site_id) DO UPDATE SET enabled=EXCLUDED.enabled,allow_external_content=EXCLUDED.allow_external_content,allowed_providers=EXCLUDED.allowed_providers,max_data_classification=EXCLUDED.max_data_classification,daily_request_limit=EXCLUDED.daily_request_limit,daily_input_chars_limit=EXCLUDED.daily_input_chars_limit,require_human_review=true,updated_by=EXCLUDED.updated_by,updated_at=now()
          RETURNING site_id,enabled,allow_external_content,allowed_providers,max_data_classification,daily_request_limit,daily_input_chars_limit,require_human_review,updated_by,updated_at`, [siteId, body.enabled, body.allowExternalContent, JSON.stringify(allowedProviders), body.maxDataClassification, dailyRequests, dailyChars, actor.user.id || null]);
        if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'ai.policy_updated', targetType: 'ai-policy', requestId, details: { enabled: body.enabled, allowedProviders, maxDataClassification: body.maxDataClassification } });
        return sendJson(res, 200, { policy: updated.rows[0], requestId });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/ai/page-draft') {
        const body = await readJson(req, maxBody);
        const siteId = await ensureSiteCapabilityForAI(actor, url, body, 'ai:use');
        const context = await prepareAIPageDraftContext({ actor, siteId, body });
        const { result, taskId } = await runGovernedAIForRequest({
          req, res, actor, siteId, body: context.body, action: 'page_draft',
          inputChars: context.inputChars, requestId,
          run: signal => ai.generatePageDraft({
            prompt: body.prompt,
            siteContext: context.siteContext,
            actor: actor.user.id || 'local-development-token',
            signal
          })
        });
        return sendJson(res, 200, { ...result, requestId, taskId, humanReviewRequired: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/ai/content-assist') {
        const body = await readJson(req, maxBody); const siteId = await ensureSiteCapabilityForAI(actor, url, body, 'ai:use');
        const { result, taskId } = await runGovernedAIForRequest({ req, res, actor, siteId, body, action: 'content_assist', inputChars: String(body.text || '').length, requestId, run: signal => ai.assistContent({ text: body.text, operation: body.operation || 'make-clearer', tone: body.tone || 'clear and professional', actor: actor.user.id || 'local-development-token', signal }) });
        return sendJson(res, 200, { ...result, requestId, taskId, humanReviewRequired: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/ai/seo') {
        const body = await readJson(req, maxBody); const siteId = await ensureSiteCapabilityForAI(actor, url, body, 'ai:use');
        const { result, taskId } = await runGovernedAIForRequest({ req, res, actor, siteId, body, action: 'seo', inputChars: String(body.title || '').length + String(body.content || '').length, requestId, run: signal => ai.generateSeo({ title: body.title, content: body.content, actor: actor.user.id || 'local-development-token', signal }) });
        return sendJson(res, 200, { ...result, requestId, taskId, humanReviewRequired: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/ai/translate') {
        const body = await readJson(req, maxBody); const siteId = await ensureSiteCapabilityForAI(actor, url, body, 'ai:use');
        const { result, taskId } = await runGovernedAIForRequest({ req, res, actor, siteId, body, action: 'translate', inputChars: String(body.text || '').length, requestId, run: signal => ai.translate({ text: body.text, targetLanguage: body.targetLanguage, actor: actor.user.id || 'local-development-token', signal }) });
        return sendJson(res, 200, { ...result, requestId, taskId, humanReviewRequired: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/pages/validate') {
        const body = await readJson(req, maxBody); const validation = validatePageDocument(body.document);
        return sendJson(res, validation.valid ? 200 : 422, { ...validation, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/preview') {
        const body = await readJson(req, maxBody); const html = renderPageDocument(body.document);
        return sendHtml(res, 200, html, htmlCspPreview());
      }

      const contentTypeHandled = await contentTypeRouteHandler({
        req, res, url, actor, siteIdFor, requireCapability, readJson,
        sendJson, fail, requestId, localPool, store, maxBody,
        contentReadScope: getContentReadScope,
      });
      if (contentTypeHandled) return;

      // Asset uploads are image-only, MIME-sniffed, path-safe, and stored outside the web root.
      if (req.method === 'GET' && url.pathname === '/api/v1/media') {
        if (!mediaStore) return sendJson(res, 503, { error: 'Media storage requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor }); await requireCapability(actor, siteId, 'media:manage');
        return sendJson(res, 200, { assets: await mediaStore.list({ siteId, limit: url.searchParams.get('limit') || 50 }), requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/media/uploads') {
        if (!mediaStore) return sendJson(res, 503, { error: 'Media storage requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const body = await readJson(req, maxMediaBody); const siteId = await siteIdFor({ req, url, body, actor }); await requireCapability(actor, siteId, 'media:manage');
        const asset = await mediaStore.upload({ siteId, actorId: actor.user.id, dataBase64: body.dataBase64, mimeType: body.mimeType, altText: body.altText || '', isPublic: body.public !== false });
        if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'media.uploaded', targetType: 'media', targetId: asset.id, requestId, details: { mimeType: asset.mime_type, byteSize: asset.byte_size } });
        return sendJson(res, 201, { asset, url: mediaStore.publicUrl ? mediaStore.publicUrl(asset) : `/media/${asset.id}`, requestId });
      }

      // All data and workflow operations are scoped to an explicit site membership.
      if (req.method === 'GET' && url.pathname === '/api/v1/pages') {
        if (!store) return sendJson(res, 503, { error: 'PostgreSQL is not configured.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor });
        let capability = await identity?.authorizeSite(actor.user.id, siteId, 'content:read');
        if (!actor.isDeveloper && !capability && !(await identity.authorizeSite(actor.user.id, siteId, 'content:read:own'))) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'Content read permission is required.');
        const ownOnly = !actor.isDeveloper && !capability;
        return sendJson(res, 200, { items: await store.listContent({ siteId, status: url.searchParams.get('status'), contentType: 'page', limit: url.searchParams.get('limit') || 50, offset: url.searchParams.get('offset') || 0, actorId: ownOnly ? actor.user.id : null }), requestId });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/pages/drafts') {
        if (!store) return sendJson(res, 503, { error: 'PostgreSQL is not configured.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor }); await requireCapability(actor, siteId, 'content:read');
        return sendJson(res, 200, { drafts: await store.listContent({ siteId, status: 'draft', contentType: 'page', limit: url.searchParams.get('limit') || 50 }), requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/pages/drafts') {
        if (!store) return sendJson(res, 503, { error: 'PostgreSQL is not configured; draft persistence is disabled.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const body = await readJson(req, maxBody); const safe = validateSaveDraftBody(body); const siteId = await siteIdFor({ req, url, body: safe, actor });
        if (safe.id) { const current = await store.getById({ siteId, id: safe.id }); await canEditContent(actor, siteId, current); }
        else await requireCapability(actor, siteId, 'content:create');
        const saved = await store.saveDraft({ siteId, id: safe.id, title: safe.document.title, slug: safe.slug, locale: safe.locale, contentType: 'page', document: safe.document, authorId: actor.user.id, expectedVersion: safe.expectedVersion, note: safe.note, correlationId: requestId });
        if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'content.draft_saved', targetType: 'content', targetId: saved.id, requestId, details: { version: saved.version } });
        return sendJson(res, 201, { status: 'draft', persisted: true, published: Boolean(saved.published_version), content: saved, requestId });
      }

      const collaborationMatch = url.pathname.match(/^\/api\/v1\/pages\/([0-9a-f-]{36})\/collaboration\/(operations|sync)$/i);
      if (collaborationMatch) {
        if (!store || typeof store.getCollaborationSync !== 'function' || typeof store.applyCollaborationOperation !== 'function') {
          return sendJson(res, 503, { error: 'Collaborative editing requires the PostgreSQL-backed content store.', code: 'ERR_VIRGOSCORPIO_HUB_COLLABORATION_DISABLED', requestId });
        }
        const contentId = collaborationMatch[1];
        const action = collaborationMatch[2];
        if ((action === 'operations' && req.method !== 'POST') || (action === 'sync' && req.method !== 'GET')) {
          throw fail(405, 'ERR_VIRGOSCORPIO_HUB_METHOD_NOT_ALLOWED', 'Use POST for operations and GET for collaboration sync.');
        }
        const siteId = await siteIdFor({ req, url, actor });
        const current = await store.getById({ siteId, id: contentId });
        if (!current || current.content_type !== 'page') {
          throw fail(404, 'ERR_VIRGOSCORPIO_HUB_CONTENT_NOT_FOUND', 'Page not found.');
        }
        await canEditContent(actor, siteId, current);
        if (current.status !== 'draft') {
          throw fail(409, 'ERR_VIRGOSCORPIO_HUB_COLLABORATION_NOT_DRAFT', 'Collaborative editing is available only while the page is a draft.');
        }

        if (action === 'operations') {
          const body = await readJson(req, Math.min(maxBody, 12 * 1024));
          if (!body || typeof body !== 'object' || Array.isArray(body) ||
              Object.keys(body).length !== 1 || !Object.hasOwn(body, 'operation')) {
            throw fail(400, 'ERR_VIRGOSCORPIO_HUB_COLLABORATION_BODY_INVALID', 'Only the operation field is accepted.');
          }
          const result = await store.applyCollaborationOperation({
            siteId,
            contentId,
            actorId: actor.user.id || null,
            operation: body.operation,
            correlationId: requestId
          });
          if (result.reloadRequired) {
            return sendJson(res, 409, { ...result, code: 'ERR_VIRGOSCORPIO_HUB_COLLABORATION_RELOAD_REQUIRED', requestId });
          }
          let fanoutDegraded = false;
          if (!result.duplicate && documentPublisher) {
            try {
              const publication = await documentPublisher({
                siteId,
                contentId,
                sequence: result.sequence,
                originConnectionId: null,
                operation: result.operation
              });
              fanoutDegraded = publication?.degraded === true;
            } catch {
              fanoutDegraded = true;
            }
          }
          return sendJson(res, 200, { ...result, fanoutDegraded, requestId });
        }

        const cursorValues = url.searchParams.getAll('afterSequence');
        if (cursorValues.length !== 1 || !/^(0|[1-9]\\d*)$/.test(cursorValues[0])) {
          throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_COLLABORATION_SEQUENCE', 'Provide one non-negative afterSequence query parameter.');
        }
        const afterSequence = Number(cursorValues[0]);
        if (!Number.isSafeInteger(afterSequence)) {
          throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_COLLABORATION_SEQUENCE', 'afterSequence must be a safe integer.');
        }
        const sync = await store.getCollaborationSync({ siteId, contentId, afterSequence });
        return sendJson(res, 200, { ...sync, requestId });
      }

      const pageIdMatch = url.pathname.match(/^\/api\/v1\/pages\/([0-9a-f-]{36})$/i);
      if (req.method === 'GET' && pageIdMatch) {
        if (!store) return sendJson(res, 503, { error: 'PostgreSQL is not configured.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor });
        if (!(await identity?.authorizeSite(actor.user.id, siteId, 'content:read')) && !actor.isDeveloper) {
          const current = await store.getById({ siteId, id: pageIdMatch[1] });
          if (!current || current.created_by !== actor.user.id || !(await identity.authorizeSite(actor.user.id, siteId, 'content:read:own'))) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'Content read permission is required.');
          return sendJson(res, 200, { content: current, requestId });
        }
        const content = await store.getById({ siteId, id: pageIdMatch[1] });
        if (!content) return sendJson(res, 404, { error: 'Content not found.', code: 'ERR_VIRGOSCORPIO_HUB_CONTENT_NOT_FOUND', requestId });
        return sendJson(res, 200, { content, requestId });
      }

      const revisionsMatch = url.pathname.match(/^\/api\/v1\/pages\/([0-9a-f-]{36})\/revisions$/i);
      if (req.method === 'GET' && revisionsMatch) {
        const siteId = await siteIdFor({ req, url, actor });
        if (!(await hasContentRead(actor, siteId))) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'Content read permission is required.');
        const current = await store.getById({ siteId, id: revisionsMatch[1] });
        if (!current) return sendJson(res, 404, { error: 'Content not found.', code: 'ERR_VIRGOSCORPIO_HUB_CONTENT_NOT_FOUND', requestId });
        if (!actor.isDeveloper && !(await identity.authorizeSite(actor.user.id, siteId, 'content:read')) && current.created_by !== actor.user.id) {
          throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'You cannot read revisions for this content.');
        }
        return sendJson(res, 200, { revisions: await store.listRevisions({ siteId, contentId: revisionsMatch[1] }), requestId });
      }
      const restoreMatch = url.pathname.match(/^\/api\/v1\/pages\/([0-9a-f-]{36})\/restore\/(\d+)$/i);
      if (req.method === 'POST' && restoreMatch) {
        const body = await readJson(req, maxBody); const siteId = await siteIdFor({ req, url, body, actor });
        const current = await store.getById({ siteId, id: restoreMatch[1] }); await canEditContent(actor, siteId, current);
        const revision = await store.getRevision({ siteId, contentId: restoreMatch[1], version: Number(restoreMatch[2]) });
        if (!revision) return sendJson(res, 404, { error: 'Revision not found.', code: 'ERR_VIRGOSCORPIO_HUB_REVISION_NOT_FOUND', requestId });
        const snap = revision.snapshot;
        const saved = await store.saveDraft({ siteId, id: restoreMatch[1], title: snap.title, slug: snap.slug, locale: snap.locale, contentType: snap.contentType || 'page', document: snap.document, authorId: actor.user.id, expectedVersion: body.expectedVersion, note: `Restored revision ${revision.version}`, correlationId: requestId });
        return sendJson(res, 200, { status: 'draft', restoredFromVersion: revision.version, content: saved, requestId });
      }

      const workflowMatch = url.pathname.match(/^\/api\/v1\/(?:pages|content)\/([0-9a-f-]{36})\/(submit-review|approve|reject|publish|schedule|archive|unpublish)$/i);
      if (req.method === 'POST' && workflowMatch) {
        if (!store) return sendJson(res, 503, { error: 'PostgreSQL is not configured.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const body = await readJson(req, Math.min(maxBody, 64_000)); const siteId = await siteIdFor({ req, url, body, actor });
        const [, id, action] = workflowMatch; const expectedVersion = body.expectedVersion === undefined ? undefined : Number(body.expectedVersion); const note = body.note;
        const caps = { 'submit-review': 'content:submit-review', approve: 'content:approve', reject: 'content:approve', publish: 'content:publish', schedule: 'content:publish', archive: 'content:archive', unpublish: 'content:publish' };
        await requireCapability(actor, siteId, caps[action]);
        const operations = {
          'submit-review': () => store.submitForReview({ siteId, id, actorId: actor.user.id, correlationId: requestId, expectedVersion, note }),
          approve: () => store.approve({ siteId, id, actorId: actor.user.id, correlationId: requestId, expectedVersion, note }),
          reject: () => store.rejectReview({ siteId, id, actorId: actor.user.id, correlationId: requestId, expectedVersion, note }),
          publish: () => store.publishContent({ siteId, id, actorId: actor.user.id, correlationId: requestId, expectedVersion, note }),
          schedule: () => store.scheduleContent({ siteId, id, actorId: actor.user.id, correlationId: requestId, expectedVersion, scheduledAt: body.scheduledAt, note }),
          archive: () => store.archiveContent({ siteId, id, actorId: actor.user.id, correlationId: requestId, expectedVersion, note }),
          unpublish: () => store.unpublishContent({ siteId, id, actorId: actor.user.id, correlationId: requestId, expectedVersion, note })
        };
        const result = await operations[action]();
        if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: `content.${action}`, targetType: 'content', targetId: id, requestId, details: { version: result.version, status: result.status } });
        return sendJson(res, 200, { status: result.status, content: result, requestId });
      }

      const siteMembershipHandled = await handleSiteMembershipRoute({
        req,
        res,
        url,
        actor,
        requireCapability,
        readJson,
        sendJson,
        requestId,
        identity,
        maxBody,
      });
      if (siteMembershipHandled) return;

      // Plugin registry. Activation requires admin approval plus an immutable OCI image digest.
      if (req.method === 'GET' && url.pathname === '/api/v1/plugins') {
        if (!localPool) return sendJson(res, 503, { error: 'Plugin registry requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor }); await requireCapability(actor, siteId, 'plugins:read');
        const result = await localPool.query('SELECT id,name,version,api_version,status,source_type,package_sha256,image_digest,artifact_digest,sbom_reference,provenance,signature_verified,security_reviewed_at,security_reviewed_by,manifest,requested_capabilities,approved_capabilities,created_at,updated_at FROM plugin_installs WHERE site_id=$1 ORDER BY name', [siteId]);
        return sendJson(res, 200, { plugins: result.rows, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/plugins/register') {
        const body = await readJson(req, Math.min(maxBody, 256_000)); const siteId = await siteIdFor({ req, url, body, actor }); await requireCapability(actor, siteId, 'plugins:manage');
        const validation = validatePluginManifest(body.manifest);
        if (!validation.valid) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_MANIFEST_INVALID', 'Plugin manifest failed validation.', validation.errors);
        if (!['npm-archive','oci-image'].includes(body.sourceType)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_SOURCE_INVALID', 'sourceType must be npm-archive or oci-image.');
        if (body.sourceType === 'oci-image' && !validatePinnedImageDigest(body.imageDigest)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_IMAGE_NOT_PINNED', 'OCI image must be pinned by SHA-256 digest.');
        if (body.sourceType === 'npm-archive' && !/^[a-f0-9]{64}$/i.test(body.packageSha256 || '')) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_HASH_REQUIRED', 'npm-archive registration requires a SHA-256 package hash.');
        const artifactDigest = body.sourceType === 'npm-archive' ? String(body.packageSha256).toLowerCase() : digestForArtifact(body.imageDigest);
        const trustedKeys = trustedKeysFromEnv(env.VIRGOSCORPIO_HUB_PLUGIN_TRUSTED_PUBLIC_KEYS);
        let signatureResult = { valid: false, reason: 'ERR_VIRGOSCORPIO_HUB_PLUGIN_SIGNATURE_MISSING_OR_INVALID' };
        if (body.signature !== undefined || body.keyId !== undefined) {
          signatureResult = verifyPluginArtifactSignature({ manifest: body.manifest, artifactDigest, sbomDigest: body.sbomDigest, sourceType: body.sourceType, keyId: body.keyId, signature: body.signature, trustedKeys });
          if (!signatureResult.valid) throw fail(422, signatureResult.reason || 'ERR_VIRGOSCORPIO_HUB_PLUGIN_SIGNATURE_INVALID', 'Plugin artifact signature is invalid or its signing key is not trusted.');
        }
        if (body.provenance !== undefined && (!body.provenance || typeof body.provenance !== 'object' || Array.isArray(body.provenance) || JSON.stringify(body.provenance).length > 32_000)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_PROVENANCE_INVALID', 'provenance must be a JSON object up to 32 KB.');
        if (body.sbomReference !== undefined && (typeof body.sbomReference !== 'string' || body.sbomReference.length > 2048 || /[\r\n]/.test(body.sbomReference))) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_SBOM_INVALID', 'sbomReference must be a safe artifact reference.');
        if (body.sbomDigest !== undefined && !/^[a-f0-9]{64}$/i.test(body.sbomDigest)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_SBOM_INVALID', 'sbomDigest must be a SHA-256 digest.');
        if (signatureResult.valid && (!body.sbomReference || !body.sbomDigest)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_SBOM_REQUIRED', 'Signed plugin registration must include a verifiable SBOM reference and SHA-256 digest.');
        const provenance = { ...(body.provenance || {}), signingKeyId: signatureResult.valid ? body.keyId : null, signatureVerification: signatureResult.valid ? 'verified' : 'not-verified', signatureReason: signatureResult.valid ? null : signatureResult.reason };
        const result = await localPool.query(
          `INSERT INTO plugin_installs(site_id,name,version,api_version,status,source_type,package_sha256,image_digest,artifact_digest,sbom_reference,sbom_digest,provenance,signature_verified,security_reviewed_at,security_reviewed_by,manifest,requested_capabilities,installed_by)
           VALUES($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11::jsonb,$12,NULL,NULL,$13::jsonb,$14::jsonb,$15)
           ON CONFLICT(site_id,name) DO UPDATE SET version=EXCLUDED.version,api_version=EXCLUDED.api_version,status='pending',source_type=EXCLUDED.source_type,package_sha256=EXCLUDED.package_sha256,image_digest=EXCLUDED.image_digest,artifact_digest=EXCLUDED.artifact_digest,sbom_reference=EXCLUDED.sbom_reference,sbom_digest=EXCLUDED.sbom_digest,provenance=EXCLUDED.provenance,signature_verified=EXCLUDED.signature_verified,security_reviewed_at=NULL,security_reviewed_by=NULL,manifest=EXCLUDED.manifest,requested_capabilities=EXCLUDED.requested_capabilities,approved_capabilities='[]'::jsonb,approved_by=NULL,updated_at=now()
           RETURNING id,name,version,status,source_type,image_digest,artifact_digest,sbom_reference,sbom_digest,signature_verified,security_reviewed_at,requested_capabilities`,
          [siteId, body.manifest.name, body.manifest.version, body.manifest.apiVersion, body.sourceType, body.packageSha256 || null, body.imageDigest || null, artifactDigest, body.sbomReference || null, body.sbomDigest ? String(body.sbomDigest).toLowerCase() : null, JSON.stringify(provenance), signatureResult.valid, JSON.stringify(body.manifest), JSON.stringify(body.manifest.capabilities), actor.user.id]
        );
        await identity?.audit({ siteId, actorId: actor.user.id, action: 'plugin.registered', targetType: 'plugin', targetId: result.rows[0].id, requestId, details: { name: result.rows[0].name, signatureVerified: signatureResult.valid } });
        return sendJson(res, 201, { plugin: result.rows[0], requestId });
      }
      const pluginActionMatch = url.pathname.match(/^\/api\/v1\/plugins\/([0-9a-f-]{36})\/(approve|security-review|activate|disable|invoke)$/i);
      if (req.method === 'POST' && pluginActionMatch) {
        const body = await readJson(req, Math.min(maxBody, 256_000)); const siteId = await siteIdFor({ req, url, body, actor }); await requireCapability(actor, siteId, 'plugins:manage');
        const [, pluginId, action] = pluginActionMatch; const plugin = await getPlugin(siteId, pluginId);
        if (!plugin) return sendJson(res, 404, { error: 'Plugin not found.', code: 'ERR_VIRGOSCORPIO_HUB_PLUGIN_NOT_FOUND', requestId });
        let result;
        if (action === 'approve') {
          const requested = Array.isArray(plugin.requested_capabilities) ? plugin.requested_capabilities : [];
          const approved = body.approvedCapabilities === undefined ? requested : body.approvedCapabilities;
          if (!Array.isArray(approved) || approved.some(cap => !requested.includes(cap))) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_CAPABILITY_INVALID', 'Approved capabilities must be a subset of requested capabilities.');
          result = await localPool.query("UPDATE plugin_installs SET status='approved',approved_capabilities=$3::jsonb,approved_by=$4,updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING id,name,status,approved_capabilities,image_digest,signature_verified", [siteId, pluginId, JSON.stringify(approved), actor.user.id]);
        } else if (action === 'security-review') {
          if (plugin.status !== 'approved') throw fail(409, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_NOT_APPROVED', 'Plugin must be approved before security review.');
          if (plugin.approved_by && plugin.approved_by === actor.user.id) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_REVIEW_INDEPENDENCE', 'A different administrator must perform the security review.');
          if (plugin.signature_verified !== true || !plugin.artifact_digest) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_SIGNATURE_REQUIRED', 'A verified signature and immutable artifact digest are required before security review.');
          if (!plugin.sbom_reference || !plugin.sbom_digest || !/^[a-f0-9]{64}$/i.test(String(plugin.sbom_digest))) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_SBOM_REQUIRED', 'A signed software bill of materials reference and SHA-256 digest are required before activation.');
          if (plugin.source_type !== 'oci-image' || !validatePinnedImageDigest(plugin.image_digest)) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_IMAGE_REQUIRED', 'Only a pinned OCI image can pass the execution security review.');
          result = await localPool.query('UPDATE plugin_installs SET security_reviewed_at=now(),security_reviewed_by=$3,updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING id,name,status,signature_verified,security_reviewed_at,security_reviewed_by,image_digest', [siteId, pluginId, actor.user.id]);
        } else if (action === 'activate') {
          if (env.VIRGOSCORPIO_HUB_PLUGIN_EXECUTION_ENABLED !== 'true') throw fail(503, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_EXECUTION_DISABLED', 'Plugin execution is disabled until an isolated runner, trusted signing keys, and security policies are configured.');
          if (plugin.status !== 'approved') throw fail(409, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_NOT_APPROVED', 'Plugin must be approved before activation.');
          if (plugin.signature_verified !== true || !plugin.artifact_digest) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_SIGNATURE_REQUIRED', 'The exact plugin artifact must have a verified trusted signature.');
          if (!plugin.sbom_reference) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_SBOM_REQUIRED', 'An SBOM artifact reference is required before activation.');
          if (!plugin.security_reviewed_at || !plugin.security_reviewed_by || (plugin.approved_by && plugin.security_reviewed_by === plugin.approved_by)) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_SECURITY_REVIEW_REQUIRED', 'A second administrator must review the exact artifact before activation.');
          if (!validatePinnedImageDigest(plugin.image_digest) || digestForArtifact(plugin.image_digest) !== String(plugin.artifact_digest).toLowerCase()) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_IMAGE_DIGEST_MISMATCH', 'The reviewed OCI image digest must match the signed artifact digest.');
          result = await localPool.query("UPDATE plugin_installs SET status='active',updated_at=now() WHERE site_id=$1 AND id=$2 AND signature_verified=true AND security_reviewed_at IS NOT NULL RETURNING id,name,status,image_digest,approved_capabilities,signature_verified,security_reviewed_at", [siteId, pluginId]);
        } else if (action === 'disable') {
          result = await localPool.query("UPDATE plugin_installs SET status='disabled',updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING id,name,status", [siteId, pluginId]);
        } else {
          if (env.VIRGOSCORPIO_HUB_PLUGIN_EXECUTION_ENABLED !== 'true') throw fail(503, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_EXECUTION_DISABLED', 'Plugin execution is disabled by policy.');
          if (plugin.status !== 'active' || !validatePinnedImageDigest(plugin.image_digest) || plugin.signature_verified !== true || !plugin.security_reviewed_at) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_PLUGIN_INACTIVE', 'Only reviewed, signed, active plugins with pinned images may execute.');
          const started = Date.now();
          try {
            const output = await sandboxRunner.invoke({ imageDigest: plugin.image_digest, action: body.action, input: body.input, requestId });
            await localPool.query("INSERT INTO plugin_invocations(site_id,plugin_id,action,result,elapsed_ms,request_id) VALUES($1,$2,$3,'success',$4,$5)", [siteId, pluginId, body.action, Date.now() - started, requestId]);
            return sendJson(res, 200, { result: output, requestId });
          } catch (error) {
            await localPool.query("INSERT INTO plugin_invocations(site_id,plugin_id,action,result,elapsed_ms,request_id,error_code) VALUES($1,$2,$3,$4,$5,$6,$7)", [siteId, pluginId, body.action || 'unknown', error.code === 'ERR_VIRGOSCORPIO_HUB_PLUGIN_TIMEOUT' ? 'timeout' : 'failure', Date.now() - started, requestId, error.code || 'ERR_VIRGOSCORPIO_HUB_PLUGIN_FAILED']);
            throw error;
          }
        }
        if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: `plugin.${action}`, targetType: 'plugin', targetId: pluginId, requestId, details: { status: result.rows[0]?.status, signatureVerified: Boolean(result.rows[0]?.signature_verified) } });
        return sendJson(res, 200, { plugin: result.rows[0], requestId });
      }

      return sendJson(res, 404, { error: 'Route not found.', code: 'ERR_VIRGOSCORPIO_HUB_NOT_FOUND', requestId });
    } catch (error) {
      if (req.aborted || res.destroyed || res.writableEnded) {
        if (error.code === 'ERR_VIRGOSCORPIO_HUB_AI_CANCELLED') {
          structuredLogger.emit('info', 'virgoscorpio_hub.ai.request_cancelled', {
            component: 'ai',
            operation: 'request',
            code: error.code
          });
        }
        return;
      }
      const status = Number.isInteger(error.statusCode) ? error.statusCode : error.code === 'ERR_VIRGOSCORPIO_HUB_INVALID_DOCUMENT' ? 422 : 500;
      const errorPath = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return '/other'; } })();
      setHttpStatus(requestSpan, status);
      structuredLogger.emit('error', 'virgoscorpio_hub.http.error', {
        requestId,
        method: req.method,
        route: requestMetrics.normalizeRoute(errorPath),
        code: error.code || 'ERR_VIRGOSCORPIO_HUB_INTERNAL',
        statusCode: status,
        elapsedMs: Date.now() - started,
        errorType: error.name || 'Error'
      });
      if (status >= 500 && !error.statusCode) return sendJson(res, status, { error: 'An internal error occurred.', code: error.code || 'ERR_VIRGOSCORPIO_HUB_INTERNAL', requestId });
      if (status === 429 && error.retryAfterSeconds) res.setHeader('retry-after', String(error.retryAfterSeconds));
      return sendJson(res, status, { error: error.message, code: error.code || 'ERR_VIRGOSCORPIO_HUB_REQUEST', details: error.details, requestId });
      }
    }, {
      'virgoscorpio_hub.component': 'api',
      'virgoscorpio_hub.operation': 'http_request',
      'http.request.method': req.method
    });
  }

  const server = http.createServer((req, res) => { void handler(req, res); });

  function rejectWebSocketUpgrade(socket, error) {
    if (!socket || socket.destroyed) return;
    const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    const statusText = ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 429: 'Too Many Requests', 503: 'Service Unavailable' })[status] || 'Internal Server Error';
    const payload = Buffer.from(JSON.stringify({
      error: status >= 500 ? 'Real-time connection is unavailable.' : String(error?.message || 'WebSocket upgrade rejected.'),
      code: String(error?.code || 'ERR_VIRGOSCORPIO_HUB_REALTIME_UPGRADE').slice(0, 100)
    }));
    try {
      socket.end('HTTP/1.1 ' + status + ' ' + statusText + '\r\n' +
        'Connection: close\r\n' +
        'Content-Type: application/json; charset=utf-8\r\n' +
        'Content-Length: ' + payload.length + '\r\n' +
        (error?.retryAfterSeconds ? 'Retry-After: ' + error.retryAfterSeconds + '\r\n' : '') +
        'Cache-Control: no-store\r\n\r\n' + payload);
    } catch { socket.destroy(); }
  }

  server.on('upgrade', (req, socket, head) => {
    const requestId = typeof req.headers['x-request-id'] === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : randomUUID();
    const traceContext = createTraceContext({
      requestId,
      incomingTraceparent: req.headers.traceparent,
      trustRemote: env.VIRGOSCORPIO_HUB_TRACE_CONTEXT_TRUST_REMOTE === 'true'
    });
    void runWithServerSpan(traceContext, async upgradeSpan => {
      const started = Date.now();
      let upgradePath = '/other';
      try {
      const url = new URL(req.url || '/', 'http://localhost');
      upgradePath = url.pathname;
      const match = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/realtime\/ws$/i);
      if (!match) throw fail(404, 'ERR_VIRGOSCORPIO_HUB_NOT_FOUND', 'The WebSocket route was not found.');
      if (req.method !== 'GET') throw fail(405, 'ERR_VIRGOSCORPIO_HUB_METHOD_NOT_ALLOWED', 'WebSocket upgrades require GET.');
      if (!realtimeWebSocketGateway) throw fail(503, 'ERR_VIRGOSCORPIO_HUB_REALTIME_DISABLED', 'The real-time WebSocket gateway is not configured.');
      const siteId = match[1];
      if (!ID_RE.test(siteId)) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_INVALID_SITE_ID', 'siteId must be a valid UUID.');

      const origin = req.headers.origin;
      const expectedOrigin = `${secureCookies ? 'https' : (req.socket.encrypted ? 'https' : 'http')}://${req.headers.host}`;
      if (typeof origin !== 'string' || origin !== expectedOrigin) {
        throw fail(403, 'ERR_VIRGOSCORPIO_HUB_REALTIME_ORIGIN_FORBIDDEN', 'A same-origin WebSocket request is required.');
      }

      const firewallResult = await firewall.evaluate({
        ip: req.socket.remoteAddress || 'unknown',
        path: url.pathname,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
        siteId
      });
      if (firewallResult.action === 'deny' || firewallResult.action === 'challenge') {
        throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FIREWALL_DENY', 'The WebSocket request is blocked by site security policy.');
      }
      if (firewallResult.action === 'rate_limit') {
        throw fail(429, 'ERR_VIRGOSCORPIO_HUB_FIREWALL_RATE_LIMIT', 'The WebSocket request exceeded the firewall rate limit.');
      }

      const auth = await authenticate(req);
      if (!auth) throw fail(401, 'ERR_VIRGOSCORPIO_HUB_UNAUTHORIZED', 'Authentication is required for WebSocket connections.');
      const actor = { ...auth, isDeveloper: auth.mode === 'development-token' };
      await requireRealtimeCapability(actor, siteId);
      const principalId = actor.user.id || (actor.isDeveloper ? 'local-developer' : null);
      const sessionId = actor.sessionId || (actor.isDeveloper ? 'local-developer-session' : null);
      if (!principalId || !sessionId) throw fail(401, 'ERR_VIRGOSCORPIO_HUB_REALTIME_PRINCIPAL_REQUIRED', 'A persistent authenticated session is required.');

      const limit = allowRequest('realtime-connect:' + siteId + ':' + principalId);
      if (!limit.allowed) {
        const error = fail(429, 'ERR_VIRGOSCORPIO_HUB_REALTIME_RATE_LIMIT', 'Real-time connection rate limit exceeded.');
        error.retryAfterSeconds = limit.retryAfterSeconds;
        throw error;
      }

      await realtimeWebSocketGateway.handleUpgrade(req, socket, head, {
        principal: { id: principalId, isDeveloper: actor.isDeveloper },
        principalId,
        sessionId,
        expiresAt: actor.expiresAt || null,
        siteId,
        topic: 'presence'
      });
      setHttpStatus(upgradeSpan, 101);
      structuredLogger.requestCompleted({ requestId, method: req.method, route: requestMetrics.normalizeRoute(upgradePath), statusCode: 101, elapsedMs: Date.now() - started });
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      setHttpStatus(upgradeSpan, status);
      structuredLogger.emit('warn', 'virgoscorpio_hub.http.websocket_upgrade_rejected', {
        requestId,
        method: req.method,
        route: requestMetrics.normalizeRoute(upgradePath),
        code: error.code || 'ERR_VIRGOSCORPIO_HUB_REALTIME_UPGRADE',
        statusCode: status,
        elapsedMs: Date.now() - started,
        errorType: error.name || 'Error'
      });
      rejectWebSocketUpgrade(socket, error);
    }
    }, {
      'virgoscorpio_hub.component': 'realtime',
      'virgoscorpio_hub.operation': 'websocket_upgrade',
      'http.request.method': req.method
    });
  });

  server.virgoScorpioHub = {
    get contentStore() { return store; }, get pool() { return localPool; }, get identityService() { return identity; }, get aiTaskStore() { return aiTaskStore; }, get libraryStore() { return libraryStore; }, get firewall() { return firewall; },
    get realtimeHub() { return realtimeHub; }, get realtimeBridge() { return realtimeBridge; }, get presenceService() { return presence; }, get realtimeConnectionLimiter() { return realtimeConnectionLimiter; }, get realtimeMetrics() { return realtimeMetrics.snapshot(); },
    ready() { return realtimeBridgeReady; },
    get realtimeMode() {
      if (injectedRealtimeHub && injectedPresenceService) return 'injected-adapters';
      if (!realtimeEnabled) return 'disabled';
      if (realtimeBridge) return 'redis-shared-realtime-pubsub';
      return configuredPresenceStore === 'redis' ? 'single-process-hub-shared-redis-presence' : 'single-process-preview';
    },
    get presenceStore() {
      if (injectedPresenceService && configuredPresenceStore === 'redis') return 'redis';
      return injectedPresenceService ? 'injected' : configuredPresenceStore;
    },
    async close() {
      await realtimeGateway?.close?.().catch(() => {});
      await realtimeWebSocketGateway?.close?.().catch(() => {});
      realtimeHub?.close?.();
      if (realtimeBridge && typeof realtimeBridge.close === 'function') await Promise.resolve(realtimeBridge.close()).catch(() => {});
      if (presence && typeof presence.close === 'function') await Promise.resolve(presence.close()).catch(() => {});
      if (realtimeConnectionLimiter && typeof realtimeConnectionLimiter.close === 'function') await Promise.resolve(realtimeConnectionLimiter.close()).catch(() => {});
      samlAuth?.close?.();
      if (typeof libraryStorageAdapter?.close === 'function') await libraryStorageAdapter.close().catch(()=>{});
      if (localPool && !pool) await localPool.end();
    }
  };
  return server;
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  let tracingRuntime = null;
  let logRuntime = null;
  try {
    tracingRuntime = initializeTracing({ env: process.env, serviceName: 'virgoscorpio-hub-api', serviceVersion: VIRGOSCORPIO_HUB_VERSION });
    logRuntime = initializeLogExport({ env: process.env, serviceName: 'virgoscorpio-hub-api', serviceVersion: VIRGOSCORPIO_HUB_VERSION });
  } catch (error) {
    await Promise.all([
      tracingRuntime?.shutdown?.().catch(() => {}),
      logRuntime?.shutdown?.().catch(() => {})
    ]);
    throw error;
  }
  const structuredLogger = createStructuredLogger({
    logger: console,
    otelLogger: logRuntime.logger,
    service: 'virgoscorpio-hub-api',
    environment: process.env.NODE_ENV || 'development',
    accessLogsEnabled: process.env.VIRGOSCORPIO_HUB_HTTP_ACCESS_LOGS_ENABLED === 'true'
  });
  try {
  let presenceService = null;
  let realtimeBridge = null;
  let realtimeConnectionLimiter = null;
  const realtimeEnabled = process.env.VIRGOSCORPIO_HUB_REALTIME_ENABLED === 'true';
  const realtimeMetrics = createRealtimeMetrics();
  const presenceStore = String(process.env.VIRGOSCORPIO_HUB_PRESENCE_STORE || 'memory').toLowerCase();
  if (!['memory', 'redis'].includes(presenceStore)) {
    throw new Error('VIRGOSCORPIO_HUB_PRESENCE_STORE must be memory or redis.');
  }
  if (realtimeEnabled && process.env.NODE_ENV === 'production') {
    throw new Error('The standalone API entry point does not yet provide distributed event, presence and connection-quota adapters. Inject all three through the production host bootstrap.');
  }
  if (realtimeEnabled && presenceStore === 'redis') {
    try {
      const redisUrl = process.env.VIRGOSCORPIO_HUB_PRESENCE_REDIS_URL;
      realtimeConnectionLimiter = await createRedisRealtimeConnectionLimiter({
        url: redisUrl,
        limits: {
          maxGlobal: boundedInt(process.env.VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS, 10_000, 1, 100_000, 'VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS'),
          maxPerSite: boundedInt(process.env.VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS_PER_SITE, 500, 1, 100_000, 'VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS_PER_SITE'),
          maxPerPrincipal: boundedInt(process.env.VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS_PER_PRINCIPAL, 4, 1, 1_000, 'VIRGOSCORPIO_HUB_REALTIME_MAX_CONNECTIONS_PER_PRINCIPAL')
        },
        leaseMs: boundedInt(process.env.VIRGOSCORPIO_HUB_REALTIME_CONNECTION_LEASE_MS, 45_000, 5_000, 300_000, 'VIRGOSCORPIO_HUB_REALTIME_CONNECTION_LEASE_MS'),
        metrics: realtimeMetrics
      });
      realtimeBridge = await createRedisRealtimeBridge({
        url: redisUrl,
        metrics: realtimeMetrics,
        onError: event => structuredLogger.emit('error', 'virgoscorpio_hub.realtime.redis_error', {
          component: 'realtime',
          code: event?.code
        })
      });
    presenceService = await createRedisPresenceService({
      url: redisUrl,
      leaseMs: boundedInt(process.env.VIRGOSCORPIO_HUB_PRESENCE_LEASE_MS, 30_000, 5_000, 120_000, 'VIRGOSCORPIO_HUB_PRESENCE_LEASE_MS'),
      maxEntriesPerSite: boundedInt(process.env.VIRGOSCORPIO_HUB_PRESENCE_MAX_SESSIONS_PER_SITE, 10_000, 1, 100_000, 'VIRGOSCORPIO_HUB_PRESENCE_MAX_SESSIONS_PER_SITE'),
      expiryRetentionMs: boundedInt(process.env.VIRGOSCORPIO_HUB_PRESENCE_EXPIRY_RETENTION_MS, 30_000, 1_000, 300_000, 'VIRGOSCORPIO_HUB_PRESENCE_EXPIRY_RETENTION_MS'),
      metrics: realtimeMetrics,
      onError: event => structuredLogger.emit('error', 'virgoscorpio_hub.presence.redis_error', {
        component: 'presence',
        code: event?.code
      }),
      onExpired: event => {
        structuredLogger.emit('info', 'virgoscorpio_hub.presence.lease_expired', {
          component: 'presence',
          operation: 'lease_expired'
        });
        return realtimeBridge.publish({ siteId: event.siteId, topic: 'presence', payload: { kind: 'presence.refresh' } })
          .catch(error => structuredLogger.emit('error', 'virgoscorpio_hub.realtime.expiry_publish_failed', {
            component: 'realtime',
            operation: 'expiry_publish',
            code: error?.code
          }));
      }
      });
    } catch (error) {
      await Promise.all([
        presenceService?.close?.().catch(() => {}),
        realtimeBridge?.close?.().catch(() => {}),
        realtimeConnectionLimiter?.close?.().catch(() => {})
      ]);
      throw error;
    }
  }
  let server;
  try {
    server = createApiServer({ presenceService, realtimeBridge, realtimeMetrics, realtimeConnectionLimiter, structuredLogger });
    await server.virgoScorpioHub.ready();
  } catch (error) {
    await Promise.all([
      presenceService?.close?.().catch(() => {}),
      realtimeBridge?.close?.().catch(() => {}),
      realtimeConnectionLimiter?.close?.().catch(() => {})
    ]);
    throw error;
  }
  const host = process.env.HOST || '127.0.0.1'; const port = Number(process.env.PORT || 8787);
  server.listen(port, host, () => structuredLogger.emit('info', 'virgoscorpio_hub.api.started', {
    component: 'api', operation: 'startup', outcome: 'success'
  }));
  const shutdown = async () => { server.close(async () => {
    await server.virgoScorpioHub.close().catch(() => {});
    await Promise.all([tracingRuntime.shutdown().catch(() => {}), logRuntime.shutdown().catch(() => {})]);
    process.exit(0);
  }); setTimeout(() => process.exit(1), 5000).unref(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } catch (error) {
    structuredLogger.emit('error', 'virgoscorpio_hub.api.start_failed', {
      component: 'api', operation: 'startup', outcome: 'failure',
      code: error?.code, errorType: error?.name || 'Error'
    });
    await Promise.all([tracingRuntime.shutdown().catch(() => {}), logRuntime.shutdown().catch(() => {})]);
    throw error;
  }
}
if (require.main === module) void main().catch(() => { process.exitCode = 1; });
module.exports = { createApiServer, readJson, normalizeSlug, validateSaveDraftBody, sameSecret, parseCookies, ID_RE };
