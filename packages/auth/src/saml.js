'use strict';

const crypto = require('node:crypto');

function samlError(statusCode, code, message) { const error = new Error(message); error.statusCode = statusCode; error.code = code; return error; }
function configFromEnv(env = process.env) {
  if (env.SAML_ENABLED !== 'true') return null;
  const entryPoint = String(env.SAML_IDP_ENTRY_POINT || '');
  const idpIssuer = String(env.SAML_IDP_ISSUER || '');
  const cert = String(env.SAML_IDP_CERT || '').replace(/\\n/g, '\n').trim();
  const issuer = String(env.SAML_SP_ISSUER || '');
  const callbackUrl = String(env.SAML_ACS_URL || '');
  let entry; let callback;
  try { entry = new URL(entryPoint); callback = new URL(callbackUrl); } catch { throw samlError(500, 'ERR_SYSTEMFABRIC_SAML_CONFIG', 'SAML entry point and assertion consumer URL must be absolute URLs.'); }
  if (!idpIssuer || !cert || !issuer || !callbackUrl) throw samlError(500, 'ERR_SYSTEMFABRIC_SAML_CONFIG', 'SAML_ENABLED requires SAML_IDP_ENTRY_POINT, SAML_IDP_ISSUER, SAML_IDP_CERT, SAML_SP_ISSUER, and SAML_ACS_URL.');
  if (env.NODE_ENV === 'production' && (entry.protocol !== 'https:' || callback.protocol !== 'https:')) throw samlError(500, 'ERR_SYSTEMFABRIC_SAML_HTTPS_REQUIRED', 'SAML entry point and callback must use HTTPS in production.');
  if (!['http:', 'https:'].includes(entry.protocol) || !['http:', 'https:'].includes(callback.protocol) || entry.username || entry.password || callback.username || callback.password || callback.hash || callback.search) throw samlError(500, 'ERR_SYSTEMFABRIC_SAML_CONFIG', 'SAML URLs contain unsupported parts.');
  if (cert.length < 100 || !cert.includes('BEGIN CERTIFICATE') || !cert.includes('END CERTIFICATE')) throw samlError(500, 'ERR_SYSTEMFABRIC_SAML_CERT_INVALID', 'SAML_IDP_CERT must contain the IdP X.509 signing certificate.');
  try {
    const idpCertificate = new crypto.X509Certificate(cert);
    const now = Date.now();
    if (Date.parse(idpCertificate.validFrom) > now || Date.parse(idpCertificate.validTo) <= now) throw new Error('The IdP certificate is outside its validity window.');
  } catch { throw samlError(500, 'ERR_SYSTEMFABRIC_SAML_CERT_INVALID', 'SAML_IDP_CERT must be a currently valid X.509 signing certificate.'); }
  const privateKey = String(env.SAML_SP_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  const publicCert = String(env.SAML_SP_PUBLIC_CERT || env.SAML_SP_CERT || '').replace(/\\n/g, '\n').trim();
  if (Boolean(privateKey) !== Boolean(publicCert)) throw samlError(500, 'ERR_SYSTEMFABRIC_SAML_SP_KEY_PAIR', 'SAML_SP_PRIVATE_KEY and SAML_SP_PUBLIC_CERT must be configured together to sign AuthnRequests.');
  if (privateKey) {
    try {
      const parsedKey = crypto.createPrivateKey(privateKey);
      if (parsedKey.asymmetricKeyType !== 'rsa') throw new Error('RSA is required for the configured SAML signing algorithm.');
      const parsedCert = new crypto.X509Certificate(publicCert);
      if (parsedCert.publicKey.asymmetricKeyType !== 'rsa') throw new Error('The service-provider certificate must contain an RSA public key.');
      const keyPublic = crypto.createPublicKey(parsedKey).export({ type: 'spki', format: 'der' });
      const certPublic = parsedCert.publicKey.export({ type: 'spki', format: 'der' });
      if (!keyPublic.equals(certPublic)) throw new Error('The private key does not match the service-provider certificate.');
    } catch { throw samlError(500, 'ERR_SYSTEMFABRIC_SAML_SP_KEY_PAIR', 'SAML service-provider signing key and certificate must be a valid matching RSA PEM pair.'); }
  }
  if (publicCert && !privateKey) {
    try { const parsedCert = new crypto.X509Certificate(publicCert); if (parsedCert.publicKey.asymmetricKeyType !== 'rsa') throw new Error('RSA required'); }
    catch { throw samlError(500, 'ERR_SYSTEMFABRIC_SAML_SP_CERT_INVALID', 'SAML_SP_PUBLIC_CERT must contain a valid X.509 certificate with an RSA public key.'); }
  }
  return Object.freeze({ entryPoint, idpIssuer, cert, issuer, callbackUrl, emailAttribute: String(env.SAML_EMAIL_ATTRIBUTE || 'email').slice(0, 200), privateKey, publicCert });
}
function createSamlAuthenticator({ env = process.env, pool } = {}) {
  const config = configFromEnv(env);
  if (!config) return null;
  if (!pool || typeof pool.query !== 'function') throw samlError(503, 'ERR_SYSTEMFABRIC_SAML_DATABASE_REQUIRED', 'SAML SSO requires PostgreSQL-backed shared request-state storage.');
  let samlPackage;
  try { samlPackage = require('@node-saml/node-saml'); } catch { throw samlError(503, 'ERR_SYSTEMFABRIC_SAML_DEPENDENCY', 'Install the declared @node-saml/node-saml dependency to enable SAML SSO.'); }
  const { SAML } = samlPackage;
  const { createPgSamlCacheProvider } = require('./pg-saml-cache');
  const cacheProvider = createPgSamlCacheProvider({ pool, issuer: config.idpIssuer, ttlMs: 8 * 60 * 60 * 1000 });
  const saml = new SAML({
    entryPoint: config.entryPoint,
    issuer: config.issuer,
    callbackUrl: config.callbackUrl,
    idpCert: config.cert,
    idpIssuer: config.idpIssuer,
    ...(config.privateKey ? { privateKey: config.privateKey, publicCert: config.publicCert, signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256' } : {}),
    audience: config.issuer,
    validateInResponseTo: 'always',
    requestIdExpirationPeriodMs: 8 * 60 * 60 * 1000,
    rejectReplayedAssertions: true,
    cacheProvider,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    acceptedClockSkewMs: 5_000,
    maxAssertionAgeMs: 5 * 60_000,
    disableRequestedAuthnContext: true,
    authnRequestBinding: 'HTTP-Redirect'
  });
  const purgeTimer = setInterval(() => { void cacheProvider.purgeExpired().catch(() => {}); }, 60_000);
  purgeTimer.unref?.();
  return Object.freeze({
    config,
    async getAuthorizeUrl(relayState) { return saml.getAuthorizeUrlAsync(relayState); },
    async validatePostResponse(fields) {
      const result = await saml.validatePostResponseAsync(fields);
      return { profile: result?.profile || null, loggedOut: Boolean(result?.loggedOut) };
    },
    getMetadata() { return saml.generateServiceProviderMetadata(null, config.publicCert || ''); },
    close() { clearInterval(purgeTimer); },
    extractEmail(profile) {
      const candidates = [profile?.email, profile?.mail, profile?.[config.emailAttribute], profile?.['urn:oid:0.9.2342.19200300.100.1.3']];
      return candidates.find(value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))?.trim().toLowerCase() || '';
    },
    externalIssuer() { return `saml:${config.idpIssuer}`; }
  });
}
module.exports = { configFromEnv, createSamlAuthenticator, samlError };
