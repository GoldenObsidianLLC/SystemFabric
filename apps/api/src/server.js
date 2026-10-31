'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { loadEnvFile } = require('../../../scripts/load-env');
const { createAIService } = require('../../../packages/ai/src/service');
const { createPostgresPool, createPostgresStore } = require('../../../packages/db/src/postgres-store');
const { createIdentityService } = require('../../../packages/auth/src/service');
const { createAuthorizationRequest, exchangeAndVerify, configFromEnv } = require('../../../packages/auth/src/oidc');
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
const { verifyStripeSignature, digestWebhookBody } = require('../../../packages/billing/src/stripe');
const { releaseOrderStockReservations, commitOrderStockReservations } = require('../../../packages/commerce/src/stock-reservations');
const { validatePluginManifest, validatePinnedImageDigest } = require('../../../packages/plugins/src/manifest');
const { createWidgetRegistry } = require('../../../packages/widgets/src/registry');
const { validatePageDocument } = require('../../../packages/domain/src/page-document');
const { validateDesignTokens } = require('../../../packages/domain/src/design-system');
const { validateMenuItems } = require('../../../packages/domain/src/navigation');
const { validateContentTypeDefinition, validateRecordValues, NAME_RE: CONTENT_TYPE_NAME_RE } = require('../../../packages/domain/src/content-types');
const { renderPageDocument, rendererInfo } = require('../../../packages/render/src');
const { createRequestMetrics } = require('../../../packages/observability/src/metrics');
const { createRealtimeHub } = require('../../../packages/realtime/src/event-hub');
const { createMemoryPresenceAdapter, createPresenceService } = require('../../../packages/realtime/src/presence');
const { createRedisPresenceService } = require('../../../packages/realtime/src/redis-presence');
const { createRedisRealtimeBridge } = require('../../../packages/realtime/src/redis-realtime');
const { createSseGateway } = require('../../../packages/realtime/src/sse-gateway');
const { boundedInt } = require('../../../packages/ai/src/config');
const SYSTEMFABRIC_VERSION = require('../../../package.json').version;

const MAX_BODY_DEFAULT = 1_048_576;
const MAX_MEDIA_BODY = 16 * 1024 * 1024;
const MAX_LIBRARY_BODY_DEFAULT = 72 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  const left = createHash('sha256').update(candidate).digest(); const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}
function parseBearer(req) { const header = req.headers.authorization; return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null; }
function parseCookies(header = '') {
  const cookies = Object.create(null);
  for (const piece of header.split(';')) {
    const index = piece.indexOf('='); if (index < 0) continue;
    const key = piece.slice(0, index).trim(); const value = piece.slice(index + 1).trim();
    if (/^[A-Za-z0-9_-]+$/.test(key)) cookies[key] = value;
  }
  return cookies;
}
function cookie(name, value, { httpOnly = false, secure = false, maxAge = 43_200, sameSite = 'Lax', path = '/' } = {}) {
  return `${name}=${value}; Path=${path}; SameSite=${sameSite}; Max-Age=${maxAge}${httpOnly ? '; HttpOnly' : ''}${secure ? '; Secure' : ''}`;
}
function normalizeSlug(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180);
}
async function readRawBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) throw fail(413, 'ERR_SYSTEMFABRIC_BODY_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw fail(413, 'ERR_SYSTEMFABRIC_BODY_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readForm(req, maxBytes) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) throw fail(415, 'ERR_SYSTEMFABRIC_FORM_CONTENT_TYPE', 'Expected application/x-www-form-urlencoded.');
  const raw = (await readRawBody(req, maxBytes)).toString('utf8');
  const params = new URLSearchParams(raw); const result = Object.create(null);
  for (const key of ['SAMLResponse', 'RelayState']) { const values = params.getAll(key); if (values.length > 1) throw fail(400, 'ERR_SYSTEMFABRIC_SAML_FORM', `Duplicate ${key} form fields are not allowed.`); if (values.length === 1) result[key] = values[0]; }
  if (!result.SAMLResponse || !result.RelayState) throw fail(400, 'ERR_SYSTEMFABRIC_SAML_FORM', 'SAMLResponse and RelayState are required.');
  return result;
}
async function readJson(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) { const error = new Error(`Request body exceeds ${maxBytes} bytes.`); error.statusCode = 413; error.code = 'ERR_SYSTEMFABRIC_BODY_TOO_LARGE'; throw error; }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) { const error = new Error(`Request body exceeds ${maxBytes} bytes.`); error.statusCode = 413; error.code = 'ERR_SYSTEMFABRIC_BODY_TOO_LARGE'; throw error; }
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('Request body must be valid JSON.'); error.statusCode = 400; error.code = 'ERR_SYSTEMFABRIC_INVALID_JSON'; throw error; }
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
  if (!body || typeof body !== 'object' || !body.document || typeof body.document !== 'object') throw fail(400, 'ERR_SYSTEMFABRIC_DOCUMENT_REQUIRED', 'document is required.');
  const validation = validatePageDocument(body.document);
  if (!validation.valid) throw fail(422, 'ERR_SYSTEMFABRIC_INVALID_DOCUMENT', 'Page document failed validation.', validation.errors);
  const slug = normalizeSlug(body.slug || body.document.title);
  if (body.id !== undefined && (typeof body.id !== 'string' || !ID_RE.test(body.id))) throw fail(400, 'ERR_SYSTEMFABRIC_INVALID_ID', 'id must be a valid UUID when provided.');
  if (body.siteId !== undefined && (typeof body.siteId !== 'string' || !ID_RE.test(body.siteId))) throw fail(400, 'ERR_SYSTEMFABRIC_INVALID_SITE_ID', 'siteId must be a valid UUID.');
  if (body.locale !== undefined && (typeof body.locale !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(body.locale))) throw fail(400, 'ERR_SYSTEMFABRIC_INVALID_LOCALE', 'locale must be a valid language tag.');
  if (!slug) throw fail(400, 'ERR_SYSTEMFABRIC_INVALID_SLUG', 'A valid page slug is required.');
  if (body.aiGenerated === true && body.reviewed !== true) throw fail(409, 'ERR_SYSTEMFABRIC_REVIEW_REQUIRED', 'Set reviewed=true after reviewing the AI proposal.');
  return { document: body.document, slug, locale: typeof body.locale === 'string' ? body.locale.slice(0, 20) : 'en', id: body.id, siteId: body.siteId, expectedVersion: body.expectedVersion === undefined ? undefined : Number(body.expectedVersion), note: typeof body.note === 'string' ? body.note.slice(0, 2000) : null };
}
function htmlCspPreview() { return "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'none'; connect-src 'none'"; }
function htmlCspAdmin() { return "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"; }

