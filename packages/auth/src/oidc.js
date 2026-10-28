'use strict';

const { randomBytes, createHash, createPublicKey, verify: verifySignature } = require('node:crypto');

function oidcError(statusCode, code, message) { const error = new Error(message); error.statusCode = statusCode; error.code = code; return error; }
function b64u(buffer) { return Buffer.from(buffer).toString('base64url'); }
function sha256(value) { return createHash('sha256').update(value).digest(); }
function parseJsonSegment(segment, name) {
  try { return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')); }
  catch { throw oidcError(401, 'ERR_SYSTEMFABRIC_OIDC_TOKEN_INVALID', `The identity provider returned an invalid ${name}.`); }
}
function configFromEnv(env = process.env) {
  const issuer = String(env.OIDC_ISSUER || '').replace(/\/$/, '');
  const clientId = String(env.OIDC_CLIENT_ID || '');
  const clientSecret = String(env.OIDC_CLIENT_SECRET || '');
  const redirectUri = String(env.OIDC_REDIRECT_URI || '');
  if (!issuer || !clientId || !clientSecret || !redirectUri) return null;
  let issuerUrl; let redirectUrl;
  try { issuerUrl = new URL(issuer); redirectUrl = new URL(redirectUri); } catch { throw oidcError(500, 'ERR_SYSTEMFABRIC_OIDC_CONFIG', 'OIDC issuer and redirect URI must be valid absolute URLs.'); }
  const production = env.NODE_ENV === 'production';
  if (production && (issuerUrl.protocol !== 'https:' || redirectUrl.protocol !== 'https:')) throw oidcError(500, 'ERR_SYSTEMFABRIC_OIDC_HTTPS_REQUIRED', 'OIDC issuer and redirect URI must use HTTPS in production.');
  if (!['https:', 'http:'].includes(issuerUrl.protocol) || !['https:', 'http:'].includes(redirectUrl.protocol) || issuerUrl.username || issuerUrl.password || redirectUrl.username || redirectUrl.password || redirectUrl.hash) throw oidcError(500, 'ERR_SYSTEMFABRIC_OIDC_CONFIG', 'OIDC URLs are not valid for authentication.');
  return { issuer, clientId, clientSecret, redirectUri, issuerUrl, redirectUrl };
}
async function fetchJson(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(10_000) }); }
  catch { throw oidcError(502, 'ERR_SYSTEMFABRIC_OIDC_UPSTREAM', 'The identity provider could not be reached.'); }
  if (!response.ok) throw oidcError(502, 'ERR_SYSTEMFABRIC_OIDC_UPSTREAM', 'The identity provider returned an unsuccessful response.');
  try { return await response.json(); } catch { throw oidcError(502, 'ERR_SYSTEMFABRIC_OIDC_RESPONSE_INVALID', 'The identity provider returned malformed JSON.'); }
}
async function discovery(config) {
  const metadata = await fetchJson(`${config.issuer}/.well-known/openid-configuration`);
  if (metadata.issuer !== config.issuer) throw oidcError(502, 'ERR_SYSTEMFABRIC_OIDC_ISSUER_MISMATCH', 'The discovered issuer does not match OIDC_ISSUER.');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    let target; try { target = new URL(metadata[key]); } catch { throw oidcError(502, 'ERR_SYSTEMFABRIC_OIDC_METADATA_INVALID', 'The identity provider metadata is incomplete.'); }
    if (config.issuerUrl.protocol === 'https:' && target.protocol !== 'https:') throw oidcError(502, 'ERR_SYSTEMFABRIC_OIDC_METADATA_INVALID', 'The identity provider metadata contains a non-HTTPS endpoint.');
  }
  if (!Array.isArray(metadata.id_token_signing_alg_values_supported) || !metadata.id_token_signing_alg_values_supported.includes('RS256')) throw oidcError(502, 'ERR_SYSTEMFABRIC_OIDC_ALGORITHM_UNSUPPORTED', 'The identity provider must advertise RS256 ID-token signing.');
  return metadata;
}
async function createAuthorizationRequest(env = process.env) {
  const config = configFromEnv(env);
  if (!config) throw oidcError(503, 'ERR_SYSTEMFABRIC_OIDC_NOT_CONFIGURED', 'OIDC SSO is not configured.');
  const metadata = await discovery(config);
  const state = b64u(randomBytes(32)); const nonce = b64u(randomBytes(32)); const verifier = b64u(randomBytes(48));
  const challenge = b64u(sha256(verifier));
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code'); url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri); url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state); url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge); url.searchParams.set('code_challenge_method', 'S256');
  return { state, nonce, verifier, authorizationUrl: url.toString(), issuer: config.issuer };
}
async function exchangeAndVerify({ code, nonce, verifier, env = process.env, clock = () => Date.now() }) {
  const config = configFromEnv(env);
  if (!config) throw oidcError(503, 'ERR_SYSTEMFABRIC_OIDC_NOT_CONFIGURED', 'OIDC SSO is not configured.');
  if (typeof code !== 'string' || code.length < 1 || code.length > 4096) throw oidcError(400, 'ERR_SYSTEMFABRIC_OIDC_CODE_INVALID', 'OIDC authorization code is invalid.');
  const metadata = await discovery(config);
  const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, client_id: config.clientId, client_secret: config.clientSecret, code_verifier: verifier });
  const tokenResponse = await fetchJson(metadata.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: tokenBody });
  if (typeof tokenResponse.id_token !== 'string') throw oidcError(401, 'ERR_SYSTEMFABRIC_OIDC_ID_TOKEN_MISSING', 'The identity provider did not return an ID token.');
  const pieces = tokenResponse.id_token.split('.');
  if (pieces.length !== 3) throw oidcError(401, 'ERR_SYSTEMFABRIC_OIDC_TOKEN_INVALID', 'The identity provider returned an invalid ID token.');
  const header = parseJsonSegment(pieces[0], 'token header'); const claims = parseJsonSegment(pieces[1], 'token payload');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw oidcError(401, 'ERR_SYSTEMFABRIC_OIDC_ALGORITHM_INVALID', 'The ID token signing algorithm is not permitted.');
  const keySet = await fetchJson(metadata.jwks_uri);
  const jwk = Array.isArray(keySet.keys) ? keySet.keys.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256')) : null;
  if (!jwk) throw oidcError(401, 'ERR_SYSTEMFABRIC_OIDC_SIGNING_KEY_INVALID', 'No permitted signing key matched the ID token.');
  let validSignature = false;
  try { validSignature = verifySignature('RSA-SHA256', Buffer.from(`${pieces[0]}.${pieces[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(pieces[2], 'base64url')); } catch { validSignature = false; }
  const seconds = Math.floor(clock() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!validSignature || claims.iss !== config.issuer || !audience.includes(config.clientId) || (audience.length > 1 && claims.azp !== config.clientId) || !Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) || claims.iat > seconds + 90 || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub || claims.email_verified !== true || typeof claims.email !== 'string') {
    throw oidcError(401, 'ERR_SYSTEMFABRIC_OIDC_CLAIMS_INVALID', 'The ID token failed signature, issuer, audience, time, nonce, or verified-email validation.');
  }
  return { issuer: config.issuer, subject: claims.sub, email: claims.email, displayName: typeof claims.name === 'string' ? claims.name.slice(0,180) : '', claims: { acr: claims.acr || null, amr: Array.isArray(claims.amr) ? claims.amr.slice(0,10) : [] } };
}
module.exports = { configFromEnv, createAuthorizationRequest, exchangeAndVerify, discovery, oidcError };
