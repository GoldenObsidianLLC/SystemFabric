'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { signPluginArtifact, verifyPluginArtifactSignature, signedArtifactPayload } = require('../packages/plugins/src/provenance');
const { configFromEnv } = require('../packages/auth/src/saml');
const { createPgSamlCacheProvider } = require('../packages/auth/src/pg-saml-cache');
const { createS3MediaStore } = require('../packages/media/src/s3-store');

const manifest = { apiVersion: 1, name: 'vendor.test-widget', version: '1.0.0' };
const digest = 'a'.repeat(64);
const sbomDigest = 'b'.repeat(64);

test('plugin provenance binds artifact, SBOM, version, and source type with Ed25519', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signature = signPluginArtifact({ manifest, artifactDigest: digest, sbomDigest, sourceType: 'oci-image', privateKey });
  const trustedKeys = { 'release-key-1': publicKey };
  assert.equal(verifyPluginArtifactSignature({ manifest, artifactDigest: digest, sbomDigest, sourceType: 'oci-image', keyId: 'release-key-1', signature, trustedKeys }).valid, true);
  assert.equal(verifyPluginArtifactSignature({ manifest, artifactDigest: 'c'.repeat(64), sbomDigest, sourceType: 'oci-image', keyId: 'release-key-1', signature, trustedKeys }).valid, false);
  assert.equal(verifyPluginArtifactSignature({ manifest, artifactDigest: digest, sbomDigest: 'd'.repeat(64), sourceType: 'oci-image', keyId: 'release-key-1', signature, trustedKeys }).valid, false);
  assert.equal(verifyPluginArtifactSignature({ manifest, artifactDigest: digest, sbomDigest, sourceType: 'npm-archive', keyId: 'release-key-1', signature, trustedKeys }).valid, false);
  assert.throws(() => signedArtifactPayload({ manifest, artifactDigest: 'not-a-digest', sbomDigest, sourceType: 'oci-image' }), /SHA-256/);
});

test('SAML is disabled by default and invalid production URLs fail closed', () => {
  assert.equal(configFromEnv({ NODE_ENV: 'production' }), null);
  const env = { NODE_ENV: 'production', SAML_ENABLED: 'true', SAML_IDP_ENTRY_POINT: 'http://idp.example.test/sso', SAML_IDP_ISSUER: 'urn:example:idp', SAML_IDP_CERT: `-----BEGIN CERTIFICATE-----\n${'a'.repeat(160)}\n-----END CERTIFICATE-----`, SAML_SP_ISSUER: 'https://cms.example.test/saml/metadata', SAML_ACS_URL: 'https://cms.example.test/api/v1/auth/saml/acs' };
  assert.throws(() => configFromEnv(env), { code: 'ERR_SYSTEMFABRIC_SAML_HTTPS_REQUIRED' });
  const httpsDev = { ...env, NODE_ENV: 'development', SAML_IDP_ENTRY_POINT: 'https://idp.example.test/sso' };
  assert.throws(() => configFromEnv(httpsDev), { code: 'ERR_SYSTEMFABRIC_SAML_CERT_INVALID' });
});

test('PostgreSQL SAML cache namespaces keys by IdP and atomically consumes one-time values', async () => {
  const calls = [];
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    if (/DELETE FROM auth_saml_request_cache/.test(sql)) return { rows: [{ cache_value: 'request-value' }], rowCount: 1 };
    if (/INSERT INTO auth_saml_request_cache/.test(sql)) return { rows: [{ cache_value: params[1], created_at: new Date(1_700_000_000_000) }] };
    if (/SELECT cache_value/.test(sql)) return { rows: [{ cache_value: 'request-value' }] };
    return { rows: [], rowCount: 0 };
  } };
  const cache = createPgSamlCacheProvider({ pool, issuer: 'urn:identity-provider:test' });
  const other = createPgSamlCacheProvider({ pool, issuer: 'urn:identity-provider:other' });
  await cache.saveAsync('req-1', 'request-value');
  await other.saveAsync('req-1', 'other-provider-value');
  assert.notEqual(calls[0].params[0], calls[1].params[0]);
  assert.equal(calls[0].params[0].length, 97);
  assert.equal(calls[1].params[0].length, 97);
  assert.equal(await cache.getAsync('req-1'), 'request-value');
  assert.equal(await cache.consumeAsync('req-1'), 'request-value');
  assert.match(calls.at(-1).sql, /DELETE FROM auth_saml_request_cache[\s\S]*RETURNING cache_value/);
  assert.equal(await cache.consumeAsync(''), null);
});

test('S3 media store validates image signatures and writes object metadata before SQL metadata', async () => {
  const sent = [];
  class Command { constructor(input) { this.input = input; } }
  const commands = { PutObjectCommand: Command, DeleteObjectCommand: Command, GetObjectCommand: Command };
  const client = { async send(command) { sent.push(command); if (command instanceof commands.GetObjectCommand) return { Body: Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]) }; return {}; } };
  const poolCalls = [];
  const pool = { async query(sql, args) { poolCalls.push({ sql, args }); return { rows: [{ id: args[0], site_id: args[1], storage_key: args[2], mime_type: args[3], byte_size: args[4], alt_text: args[5], publicly_accessible: args[8], created_at: new Date() }] }; } };
  const store = createS3MediaStore({ pool, client, commands, env: { S3_BUCKET: 'systemfabric-assets', S3_REGION: 'us-east-1', CDN_BASE_URL: 'https://cdn.example.test', MEDIA_CDN_PUBLIC: 'true' } });
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
  await assert.rejects(() => store.upload({ siteId: 'site-a', dataBase64: Buffer.from('<svg/>').toString('base64'), mimeType: 'image/svg+xml' }), { code: 'ERR_SYSTEMFABRIC_MEDIA_INVALID' });
  assert.equal(sent.length, 0);
  const asset = await store.upload({ siteId: 'site-a', actorId: 'user-a', dataBase64: png.toString('base64'), mimeType: 'image/png', altText: 'Example' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].input.Key, /^site-a\//);
  assert.equal(store.publicUrl(asset).startsWith('https://cdn.example.test/site-a/'), true);
  assert.equal(poolCalls.length, 1);
});