function createApiServer({ env = process.env, aiService, contentStore, pool, identityService, pluginRunner, realtimeHub: injectedRealtimeHub, presenceService: injectedPresenceService, realtimeBridge: injectedRealtimeBridge, logger = console } = {}) {
  if (env.NODE_ENV === 'production') {
    const missing = [];
    if (!env.DATABASE_URL && !pool) missing.push('DATABASE_URL');
    if (env.SESSION_COOKIE_SECURE !== 'true') missing.push('SESSION_COOKIE_SECURE=true');
    if (env.REQUIRE_VERIFIED_EMAIL !== 'true') missing.push('REQUIRE_VERIFIED_EMAIL=true');
    if (!env.SYSTEMFABRIC_MFA_ENCRYPTION_KEY) missing.push('SYSTEMFABRIC_MFA_ENCRYPTION_KEY (32-byte base64url key)');
    if (env.SYSTEMFABRIC_METRICS_ENABLED === 'true' && (!env.SYSTEMFABRIC_METRICS_TOKEN || env.SYSTEMFABRIC_METRICS_TOKEN.length < 32)) missing.push('SYSTEMFABRIC_METRICS_TOKEN (at least 32 characters when metrics are enabled)');
    if ((env.AI_PROVIDER || 'mock') === 'mock' && env.SYSTEMFABRIC_ALLOW_MOCK_AI_IN_PRODUCTION !== 'true') missing.push('a reviewed AI_PROVIDER or SYSTEMFABRIC_ALLOW_MOCK_AI_IN_PRODUCTION=true for an explicitly mock-only deployment');
    if (env.SYSTEMFABRIC_PLUGIN_EXECUTION_ENABLED === 'true' && (!env.SYSTEMFABRIC_PLUGIN_TRUSTED_PUBLIC_KEYS || !env.SYSTEMFABRIC_PLUGIN_RUNNER_URL || !env.SYSTEMFABRIC_PLUGIN_RUNNER_TOKEN || env.SYSTEMFABRIC_PLUGIN_RUNNER_TOKEN.length < 32)) missing.push('plugin trusted public keys, runner URL, and strong runner token when plugin execution is enabled');
    if (missing.length) throw new Error(`SystemFabric is not production-ready: configure ${missing.join(', ')} and complete deployment review before starting.`);
  }

  const devToken = env.SYSTEMFABRIC_API_TOKEN;
  const maxBody = boundedInt(env.MAX_REQUEST_BYTES, MAX_BODY_DEFAULT, 1_024, 16 * 1024 * 1024, 'MAX_REQUEST_BYTES');
  const maxMediaBody = Math.max(maxBody, MAX_MEDIA_BODY);
  const allowRequest = createRateLimiter(env);
  const ai = aiService || createAIService({ env });
  const registry = createWidgetRegistry();
  let localPool = pool || null; let store = contentStore || null;
  if (!store && env.DATABASE_URL) { localPool = localPool || createPostgresPool(env); store = createPostgresStore({ pool: localPool }); }
  const identity = identityService || (localPool ? createIdentityService({ pool: localPool, env }) : null);
  // Use a shared PostgreSQL-backed SAML cache so request IDs are validated and consumed across replicas.
  const samlAuth = env.SAML_ENABLED === 'true' ? createSamlAuthenticator({ env, pool: localPool }) : null;
  const mediaStore = localPool ? (env.MEDIA_DRIVER === 's3' ? createS3MediaStore({ pool: localPool, env }) : createLocalMediaStore({ pool: localPool, root: env.MEDIA_ROOT || path.resolve(process.cwd(), 'var', 'media') })) : null;
  const maxLibraryFileBytes = boundedInt(env.SYSTEMFABRIC_LIBRARY_MAX_FILE_BYTES, 50 * 1024 * 1024, 1024, 50 * 1024 * 1024, 'SYSTEMFABRIC_LIBRARY_MAX_FILE_BYTES');
  const maxLibraryBody = boundedInt(env.SYSTEMFABRIC_LIBRARY_MAX_BODY_BYTES, MAX_LIBRARY_BODY_DEFAULT, 16 * 1024 * 1024, 80 * 1024 * 1024, 'SYSTEMFABRIC_LIBRARY_MAX_BODY_BYTES');
  const libraryStorageAdapter = createCloudStorageAdapterFromEnv({ env });
  const malwareScanner = String(env.LIBRARY_MALWARE_SCANNER || '').toLowerCase() === 'clamdscan' ? createClamDScanScanner({ executable: env.CLAMDSCAN_PATH || 'clamdscan', timeoutMs: Number(env.LIBRARY_MALWARE_SCAN_TIMEOUT_MS || 20000), maxBytes: maxLibraryFileBytes }) : null;
  const libraryStore = localPool ? createLibraryStore({ pool: localPool, root: env.LIBRARY_ROOT || path.resolve(process.cwd(), 'var', 'library'), maxFileBytes: maxLibraryFileBytes, storageAdapter: libraryStorageAdapter, malwareScanner, requireMalwareScan: env.NODE_ENV === 'production' }) : null;
  const firewall = createFirewall({ pool: localPool, env, cacheTtlMs: boundedInt(env.SYSTEMFABRIC_FIREWALL_CACHE_MS, 5000, 500, 60_000, 'SYSTEMFABRIC_FIREWALL_CACHE_MS') });
  const sandboxRunner = pluginRunner || createRemotePluginRunner({
    url: env.SYSTEMFABRIC_PLUGIN_RUNNER_URL, token: env.SYSTEMFABRIC_PLUGIN_RUNNER_TOKEN,
    timeoutMs: boundedInt(env.PLUGIN_TIMEOUT_MS, 8000, 100, 30_000, 'PLUGIN_TIMEOUT_MS'),
    allowHttpInternal: env.PLUGIN_RUNNER_ALLOW_HTTP_INTERNAL === 'true'
  });
  const secureCookies = env.NODE_ENV === 'production' || env.SESSION_COOKIE_SECURE === 'true';
  const requestMetrics = createRequestMetrics();
  const realtimeEnabled = env.SYSTEMFABRIC_REALTIME_ENABLED === 'true';
  const configuredPresenceStore = String(env.SYSTEMFABRIC_PRESENCE_STORE || 'memory').toLowerCase();
  if (!['memory', 'redis'].includes(configuredPresenceStore)) {
    throw new Error('SYSTEMFABRIC_PRESENCE_STORE must be memory or redis.');
  }
  if (realtimeEnabled && env.NODE_ENV === 'production' && (!injectedRealtimeHub || !injectedPresenceService)) {
    throw new Error('Real-time services in production require injected distributed event and presence adapters; the in-memory preview adapters are not production-safe.');
  }
  if (realtimeEnabled && configuredPresenceStore === 'redis' && !injectedPresenceService) {
    throw new Error('The Redis presence store requires an asynchronously connected presenceService to be injected.');
  }
  if (realtimeEnabled && configuredPresenceStore === 'redis' && !injectedRealtimeBridge) {
    throw new Error('The Redis presence store requires an attached cross-instance realtimeBridge for Pub/Sub fan-out.');
  }
  const realtimeHub = injectedRealtimeHub || (realtimeEnabled && env.NODE_ENV !== 'production'
    ? createRealtimeHub({
      authorizeSubscribe: async ({ principal, siteId, topic }) => {
        if (topic !== 'presence') return false;
        if (principal.isDeveloper) return env.NODE_ENV !== 'production';
        return Boolean(identity && await identity.authorizeSite(principal.id, siteId, 'content:read'));
      }
    })
    : null);
  const presence = injectedPresenceService || (realtimeEnabled && env.NODE_ENV !== 'production' && configuredPresenceStore === 'memory'
    ? createPresenceService({ adapter: createMemoryPresenceAdapter() })
    : null);
  const realtimeGateway = realtimeHub ? createSseGateway({ hub: realtimeHub }) : null;
  const realtimeBridge = injectedRealtimeBridge || null;
  const realtimeBridgeReady = realtimeBridge ? Promise.resolve().then(() => realtimeBridge.attach(realtimeHub)) : Promise.resolve();

  async function authenticate(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    const bearer = parseBearer(req);
    const sessionToken = bearer || cookies.sf_session;
    if (sessionToken && identity) {
      const session = await identity.authenticate(sessionToken);
      if (session) {
        const usingCookie = !bearer && Boolean(cookies.sf_session);
        if (usingCookie && UNSAFE_METHODS.has(req.method)) {
          const origin = req.headers.origin;
          const expectedOrigin = `${secureCookies ? 'https' : (req.socket.encrypted ? 'https' : 'http')}://${req.headers.host}`;
          if (typeof origin !== 'string' || origin !== expectedOrigin) throw fail(403, 'ERR_SYSTEMFABRIC_CSRF', 'A matching same-origin Origin header is required for cookie-authenticated writes.');
          const header = req.headers['x-csrf-token'];
          if (!header || !safeCsrfCookie(cookies.sf_csrf, header) || !(await identity.validateCsrf(sessionToken, header))) throw fail(403, 'ERR_SYSTEMFABRIC_CSRF', 'A valid CSRF token is required.');
        }
        return { mode: 'session', sessionToken, sessionId: session.sessionId, user: session.user, memberships: session.memberships };
      }
    }
    if (env.NODE_ENV !== 'production' && devToken && sameSecret(bearer, devToken)) {
      return { mode: 'development-token', user: { id: null, email: 'developer@localhost', displayName: 'Local Developer', status: 'active' }, memberships: [], isDeveloper: true };
    }
    return null;
  }
  function safeCsrfCookie(a, b) { return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }

  async function siteIdFor({ req, url, body, actor, required = true, routeSiteId }) {
    const querySiteIds = url.searchParams.getAll('siteId');
    if (querySiteIds.length > 1) {
      throw fail(400, 'ERR_SYSTEMFABRIC_SITE_CONTEXT_MISMATCH', 'Provide a siteId query parameter only once.');
    }
    const selectorEntries = [
      ['route', routeSiteId],
      ['header', req.headers['x-systemfabric-site-id']],
      ['query', querySiteIds[0]],
      ['body', body?.siteId],
    ].filter(([, value]) => value !== undefined && value !== null && value !== '');
    if (selectorEntries.some(([, value]) => typeof value !== 'string')) {
      throw fail(400, 'ERR_SYSTEMFABRIC_INVALID_SITE_ID', 'siteId must be a valid UUID.');
    }
    const distinctSiteIds = new Set(selectorEntries.map(([, value]) => value.toLowerCase()));
    if (distinctSiteIds.size > 1) {
      throw fail(400, 'ERR_SYSTEMFABRIC_SITE_CONTEXT_MISMATCH', 'All site selectors in the request must identify the same site.');
    }
    const fromRequest = selectorEntries[0]?.[1];
    let siteId = typeof fromRequest === 'string' ? fromRequest : '';
    if (!siteId && actor.isDeveloper) siteId = env.SYSTEMFABRIC_DEFAULT_SITE_ID || '';
    if (!siteId && actor.memberships.length === 1) siteId = actor.memberships[0].siteId;
    if (!siteId && !required) return null;
    if (!siteId && actor.memberships.length > 1) throw fail(400, 'ERR_SYSTEMFABRIC_SITE_REQUIRED', 'Select a site using x-systemfabric-site-id or siteId.');
    if (!siteId) throw fail(400, 'ERR_SYSTEMFABRIC_SITE_REQUIRED', 'A siteId is required for this operation.');
    if (!ID_RE.test(siteId)) throw fail(400, 'ERR_SYSTEMFABRIC_INVALID_SITE_ID', 'siteId must be a valid UUID.');

    if (!actor.isDeveloper && !(await identity.authorizeSite(actor.user.id, siteId, 'content:read'))) {
      // Read membership directly; the requested capability is checked by route-specific authorization below.
      const hasMembership = actor.memberships.some(item => item.siteId === siteId);
      if (!hasMembership) throw fail(403, 'ERR_SYSTEMFABRIC_TENANT_FORBIDDEN', 'You are not a member of this site.');
    }
    return siteId;
  }
  async function requireCapability(actor, siteId, capability) {
    if (actor.isDeveloper) return true;
    if (!identity || !(await identity.authorizeSite(actor.user.id, siteId, capability))) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', `The ${capability} capability is required for this site.`);
    return true;
  }
  async function canEditContent(actor, siteId, content) {
    if (actor.isDeveloper) return;
    if (await identity.authorizeSite(actor.user.id, siteId, 'content:edit')) return;
    if (content?.created_by === actor.user.id && await identity.authorizeSite(actor.user.id, siteId, 'content:edit:own')) return;
    throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'You cannot edit this content.');
  }
  async function ensureSiteCapabilityForAI(actor, url, body, capability = 'ai:use') {
    const siteId = await siteIdFor({ req: { headers: {}, }, url, body, actor, required: false });
    if (siteId) await requireCapability(actor, siteId, capability);
    else if (!actor.isDeveloper) {
      const allowed = actor.memberships.some(m => m.capabilities.includes(capability) || m.capabilities.includes('site:manage'));
      if (!allowed) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', `The ${capability} capability is required.`);
    }
    return siteId;
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
      if (env.NODE_ENV === 'production') throw fail(503, 'ERR_SYSTEMFABRIC_AI_GOVERNANCE_UNAVAILABLE', 'AI governance requires a site-scoped PostgreSQL policy.');
      return { siteId: null, policy: null };
    }
    const policy = await getSiteAIPolicy(siteId);
    if (!policy || !policy.enabled) throw fail(403, 'ERR_SYSTEMFABRIC_AI_DISABLED', 'AI assistance is disabled for this site.');
    const provider = ai.providerInfo().provider;
    const globalAllow = new Set(String(env.AI_ALLOWED_PROVIDERS || 'mock').split(',').map(item => item.trim()).filter(Boolean));
    const siteAllow = Array.isArray(policy.allowed_providers) ? policy.allowed_providers : [];
    if (!AI_PROVIDERS.has(provider) || !globalAllow.has(provider) || !siteAllow.includes(provider)) throw fail(403, 'ERR_SYSTEMFABRIC_AI_PROVIDER_NOT_ALLOWED', 'The configured AI provider is not allowed by both the global and site-level policies.');
    if (provider !== 'mock' && (env.AI_ALLOW_EXTERNAL_CONTENT !== 'true' || !policy.allow_external_content)) throw fail(403, 'ERR_SYSTEMFABRIC_AI_EXTERNAL_CONTENT_DISABLED', 'External AI content processing requires explicit global and site-level approval.');
    const classification = body.dataClassification || 'public';
    if (!Object.hasOwn(DATA_CLASSIFICATION_RANK, classification)) throw fail(400, 'ERR_SYSTEMFABRIC_AI_CLASSIFICATION_INVALID', 'dataClassification must be public, internal, or confidential.');
    if (DATA_CLASSIFICATION_RANK[classification] > DATA_CLASSIFICATION_RANK[policy.max_data_classification]) throw fail(403, 'ERR_SYSTEMFABRIC_AI_CLASSIFICATION_BLOCKED', `The site policy does not permit sending ${classification} data to the configured AI provider.`);
    const chars = Math.max(0, Math.min(100_000_000, Number(inputChars) || 0));
    const reserved = await localPool.query(
      `INSERT INTO ai_usage_daily(site_id,usage_date,requests,input_chars) VALUES($1,current_date,1,$2)
       ON CONFLICT(site_id,usage_date) DO UPDATE SET requests=ai_usage_daily.requests+1,input_chars=ai_usage_daily.input_chars+EXCLUDED.input_chars,updated_at=now()
       WHERE ai_usage_daily.requests < $3 AND ai_usage_daily.input_chars + EXCLUDED.input_chars <= $4
       RETURNING requests,input_chars`,
      [siteId, chars, policy.daily_request_limit, Number(policy.daily_input_chars_limit)]
    );
    if (!reserved.rows[0]) throw fail(429, 'ERR_SYSTEMFABRIC_AI_DAILY_BUDGET_EXCEEDED', 'The site has reached its daily AI request or input-character budget.');
    return { siteId, policy, provider, model: ai.providerInfo().model, chars, action, classification, userId: actor.user?.id || null };
  }
  async function recordAIUsage(context, { status, error, outputChars = 0, elapsedMs = 0, requestId }) {
    if (!localPool || !context?.siteId) return;
    try {
      await localPool.query(`INSERT INTO ai_run_audit(site_id,actor_id,provider,model,action,status,latency_ms,input_chars,output_chars,error_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [context.siteId, context.userId, context.provider || ai.providerInfo().provider, context.model || ai.providerInfo().model, context.action, status, Math.max(0, Math.min(2_147_483_647, Math.floor(elapsedMs))), context.chars || 0, Math.max(0, Number(outputChars) || 0), error ? String(error.code || 'ERR_SYSTEMFABRIC_AI_FAILURE').slice(0,100) : null]);
    } catch (auditError) { logger.error?.(JSON.stringify({ type: 'systemfabric.ai.audit_persist_failed', requestId, code: auditError.code || 'ERR_SYSTEMFABRIC_AI_AUDIT_FAILED' })); }
  }
  async function runGovernedAI({ actor, siteId, body, action, inputChars, requestId, run }) {
    const started = Date.now();
    let context = null;
    try {
      context = await reserveAIUsage({ actor, siteId, body, action, inputChars });
      const result = await run();
      const outputChars = typeof result === 'string' ? result.length : JSON.stringify(result).length;
      await recordAIUsage(context, { status: 'succeeded', outputChars, elapsedMs: Date.now() - started, requestId });
      if (identity && context.siteId && actor.user.id) await identity.audit({ siteId: context.siteId, actorId: actor.user.id, action: `ai.${action}`, targetType: 'ai-run', requestId, details: { provider: context.provider, model: context.model, classification: context.classification, inputChars: context.chars, outputChars } });
      return result;
    } catch (error) {
      if (context) await recordAIUsage(context, { status: error.statusCode === 403 || error.statusCode === 429 ? 'blocked' : 'failed', error, elapsedMs: Date.now() - started, requestId });
      throw error;
    }
  }

  async function getPlugin(siteId, pluginId) {
    const result = await localPool.query('SELECT * FROM plugin_installs WHERE site_id=$1 AND id=$2', [siteId, pluginId]);
    return result.rows[0] || null;
  }
  function gitContentTypeDefinitions() {
    const directory = path.resolve(__dirname, '../../../config/cpt');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(file => /^[a-z0-9_-]+\.json$/i.test(file)).map(file => {
      try { return JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')); } catch { throw new Error(`Invalid Git-managed content type definition: ${file}`); }
    });
  }
  async function getContentTypeDefinition(siteId, slug) {
    if (!CONTENT_TYPE_NAME_RE.test(slug)) throw fail(400, 'ERR_SYSTEMFABRIC_CONTENT_TYPE_INVALID', 'Content type slug is invalid.');
    const git = gitContentTypeDefinitions().find(item => item.name === slug);
    if (git) { const validation = validateContentTypeDefinition(git); if (!validation.valid) throw new Error(`Git-managed content type ${slug} is invalid: ${validation.errors.join('; ')}`); return git; }
    if (!localPool) return null;
    const result = await localPool.query(`SELECT definition FROM content_type_definitions WHERE site_id=$1 AND slug=$2 AND active=true ORDER BY version DESC LIMIT 1`, [siteId, slug]);
    return result.rows[0]?.definition || null;
  }
  async function hasContentRead(actor, siteId) {
    if (actor.isDeveloper) return true;
    return (await identity.authorizeSite(actor.user.id, siteId, 'content:read')) || (await identity.authorizeSite(actor.user.id, siteId, 'content:read:own'));
  }

  async function handler(req, res) {
    const requestId = typeof req.headers['x-request-id'] === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : randomUUID();
    res.setHeader('x-request-id', requestId); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('x-frame-options', 'SAMEORIGIN'); res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('cross-origin-opener-policy', 'same-origin'); res.setHeader('x-permitted-cross-domain-policies', 'none');
    if (env.NODE_ENV === 'production' && secureCookies) res.setHeader('strict-transport-security', `max-age=${boundedInt(env.SYSTEMFABRIC_HSTS_MAX_AGE, 15552000, 0, 63072000, 'SYSTEMFABRIC_HSTS_MAX_AGE')}; includeSubDomains`);
    const started = Date.now(); let route = 'unknown';
    res.once('finish', () => requestMetrics.record({ method: req.method, pathname: (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return '/other'; } })(), statusCode: res.statusCode, durationMs: Date.now() - started }));
    try {
      const url = new URL(req.url, 'http://localhost'); route = `${req.method} ${url.pathname}`;
      const firewallSite = url.pathname.match(/\/sites\/([0-9a-f-]{36})(?:\/|$)/i)?.[1] || null;
      const firewallResult = await firewall.evaluate({ ip: req.socket.remoteAddress || 'unknown', path: url.pathname, userAgent: String(req.headers['user-agent'] || '').slice(0, 500), siteId: firewallSite });
      if (firewallResult.action === 'deny') return sendJson(res, 403, { error: 'Request blocked by SystemFabric firewall policy.', code: 'ERR_SYSTEMFABRIC_FIREWALL_DENY', requestId });
      if (firewallResult.action === 'challenge') return sendJson(res, 403, { error: 'This request requires an additional verification step.', code: 'ERR_SYSTEMFABRIC_FIREWALL_CHALLENGE', requestId });
      if (firewallResult.action === 'rate_limit') return sendJson(res, 429, { error: 'Firewall rate limit exceeded.', code: 'ERR_SYSTEMFABRIC_FIREWALL_RATE_LIMIT', requestId });
      if (url.pathname === '/metrics') {
        if (env.SYSTEMFABRIC_METRICS_ENABLED !== 'true') return sendJson(res, 404, { error: 'Not found.', code: 'ERR_SYSTEMFABRIC_NOT_FOUND', requestId });
        if (!sameSecret(parseBearer(req), env.SYSTEMFABRIC_METRICS_TOKEN)) return sendJson(res, 401, { error: 'Metrics authorization required.', code: 'ERR_SYSTEMFABRIC_METRICS_UNAUTHORIZED', requestId });
        const output = Buffer.from(requestMetrics.renderPrometheus());
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': output.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(output);
      }
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { status: 'ok', service: 'systemfabric-api', version: SYSTEMFABRIC_VERSION, renderer: rendererInfo, ai: ai.providerInfo(), features: ['sessions','tenant-memberships','password-reset','email-verification','totp-mfa','oidc-sso','saml-sso-optional','drafts','revision-history','publication-workflows','visual-builder','taxonomy-relationships','media-library','document-library','file-library','video-assets','icon-library','math-formulas','media-optimization-optional','mega-menus','commerce','paid-memberships','community','firewall-rules','cloud-storage-adapters','ai-governance','plugin-provenance','sandboxed-plugins','mcp','ai-assistance'], requestId });
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

      // Public account bootstrap and login. Bootstrap is closed automatically after the first active account.
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
        const limit = allowRequest(`login:${req.socket.remoteAddress || 'unknown'}`);
        if (!limit.allowed) { res.setHeader('retry-after', String(limit.retryAfterSeconds)); return sendJson(res, 429, { error: 'Too many requests.', code: 'ERR_SYSTEMFABRIC_RATE_LIMIT', requestId }); }
        if (!identity) return sendJson(res, 503, { error: 'Authentication requires PostgreSQL and applied migrations.', code: 'ERR_SYSTEMFABRIC_IDENTITY_DISABLED', requestId });
        const body = await readJson(req, Math.min(maxBody, 16_384));
        const session = await identity.login({ email: body.email, password: body.password, ip: req.socket.remoteAddress, userAgent: String(req.headers['user-agent'] || '').slice(0, 500) });
        if (session.mfaRequired) {
          res.setHeader('set-cookie', cookie('sf_mfa_challenge', session.challengeToken, { httpOnly: true, secure: secureCookies, sameSite: 'Strict', path: '/api/v1/auth/mfa', maxAge: 300 }));
          return sendJson(res, 200, { authenticated: false, mfaRequired: true, user: { id: session.user.id, email: session.user.email }, expiresAt: session.expiresAt, requestId });
        }
        res.setHeader('set-cookie', [cookie('sf_session', session.token, { httpOnly: true, secure: secureCookies, maxAge: Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000) }), cookie('sf_csrf', session.csrf, { secure: secureCookies, maxAge: Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000) })]);
        return sendJson(res, 200, { authenticated: true, user: session.user, expiresAt: session.expiresAt, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/mfa/verify') {
        if (!identity) return sendJson(res, 503, { error: 'Authentication requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_IDENTITY_DISABLED', requestId });
        const expectedOrigin = `${secureCookies ? 'https' : (req.socket.encrypted ? 'https' : 'http')}://${req.headers.host}`;
        if (typeof req.headers.origin !== 'string' || req.headers.origin !== expectedOrigin) throw fail(403, 'ERR_SYSTEMFABRIC_CSRF', 'A matching same-origin Origin header is required.');
        const challenge = parseCookies(req.headers.cookie || '').sf_mfa_challenge;
        const body = await readJson(req, Math.min(maxBody, 16_384));
        const session = await identity.completeMfaLogin({ challengeToken: challenge, code: body.code, ip: req.socket.remoteAddress, userAgent: String(req.headers['user-agent'] || '').slice(0, 500) });
        const maxAge = Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000);
        res.setHeader('set-cookie', [cookie('sf_session', session.token, { httpOnly: true, secure: secureCookies, maxAge }), cookie('sf_csrf', session.csrf, { secure: secureCookies, maxAge }), cookie('sf_mfa_challenge', '', { httpOnly: true, secure: secureCookies, sameSite: 'Strict', path: '/api/v1/auth/mfa', maxAge: 0 })]);
        return sendJson(res, 200, { authenticated: true, user: session.user, expiresAt: session.expiresAt, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/password-reset/request') {
        if (!identity) return sendJson(res, 503, { error: 'Authentication requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_IDENTITY_DISABLED', requestId });
        const body = await readJson(req, Math.min(maxBody, 16_384));
        const result = await identity.requestPasswordReset({ email: body.email });
        return sendJson(res, 202, { ...result, message: 'If an active account matches that address, password reset instructions will be sent.', requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/password-reset/complete') {
        if (!identity) return sendJson(res, 503, { error: 'Authentication requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_IDENTITY_DISABLED', requestId });
        const body = await readJson(req, Math.min(maxBody, 16_384));
        const result = await identity.resetPassword({ token: body.token, password: body.password });
        return sendJson(res, 200, { ...result, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/email-verification/confirm') {
        if (!identity) return sendJson(res, 503, { error: 'Authentication requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_IDENTITY_DISABLED', requestId });
        const body = await readJson(req, Math.min(maxBody, 16_384));
        const result = await identity.verifyEmail({ token: body.token });
        return sendJson(res, 200, { ...result, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/bootstrap') {
        const bootstrapLimit = allowRequest(`bootstrap:${req.socket.remoteAddress || 'unknown'}`);
        if (!bootstrapLimit.allowed) { res.setHeader('retry-after', String(bootstrapLimit.retryAfterSeconds)); return sendJson(res, 429, { error: 'Too many bootstrap attempts.', code: 'ERR_SYSTEMFABRIC_RATE_LIMIT', requestId }); }
        if (!identity || !env.SYSTEMFABRIC_BOOTSTRAP_SECRET || !sameSecret(req.headers['x-systemfabric-bootstrap-secret'], env.SYSTEMFABRIC_BOOTSTRAP_SECRET)) return sendJson(res, 403, { error: 'Bootstrap is disabled or the bootstrap secret is invalid.', code: 'ERR_SYSTEMFABRIC_BOOTSTRAP_FORBIDDEN', requestId });
        const body = await readJson(req, Math.min(maxBody, 16_384));
        const result = await identity.bootstrapOwner({ email: body.email, password: body.password, displayName: body.displayName, siteSlug: body.siteSlug || 'main', siteName: body.siteName || 'Main Site' });
        return sendJson(res, 201, { status: 'created', ...result, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/invitations/accept') {
        const inviteLimit = allowRequest(`invite-accept:${req.socket.remoteAddress || 'unknown'}`);
        if (!inviteLimit.allowed) { res.setHeader('retry-after', String(inviteLimit.retryAfterSeconds)); return sendJson(res, 429, { error: 'Too many invitation attempts.', code: 'ERR_SYSTEMFABRIC_RATE_LIMIT', requestId }); }
        if (!identity) return sendJson(res, 503, { error: 'Authentication requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_IDENTITY_DISABLED', requestId });
        const body = await readJson(req, Math.min(maxBody, 16_384));
        const result = await identity.acceptInvitation({ token: body.token, password: body.password, displayName: body.displayName });
        return sendJson(res, 200, { status: 'accepted', ...result, requestId });
      }

      if (url.pathname === '/api/v1/auth/saml/metadata' && req.method === 'GET') {
        if (!samlAuth) throw fail(404, 'ERR_SYSTEMFABRIC_SAML_DISABLED', 'SAML SSO is not enabled.');
        const xml = Buffer.from(samlAuth.getMetadata());
        res.writeHead(200, { 'content-type': 'application/samlmetadata+xml; charset=utf-8', 'content-length': xml.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(xml);
      }
      if (url.pathname === '/api/v1/auth/saml/start' && req.method === 'GET') {
        if (!samlAuth || !identity) throw fail(503, 'ERR_SYSTEMFABRIC_SAML_DISABLED', 'SAML SSO is not enabled or identity storage is unavailable.');
        const limitSaml = allowRequest(`saml-start:${req.socket.remoteAddress || 'unknown'}`);
        if (!limitSaml.allowed) throw fail(429, 'ERR_SYSTEMFABRIC_RATE_LIMIT', 'Too many SSO attempts.');
        const state = require('node:crypto').randomBytes(32).toString('base64url');
        await identity.createOidcState({ state, nonce: 'saml', verifier: 'saml', issuer: samlAuth.externalIssuer() });
        const redirect = await samlAuth.getAuthorizeUrl(state);
        const target = new URL(redirect);
        if (target.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && target.protocol === 'http:')) throw fail(502, 'ERR_SYSTEMFABRIC_SAML_IDP_URL', 'SAML identity provider redirect must use HTTPS.');
        res.writeHead(302, { location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); return res.end();
      }
      if (url.pathname === '/api/v1/auth/saml/acs' && req.method === 'POST') {
        if (!samlAuth || !identity) throw fail(503, 'ERR_SYSTEMFABRIC_SAML_DISABLED', 'SAML SSO is not enabled or identity storage is unavailable.');
        const form = await readForm(req, Math.min(maxBody, 2 * 1024 * 1024));
        const saved = await identity.consumeOidcState({ state: form.RelayState });
        if (saved.issuer !== samlAuth.externalIssuer()) throw fail(401, 'ERR_SYSTEMFABRIC_SAML_STATE_ISSUER', 'The SAML relay state issuer does not match.');
        const assertion = await samlAuth.validatePostResponse({ SAMLResponse: form.SAMLResponse });
        const profile = assertion?.profile;
        if (!profile || assertion.loggedOut || typeof profile.nameID !== 'string' || !profile.nameID) throw fail(401, 'ERR_SYSTEMFABRIC_SAML_ASSERTION_INVALID', 'The SAML assertion did not contain an authenticated subject.');
        const email = samlAuth.extractEmail(profile);
        if (!email) throw fail(401, 'ERR_SYSTEMFABRIC_SAML_EMAIL_REQUIRED', 'The SAML assertion must contain a verified email attribute.');
        const session = await identity.loginFederated({ issuer: samlAuth.externalIssuer(), subject: `${String(profile.nameIDFormat || 'unspecified').slice(0, 200)}:${profile.nameID}`, email, ip: req.socket.remoteAddress, userAgent: String(req.headers['user-agent'] || '').slice(0, 500) });
        if (session.mfaRequired) {
          res.writeHead(303, { location: '/admin?mfa=required', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': cookie('sf_mfa_challenge', session.challengeToken, { httpOnly: true, secure: secureCookies, sameSite: 'Strict', path: '/api/v1/auth/mfa', maxAge: 300 }) }); return res.end();
        }
        const maxAge = Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000);
        res.writeHead(303, { location: '/admin', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': [cookie('sf_session', session.token, { httpOnly: true, secure: secureCookies, maxAge }), cookie('sf_csrf', session.csrf, { secure: secureCookies, maxAge })] }); return res.end();
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/auth/oidc/start') {
        if (!identity) return sendJson(res, 503, { error: 'SSO requires PostgreSQL and applied migrations.', code: 'ERR_SYSTEMFABRIC_IDENTITY_DISABLED', requestId });
        const limitOidc = allowRequest(`oidc-start:${req.socket.remoteAddress || 'unknown'}`);
        if (!limitOidc.allowed) { res.setHeader('retry-after', String(limitOidc.retryAfterSeconds)); return sendJson(res, 429, { error: 'Too many SSO attempts.', code: 'ERR_SYSTEMFABRIC_RATE_LIMIT', requestId }); }
        const request = await createAuthorizationRequest(env);
        await identity.createOidcState(request);
        res.writeHead(302, { location: request.authorizationUrl, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/auth/oidc/callback') {
        if (!identity) return sendJson(res, 503, { error: 'SSO requires PostgreSQL and applied migrations.', code: 'ERR_SYSTEMFABRIC_IDENTITY_DISABLED', requestId });
        const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
        if (url.searchParams.has('error') || !code || !state) throw fail(400, 'ERR_SYSTEMFABRIC_OIDC_CALLBACK_INVALID', 'The identity provider did not complete sign-in.');
        const savedState = await identity.consumeOidcState({ state }); const config = configFromEnv(env);
        if (!config || savedState.issuer !== config.issuer) throw fail(400, 'ERR_SYSTEMFABRIC_OIDC_STATE_INVALID', 'OIDC state does not match the configured issuer.');
        const external = await exchangeAndVerify({ code, nonce: savedState.nonce, verifier: savedState.verifier, env });
        if (external.issuer !== savedState.issuer) throw fail(401, 'ERR_SYSTEMFABRIC_OIDC_ISSUER_MISMATCH', 'The external identity issuer did not match the sign-in request.');
        const session = await identity.loginFederated({ issuer: external.issuer, subject: external.subject, email: external.email, ip: req.socket.remoteAddress, userAgent: String(req.headers['user-agent'] || '').slice(0, 500) });
        if (session.mfaRequired) {
          res.writeHead(303, { location: '/admin?mfa=required', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': cookie('sf_mfa_challenge', session.challengeToken, { httpOnly: true, secure: secureCookies, sameSite: 'Strict', path: '/api/v1/auth/mfa', maxAge: 300 }) });
          return res.end();
        }
        const maxAge = Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000);
        res.writeHead(303, { location: '/admin', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': [cookie('sf_session', session.token, { httpOnly: true, secure: secureCookies, maxAge }), cookie('sf_csrf', session.csrf, { secure: secureCookies, maxAge })] });
        return res.end();
      }

      // Per-IP limits cover both successful and failed authentication and all authenticated routes.
      const clientKey = req.socket.remoteAddress || 'unknown'; const limit = allowRequest(clientKey);
      res.setHeader('x-ratelimit-remaining', String(limit.remaining));
      if (!limit.allowed) { res.setHeader('retry-after', String(limit.retryAfterSeconds)); return sendJson(res, 429, { error: 'Request rate limit exceeded.', code: 'ERR_SYSTEMFABRIC_RATE_LIMIT', requestId }); }

      // Public published-page delivery only reads immutable published snapshots, never drafts.
      const publicPageMatch = url.pathname.match(/^\/public\/([a-z0-9][a-z0-9-]{0,62})\/pages\/(.+)$/);
      if (req.method === 'GET' && publicPageMatch) {
        if (!store) return sendJson(res, 503, { error: 'Published page delivery requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
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
            if (!checked.valid) throw fail(500, 'ERR_SYSTEMFABRIC_DESIGN_SYSTEM_CORRUPT', 'Published design tokens failed validation.');
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
        if (!store) return sendJson(res, 503, { error: 'Search requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const site = await store.getSiteBySlug(publicSearchMatch[1]); if (!site) return sendJson(res, 404, { error: 'Site not found.', requestId });
        const query = url.searchParams.get('q') || ''; if (!query.trim() || query.length > 500) return sendJson(res, 400, { error: 'q is required and must be at most 500 characters.', requestId });
        return sendJson(res, 200, { results: await store.search({ siteId: site.id, query, locale: url.searchParams.get('locale') || null, limit: url.searchParams.get('limit') || 20 }), requestId });
      }

      const libraryVariantMatch = url.pathname.match(/^\/library\/public\/([0-9a-f-]{36})\/variants\/([a-z0-9][a-z0-9_-]{0,60})$/i);
      if (req.method === 'GET' && libraryVariantMatch) {
        if (!libraryStore) return sendJson(res, 404, { error: 'Asset variant not found.', code: 'ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND', requestId });
        const variant = await libraryStore.readPublicVariant({ assetId: libraryVariantMatch[1], variantKey: libraryVariantMatch[2] });
        if (!variant) return sendJson(res, 404, { error: 'Asset variant not found.', code: 'ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND', requestId });
        res.writeHead(200, { 'content-type': variant.mime_type, 'content-length': variant.data.length, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-site', 'content-disposition': 'inline' });
        return res.end(variant.data);
      }
      const libraryPublicMatch = url.pathname.match(/^\/library\/public\/([0-9a-f-]{36})$/i);
      if (req.method === 'GET' && libraryPublicMatch) {
        if (!libraryStore) return sendJson(res, 404, { error: 'Asset not found.', code: 'ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND', requestId });
        const asset = await libraryStore.readPublic(libraryPublicMatch[1]);
        if (!asset) return sendJson(res, 404, { error: 'Asset not found.', code: 'ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND', requestId });
        const disposition = /^(?:image|video|audio|font)\//.test(asset.mime_type) ? 'inline' : 'attachment';
        res.writeHead(200, { 'content-type': asset.mime_type, 'content-length': asset.data.length, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-site', 'content-disposition': disposition });
        return res.end(asset.data);
      }
      const publicProductsMatch = url.pathname.match(/^\/api\/v1\/public\/([a-z0-9][a-z0-9-]{0,62})\/products$/);
      if (req.method === 'GET' && publicProductsMatch) {
        if (!localPool) return sendJson(res, 503, { error: 'Storefront requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const site = await localPool.query('SELECT id,slug FROM sites WHERE slug=$1', [publicProductsMatch[1]]);
        if (!site.rows[0]) return sendJson(res, 404, { error: 'Store not found.', requestId });
        const result = await localPool.query("SELECT id,slug,name,description,product_type,currency,price_minor,compare_at_price_minor,sku,stock_status,requires_shipping,weight_grams,images,attributes,version,updated_at FROM commerce_products WHERE site_id=$1 AND status='published' ORDER BY created_at DESC LIMIT $2", [site.rows[0].id, Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50))]);
        return sendJson(res, 200, { siteSlug: site.rows[0].slug, products: result.rows, requestId });
      }
      const publicPlansMatch = url.pathname.match(/^\/api\/v1\/public\/([a-z0-9][a-z0-9-]{0,62})\/membership-plans$/);
      if (req.method === 'GET' && publicPlansMatch) {
        if (!localPool) return sendJson(res, 503, { error: 'Membership plans require PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const site = await localPool.query('SELECT id,slug FROM sites WHERE slug=$1', [publicPlansMatch[1]]); if (!site.rows[0]) return sendJson(res, 404, { error: 'Site not found.', requestId });
        const plans = await localPool.query('SELECT id,slug,name,description,price_minor,currency,interval_unit,interval_count FROM membership_plans WHERE site_id=$1 AND active=true ORDER BY price_minor', [site.rows[0].id]);
        return sendJson(res, 200, { siteSlug: site.rows[0].slug, plans: plans.rows, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/billing/stripe/webhook') {
        if (!localPool || !env.STRIPE_WEBHOOK_SECRET) return sendJson(res, 503, { error: 'Payment webhook is not configured.', code: 'ERR_SYSTEMFABRIC_BILLING_DISABLED', requestId });
        const rawBody = await readRawBody(req, 2 * 1024 * 1024);
        if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET)) return sendJson(res, 400, { error: 'Stripe signature is invalid or outside its timestamp tolerance.', code: 'ERR_SYSTEMFABRIC_BILLING_SIGNATURE', requestId });
        let event; try { event = JSON.parse(rawBody.toString('utf8')); } catch { return sendJson(res, 400, { error: 'Webhook body must be JSON.', code: 'ERR_SYSTEMFABRIC_BILLING_WEBHOOK_JSON', requestId }); }
        if (typeof event.id !== 'string' || typeof event.type !== 'string' || !event.data?.object) return sendJson(res, 400, { error: 'Webhook event structure is invalid.', code: 'ERR_SYSTEMFABRIC_BILLING_WEBHOOK_INVALID', requestId });
        const client = await localPool.connect();
        try {
          await client.query('BEGIN');
          const inserted = await client.query("INSERT INTO billing_webhook_events(provider,provider_event_id,event_type,payload_digest,status) VALUES('stripe',$1,$2,$3,'received') ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING provider_event_id", [event.id,event.type,digestWebhookBody(rawBody)]);
          if (!inserted.rows[0]) { await client.query('ROLLBACK'); return sendJson(res,200,{received:true,duplicate:true,requestId}); }
          const object = event.data.object;
          if (['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
            const md = object.metadata || {};
            if (md.order_id && md.site_id && (event.type !== 'checkout.session.completed' || ['paid','no_payment_required'].includes(object.payment_status))) {
              const paidOrder=await client.query("UPDATE commerce_orders SET status='paid',provider='stripe',provider_session_id=$3,provider_payment_id=$4,updated_at=now() WHERE site_id=$1 AND id=$2 AND status IN ('pending_payment','processing') RETURNING id,site_id",[md.site_id,md.order_id,object.id,typeof object.payment_intent==='string'?object.payment_intent:null]);if(paidOrder.rows[0])await commitOrderStockReservations(client,{siteId:paidOrder.rows[0].site_id,orderId:paidOrder.rows[0].id});
            }
            if (md.purchase_type === 'membership' && md.site_id && md.user_id && md.membership_plan_id && (event.type !== 'checkout.session.completed' || ['paid','no_payment_required'].includes(object.payment_status))) {
              const existing=await client.query("SELECT id FROM paid_memberships WHERE site_id=$1 AND user_id=$2 AND plan_id=$3 AND status='pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[md.site_id,md.user_id,md.membership_plan_id]);
              if (existing.rows[0]) await client.query("UPDATE paid_memberships SET status='active',provider='stripe',provider_customer_id=$2,provider_subscription_id=$3,updated_at=now() WHERE id=$1",[existing.rows[0].id,typeof object.customer==='string'?object.customer:null,typeof object.subscription==='string'?object.subscription:null]);
              else await client.query("INSERT INTO paid_memberships(site_id,user_id,plan_id,status,provider,provider_customer_id,provider_subscription_id) VALUES($1,$2,$3,'active','stripe',$4,$5)",[md.site_id,md.user_id,md.membership_plan_id,typeof object.customer==='string'?object.customer:null,typeof object.subscription==='string'?object.subscription:null]);
            }
          }
          if (['checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)) {
            const md=object.metadata||{};const found=await client.query("UPDATE commerce_orders SET status='failed',updated_at=now() WHERE status='pending_payment' AND (($1::text IS NOT NULL AND provider_session_id=$1) OR ($2::uuid IS NOT NULL AND id=$2)) AND ($3::uuid IS NULL OR site_id=$3) RETURNING id,site_id",[typeof object.id==='string'?object.id:null,md.order_id||null,md.site_id||null]);
            for(const row of found.rows) await releaseOrderStockReservations(client,{siteId:row.site_id,orderId:row.id,status:'released'});
          }
          if (event.type.startsWith('customer.subscription.') && object.id) {
            const status = object.status==='active'||object.status==='trialing'?'active':object.status==='past_due'?'past_due':object.status==='canceled'?'cancelled':'pending';
            await client.query('UPDATE paid_memberships SET status=$2,cancel_at_period_end=$3,current_period_start=to_timestamp(NULLIF($4,0)),current_period_end=to_timestamp(NULLIF($5,0)),updated_at=now() WHERE provider_subscription_id=$1',[object.id,status,object.cancel_at_period_end===true,Number(object.current_period_start||0),Number(object.current_period_end||0)]);
          }
          await client.query("UPDATE billing_webhook_events SET status='processed',processed_at=now() WHERE provider='stripe' AND provider_event_id=$1",[event.id]);
          await client.query('COMMIT'); return sendJson(res,200,{received:true,requestId});
        } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; } finally { client.release(); }
      }

      const publicProductPath = url.pathname.match(/^\/api\/v1\/public\/sites\/([0-9a-f-]{36})\/products(?:\/([a-z0-9][a-z0-9-]{0,180}))?$/i);
      if (req.method === 'GET' && publicProductPath) {
        if (!localPool) return sendJson(res, 503, { error: 'Public product catalog requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = publicProductPath[1];
        if (!ID_RE.test(siteId)) return sendJson(res, 400, { error: 'Site identifier is invalid.', code: 'ERR_SYSTEMFABRIC_INVALID_ID', requestId });
        if (publicProductPath[2]) {
          const found = await localPool.query("SELECT id,slug,name,description,product_type,currency,price_minor,compare_at_price_minor,sku,stock_status,requires_shipping,weight_grams,images,attributes,created_at,updated_at FROM commerce_products WHERE site_id=$1 AND slug=$2 AND status='published' LIMIT 1", [siteId, publicProductPath[2]]);
          if (!found.rows[0]) return sendJson(res, 404, { error: 'Product not found.', code: 'ERR_SYSTEMFABRIC_PRODUCT_NOT_FOUND', requestId });
          return sendJson(res, 200, { product: found.rows[0], requestId });
        }
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 24));
        const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0));
        const found = await localPool.query("SELECT id,slug,name,description,product_type,currency,price_minor,compare_at_price_minor,sku,stock_status,requires_shipping,weight_grams,images,attributes,created_at,updated_at FROM commerce_products WHERE site_id=$1 AND status='published' ORDER BY created_at DESC LIMIT $2 OFFSET $3", [siteId, limit, offset]);
        return sendJson(res, 200, { products: found.rows, limit, offset, requestId });
      }
      const publicPlansPath = url.pathname.match(/^\/api\/v1\/public\/sites\/([0-9a-f-]{36})\/membership-plans$/i);
      if (req.method === 'GET' && publicPlansPath) {
        if (!localPool) return sendJson(res, 503, { error: 'Public membership plans require PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        if (!ID_RE.test(publicPlansPath[1])) return sendJson(res, 400, { error: 'Site identifier is invalid.', code: 'ERR_SYSTEMFABRIC_INVALID_ID', requestId });
        const found = await localPool.query('SELECT id,slug,name,description,price_minor,currency,interval_unit,interval_count FROM membership_plans WHERE site_id=$1 AND active=true ORDER BY price_minor,name LIMIT 100', [publicPlansPath[1]]);
        return sendJson(res, 200, { plans: found.rows, requestId });
      }

      const auth = await authenticate(req);
      if (!auth) return sendJson(res, 401, { error: 'Authentication required.', code: 'ERR_SYSTEMFABRIC_UNAUTHORIZED', requestId });
      const actor = { ...auth, isDeveloper: auth.mode === 'development-token' };

      const presenceMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/presence$/i);
      const presenceHeartbeatMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/presence\/heartbeat$/i);
      const realtimeEventsMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/realtime\/events$/i);

      function presencePrincipal() {
        const principalId = actor.user.id || (actor.isDeveloper ? 'local-developer' : null);
        const sessionId = actor.sessionId || (actor.isDeveloper ? 'local-developer-session' : null);
        if (!principalId || !sessionId) throw fail(401, 'ERR_SYSTEMFABRIC_PRESENCE_PRINCIPAL_REQUIRED', 'A persistent authenticated session is required.');
        return { principalId, sessionId };
      }

      if (req.method === 'GET' && presenceMatch) {
        if (!presence) return sendJson(res, 503, { error: 'Real-time presence is not configured.', code: 'ERR_SYSTEMFABRIC_REALTIME_DISABLED', requestId });
        const siteId = presenceMatch[1];
        if (!ID_RE.test(siteId)) throw fail(400, 'ERR_SYSTEMFABRIC_INVALID_SITE_ID', 'siteId must be a valid UUID.');
        await requireCapability(actor, siteId, 'content:read');
        const { principalId } = presencePrincipal();
        const members = await presence.list({ siteId, viewerId: principalId });
        return sendJson(res, 200, { presence: members, requestId });
      }

      if (req.method === 'POST' && presenceHeartbeatMatch) {
        if (!presence) return sendJson(res, 503, { error: 'Real-time presence is not configured.', code: 'ERR_SYSTEMFABRIC_REALTIME_DISABLED', requestId });
        const siteId = presenceHeartbeatMatch[1];
        if (!ID_RE.test(siteId)) throw fail(400, 'ERR_SYSTEMFABRIC_INVALID_SITE_ID', 'siteId must be a valid UUID.');
        await requireCapability(actor, siteId, 'content:read');
        const { principalId, sessionId } = presencePrincipal();
        const limit = allowRequest('realtime-presence:' + siteId + ':' + principalId);
        if (!limit.allowed) {
          res.setHeader('retry-after', String(limit.retryAfterSeconds));
          return sendJson(res, 429, { error: 'Presence heartbeat rate limit exceeded.', code: 'ERR_SYSTEMFABRIC_REALTIME_RATE_LIMIT', requestId });
        }
        const body = await readJson(req, 8_192);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'availability')) {
          throw fail(400, 'ERR_SYSTEMFABRIC_PRESENCE_BODY_INVALID', 'Only the availability field is accepted.');
        }
        const saved = await presence.heartbeat({ siteId, principalId, sessionId, availability: body.availability === undefined ? 'active' : body.availability });
        if (realtimeBridge || realtimeHub) await (realtimeBridge || realtimeHub).publish({ siteId, topic: 'presence', payload: { kind: 'presence.refresh' } });
        return sendJson(res, 200, { presence: saved, requestId });
      }

      if (req.method === 'DELETE' && presenceHeartbeatMatch) {
        if (!presence) return sendJson(res, 503, { error: 'Real-time presence is not configured.', code: 'ERR_SYSTEMFABRIC_REALTIME_DISABLED', requestId });
        const siteId = presenceHeartbeatMatch[1];
        if (!ID_RE.test(siteId)) throw fail(400, 'ERR_SYSTEMFABRIC_INVALID_SITE_ID', 'siteId must be a valid UUID.');
        await requireCapability(actor, siteId, 'content:read');
        const { principalId, sessionId } = presencePrincipal();
        await presence.leave({ siteId, principalId, sessionId });
        if (realtimeBridge || realtimeHub) await (realtimeBridge || realtimeHub).publish({ siteId, topic: 'presence', payload: { kind: 'presence.refresh' } });
        return sendJson(res, 200, { left: true, requestId });
      }

      if (req.method === 'GET' && realtimeEventsMatch) {
        if (!realtimeGateway) return sendJson(res, 503, { error: 'Real-time event delivery is not configured.', code: 'ERR_SYSTEMFABRIC_REALTIME_DISABLED', requestId });
        const siteId = realtimeEventsMatch[1];
        if (!ID_RE.test(siteId)) throw fail(400, 'ERR_SYSTEMFABRIC_INVALID_SITE_ID', 'siteId must be a valid UUID.');
        await requireCapability(actor, siteId, 'content:read');
        const requestedTopics = url.searchParams.getAll('topic');
        if (requestedTopics.length > 1 || (requestedTopics.length === 1 && requestedTopics[0] !== 'presence')) {
          throw fail(400, 'ERR_SYSTEMFABRIC_REALTIME_TOPIC_INVALID', 'The initial real-time preview supports only the presence topic.');
        }
        const { principalId } = presencePrincipal();
        const limit = allowRequest('realtime-connect:' + siteId + ':' + principalId);
        if (!limit.allowed) {
          res.setHeader('retry-after', String(limit.retryAfterSeconds));
          return sendJson(res, 429, { error: 'Real-time connection rate limit exceeded.', code: 'ERR_SYSTEMFABRIC_REALTIME_RATE_LIMIT', requestId });
        }
        return await realtimeGateway.handle(req, res, {
          principal: { id: principalId, isDeveloper: actor.isDeveloper },
          siteId,
          topic: 'presence'
        });
      }

      const platformHandled = await handlePlatformRoute({ req, res, url, actor, siteIdFor, requireCapability, readJson, sendJson, fail, requestId, localPool, libraryStore, firewall, env, identity, maxBody, maxLibraryBody, maxOptimizerBytes: maxLibraryFileBytes, store });
      if (platformHandled) return;

      if (req.method === 'GET' && url.pathname === '/api/v1/auth/me') {
        return sendJson(res, 200, { authenticated: true, user: actor.user, sites: actor.isDeveloper ? (env.SYSTEMFABRIC_DEFAULT_SITE_ID ? [{ siteId: env.SYSTEMFABRIC_DEFAULT_SITE_ID, siteSlug: 'local', siteName: 'Local Site', role: 'development', capabilities: ['*'] }] : []) : actor.memberships, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
        if (actor.sessionToken) await identity.logout(actor.sessionToken);
        res.setHeader('set-cookie', [cookie('sf_session', '', { httpOnly: true, secure: secureCookies, maxAge: 0 }), cookie('sf_csrf', '', { secure: secureCookies, maxAge: 0 })]);
        return sendJson(res, 200, { authenticated: false, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/email-verification/request') {
        if (actor.isDeveloper) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'Email verification requires a real account.');
        const result = await identity.requestEmailVerification({ userId: actor.user.id });
        return sendJson(res, 202, { ...result, requestId });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/auth/sessions') {
        if (actor.isDeveloper) return sendJson(res, 200, { sessions: [], requestId });
        return sendJson(res, 200, { sessions: await identity.listSessions({ userId: actor.user.id, currentSessionId: actor.sessionId }), requestId });
      }
      const ownSessionMatch = url.pathname.match(/^\/api\/v1\/auth\/sessions\/([0-9a-f-]{36})$/i);
      if (req.method === 'DELETE' && ownSessionMatch) {
        if (actor.isDeveloper) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'Session management requires a real account.');
        const result = await identity.revokeSession({ userId: actor.user.id, sessionId: ownSessionMatch[1] });
        if (result.revoked && ownSessionMatch[1] === actor.sessionId) res.setHeader('set-cookie', [cookie('sf_session', '', { httpOnly: true, secure: secureCookies, maxAge: 0 }), cookie('sf_csrf', '', { secure: secureCookies, maxAge: 0 })]);
        return sendJson(res, 200, { ...result, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/mfa/enroll') {
        if (actor.isDeveloper) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'MFA enrollment requires a real account.');
        return sendJson(res, 200, { enrollment: await identity.beginMfaEnrollment({ userId: actor.user.id }), requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/mfa/confirm') {
        if (actor.isDeveloper) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'MFA enrollment requires a real account.');
        const body = await readJson(req, Math.min(maxBody, 16_384));
        return sendJson(res, 200, { ...await identity.confirmMfaEnrollment({ userId: actor.user.id, code: body.code }), requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/auth/mfa/disable') {
        if (actor.isDeveloper) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'MFA management requires a real account.');
        const body = await readJson(req, Math.min(maxBody, 16_384));
        const result = await identity.disableMfa({ userId: actor.user.id, password: body.password, code: body.code });
        res.setHeader('set-cookie', [cookie('sf_session', '', { httpOnly: true, secure: secureCookies, maxAge: 0 }), cookie('sf_csrf', '', { secure: secureCookies, maxAge: 0 })]);
        return sendJson(res, 200, { ...result, reauthenticationRequired: true, requestId });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/ai/status') return sendJson(res, 200, { ...ai.providerInfo(), capabilities: ['page-draft','content-assist','seo-suggestion','translation','document-validation','preview','widget-suggestion'], requiresHumanReviewForDraftPersistence: true, requestId });
      if (req.method === 'GET' && url.pathname === '/api/v1/widgets') return sendJson(res, 200, { apiVersion: 1, widgets: registry.list(), requestId });

      if (req.method === 'GET' && url.pathname === '/api/v1/sites') {
        if (actor.isDeveloper) return sendJson(res, 200, { sites: env.SYSTEMFABRIC_DEFAULT_SITE_ID ? [{ id: env.SYSTEMFABRIC_DEFAULT_SITE_ID, slug: 'local', name: 'Local Site', defaultLocale: 'en' }] : [], requestId });
        return sendJson(res, 200, { sites: await identity.listSites(actor.user.id), requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/sites') {
        if (actor.isDeveloper) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'Site creation requires an authenticated site owner.');
        const body = await readJson(req, Math.min(maxBody, 16_384));
        const site = await identity.createSite({ actorId: actor.user.id, slug: normalizeSlug(body.slug), name: body.name });
        await identity.audit({ siteId: site.id, actorId: actor.user.id, action: 'site.created', targetType: 'site', targetId: site.id, requestId });
        return sendJson(res, 201, { site, requestId });
      }

      const designSystemMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/design-system$/i);
      if (designSystemMatch && ['GET','PUT'].includes(req.method)) {
        if (!localPool) return sendJson(res, 503, { error: 'Design systems require PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = designSystemMatch[1]; await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'site:manage');
        if (req.method === 'GET') {
          const result = await localPool.query('SELECT version,tokens,updated_at FROM site_design_systems WHERE site_id=$1', [siteId]);
          return sendJson(res, 200, { designSystem: result.rows[0] || { version: 0, tokens: {} }, requestId });
        }
        const body = await readJson(req, Math.min(maxBody, 64_000)); const validation = validateDesignTokens(body.tokens || {});
        if (!validation.valid) throw fail(422, 'ERR_SYSTEMFABRIC_DESIGN_TOKENS_INVALID', 'Design tokens failed validation.', validation.errors);
        const client = await localPool.connect();
        try {
          await client.query('BEGIN');
          const current = await client.query('SELECT version FROM site_design_systems WHERE site_id=$1 FOR UPDATE', [siteId]);
          const version = current.rows[0]?.version || 0; const expected = body.expectedVersion === undefined ? version : Number(body.expectedVersion);
          if (!Number.isInteger(expected) || expected !== version) throw fail(409, 'ERR_SYSTEMFABRIC_VERSION_CONFLICT', 'The design system changed since it was loaded.', { expectedVersion: expected, currentVersion: version });
          const saved = await client.query(`INSERT INTO site_design_systems(site_id,version,tokens,updated_by,updated_at) VALUES($1,1,$2::jsonb,$3,now())
            ON CONFLICT(site_id) DO UPDATE SET version=site_design_systems.version+1,tokens=EXCLUDED.tokens,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING version,tokens,updated_at`, [siteId, JSON.stringify(body.tokens || {}), actor.user.id]);
          await client.query('COMMIT'); await identity?.audit({ siteId, actorId: actor.user.id, action: 'design_system.updated', targetType: 'design_system', requestId, details: { version: saved.rows[0].version } });
          return sendJson(res, 200, { designSystem: saved.rows[0], requestId });
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
      }

      const reusableCollectionMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/reusable-components$/i);
      const reusableItemMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/reusable-components\/([0-9a-f-]{36})$/i);
      if ((reusableCollectionMatch && ['GET','POST'].includes(req.method)) || (reusableItemMatch && ['PUT','DELETE'].includes(req.method))) {
        if (!localPool) return sendJson(res, 503, { error: 'Reusable components require PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = reusableCollectionMatch?.[1] || reusableItemMatch[1]; await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'content:edit');
        if (req.method === 'GET') {
          const result = await localPool.query('SELECT id,slug,name,version,document,created_at,updated_at FROM reusable_components WHERE site_id=$1 ORDER BY name', [siteId]);
          return sendJson(res, 200, { components: result.rows, requestId });
        }
        if (req.method === 'DELETE') {
          const deleted = await localPool.query('DELETE FROM reusable_components WHERE site_id=$1 AND id=$2 RETURNING id', [siteId, reusableItemMatch[2]]);
          if (!deleted.rows[0]) throw fail(404, 'ERR_SYSTEMFABRIC_COMPONENT_NOT_FOUND', 'Reusable component not found.');
          return sendJson(res, 200, { deleted: true, requestId });
        }
        const body = await readJson(req, Math.min(maxBody, 1_000_000)); const validation = validatePageDocument(body.document);
        if (!validation.valid) throw fail(422, 'ERR_SYSTEMFABRIC_INVALID_DOCUMENT', 'Reusable component document failed validation.', validation.errors);
        if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(String(body.slug || '')) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 180) throw fail(400, 'ERR_SYSTEMFABRIC_COMPONENT_METADATA_INVALID', 'A safe slug and component name are required.');
        if (req.method === 'POST') {
          const saved = await localPool.query('INSERT INTO reusable_components(site_id,slug,name,document,created_by,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$5) RETURNING id,slug,name,version,document,created_at,updated_at', [siteId, body.slug, body.name.trim(), JSON.stringify(body.document), actor.user.id]);
          return sendJson(res, 201, { component: saved.rows[0], requestId });
        }
        const expected = Number(body.expectedVersion);
        const saved = await localPool.query('UPDATE reusable_components SET slug=$3,name=$4,document=$5::jsonb,version=version+1,updated_by=$6,updated_at=now() WHERE site_id=$1 AND id=$2 AND version=$7 RETURNING id,slug,name,version,document,updated_at', [siteId, reusableItemMatch[2], body.slug, body.name.trim(), JSON.stringify(body.document), actor.user.id, expected]);
        if (!saved.rows[0]) throw fail(409, 'ERR_SYSTEMFABRIC_VERSION_CONFLICT', 'The reusable component changed or was removed since it was loaded.');
        return sendJson(res, 200, { component: saved.rows[0], requestId });
      }

      const templateCollectionMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/templates$/i);
      const templateItemMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/templates\/([0-9a-f-]{36})$/i);
      if ((templateCollectionMatch && ['GET','POST'].includes(req.method)) || (templateItemMatch && ['PUT','DELETE'].includes(req.method))) {
        if (!localPool) return sendJson(res, 503, { error: 'Site templates require PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = templateCollectionMatch?.[1] || templateItemMatch[1]; await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'site:manage');
        if (req.method === 'GET') { const result = await localPool.query('SELECT id,slug,name,template_type,version,active,document,created_at,updated_at FROM site_templates WHERE site_id=$1 ORDER BY template_type,name', [siteId]); return sendJson(res, 200, { templates: result.rows, requestId }); }
        if (req.method === 'DELETE') { const deleted = await localPool.query('DELETE FROM site_templates WHERE site_id=$1 AND id=$2 AND active=false RETURNING id', [siteId, templateItemMatch[2]]); if (!deleted.rows[0]) throw fail(409, 'ERR_SYSTEMFABRIC_TEMPLATE_ACTIVE_OR_MISSING', 'Only an inactive template can be deleted.'); return sendJson(res, 200, { deleted: true, requestId }); }
        const body = await readJson(req, Math.min(maxBody, 1_000_000)); const validation = validatePageDocument(body.document);
        if (!validation.valid) throw fail(422, 'ERR_SYSTEMFABRIC_INVALID_DOCUMENT', 'Template document failed validation.', validation.errors);
        if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(String(body.slug || '')) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 180 || !['single','archive','header','footer','404','search','page'].includes(body.templateType)) throw fail(400, 'ERR_SYSTEMFABRIC_TEMPLATE_METADATA_INVALID', 'Template slug, name, or type is invalid.');
        const client = await localPool.connect();
        try {
          await client.query('BEGIN');
          let result;
          if (req.method === 'POST') {
            result = await client.query('INSERT INTO site_templates(site_id,slug,name,template_type,document,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5::jsonb,false,$6,$6) RETURNING id,slug,name,template_type,version,active,document,updated_at', [siteId, body.slug, body.name.trim(), body.templateType, JSON.stringify(body.document), actor.user.id]);
          } else {
            const current = await client.query('SELECT template_type,version FROM site_templates WHERE site_id=$1 AND id=$2 FOR UPDATE', [siteId, templateItemMatch[2]]);
            if (!current.rows[0] || Number(body.expectedVersion) !== current.rows[0].version) throw fail(409, 'ERR_SYSTEMFABRIC_VERSION_CONFLICT', 'The template changed or was removed since it was loaded.');
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
        if (!localPool) throw fail(503, 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', 'Taxonomy management requires PostgreSQL.');
        const siteId = termsCollectionMatch?.[1] || termItemMatch[1];
        await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'content:edit');
        if (req.method === 'GET') {
          const taxonomy = url.searchParams.get('taxonomy');
          if (taxonomy && !/^[a-z][a-z0-9_-]{0,62}$/.test(taxonomy)) throw fail(400, 'ERR_SYSTEMFABRIC_TAXONOMY_INVALID', 'taxonomy must be a lowercase identifier.');
          const values = taxonomy ? [siteId, taxonomy] : [siteId];
          const result = await localPool.query(`SELECT id,site_id,taxonomy,slug,label,version,metadata,created_at,updated_at FROM taxonomy_terms WHERE site_id=$1 AND deleted_at IS NULL ${taxonomy ? 'AND taxonomy=$2' : ''} ORDER BY taxonomy,label LIMIT 500`, values);
          return sendJson(res, 200, { terms: result.rows, requestId });
        }
        if (req.method === 'POST') {
          const body = await readJson(req, Math.min(maxBody, 64_000));
          const taxonomy = String(body.taxonomy || 'category').toLowerCase();
          const slug = normalizeSlug(body.slug || body.label);
          if (!/^[a-z][a-z0-9_-]{0,62}$/.test(taxonomy) || !slug || slug.length > 180 || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 180) throw fail(400, 'ERR_SYSTEMFABRIC_TAXONOMY_INVALID', 'taxonomy, slug and label are required and must be valid.');
          const metadata = body.metadata === undefined ? {} : body.metadata;
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 16_000) throw fail(400, 'ERR_SYSTEMFABRIC_TAXONOMY_METADATA_INVALID', 'metadata must be a JSON object up to 16 KB.');
          const client = await localPool.connect();
          try {
            await client.query('BEGIN');
            const result = await client.query('INSERT INTO taxonomy_terms(site_id,taxonomy,slug,label,metadata) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,site_id,taxonomy,slug,label,version,metadata', [siteId, taxonomy, slug, body.label.trim(), JSON.stringify(metadata)]);
            const term = result.rows[0];
            await client.query(`INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('taxonomy-term',$1,$2,'taxonomy.upsert',$3::jsonb) ON CONFLICT(aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`, [term.id, term.version, JSON.stringify({ id: term.id, siteId: term.site_id, taxonomy: term.taxonomy, slug: term.slug, label: term.label, metadata: term.metadata, version: term.version, status: 'active' })]);
            await client.query('COMMIT');
            if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'taxonomy.created', targetType: 'taxonomy-term', targetId: term.id, requestId, details: { taxonomy, slug } });
            return sendJson(res, 201, { term, requestId });
          } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') throw fail(409, 'ERR_SYSTEMFABRIC_TAXONOMY_CONFLICT', 'A term with this slug already exists in the taxonomy.'); throw error; }
          finally { client.release(); }
        }
        const termId = termItemMatch[2];
        const client = await localPool.connect();
        try {
          await client.query('BEGIN');
          const selected = await client.query('SELECT id,site_id,taxonomy,slug,label,version,metadata FROM taxonomy_terms WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [siteId, termId]);
          const existing = selected.rows[0];
          if (!existing) throw fail(404, 'ERR_SYSTEMFABRIC_TAXONOMY_TERM_NOT_FOUND', 'Taxonomy term not found.');
          if (req.method === 'PUT') {
            const body = await readJson(req, Math.min(maxBody, 64_000));
            if (!Number.isInteger(Number(body.expectedVersion)) || Number(body.expectedVersion) !== existing.version) throw fail(409, 'ERR_SYSTEMFABRIC_VERSION_CONFLICT', 'Taxonomy term changed since it was loaded. Reload before retrying.');
            const label = body.label === undefined ? existing.label : body.label;
            const slug = body.slug === undefined ? existing.slug : normalizeSlug(body.slug);
            const metadata = body.metadata === undefined ? existing.metadata : body.metadata;
            if (typeof label !== 'string' || !label.trim() || label.length > 180 || !slug || slug.length > 180 || !metadata || typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 16_000) throw fail(400, 'ERR_SYSTEMFABRIC_TAXONOMY_INVALID', 'Term label, slug or metadata is invalid.');
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
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') throw fail(409, 'ERR_SYSTEMFABRIC_TAXONOMY_CONFLICT', 'A term with this slug already exists.'); throw error; }
        finally { client.release(); }
      }

      const relationshipsCollectionMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/relationships$/i);
      const relationshipItemMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/relationships\/([0-9a-f-]{36})$/i);
      if ((relationshipsCollectionMatch && ['GET', 'POST'].includes(req.method)) || (relationshipItemMatch && req.method === 'DELETE')) {
        if (!localPool) throw fail(503, 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', 'Relationship management requires PostgreSQL.');
        const siteId = relationshipsCollectionMatch?.[1] || relationshipItemMatch[1];
        await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'content:edit');
        if (req.method === 'GET') {
          const result = await localPool.query('SELECT id,source_id,target_id,kind,metadata,version,created_at,deleted_at FROM content_relationships WHERE site_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 500', [siteId]);
          return sendJson(res, 200, { relationships: result.rows, requestId });
        }
        if (req.method === 'POST') {
          const body = await readJson(req, Math.min(maxBody, 32_000));
          if (!ID_RE.test(String(body.sourceId || '')) || !ID_RE.test(String(body.targetId || '')) || body.sourceId === body.targetId || !['HAS_TERM','PARENT_OF','RELATED_TO','LOCALIZED_AS','NAVIGATES_TO'].includes(body.kind)) throw fail(400, 'ERR_SYSTEMFABRIC_RELATIONSHIP_INVALID', 'sourceId, targetId and an approved relationship kind are required.');
          const client = await localPool.connect();
          try {
            await client.query('BEGIN');
            const src = await client.query(`SELECT id,'content'::text AS node_type FROM content_items WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL UNION ALL SELECT id,'term'::text AS node_type FROM taxonomy_terms WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL LIMIT 1`, [siteId, body.sourceId]);
            const dst = await client.query(`SELECT id,'content'::text AS node_type FROM content_items WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL UNION ALL SELECT id,'term'::text AS node_type FROM taxonomy_terms WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL LIMIT 1`, [siteId, body.targetId]);
            if (!src.rows[0] || !dst.rows[0]) throw fail(404, 'ERR_SYSTEMFABRIC_RELATIONSHIP_ENDPOINT_NOT_FOUND', 'Both relationship endpoints must exist in the selected site.');
            const sourceType = src.rows[0].node_type; const targetType = dst.rows[0].node_type;
            if (body.kind === 'HAS_TERM' && (sourceType !== 'content' || targetType !== 'term')) throw fail(422, 'ERR_SYSTEMFABRIC_RELATIONSHIP_TYPE', 'HAS_TERM must connect content to a taxonomy term.');
            if (body.kind === 'PARENT_OF' && sourceType !== targetType) throw fail(422, 'ERR_SYSTEMFABRIC_RELATIONSHIP_TYPE', 'PARENT_OF endpoints must both be content or both be taxonomy terms.');
            if (!['HAS_TERM','PARENT_OF'].includes(body.kind) && (sourceType !== 'content' || targetType !== 'content')) throw fail(422, 'ERR_SYSTEMFABRIC_RELATIONSHIP_TYPE', 'This relation kind must connect content records.');
            const metadata = body.metadata === undefined ? {} : body.metadata;
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 16_000) throw fail(400, 'ERR_SYSTEMFABRIC_RELATIONSHIP_METADATA', 'metadata must be a JSON object up to 16 KB.');
            const inserted = await client.query('INSERT INTO content_relationships(site_id,source_id,target_id,kind,metadata) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,site_id,source_id,target_id,kind,metadata,version,created_at', [siteId, body.sourceId, body.targetId, body.kind, JSON.stringify(metadata)]);
            const rel = inserted.rows[0];
            await client.query(`INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES('relationship',$1,$2,'relationship.upsert',$3::jsonb) ON CONFLICT(aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`, [rel.id, rel.version, JSON.stringify({ relationshipId: rel.id, siteId, sourceId: rel.source_id, targetId: rel.target_id, sourceType, targetType, kind: rel.kind, version: rel.version })]);
            await client.query('COMMIT');
            if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'relationship.created', targetType: 'relationship', targetId: rel.id, requestId, details: { kind: rel.kind } });
            return sendJson(res, 201, { relationship: rel, requestId });
          } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') throw fail(409, 'ERR_SYSTEMFABRIC_RELATIONSHIP_EXISTS', 'This relationship already exists.'); throw error; }
          finally { client.release(); }
        }
        const relationshipId = relationshipItemMatch[2]; const client = await localPool.connect();
        try {
          await client.query('BEGIN');
          const found = await client.query('SELECT * FROM content_relationships WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [siteId, relationshipId]);
          const rel = found.rows[0]; if (!rel) throw fail(404, 'ERR_SYSTEMFABRIC_RELATIONSHIP_NOT_FOUND', 'Relationship not found.');
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
        if (!localPool) return sendJson(res, 503, { error: 'Navigation menus require PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = menuCollectionMatch?.[1] || menuItemMatch[1]; await requireCapability(actor, siteId, req.method === 'GET' ? 'content:read' : 'site:manage');
        if (req.method === 'GET') { const result = await localPool.query('SELECT id,slug,name,version,items,presentation,created_at,updated_at FROM navigation_menus WHERE site_id=$1 ORDER BY name', [siteId]); return sendJson(res, 200, { menus: result.rows, requestId }); }
        if (req.method === 'DELETE') { const deleted = await localPool.query('DELETE FROM navigation_menus WHERE site_id=$1 AND slug=$2 RETURNING slug', [siteId, menuItemMatch[2]]); if (!deleted.rows[0]) throw fail(404, 'ERR_SYSTEMFABRIC_MENU_NOT_FOUND', 'Navigation menu not found.'); return sendJson(res, 200, { deleted: true, requestId }); }
        const body = await readJson(req, Math.min(maxBody, 256_000)); const validation = validateMenuItems(body.items || []);
        if (!validation.valid) throw fail(422, 'ERR_SYSTEMFABRIC_MENU_INVALID', 'Navigation menu failed validation.', validation.errors);
        if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(String(body.slug || '')) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 180) throw fail(400, 'ERR_SYSTEMFABRIC_MENU_METADATA_INVALID', 'Menu slug and name are required.');
        const presentation = body.presentation === undefined ? {} : body.presentation;
        if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation) || Buffer.byteLength(JSON.stringify(presentation)) > 16_384) throw fail(400, 'ERR_SYSTEMFABRIC_MENU_PRESENTATION_INVALID', 'presentation must be a small JSON object.');
        const expected = req.method === 'PUT' ? Number(body.expectedVersion) : null;
        const saved = req.method === 'POST'
          ? await localPool.query('INSERT INTO navigation_menus(site_id,slug,name,items,presentation,updated_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6) RETURNING id,slug,name,version,items,presentation,updated_at', [siteId, body.slug, body.name.trim(), JSON.stringify(body.items || []), JSON.stringify(presentation), actor.user.id])
          : await localPool.query('UPDATE navigation_menus SET name=$3,items=$4::jsonb,presentation=$5::jsonb,version=version+1,updated_by=$6,updated_at=now() WHERE site_id=$1 AND slug=$2 AND version=$7 RETURNING id,slug,name,version,items,presentation,updated_at', [siteId, menuItemMatch[2], body.name.trim(), JSON.stringify(body.items || []), JSON.stringify(presentation), actor.user.id, expected]);
        if (!saved.rows[0]) throw fail(req.method === 'POST' ? 409 : 409, 'ERR_SYSTEMFABRIC_VERSION_CONFLICT', 'Menu already exists or changed since it was loaded.');
        return sendJson(res, req.method === 'POST' ? 201 : 200, { menu: saved.rows[0], requestId });
      }

      const aiPolicyMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/ai-policy$/i);
      if (aiPolicyMatch && ['GET','PUT'].includes(req.method)) {
        if (!localPool) throw fail(503, 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', 'AI governance configuration requires PostgreSQL.');
        const siteId = aiPolicyMatch[1]; await requireCapability(actor, siteId, 'site:manage');
        if (req.method === 'GET') {
          const policy = await getSiteAIPolicy(siteId);
          return sendJson(res, 200, { policy, availableProviders: [...AI_PROVIDERS], classificationLevels: Object.keys(DATA_CLASSIFICATION_RANK), requestId });
        }
        const body = await readJson(req, Math.min(maxBody, 32_000));
        const allowedProviders = body.allowedProviders;
        if (!Array.isArray(allowedProviders) || allowedProviders.length < 1 || allowedProviders.length > AI_PROVIDERS.size || allowedProviders.some(provider => typeof provider !== 'string' || !AI_PROVIDERS.has(provider)) || new Set(allowedProviders).size !== allowedProviders.length) throw fail(400, 'ERR_SYSTEMFABRIC_AI_POLICY_INVALID', 'allowedProviders must contain unique supported provider names.');
        if (typeof body.enabled !== 'boolean' || typeof body.allowExternalContent !== 'boolean' || !Object.hasOwn(DATA_CLASSIFICATION_RANK, body.maxDataClassification)) throw fail(400, 'ERR_SYSTEMFABRIC_AI_POLICY_INVALID', 'enabled, allowExternalContent and maxDataClassification are required.');
        if (body.requireHumanReview !== undefined && body.requireHumanReview !== true) throw fail(400, 'ERR_SYSTEMFABRIC_AI_REVIEW_REQUIRED', 'Human review is mandatory for AI-generated content.');
        const dailyRequests = Number(body.dailyRequestLimit); const dailyChars = Number(body.dailyInputCharsLimit);
        if (!Number.isInteger(dailyRequests) || dailyRequests < 1 || dailyRequests > 100_000 || !Number.isInteger(dailyChars) || dailyChars < 1000 || dailyChars > 100_000_000) throw fail(400, 'ERR_SYSTEMFABRIC_AI_POLICY_INVALID', 'dailyRequestLimit must be 1–100000 and dailyInputCharsLimit must be 1000–100000000.');
        if (body.allowExternalContent && env.AI_ALLOW_EXTERNAL_CONTENT !== 'true') throw fail(409, 'ERR_SYSTEMFABRIC_AI_EXTERNAL_APPROVAL_REQUIRED', 'Set AI_ALLOW_EXTERNAL_CONTENT=true in deployment configuration before enabling external content processing for a site.');
        const globalAllow = new Set(String(env.AI_ALLOWED_PROVIDERS || 'mock').split(',').map(item => item.trim()).filter(Boolean));
        if (allowedProviders.some(provider => !globalAllow.has(provider))) throw fail(409, 'ERR_SYSTEMFABRIC_AI_PROVIDER_GLOBAL_POLICY', 'A site policy cannot grant a provider that the global deployment allowlist excludes.');
        const updated = await localPool.query(`INSERT INTO site_ai_policies(site_id,enabled,allow_external_content,allowed_providers,max_data_classification,daily_request_limit,daily_input_chars_limit,require_human_review,updated_by,updated_at)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,true,$8,now())
          ON CONFLICT(site_id) DO UPDATE SET enabled=EXCLUDED.enabled,allow_external_content=EXCLUDED.allow_external_content,allowed_providers=EXCLUDED.allowed_providers,max_data_classification=EXCLUDED.max_data_classification,daily_request_limit=EXCLUDED.daily_request_limit,daily_input_chars_limit=EXCLUDED.daily_input_chars_limit,require_human_review=true,updated_by=EXCLUDED.updated_by,updated_at=now()
          RETURNING site_id,enabled,allow_external_content,allowed_providers,max_data_classification,daily_request_limit,daily_input_chars_limit,require_human_review,updated_by,updated_at`, [siteId, body.enabled, body.allowExternalContent, JSON.stringify(allowedProviders), body.maxDataClassification, dailyRequests, dailyChars, actor.user.id || null]);
        if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'ai.policy_updated', targetType: 'ai-policy', requestId, details: { enabled: body.enabled, allowedProviders, maxDataClassification: body.maxDataClassification } });
        return sendJson(res, 200, { policy: updated.rows[0], requestId });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/ai/page-draft') {
        const body = await readJson(req, maxBody); const siteId = await ensureSiteCapabilityForAI(actor, url, body, 'ai:use');
        const result = await runGovernedAI({ actor, siteId, body, action: 'page_draft', inputChars: String(body.prompt || '').length + String(body.siteContext || '').length, requestId, run: () => ai.generatePageDraft({ prompt: body.prompt, siteContext: body.siteContext || '', actor: actor.user.id || 'local-development-token' }) });
        return sendJson(res, 200, { ...result, requestId, humanReviewRequired: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/ai/content-assist') {
        const body = await readJson(req, maxBody); const siteId = await ensureSiteCapabilityForAI(actor, url, body, 'ai:use');
        const result = await runGovernedAI({ actor, siteId, body, action: 'content_assist', inputChars: String(body.text || '').length, requestId, run: () => ai.assistContent({ text: body.text, operation: body.operation || 'make-clearer', tone: body.tone || 'clear and professional', actor: actor.user.id || 'local-development-token' }) });
        return sendJson(res, 200, { ...result, requestId, humanReviewRequired: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/ai/seo') {
        const body = await readJson(req, maxBody); const siteId = await ensureSiteCapabilityForAI(actor, url, body, 'ai:use');
        const result = await runGovernedAI({ actor, siteId, body, action: 'seo', inputChars: String(body.title || '').length + String(body.content || '').length, requestId, run: () => ai.generateSeo({ title: body.title, content: body.content, actor: actor.user.id || 'local-development-token' }) });
        return sendJson(res, 200, { ...result, requestId, humanReviewRequired: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/ai/translate') {
        const body = await readJson(req, maxBody); const siteId = await ensureSiteCapabilityForAI(actor, url, body, 'ai:use');
        const result = await runGovernedAI({ actor, siteId, body, action: 'translate', inputChars: String(body.text || '').length, requestId, run: () => ai.translate({ text: body.text, targetLanguage: body.targetLanguage, actor: actor.user.id || 'local-development-token' }) });
        return sendJson(res, 200, { ...result, requestId, humanReviewRequired: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/pages/validate') {
        const body = await readJson(req, maxBody); const validation = validatePageDocument(body.document);
        return sendJson(res, validation.valid ? 200 : 422, { ...validation, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/preview') {
        const body = await readJson(req, maxBody); const html = renderPageDocument(body.document);
        return sendHtml(res, 200, html, htmlCspPreview());
      }

      // Developer-managed and dashboard-managed content types resolve into one validated registry.
      if (req.method === 'GET' && url.pathname === '/api/v1/content-types') {
        if (!localPool) return sendJson(res, 503, { error: 'Content type registry requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor }); if (!(await hasContentRead(actor, siteId))) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'Content read permission is required.');
        const git = gitContentTypeDefinitions(); const db = await localPool.query('SELECT slug,label,version,definition,source,updated_at FROM content_type_definitions WHERE site_id=$1 AND active=true ORDER BY slug,version DESC', [siteId]);
        const gitNames = new Set(git.map(item => item.name));
        const admin = db.rows.filter(row => !gitNames.has(row.slug)).map(row => ({ ...row.definition, source: row.source, updatedAt: row.updated_at }));
        const conflicts = db.rows.filter(row => gitNames.has(row.slug)).map(row => row.slug);
        return sendJson(res, 200, { definitions: [...git, ...admin], conflicts: [...new Set(conflicts)], precedence: 'Git-managed definitions are authoritative; name conflicts are rejected.', requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/content-types') {
        if (!localPool) return sendJson(res, 503, { error: 'Content type registry requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const body = await readJson(req, Math.min(maxBody, 256_000)); const siteId = await siteIdFor({ req, url, body, actor }); await requireCapability(actor, siteId, 'site:manage');
        const definition = { ...body.definition, source: 'admin', apiVersion: 1 }; const validation = validateContentTypeDefinition(definition);
        if (!validation.valid) throw fail(422, 'ERR_SYSTEMFABRIC_CONTENT_TYPE_INVALID', 'Content type definition failed validation.', validation.errors);
        if (gitContentTypeDefinitions().some(item => item.name === definition.name)) throw fail(409, 'ERR_SYSTEMFABRIC_CONTENT_TYPE_CONFLICT', 'A Git-managed definition already owns this slug. Rename one definition rather than silently overriding it.');
        const client = await localPool.connect();
        let row; try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [siteId, definition.name]); const old = await client.query('SELECT COALESCE(max(version),0)::integer AS version FROM content_type_definitions WHERE site_id=$1 AND slug=$2', [siteId, definition.name]); definition.version = old.rows[0].version + 1;
          await client.query('UPDATE content_type_definitions SET active=false,updated_at=now() WHERE site_id=$1 AND slug=$2 AND active=true', [siteId, definition.name]);
          const result = await client.query(`INSERT INTO content_type_definitions(site_id,slug,label,version,source,active,definition) VALUES($1,$2,$3,$4,'admin',true,$5::jsonb) RETURNING id,slug,label,version,source,active`, [siteId, definition.name, definition.label, definition.version, JSON.stringify(definition)]); row = result.rows[0]; await client.query('COMMIT');
        } catch(error) { await client.query('ROLLBACK').catch(()=>{}); throw error; } finally { client.release(); }
        return sendJson(res, 201, { definition: { ...definition, id: row.id }, requestId });
      }
      const cptRecordsMatch = url.pathname.match(/^\/api\/v1\/content-types\/([a-z][a-z0-9_-]{0,62})\/records$/i);
      if ((req.method === 'GET' || req.method === 'POST') && cptRecordsMatch) {
        if (!store) return sendJson(res, 503, { error: 'Content storage requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const slug = cptRecordsMatch[1]; let body = {}; if (req.method === 'POST') body = await readJson(req, maxBody);
        const siteId = await siteIdFor({ req, url, body, actor }); const definition = await getContentTypeDefinition(siteId, slug);
        if (!definition) return sendJson(res, 404, { error: 'Content type not found.', code: 'ERR_SYSTEMFABRIC_CONTENT_TYPE_NOT_FOUND', requestId });
        if (req.method === 'GET') { if (!(await hasContentRead(actor, siteId))) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'Content read permission is required.'); return sendJson(res, 200, { items: await store.listContent({ siteId, contentType: slug, status: url.searchParams.get('status'), limit: url.searchParams.get('limit') || 50, offset: url.searchParams.get('offset') || 0 }), requestId }); }
        await requireCapability(actor, siteId, 'content:create'); const validation = validateRecordValues(definition, body.values); if (!validation.valid) throw fail(422, 'ERR_SYSTEMFABRIC_CONTENT_VALUES_INVALID', 'Record values failed schema validation.', validation.errors);
        const title = String(body.title || body.values.title || body.values.name || slug).slice(0, 500); const recordSlug = normalizeSlug(body.slug || title); if (!recordSlug) throw fail(400, 'ERR_SYSTEMFABRIC_INVALID_SLUG', 'A valid record slug is required.');
        const record = { schemaVersion: 1, documentType: `custom:${slug}`, fields: body.values };
        const saved = await store.saveDraft({ siteId, title, slug: recordSlug, locale: typeof body.locale === 'string' ? body.locale : 'en', contentType: slug, document: record, authorId: actor.user.id, correlationId: requestId });
        return sendJson(res, 201, { status: 'draft', record: saved, requestId });
      }
      const cptRecordMatch = url.pathname.match(/^\/api\/v1\/content-types\/([a-z][a-z0-9_-]{0,62})\/records\/([0-9a-f-]{36})$/i);
      if (req.method === 'GET' && cptRecordMatch) {
        if (!store) return sendJson(res, 503, { error: 'Content storage requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor }); const definition = await getContentTypeDefinition(siteId, cptRecordMatch[1]);
        if (!definition) return sendJson(res, 404, { error: 'Content type not found.', requestId });
        if (!(await hasContentRead(actor, siteId))) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'Content read permission is required.');
        const record = await store.getById({ siteId, id: cptRecordMatch[2] }); if (!record || record.content_type !== cptRecordMatch[1]) return sendJson(res, 404, { error: 'Record not found.', requestId });
        return sendJson(res, 200, { record, definition, requestId });
      }

      // Asset uploads are image-only, MIME-sniffed, path-safe, and stored outside the web root.
      if (req.method === 'GET' && url.pathname === '/api/v1/media') {
        if (!mediaStore) return sendJson(res, 503, { error: 'Media storage requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor }); await requireCapability(actor, siteId, 'media:manage');
        return sendJson(res, 200, { assets: await mediaStore.list({ siteId, limit: url.searchParams.get('limit') || 50 }), requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/media/uploads') {
        if (!mediaStore) return sendJson(res, 503, { error: 'Media storage requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const body = await readJson(req, maxMediaBody); const siteId = await siteIdFor({ req, url, body, actor }); await requireCapability(actor, siteId, 'media:manage');
        const asset = await mediaStore.upload({ siteId, actorId: actor.user.id, dataBase64: body.dataBase64, mimeType: body.mimeType, altText: body.altText || '', isPublic: body.public !== false });
        if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'media.uploaded', targetType: 'media', targetId: asset.id, requestId, details: { mimeType: asset.mime_type, byteSize: asset.byte_size } });
        return sendJson(res, 201, { asset, url: mediaStore.publicUrl ? mediaStore.publicUrl(asset) : `/media/${asset.id}`, requestId });
      }

      // All data and workflow operations are scoped to an explicit site membership.
      if (req.method === 'GET' && url.pathname === '/api/v1/pages') {
        if (!store) return sendJson(res, 503, { error: 'PostgreSQL is not configured.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor });
        let capability = await identity?.authorizeSite(actor.user.id, siteId, 'content:read');
        if (!actor.isDeveloper && !capability && !(await identity.authorizeSite(actor.user.id, siteId, 'content:read:own'))) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'Content read permission is required.');
        const ownOnly = !actor.isDeveloper && !capability;
        return sendJson(res, 200, { items: await store.listContent({ siteId, status: url.searchParams.get('status'), contentType: 'page', limit: url.searchParams.get('limit') || 50, offset: url.searchParams.get('offset') || 0, actorId: ownOnly ? actor.user.id : null }), requestId });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/pages/drafts') {
        if (!store) return sendJson(res, 503, { error: 'PostgreSQL is not configured.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor }); await requireCapability(actor, siteId, 'content:read');
        return sendJson(res, 200, { drafts: await store.listContent({ siteId, status: 'draft', contentType: 'page', limit: url.searchParams.get('limit') || 50 }), requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/pages/drafts') {
        if (!store) return sendJson(res, 503, { error: 'PostgreSQL is not configured; draft persistence is disabled.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const body = await readJson(req, maxBody); const safe = validateSaveDraftBody(body); const siteId = await siteIdFor({ req, url, body: safe, actor });
        if (safe.id) { const current = await store.getById({ siteId, id: safe.id }); await canEditContent(actor, siteId, current); }
        else await requireCapability(actor, siteId, 'content:create');
        const saved = await store.saveDraft({ siteId, id: safe.id, title: safe.document.title, slug: safe.slug, locale: safe.locale, contentType: 'page', document: safe.document, authorId: actor.user.id, expectedVersion: safe.expectedVersion, note: safe.note, correlationId: requestId });
        if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: 'content.draft_saved', targetType: 'content', targetId: saved.id, requestId, details: { version: saved.version } });
        return sendJson(res, 201, { status: 'draft', persisted: true, published: Boolean(saved.published_version), content: saved, requestId });
      }

      const pageIdMatch = url.pathname.match(/^\/api\/v1\/pages\/([0-9a-f-]{36})$/i);
      if (req.method === 'GET' && pageIdMatch) {
        if (!store) return sendJson(res, 503, { error: 'PostgreSQL is not configured.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor });
        if (!(await identity?.authorizeSite(actor.user.id, siteId, 'content:read')) && !actor.isDeveloper) {
          const current = await store.getById({ siteId, id: pageIdMatch[1] });
          if (!current || current.created_by !== actor.user.id || !(await identity.authorizeSite(actor.user.id, siteId, 'content:read:own'))) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'Content read permission is required.');
          return sendJson(res, 200, { content: current, requestId });
        }
        const content = await store.getById({ siteId, id: pageIdMatch[1] });
        if (!content) return sendJson(res, 404, { error: 'Content not found.', code: 'ERR_SYSTEMFABRIC_CONTENT_NOT_FOUND', requestId });
        return sendJson(res, 200, { content, requestId });
      }

      const revisionsMatch = url.pathname.match(/^\/api\/v1\/pages\/([0-9a-f-]{36})\/revisions$/i);
      if (req.method === 'GET' && revisionsMatch) {
        const siteId = await siteIdFor({ req, url, actor });
        if (!(await hasContentRead(actor, siteId))) throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'Content read permission is required.');
        const current = await store.getById({ siteId, id: revisionsMatch[1] });
        if (!current) return sendJson(res, 404, { error: 'Content not found.', code: 'ERR_SYSTEMFABRIC_CONTENT_NOT_FOUND', requestId });
        if (!actor.isDeveloper && !(await identity.authorizeSite(actor.user.id, siteId, 'content:read')) && current.created_by !== actor.user.id) {
          throw fail(403, 'ERR_SYSTEMFABRIC_FORBIDDEN', 'You cannot read revisions for this content.');
        }
        return sendJson(res, 200, { revisions: await store.listRevisions({ siteId, contentId: revisionsMatch[1] }), requestId });
      }
      const restoreMatch = url.pathname.match(/^\/api\/v1\/pages\/([0-9a-f-]{36})\/restore\/(\d+)$/i);
      if (req.method === 'POST' && restoreMatch) {
        const body = await readJson(req, maxBody); const siteId = await siteIdFor({ req, url, body, actor });
        const current = await store.getById({ siteId, id: restoreMatch[1] }); await canEditContent(actor, siteId, current);
        const revision = await store.getRevision({ siteId, contentId: restoreMatch[1], version: Number(restoreMatch[2]) });
        if (!revision) return sendJson(res, 404, { error: 'Revision not found.', code: 'ERR_SYSTEMFABRIC_REVISION_NOT_FOUND', requestId });
        const snap = revision.snapshot;
        const saved = await store.saveDraft({ siteId, id: restoreMatch[1], title: snap.title, slug: snap.slug, locale: snap.locale, contentType: snap.contentType || 'page', document: snap.document, authorId: actor.user.id, expectedVersion: body.expectedVersion, note: `Restored revision ${revision.version}`, correlationId: requestId });
        return sendJson(res, 200, { status: 'draft', restoredFromVersion: revision.version, content: saved, requestId });
      }

      const workflowMatch = url.pathname.match(/^\/api\/v1\/(?:pages|content)\/([0-9a-f-]{36})\/(submit-review|approve|reject|publish|schedule|archive|unpublish)$/i);
      if (req.method === 'POST' && workflowMatch) {
        if (!store) return sendJson(res, 503, { error: 'PostgreSQL is not configured.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
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

      // Site members and short-lived invitation workflow.
      const membersMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/members$/i);
      if (req.method === 'GET' && membersMatch) {
        const siteId = membersMatch[1]; await requireCapability(actor, siteId, 'site:manage');
        return sendJson(res, 200, { members: await identity.listMembers({ siteId }), requestId });
      }
      if (req.method === 'POST' && membersMatch) {
        const body = await readJson(req, Math.min(maxBody, 16_384)); const siteId = membersMatch[1]; await requireCapability(actor, siteId, 'site:manage');
        const member = await identity.addMember({ siteId, email: body.email, roleSlug: body.role });
        await identity.audit({ siteId, actorId: actor.user.id, action: 'site.member_added', targetType: 'user', targetId: member.id, requestId, details: { role: body.role } });
        return sendJson(res, 201, { member, requestId });
      }
      const memberMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})$/i);
      if (req.method === 'DELETE' && memberMatch) {
        const [, siteId, userId] = memberMatch; await requireCapability(actor, siteId, 'site:manage'); await identity.removeMember({ siteId, userId });
        await identity.audit({ siteId, actorId: actor.user.id, action: 'site.member_removed', targetType: 'user', targetId: userId, requestId });
        return sendJson(res, 200, { removed: true, requestId });
      }
      const inviteMatch = url.pathname.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/invitations$/i);
      if (req.method === 'POST' && inviteMatch) {
        const body = await readJson(req, Math.min(maxBody, 16_384)); const siteId = inviteMatch[1]; await requireCapability(actor, siteId, 'site:manage');
        const invitation = await identity.createInvitation({ siteId, email: body.email, roleSlug: body.role, invitedBy: actor.user.id });
        await identity.audit({ siteId, actorId: actor.user.id, action: 'site.invitation_created', targetType: 'invitation', requestId, details: { email: invitation.email, role: invitation.role } });
        return sendJson(res, 201, { invitation, note: 'Deliver the one-time invitation token through a trusted channel; do not write it to ordinary logs.', requestId });
      }

      // Plugin registry. Activation requires admin approval plus an immutable OCI image digest.
      if (req.method === 'GET' && url.pathname === '/api/v1/plugins') {
        if (!localPool) return sendJson(res, 503, { error: 'Plugin registry requires PostgreSQL.', code: 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', requestId });
        const siteId = await siteIdFor({ req, url, actor }); await requireCapability(actor, siteId, 'plugins:read');
        const result = await localPool.query('SELECT id,name,version,api_version,status,source_type,package_sha256,image_digest,artifact_digest,sbom_reference,provenance,signature_verified,security_reviewed_at,security_reviewed_by,manifest,requested_capabilities,approved_capabilities,created_at,updated_at FROM plugin_installs WHERE site_id=$1 ORDER BY name', [siteId]);
        return sendJson(res, 200, { plugins: result.rows, requestId });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/plugins/register') {
        const body = await readJson(req, Math.min(maxBody, 256_000)); const siteId = await siteIdFor({ req, url, body, actor }); await requireCapability(actor, siteId, 'plugins:manage');
        const validation = validatePluginManifest(body.manifest);
        if (!validation.valid) throw fail(422, 'ERR_SYSTEMFABRIC_PLUGIN_MANIFEST_INVALID', 'Plugin manifest failed validation.', validation.errors);
        if (!['npm-archive','oci-image'].includes(body.sourceType)) throw fail(400, 'ERR_SYSTEMFABRIC_PLUGIN_SOURCE_INVALID', 'sourceType must be npm-archive or oci-image.');
        if (body.sourceType === 'oci-image' && !validatePinnedImageDigest(body.imageDigest)) throw fail(400, 'ERR_SYSTEMFABRIC_PLUGIN_IMAGE_NOT_PINNED', 'OCI image must be pinned by SHA-256 digest.');
        if (body.sourceType === 'npm-archive' && !/^[a-f0-9]{64}$/i.test(body.packageSha256 || '')) throw fail(400, 'ERR_SYSTEMFABRIC_PLUGIN_HASH_REQUIRED', 'npm-archive registration requires a SHA-256 package hash.');
        const artifactDigest = body.sourceType === 'npm-archive' ? String(body.packageSha256).toLowerCase() : digestForArtifact(body.imageDigest);
        const trustedKeys = trustedKeysFromEnv(env.SYSTEMFABRIC_PLUGIN_TRUSTED_PUBLIC_KEYS);
        let signatureResult = { valid: false, reason: 'ERR_SYSTEMFABRIC_PLUGIN_SIGNATURE_MISSING_OR_INVALID' };
        if (body.signature !== undefined || body.keyId !== undefined) {
          signatureResult = verifyPluginArtifactSignature({ manifest: body.manifest, artifactDigest, sbomDigest: body.sbomDigest, sourceType: body.sourceType, keyId: body.keyId, signature: body.signature, trustedKeys });
          if (!signatureResult.valid) throw fail(422, signatureResult.reason || 'ERR_SYSTEMFABRIC_PLUGIN_SIGNATURE_INVALID', 'Plugin artifact signature is invalid or its signing key is not trusted.');
        }
        if (body.provenance !== undefined && (!body.provenance || typeof body.provenance !== 'object' || Array.isArray(body.provenance) || JSON.stringify(body.provenance).length > 32_000)) throw fail(400, 'ERR_SYSTEMFABRIC_PLUGIN_PROVENANCE_INVALID', 'provenance must be a JSON object up to 32 KB.');
        if (body.sbomReference !== undefined && (typeof body.sbomReference !== 'string' || body.sbomReference.length > 2048 || /[\r\n]/.test(body.sbomReference))) throw fail(400, 'ERR_SYSTEMFABRIC_PLUGIN_SBOM_INVALID', 'sbomReference must be a safe artifact reference.');
        if (body.sbomDigest !== undefined && !/^[a-f0-9]{64}$/i.test(body.sbomDigest)) throw fail(400, 'ERR_SYSTEMFABRIC_PLUGIN_SBOM_INVALID', 'sbomDigest must be a SHA-256 digest.');
        if (signatureResult.valid && (!body.sbomReference || !body.sbomDigest)) throw fail(400, 'ERR_SYSTEMFABRIC_PLUGIN_SBOM_REQUIRED', 'Signed plugin registration must include a verifiable SBOM reference and SHA-256 digest.');
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
        if (!plugin) return sendJson(res, 404, { error: 'Plugin not found.', code: 'ERR_SYSTEMFABRIC_PLUGIN_NOT_FOUND', requestId });
        let result;
        if (action === 'approve') {
          const requested = Array.isArray(plugin.requested_capabilities) ? plugin.requested_capabilities : [];
          const approved = body.approvedCapabilities === undefined ? requested : body.approvedCapabilities;
          if (!Array.isArray(approved) || approved.some(cap => !requested.includes(cap))) throw fail(400, 'ERR_SYSTEMFABRIC_PLUGIN_CAPABILITY_INVALID', 'Approved capabilities must be a subset of requested capabilities.');
          result = await localPool.query("UPDATE plugin_installs SET status='approved',approved_capabilities=$3::jsonb,approved_by=$4,updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING id,name,status,approved_capabilities,image_digest,signature_verified", [siteId, pluginId, JSON.stringify(approved), actor.user.id]);
        } else if (action === 'security-review') {
          if (plugin.status !== 'approved') throw fail(409, 'ERR_SYSTEMFABRIC_PLUGIN_NOT_APPROVED', 'Plugin must be approved before security review.');
          if (plugin.approved_by && plugin.approved_by === actor.user.id) throw fail(403, 'ERR_SYSTEMFABRIC_PLUGIN_REVIEW_INDEPENDENCE', 'A different administrator must perform the security review.');
          if (plugin.signature_verified !== true || !plugin.artifact_digest) throw fail(409, 'ERR_SYSTEMFABRIC_PLUGIN_SIGNATURE_REQUIRED', 'A verified signature and immutable artifact digest are required before security review.');
          if (!plugin.sbom_reference || !plugin.sbom_digest || !/^[a-f0-9]{64}$/i.test(String(plugin.sbom_digest))) throw fail(409, 'ERR_SYSTEMFABRIC_PLUGIN_SBOM_REQUIRED', 'A signed software bill of materials reference and SHA-256 digest are required before activation.');
          if (plugin.source_type !== 'oci-image' || !validatePinnedImageDigest(plugin.image_digest)) throw fail(409, 'ERR_SYSTEMFABRIC_PLUGIN_IMAGE_REQUIRED', 'Only a pinned OCI image can pass the execution security review.');
          result = await localPool.query('UPDATE plugin_installs SET security_reviewed_at=now(),security_reviewed_by=$3,updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING id,name,status,signature_verified,security_reviewed_at,security_reviewed_by,image_digest', [siteId, pluginId, actor.user.id]);
        } else if (action === 'activate') {
          if (env.SYSTEMFABRIC_PLUGIN_EXECUTION_ENABLED !== 'true') throw fail(503, 'ERR_SYSTEMFABRIC_PLUGIN_EXECUTION_DISABLED', 'Plugin execution is disabled until an isolated runner, trusted signing keys, and security policies are configured.');
          if (plugin.status !== 'approved') throw fail(409, 'ERR_SYSTEMFABRIC_PLUGIN_NOT_APPROVED', 'Plugin must be approved before activation.');
          if (plugin.signature_verified !== true || !plugin.artifact_digest) throw fail(409, 'ERR_SYSTEMFABRIC_PLUGIN_SIGNATURE_REQUIRED', 'The exact plugin artifact must have a verified trusted signature.');
          if (!plugin.sbom_reference) throw fail(409, 'ERR_SYSTEMFABRIC_PLUGIN_SBOM_REQUIRED', 'An SBOM artifact reference is required before activation.');
          if (!plugin.security_reviewed_at || !plugin.security_reviewed_by || (plugin.approved_by && plugin.security_reviewed_by === plugin.approved_by)) throw fail(409, 'ERR_SYSTEMFABRIC_PLUGIN_SECURITY_REVIEW_REQUIRED', 'A second administrator must review the exact artifact before activation.');
          if (!validatePinnedImageDigest(plugin.image_digest) || digestForArtifact(plugin.image_digest) !== String(plugin.artifact_digest).toLowerCase()) throw fail(409, 'ERR_SYSTEMFABRIC_PLUGIN_IMAGE_DIGEST_MISMATCH', 'The reviewed OCI image digest must match the signed artifact digest.');
          result = await localPool.query("UPDATE plugin_installs SET status='active',updated_at=now() WHERE site_id=$1 AND id=$2 AND signature_verified=true AND security_reviewed_at IS NOT NULL RETURNING id,name,status,image_digest,approved_capabilities,signature_verified,security_reviewed_at", [siteId, pluginId]);
        } else if (action === 'disable') {
          result = await localPool.query("UPDATE plugin_installs SET status='disabled',updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING id,name,status", [siteId, pluginId]);
        } else {
          if (env.SYSTEMFABRIC_PLUGIN_EXECUTION_ENABLED !== 'true') throw fail(503, 'ERR_SYSTEMFABRIC_PLUGIN_EXECUTION_DISABLED', 'Plugin execution is disabled by policy.');
          if (plugin.status !== 'active' || !validatePinnedImageDigest(plugin.image_digest) || plugin.signature_verified !== true || !plugin.security_reviewed_at) throw fail(409, 'ERR_SYSTEMFABRIC_PLUGIN_INACTIVE', 'Only reviewed, signed, active plugins with pinned images may execute.');
          const started = Date.now();
          try {
            const output = await sandboxRunner.invoke({ imageDigest: plugin.image_digest, action: body.action, input: body.input, requestId });
            await localPool.query("INSERT INTO plugin_invocations(site_id,plugin_id,action,result,elapsed_ms,request_id) VALUES($1,$2,$3,'success',$4,$5)", [siteId, pluginId, body.action, Date.now() - started, requestId]);
            return sendJson(res, 200, { result: output, requestId });
          } catch (error) {
            await localPool.query("INSERT INTO plugin_invocations(site_id,plugin_id,action,result,elapsed_ms,request_id,error_code) VALUES($1,$2,$3,$4,$5,$6,$7)", [siteId, pluginId, body.action || 'unknown', error.code === 'ERR_SYSTEMFABRIC_PLUGIN_TIMEOUT' ? 'timeout' : 'failure', Date.now() - started, requestId, error.code || 'ERR_SYSTEMFABRIC_PLUGIN_FAILED']);
            throw error;
          }
        }
        if (identity && actor.user.id) await identity.audit({ siteId, actorId: actor.user.id, action: `plugin.${action}`, targetType: 'plugin', targetId: pluginId, requestId, details: { status: result.rows[0]?.status, signatureVerified: Boolean(result.rows[0]?.signature_verified) } });
        return sendJson(res, 200, { plugin: result.rows[0], requestId });
      }

      return sendJson(res, 404, { error: 'Route not found.', code: 'ERR_SYSTEMFABRIC_NOT_FOUND', requestId });
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : error.code === 'ERR_SYSTEMFABRIC_INVALID_DOCUMENT' ? 422 : 500;
      logger.error?.(JSON.stringify({ type: 'systemfabric.http.error', requestId, route, code: error.code || 'ERR_SYSTEMFABRIC_INTERNAL', status, elapsedMs: Date.now() - started }));
      if (status >= 500 && !error.statusCode) return sendJson(res, status, { error: 'An internal error occurred.', code: error.code || 'ERR_SYSTEMFABRIC_INTERNAL', requestId });
      if (status === 429 && error.retryAfterSeconds) res.setHeader('retry-after', String(error.retryAfterSeconds));
      return sendJson(res, status, { error: error.message, code: error.code || 'ERR_SYSTEMFABRIC_REQUEST', details: error.details, requestId });
    }
  }

  const server = http.createServer((req, res) => { void handler(req, res); });
  server.systemfabric = {
    get contentStore() { return store; }, get pool() { return localPool; }, get identityService() { return identity; }, get libraryStore() { return libraryStore; }, get firewall() { return firewall; },
    get realtimeHub() { return realtimeHub; }, get realtimeBridge() { return realtimeBridge; }, get presenceService() { return presence; },
    ready() { return realtimeBridgeReady; },
    get realtimeMode() {
      if (injectedRealtimeHub && injectedPresenceService) return 'injected-adapters';
      if (!realtimeEnabled) return 'disabled';
      if (realtimeBridge) return 'redis-shared-presence-pubsub';
      return configuredPresenceStore === 'redis' ? 'single-process-hub-shared-redis-presence' : 'single-process-preview';
    },
    get presenceStore() {
      if (injectedPresenceService && configuredPresenceStore === 'redis') return 'redis';
      return injectedPresenceService ? 'injected' : configuredPresenceStore;
    },
    async close() {
      realtimeHub?.close?.();
      if (realtimeBridge && typeof realtimeBridge.close === 'function') await Promise.resolve(realtimeBridge.close()).catch(() => {});
      if (presence && typeof presence.close === 'function') await Promise.resolve(presence.close()).catch(() => {});
      samlAuth?.close?.();
      if (typeof libraryStorageAdapter?.close === 'function') await libraryStorageAdapter.close().catch(()=>{});
      if (localPool && !pool) await localPool.end();
    }
  };
  return server;
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  let presenceService = null;
  let realtimeBridge = null;
  const realtimeEnabled = process.env.SYSTEMFABRIC_REALTIME_ENABLED === 'true';
  const presenceStore = String(process.env.SYSTEMFABRIC_PRESENCE_STORE || 'memory').toLowerCase();
  if (!['memory', 'redis'].includes(presenceStore)) {
    throw new Error('SYSTEMFABRIC_PRESENCE_STORE must be memory or redis.');
  }
  if (realtimeEnabled && process.env.NODE_ENV === 'production') {
    throw new Error('The standalone API entry point does not yet provide a distributed event gateway. Inject both the distributed event hub and presence service through the production host bootstrap.');
  }
  if (realtimeEnabled && presenceStore === 'redis') {
    try {
      const redisUrl = process.env.SYSTEMFABRIC_PRESENCE_REDIS_URL;
      realtimeBridge = await createRedisRealtimeBridge({
        url: redisUrl,
        onError: event => console.error(JSON.stringify({ type: 'systemfabric.realtime.redis_error', ...event }))
      });
    presenceService = await createRedisPresenceService({
      url: redisUrl,
      leaseMs: boundedInt(process.env.SYSTEMFABRIC_PRESENCE_LEASE_MS, 30_000, 5_000, 120_000, 'SYSTEMFABRIC_PRESENCE_LEASE_MS'),
      maxEntriesPerSite: boundedInt(process.env.SYSTEMFABRIC_PRESENCE_MAX_SESSIONS_PER_SITE, 10_000, 1, 100_000, 'SYSTEMFABRIC_PRESENCE_MAX_SESSIONS_PER_SITE'),
      expiryRetentionMs: boundedInt(process.env.SYSTEMFABRIC_PRESENCE_EXPIRY_RETENTION_MS, 30_000, 1_000, 300_000, 'SYSTEMFABRIC_PRESENCE_EXPIRY_RETENTION_MS'),
      onError: event => console.error(JSON.stringify({ type: 'systemfabric.presence.redis_error', ...event })),
      onExpired: event => {
        console.error(JSON.stringify({ type: 'systemfabric.presence.lease_expired', siteId: event.siteId, expiredAtMs: event.expiredAtMs }));
        return realtimeBridge.publish({ siteId: event.siteId, topic: 'presence', payload: { kind: 'presence.refresh' } })
          .catch(() => console.error(JSON.stringify({ type: 'systemfabric.realtime.expiry_publish_failed', siteId: event.siteId })));
      }
      });
    } catch (error) {
      await Promise.all([
        presenceService?.close?.().catch(() => {}),
        realtimeBridge?.close?.().catch(() => {})
      ]);
      throw error;
    }
  }
  let server;
  try {
    server = createApiServer({ presenceService, realtimeBridge });
    await server.systemfabric.ready();
  } catch (error) {
    await Promise.all([
      presenceService?.close?.().catch(() => {}),
      realtimeBridge?.close?.().catch(() => {})
    ]);
    throw error;
  }
  const host = process.env.HOST || '127.0.0.1'; const port = Number(process.env.PORT || 8787);
  server.listen(port, host, () => console.error(JSON.stringify({ type: 'systemfabric.api.started', host, port, version: SYSTEMFABRIC_VERSION, aiProvider: server.systemfabric ? 'configured' : 'unknown', realtimeMode: server.systemfabric.realtimeMode, presenceStore: server.systemfabric.presenceStore })));
  const shutdown = async () => { server.close(async () => { await server.systemfabric.close().catch(() => {}); process.exit(0); }); setTimeout(() => process.exit(1), 5000).unref(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
if (require.main === module) void main().catch(error => { console.error(`SystemFabric failed to start: ${error.message}`); process.exitCode = 1; });
module.exports = { createApiServer, readJson, normalizeSlug, validateSaveDraftBody, sameSecret, parseCookies, ID_RE };
