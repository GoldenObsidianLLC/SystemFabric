'use strict';

const crypto = require('node:crypto');

function digestForArtifact(value) {
  if (typeof value !== 'string') return '';
  const matched = value.match(/(?:^|@)sha256:([a-f0-9]{64})$/i);
  if (matched) return matched[1].toLowerCase();
  return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : '';
}

function signedArtifactPayload({ manifest, artifactDigest, sourceType, sbomDigest }) {
  const digest = digestForArtifact(artifactDigest);
  if (!digest) throw new TypeError('artifactDigest must be a SHA-256 digest.');
  if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || manifest.apiVersion !== 1) throw new TypeError('A valid API v1 plugin manifest is required.');
  if (!['npm-archive', 'oci-image'].includes(sourceType)) throw new TypeError('Unsupported plugin sourceType.');
  const normalizedSbom = digestForArtifact(sbomDigest);
  if (!normalizedSbom) throw new TypeError('sbomDigest must be a SHA-256 digest.');
  // This canonical property order is a signed contract. Changes require a new version.
  return Buffer.from(JSON.stringify({ apiVersion: 1, name: manifest.name, version: manifest.version, artifactDigest: digest, sbomDigest: normalizedSbom, sourceType }), 'utf8');
}

function trustedKeysFromEnv(raw) {
  if (typeof raw !== 'string' || raw.length > 64 * 1024) return Object.create(null);
  try {
    const keys = JSON.parse(raw);
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return Object.create(null);
    const result = Object.create(null);
    for (const [keyId, pem] of Object.entries(keys)) {
      if (!/^[a-zA-Z0-9._-]{1,100}$/.test(keyId) || typeof pem !== 'string' || pem.length > 16_384) continue;
      try {
        const key = crypto.createPublicKey(pem);
        if (key.asymmetricKeyType === 'ed25519') result[keyId] = key;
      } catch { /* Ignore malformed trust entries rather than making them usable. */ }
    }
    return result;
  } catch { return Object.create(null); }
}

function verifyPluginArtifactSignature({ manifest, artifactDigest, sbomDigest, sourceType, keyId, signature, trustedKeys }) {
  const digest = digestForArtifact(artifactDigest);
  if (!digest) return { valid: false, reason: 'ERR_SYSTEMFABRIC_PLUGIN_ARTIFACT_DIGEST' };
  if (typeof signature !== 'string' || signature.length < 40 || signature.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(signature)) return { valid: false, reason: 'ERR_SYSTEMFABRIC_PLUGIN_SIGNATURE_MISSING_OR_INVALID' };
  const keys = trustedKeys && typeof trustedKeys === 'object' ? trustedKeys : Object.create(null);
  let key = keys[keyId];
  try { if (typeof key === 'string') key = crypto.createPublicKey(key); } catch { key = null; }
  if (!key || key.asymmetricKeyType !== 'ed25519') return { valid: false, reason: 'ERR_SYSTEMFABRIC_PLUGIN_SIGNING_KEY_UNTRUSTED' };
  try {
    const payload = signedArtifactPayload({ manifest, artifactDigest: digest, sbomDigest, sourceType });
    const decoded = Buffer.from(signature, 'base64url');
    if (decoded.length !== 64) return { valid: false, reason: 'ERR_SYSTEMFABRIC_PLUGIN_SIGNATURE_INVALID' };
    const valid = crypto.verify(null, payload, key, decoded);
    return { valid, reason: valid ? null : 'ERR_SYSTEMFABRIC_PLUGIN_SIGNATURE_INVALID', artifactDigest: digest, sbomDigest: digestForArtifact(sbomDigest), keyId };
  } catch { return { valid: false, reason: 'ERR_SYSTEMFABRIC_PLUGIN_SIGNATURE_INVALID' }; }
}

function signPluginArtifact({ manifest, artifactDigest, sbomDigest, sourceType, privateKey }) {
  const key = privateKey && privateKey.type === 'private' && privateKey.asymmetricKeyType === 'ed25519' ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Plugin artifact signatures require an Ed25519 private key.');
  return crypto.sign(null, signedArtifactPayload({ manifest, artifactDigest, sbomDigest, sourceType }), key).toString('base64url');
}

module.exports = { digestForArtifact, signedArtifactPayload, trustedKeysFromEnv, verifyPluginArtifactSignature, signPluginArtifact };
