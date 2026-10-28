'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { validateDesignTokens, cssVariables } = require('../packages/domain/src/design-system');
const { validateMenuItems } = require('../packages/domain/src/navigation');
const { generateTotpSecret, totpAt, verifyTotp, encryptSecret, decryptSecret } = require('../packages/auth/src/totp');
const { messageFor, sendEmail } = require('../packages/notifications/src/mailer');
const { configFromEnv } = require('../packages/auth/src/oidc');

 test('design tokens are constrained and produce only approved CSS variables', () => {
  const tokens = { colors: { brand: '#123456', paper: '#ffffff' }, spacing: { small: '8px' }, fontFamilies: { body: 'Inter, system-ui' }, fontWeights: { regular: '400' }, breakpoints: { tablet: 900 } };
  assert.equal(validateDesignTokens(tokens).valid, true);
  assert.match(cssVariables(tokens), /--sf-colors-brand:#123456/);
  assert.equal(validateDesignTokens({ colors: { brand: 'red;position:fixed' } }).valid, false);
  assert.equal(validateDesignTokens({ fontFamilies: { body: 'x;position:fixed' } }).valid, false);
  assert.equal(validateDesignTokens({ spacing: { gap: 'calc(1px + 2px)' } }).valid, false);
  assert.throws(() => cssVariables({ colors: { brand: 'red;}</style><script>' } }));
});

test('navigation menu validation rejects unsafe URLs, duplicate IDs, and excessive depth', () => {
  assert.equal(validateMenuItems([{ id: 'home', label: 'Home', type: 'url', url: '/' }]).valid, true);
  assert.equal(validateMenuItems([{ id: 'bad', label: 'Bad link', type: 'url', url: 'javascript:alert(1)' }]).valid, false);
  assert.equal(validateMenuItems([{ id: 'x', label: 'One', type: 'separator' }, { id: 'x', label: 'Two', type: 'separator' }]).valid, false);
  let deeplyNested = []; let cursor = deeplyNested;
  for (let depth = 0; depth < 8; depth += 1) { const item = { id: `item-${depth}`, label: 'Nested', type: 'separator', children: [] }; cursor.push(item); cursor = item.children; }
  assert.equal(validateMenuItems(deeplyNested).valid, false);
});

test('TOTP enrollment verifies a fresh time step and rejects step replay', () => {
  const secret = generateTotpSecret(); const now = 1_700_000_000_000; const step = Math.floor(now / 30_000); const code = totpAt(secret, step);
  assert.equal(verifyTotp(secret, code, { now, window: 0, lastUsedStep: step - 1 }), step);
  assert.equal(verifyTotp(secret, code, { now, window: 0, lastUsedStep: step }), null);
  assert.equal(verifyTotp(secret, 'bad', { now, window: 0 }), null);
});

test('MFA secrets are encrypted with authenticated encryption and require a 32-byte key', () => {
  const env = { SYSTEMFABRIC_MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64url') };
  const ciphertext = encryptSecret('BASE32SECRET', env);
  assert.notEqual(ciphertext, 'BASE32SECRET');
  assert.equal(decryptSecret(ciphertext, env), 'BASE32SECRET');
  assert.throws(() => decryptSecret(ciphertext, { SYSTEMFABRIC_MFA_ENCRYPTION_KEY: randomBytes(16).toString('base64url') }), { code: 'ERR_SYSTEMFABRIC_MFA_KEY_INVALID' });
  assert.throws(() => decryptSecret(ciphertext, { SYSTEMFABRIC_MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64url') }));
});

test('notification templates escape untrusted HTML and disabled delivery fails closed', async () => {
  const email = messageFor('site-invitation', { siteName: '<script>site</script>', inviteUrl: 'https://example.test/?q="x"', expiresAt: '<b>soon</b>' });
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;script&gt;/);
  assert.match(email.html, /&quot;x&quot;/);
  await assert.rejects(() => sendEmail({ recipient: 'person@example.test', template: 'generic', payload: {} }, { SYSTEMFABRIC_MAIL_PROVIDER: 'disabled' }), { code: 'ERR_SYSTEMFABRIC_MAIL_DISABLED' });
});

test('OIDC configuration requires HTTPS in production and never accepts URL credentials', () => {
  assert.throws(() => configFromEnv({ NODE_ENV: 'production', OIDC_ISSUER: 'http://issuer.example', OIDC_CLIENT_ID: 'client', OIDC_CLIENT_SECRET: 'secret', OIDC_REDIRECT_URI: 'https://cms.example/api/v1/auth/oidc/callback' }), { code: 'ERR_SYSTEMFABRIC_OIDC_HTTPS_REQUIRED' });
  assert.throws(() => configFromEnv({ NODE_ENV: 'production', OIDC_ISSUER: 'https://issuer.example', OIDC_CLIENT_ID: 'client', OIDC_CLIENT_SECRET: 'secret', OIDC_REDIRECT_URI: 'https://user:pass@cms.example/callback' }), { code: 'ERR_SYSTEMFABRIC_OIDC_CONFIG' });
  assert.equal(configFromEnv({ NODE_ENV: 'production', OIDC_ISSUER: 'https://issuer.example', OIDC_CLIENT_ID: 'client', OIDC_CLIENT_SECRET: 'secret', OIDC_REDIRECT_URI: 'https://cms.example/api/v1/auth/oidc/callback' }).issuer, 'https://issuer.example');
});
