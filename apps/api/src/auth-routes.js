'use strict';

const { randomBytes } = require('node:crypto');
const { createAuthorizationRequest, exchangeAndVerify, configFromEnv } = require('../../../packages/auth/src/oidc');
const { parseCookies, serializeAuthCookie } = require('./auth-cookies');

const MAX_AUTH_BODY_BYTES = 16_384;
const MAX_SAML_FORM_BYTES = 2 * 1024 * 1024;

function createAuthRouteHandlers(dependencies = {}) {
  const {
    identity,
    samlAuth,
    env,
    secureCookies,
    maxBody,
    allowRequest,
    sendJson,
    fail,
    readJson,
    readForm,
    sameSecret
  } = dependencies;

  for (const [name, value] of Object.entries({
    env,
    allowRequest,
    sendJson,
    fail,
    readJson,
    readForm,
    sameSecret
  })) {
    if (name === 'env') {
      if (!value || typeof value !== 'object') throw new TypeError('Authentication routes require an environment object.');
    } else if (typeof value !== 'function') {
      throw new TypeError('Authentication routes require ' + name + '().');
    }
  }
  if (typeof secureCookies !== 'boolean') throw new TypeError('Authentication routes require an explicit secure-cookie setting.');
  if (!Number.isInteger(maxBody) || maxBody < 1_024) throw new TypeError('Authentication routes require a valid request body limit.');

  /**
   * Handle unauthenticated login, account recovery, bootstrap, invitation, and
   * federated sign-in routes. Return false only when the path/method is not an
   * auth route; matched routes always complete the response or throw a typed
   * route error for the API's central error handler.
   */
  async function handlePublic({ req, res, url, requestId }) {
    if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
      const limit = allowRequest('login:' + (req.socket.remoteAddress || 'unknown'));
      if (!limit.allowed) {
        res.setHeader('retry-after', String(limit.retryAfterSeconds));
        return sendJson(res, 429, { error: 'Too many requests.', code: 'ERR_VIRGOSCORPIO_HUB_RATE_LIMIT', requestId });
      }
      if (!identity) {
        return sendJson(res, 503, { error: 'Authentication requires PostgreSQL and applied migrations.', code: 'ERR_VIRGOSCORPIO_HUB_IDENTITY_DISABLED', requestId });
      }
      const body = await readJson(req, Math.min(maxBody, MAX_AUTH_BODY_BYTES));
      const session = await identity.login({
        email: body.email,
        password: body.password,
        ip: req.socket.remoteAddress,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500)
      });
      if (session.mfaRequired) {
        // A 256-bit, one-time challenge; PostgreSQL persists only its digest.
        res.setHeader('set-cookie', serializeAuthCookie('vsh_mfa_challenge', session.challengeToken, {
          httpOnly: true, secure: secureCookies, sameSite: 'Strict', path: '/api/v1/auth/mfa', maxAge: 300
        }));
        return sendJson(res, 200, {
          authenticated: false,
          mfaRequired: true,
          user: { id: session.user.id, email: session.user.email },
          expiresAt: session.expiresAt,
          requestId
        });
      }
      const maxAge = Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000);
      res.setHeader('set-cookie', [
        serializeAuthCookie('vsh_session', session.token, { httpOnly: true, secure: secureCookies, maxAge }),
        serializeAuthCookie('vsh_csrf', session.csrf, { secure: secureCookies, maxAge })
      ]);
      return sendJson(res, 200, { authenticated: true, user: session.user, expiresAt: session.expiresAt, requestId });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/mfa/verify') {
      if (!identity) return sendJson(res, 503, { error: 'Authentication requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_IDENTITY_DISABLED', requestId });
      const expectedOrigin = `${secureCookies ? 'https' : (req.socket.encrypted ? 'https' : 'http')}://${req.headers.host}`;
      if (typeof req.headers.origin !== 'string' || req.headers.origin !== expectedOrigin) {
        throw fail(403, 'ERR_VIRGOSCORPIO_HUB_CSRF', 'A matching same-origin Origin header is required.');
      }
      const challenge = parseCookies(req.headers.cookie || '').vsh_mfa_challenge;
      const body = await readJson(req, Math.min(maxBody, MAX_AUTH_BODY_BYTES));
      const session = await identity.completeMfaLogin({
        challengeToken: challenge,
        code: body.code,
        ip: req.socket.remoteAddress,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500)
      });
      const maxAge = Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000);
      res.setHeader('set-cookie', [
        serializeAuthCookie('vsh_session', session.token, { httpOnly: true, secure: secureCookies, maxAge }),
        serializeAuthCookie('vsh_csrf', session.csrf, { secure: secureCookies, maxAge }),
        serializeAuthCookie('vsh_mfa_challenge', '', {
          httpOnly: true, secure: secureCookies, sameSite: 'Strict', path: '/api/v1/auth/mfa', maxAge: 0
        })
      ]);
      return sendJson(res, 200, { authenticated: true, user: session.user, expiresAt: session.expiresAt, requestId });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/password-reset/request') {
      if (!identity) return sendJson(res, 503, { error: 'Authentication requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_IDENTITY_DISABLED', requestId });
      const body = await readJson(req, Math.min(maxBody, MAX_AUTH_BODY_BYTES));
      const result = await identity.requestPasswordReset({ email: body.email });
      return sendJson(res, 202, {
        ...result,
        message: 'If an active account matches that address, password reset instructions will be sent.',
        requestId
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/password-reset/complete') {
      if (!identity) return sendJson(res, 503, { error: 'Authentication requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_IDENTITY_DISABLED', requestId });
      const body = await readJson(req, Math.min(maxBody, MAX_AUTH_BODY_BYTES));
      const result = await identity.resetPassword({ token: body.token, password: body.password });
      return sendJson(res, 200, { ...result, requestId });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/email-verification/confirm') {
      if (!identity) return sendJson(res, 503, { error: 'Authentication requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_IDENTITY_DISABLED', requestId });
      const body = await readJson(req, Math.min(maxBody, MAX_AUTH_BODY_BYTES));
      const result = await identity.verifyEmail({ token: body.token });
      return sendJson(res, 200, { ...result, requestId });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/bootstrap') {
      const limit = allowRequest('bootstrap:' + (req.socket.remoteAddress || 'unknown'));
      if (!limit.allowed) {
        res.setHeader('retry-after', String(limit.retryAfterSeconds));
        return sendJson(res, 429, { error: 'Too many bootstrap attempts.', code: 'ERR_VIRGOSCORPIO_HUB_RATE_LIMIT', requestId });
      }
      if (!identity || !env.VIRGOSCORPIO_HUB_BOOTSTRAP_SECRET ||
          !sameSecret(req.headers['x-virgoscorpio-hub-bootstrap-secret'], env.VIRGOSCORPIO_HUB_BOOTSTRAP_SECRET)) {
        return sendJson(res, 403, { error: 'Bootstrap is disabled or the bootstrap secret is invalid.', code: 'ERR_VIRGOSCORPIO_HUB_BOOTSTRAP_FORBIDDEN', requestId });
      }
      const body = await readJson(req, Math.min(maxBody, MAX_AUTH_BODY_BYTES));
      const result = await identity.bootstrapOwner({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
        siteSlug: body.siteSlug || 'main',
        siteName: body.siteName || 'Main Site'
      });
      return sendJson(res, 201, { status: 'created', ...result, requestId });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/invitations/accept') {
      const limit = allowRequest('invite-accept:' + (req.socket.remoteAddress || 'unknown'));
      if (!limit.allowed) {
        res.setHeader('retry-after', String(limit.retryAfterSeconds));
        return sendJson(res, 429, { error: 'Too many invitation attempts.', code: 'ERR_VIRGOSCORPIO_HUB_RATE_LIMIT', requestId });
      }
      if (!identity) return sendJson(res, 503, { error: 'Authentication requires PostgreSQL.', code: 'ERR_VIRGOSCORPIO_HUB_IDENTITY_DISABLED', requestId });
      const body = await readJson(req, Math.min(maxBody, MAX_AUTH_BODY_BYTES));
      const result = await identity.acceptInvitation({ token: body.token, password: body.password, displayName: body.displayName });
      return sendJson(res, 200, { status: 'accepted', ...result, requestId });
    }

    if (url.pathname === '/api/v1/auth/saml/metadata' && req.method === 'GET') {
      if (!samlAuth) throw fail(404, 'ERR_VIRGOSCORPIO_HUB_SAML_DISABLED', 'SAML SSO is not enabled.');
      const xml = Buffer.from(samlAuth.getMetadata());
      res.writeHead(200, {
        'content-type': 'application/samlmetadata+xml; charset=utf-8',
        'content-length': xml.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      res.end(xml);
      return true;
    }

    if (url.pathname === '/api/v1/auth/saml/start' && req.method === 'GET') {
      if (!samlAuth || !identity) throw fail(503, 'ERR_VIRGOSCORPIO_HUB_SAML_DISABLED', 'SAML SSO is not enabled or identity storage is unavailable.');
      const limit = allowRequest('saml-start:' + (req.socket.remoteAddress || 'unknown'));
      if (!limit.allowed) throw fail(429, 'ERR_VIRGOSCORPIO_HUB_RATE_LIMIT', 'Too many SSO attempts.');
      const state = randomBytes(32).toString('base64url');
      await identity.createOidcState({ state, nonce: 'saml', verifier: 'saml', issuer: samlAuth.externalIssuer() });
      const redirect = await samlAuth.getAuthorizeUrl(state);
      const target = new URL(redirect);
      if (target.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && target.protocol === 'http:')) {
        throw fail(502, 'ERR_VIRGOSCORPIO_HUB_SAML_IDP_URL', 'SAML identity provider redirect must use HTTPS.');
      }
      res.writeHead(302, { location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end();
      return true;
    }

    if (url.pathname === '/api/v1/auth/saml/acs' && req.method === 'POST') {
      if (!samlAuth || !identity) throw fail(503, 'ERR_VIRGOSCORPIO_HUB_SAML_DISABLED', 'SAML SSO is not enabled or identity storage is unavailable.');
      const form = await readForm(req, Math.min(maxBody, MAX_SAML_FORM_BYTES));
      const saved = await identity.consumeOidcState({ state: form.RelayState });
      if (saved.issuer !== samlAuth.externalIssuer()) throw fail(401, 'ERR_VIRGOSCORPIO_HUB_SAML_STATE_ISSUER', 'The SAML relay state issuer does not match.');
      const assertion = await samlAuth.validatePostResponse({ SAMLResponse: form.SAMLResponse });
      const profile = assertion?.profile;
      if (!profile || assertion.loggedOut || typeof profile.nameID !== 'string' || !profile.nameID) {
        throw fail(401, 'ERR_VIRGOSCORPIO_HUB_SAML_ASSERTION_INVALID', 'The SAML assertion did not contain an authenticated subject.');
      }
      const email = samlAuth.extractEmail(profile);
      if (!email) throw fail(401, 'ERR_VIRGOSCORPIO_HUB_SAML_EMAIL_REQUIRED', 'The SAML assertion must contain a verified email attribute.');
      const session = await identity.loginFederated({
        issuer: samlAuth.externalIssuer(),
        subject: `${String(profile.nameIDFormat || 'unspecified').slice(0, 200)}:${profile.nameID}`,
        email,
        ip: req.socket.remoteAddress,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500)
      });
      if (session.mfaRequired) {
        res.writeHead(303, {
          location: '/admin?mfa=required',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'set-cookie': serializeAuthCookie('vsh_mfa_challenge', session.challengeToken, {
            httpOnly: true, secure: secureCookies, sameSite: 'Strict', path: '/api/v1/auth/mfa', maxAge: 300
          })
        });
        res.end();
        return true;
      }
      const maxAge = Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000);
      res.writeHead(303, {
        location: '/admin',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'set-cookie': [
          serializeAuthCookie('vsh_session', session.token, { httpOnly: true, secure: secureCookies, maxAge }),
          serializeAuthCookie('vsh_csrf', session.csrf, { secure: secureCookies, maxAge })
        ]
      });
      res.end();
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/auth/oidc/start') {
      if (!identity) return sendJson(res, 503, { error: 'SSO requires PostgreSQL and applied migrations.', code: 'ERR_VIRGOSCORPIO_HUB_IDENTITY_DISABLED', requestId });
      const limit = allowRequest('oidc-start:' + (req.socket.remoteAddress || 'unknown'));
      if (!limit.allowed) {
        res.setHeader('retry-after', String(limit.retryAfterSeconds));
        return sendJson(res, 429, { error: 'Too many SSO attempts.', code: 'ERR_VIRGOSCORPIO_HUB_RATE_LIMIT', requestId });
      }
      const request = await createAuthorizationRequest(env);
      await identity.createOidcState(request);
      res.writeHead(302, { location: request.authorizationUrl, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end();
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/auth/oidc/callback') {
      if (!identity) return sendJson(res, 503, { error: 'SSO requires PostgreSQL and applied migrations.', code: 'ERR_VIRGOSCORPIO_HUB_IDENTITY_DISABLED', requestId });
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (url.searchParams.has('error') || !code || !state) {
        throw fail(400, 'ERR_VIRGOSCORPIO_HUB_OIDC_CALLBACK_INVALID', 'The identity provider did not complete sign-in.');
      }
      const savedState = await identity.consumeOidcState({ state });
      const config = configFromEnv(env);
      if (!config || savedState.issuer !== config.issuer) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_OIDC_STATE_INVALID', 'OIDC state does not match the configured issuer.');
      const external = await exchangeAndVerify({ code, nonce: savedState.nonce, verifier: savedState.verifier, env });
      if (external.issuer !== savedState.issuer) throw fail(401, 'ERR_VIRGOSCORPIO_HUB_OIDC_ISSUER_MISMATCH', 'The external identity issuer did not match the sign-in request.');
      const session = await identity.loginFederated({
        issuer: external.issuer,
        subject: external.subject,
        email: external.email,
        ip: req.socket.remoteAddress,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500)
      });
      if (session.mfaRequired) {
        res.writeHead(303, {
          location: '/admin?mfa=required',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'set-cookie': serializeAuthCookie('vsh_mfa_challenge', session.challengeToken, {
            httpOnly: true, secure: secureCookies, sameSite: 'Strict', path: '/api/v1/auth/mfa', maxAge: 300
          })
        });
        res.end();
        return true;
      }
      const maxAge = Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000);
      res.writeHead(303, {
        location: '/admin',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'set-cookie': [
          serializeAuthCookie('vsh_session', session.token, { httpOnly: true, secure: secureCookies, maxAge }),
          serializeAuthCookie('vsh_csrf', session.csrf, { secure: secureCookies, maxAge })
        ]
      });
      res.end();
      return true;
    }

    return false;
  }

  /**
   * Handle authenticated account/session management. The server authenticates
   * the request and validates cookie CSRF before invoking this route family.
   */
  async function handleAuthenticated({ req, res, url, actor, requestId }) {
    if (req.method === 'GET' && url.pathname === '/api/v1/auth/me') {
      return sendJson(res, 200, {
        authenticated: true,
        user: actor.user,
        sites: actor.isDeveloper
          ? (env.VIRGOSCORPIO_HUB_DEFAULT_SITE_ID
            ? [{ siteId: env.VIRGOSCORPIO_HUB_DEFAULT_SITE_ID, siteSlug: 'local', siteName: 'Local Site', role: 'development', capabilities: ['*'] }]
            : [])
          : actor.memberships,
        requestId
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
      if (actor.sessionToken && identity) await identity.logout(actor.sessionToken);
      res.setHeader('set-cookie', [
        serializeAuthCookie('vsh_session', '', { httpOnly: true, secure: secureCookies, maxAge: 0 }),
        serializeAuthCookie('vsh_csrf', '', { secure: secureCookies, maxAge: 0 })
      ]);
      return sendJson(res, 200, { authenticated: false, requestId });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/email-verification/request') {
      if (actor.isDeveloper) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'Email verification requires a real account.');
      const result = await identity.requestEmailVerification({ userId: actor.user.id });
      return sendJson(res, 202, { ...result, requestId });
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/auth/sessions') {
      if (actor.isDeveloper) return sendJson(res, 200, { sessions: [], requestId });
      return sendJson(res, 200, {
        sessions: await identity.listSessions({ userId: actor.user.id, currentSessionId: actor.sessionId }),
        requestId
      });
    }

    const ownSessionMatch = url.pathname.match(/^\/api\/v1\/auth\/sessions\/([0-9a-f-]{36})$/i);
    if (req.method === 'DELETE' && ownSessionMatch) {
      if (actor.isDeveloper) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'Session management requires a real account.');
      const result = await identity.revokeSession({ userId: actor.user.id, sessionId: ownSessionMatch[1] });
      if (result.revoked && ownSessionMatch[1] === actor.sessionId) {
        res.setHeader('set-cookie', [
          serializeAuthCookie('vsh_session', '', { httpOnly: true, secure: secureCookies, maxAge: 0 }),
          serializeAuthCookie('vsh_csrf', '', { secure: secureCookies, maxAge: 0 })
        ]);
      }
      return sendJson(res, 200, { ...result, requestId });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/mfa/enroll') {
      if (actor.isDeveloper) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'MFA enrollment requires a real account.');
      return sendJson(res, 200, { enrollment: await identity.beginMfaEnrollment({ userId: actor.user.id }), requestId });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/mfa/confirm') {
      if (actor.isDeveloper) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'MFA enrollment requires a real account.');
      const body = await readJson(req, Math.min(maxBody, MAX_AUTH_BODY_BYTES));
      return sendJson(res, 200, { ...await identity.confirmMfaEnrollment({ userId: actor.user.id, code: body.code }), requestId });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/mfa/disable') {
      if (actor.isDeveloper) throw fail(403, 'ERR_VIRGOSCORPIO_HUB_FORBIDDEN', 'MFA management requires a real account.');
      const body = await readJson(req, Math.min(maxBody, MAX_AUTH_BODY_BYTES));
      const result = await identity.disableMfa({ userId: actor.user.id, password: body.password, code: body.code });
      res.setHeader('set-cookie', [
        serializeAuthCookie('vsh_session', '', { httpOnly: true, secure: secureCookies, maxAge: 0 }),
        serializeAuthCookie('vsh_csrf', '', { secure: secureCookies, maxAge: 0 })
      ]);
      return sendJson(res, 200, { ...result, reauthenticationRequired: true, requestId });
    }

    return false;
  }

  return Object.freeze({ handlePublic, handleAuthenticated });
}

module.exports = { createAuthRouteHandlers };
