'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sniffMime, sanitizeDisplayName, decodeDataBase64 } = require('../packages/library/src/file-store');
const { listIcons, renderIcon } = require('../packages/icons/src/catalog');
const { validateFormula, renderMath } = require('../packages/math/src/renderer');
const { optimizeImage } = require('../packages/media/src/optimizer');
const { validateProduct, normalizeCart, calculateLineTotal } = require('../packages/commerce/src/validation');
const { validateProfile, validateGroup } = require('../packages/community/src/validation');
const { validateIpPattern, cidrContains, ruleMatches } = require('../packages/security/src/firewall');
const { cloudConfigStatus, cloudEndpointAllowed } = require('../packages/cloud/src/storage-adapters');
const { verifyStripeSignature } = require('../packages/billing/src/stripe');
const { validatePageDocument } = require('../packages/domain/src/page-document');
const { renderPageDocument } = require('../packages/render/src/index');
const { createHash, createHmac } = require('node:crypto');

test('library type detection trusts file signatures and rejects unsafe display names', () => {
  assert.equal(sniffMime(Buffer.from([137,80,78,71,13,10,26,10,0])), 'image/png');
  assert.equal(sniffMime(Buffer.from('%PDF-1.7 test')), 'application/pdf');
  assert.equal(sniffMime(Buffer.from('hello world')), 'text/plain');
  assert.equal(sniffMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'text/plain');
  assert.equal(sanitizeDisplayName('../../a\\b:<script>.png'), 'a-b--script-.png');
  assert.throws(() => decodeDataBase64('not base64!', 100), { code: 'ERR_SYSTEMFABRIC_LIBRARY_INVALID' });
});

test('icon catalog renders only curated SVG paths and escapes titles', () => {
  assert.ok(listIcons().length >= 10);
  const svg = renderIcon('check', { size: 24, title: '<script>alert(1)</script>' });
  assert.match(svg, /^<svg /);
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/i);
  assert.throws(() => renderIcon('unknown'), { code: 'ERR_SYSTEMFABRIC_ICON_NOT_FOUND' });
  assert.throws(() => renderIcon('check', { size: 1000 }), { code: 'ERR_SYSTEMFABRIC_ICON_OPTIONS' });
});

test('math formulas reject dangerous TeX commands and use an escaped fallback when KaTeX is absent', () => {
  assert.equal(validateFormula('\\frac{a}{b}').valid, true);
  assert.equal(validateFormula('\\href{javascript:alert(1)}{x}').valid, false);
  assert.equal(validateFormula('{x').valid, false);
  assert.throws(() => renderMath('\\write18{touch /tmp/x}'), { code: 'ERR_SYSTEMFABRIC_MATH_INVALID' });
  const fallback = renderMath('<script>x</script>', { katex: false });
  assert.equal(fallback.rendered, false);
  assert.match(fallback.html, /&lt;script&gt;/);
  assert.doesNotMatch(fallback.html, /<script>/i);
});

test('optional image optimization fails closed without a native image optimizer', async () => {
  const sentinel = async () => { throw new Error('must not run'); };
  const result = await optimizeImage(Buffer.from('not an image'), { sharp: false });
  assert.ok(result && typeof result.optimized === 'boolean');
  assert.ok(['optimizer-unavailable','not-smaller','converted-to-webp'].includes(result.reason));
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.equal(typeof sentinel, 'function');
});

test('commerce validation uses integer-safe minor-unit prices and bounded cart quantities', () => {
  assert.equal(validateProduct({ slug: 'book', name: 'Book', priceMinor: 1299, currency: 'USD', status: 'published' }, { requireStatus: true }).valid, true);
  assert.equal(validateProduct({ slug: 'bad slug', name: 'Book', priceMinor: 1.25, currency: 'USD', status: 'live' }, { requireStatus: true }).valid, false);
  const cart = normalizeCart([{ productId: '11111111-1111-4111-8111-111111111111', quantity: 2 }, { productId: '11111111-1111-4111-8111-111111111111', quantity: 3 }]);
  assert.equal(cart.valid, true); assert.equal(cart.items[0].quantity, 5);
  assert.equal(normalizeCart([{ productId: '11111111-1111-4111-8111-111111111111', quantity: 1001 }]).valid, false);
  assert.equal(calculateLineTotal(1299, 3), 3897);
  assert.throws(() => calculateLineTotal(Number.MAX_SAFE_INTEGER, 2), RangeError);
});

test('community profile and group validation rejects unsafe URLs and invalid slugs', () => {
  assert.equal(validateProfile({ displayName: 'Alice', websiteUrl: 'https://example.com', visibility: 'members' }).valid, true);
  assert.equal(validateProfile({ displayName: 'Alice', websiteUrl: 'javascript:alert(1)' }).valid, false);
  assert.equal(validateGroup({ slug: 'developers', name: 'Developers', privacy: 'private' }).valid, true);
  assert.equal(validateGroup({ slug: '../admin', name: 'Group' }).valid, false);
});

test('firewall validates IPv4 CIDR and matches exact safe rules', () => {
  assert.equal(validateIpPattern('cidr', '192.0.2.0/24'), true);
  assert.equal(validateIpPattern('cidr', '192.0.2.0/99'), false);
  assert.equal(cidrContains('192.0.2.55', '192.0.2.0/24'), true);
  assert.equal(cidrContains('192.0.3.55', '192.0.2.0/24'), false);
  assert.equal(validateIpPattern('path', '/admin/private'), true);
  assert.equal(validateIpPattern('path', '/admin/../secret'), false);
  assert.equal(ruleMatches({ enabled: true, scope: 'path', pattern: '/admin', action: 'deny' }, { path: '/admin/settings' }), true);
});

test('cloud configs only accept secret references and a whitelisted non-secret provider configuration', () => {
  assert.equal(cloudConfigStatus({ provider: 'aws-s3', credentialReference: 'env://SYSTEMFABRIC_STORAGE_KEY', config: { bucket: 'assets' } }).valid, true);
  assert.equal(cloudConfigStatus({ provider: 'aws-s3', credentialReference: 'super-secret-access-key', config: {} }).valid, false);
  assert.equal(cloudConfigStatus({ provider: 'aws-s3', credentialReference: 'vault://production/storage', config: {} }).valid, false, 'vault references must be resolved by an integration not present in this build');
  assert.equal(cloudConfigStatus({ provider: 'unknown', credentialReference: 'env://STORAGE_KEY', config: {} }).valid, false);
  assert.equal(cloudConfigStatus({ provider: 's3-compatible', credentialReference: 'env://AWS_SECRET_ACCESS_KEY', config: { accessKeyId: 'id', secretAccessKey: 'secret' } }).valid, false);
  assert.equal(cloudConfigStatus({ provider: 's3-compatible', credentialReference: 'env://AWS_SECRET_ACCESS_KEY', config: { endpoint: 'https://user:secret@bucket.example.test' } }).valid, false);
  assert.equal(cloudConfigStatus({ provider: 's3-compatible', credentialReference: 'env://AWS_SECRET_ACCESS_KEY', config: { endpoint: 'https://bucket.example.test?token=secret' } }).valid, false);
  assert.equal(cloudConfigStatus({ provider: 'google-cloud-storage', credentialReference: 'env://GOOGLE_APPLICATION_CREDENTIALS', config: { endpoint: 'https://storage.example.test' } }).valid, false, 'provider-specific ignored configuration is rejected');
  assert.equal(cloudEndpointAllowed('https://minio.example.test:9000', { NODE_ENV: 'production', SYSTEMFABRIC_CLOUD_ENDPOINT_ALLOWLIST: 'minio.example.test:9000' }), true);
  assert.equal(cloudEndpointAllowed('https://169.254.169.254', { NODE_ENV: 'production', SYSTEMFABRIC_CLOUD_ENDPOINT_ALLOWLIST: 'minio.example.test:9000' }), false);
  assert.equal(cloudEndpointAllowed('http://minio.example.test:9000', { NODE_ENV: 'production', SYSTEMFABRIC_CLOUD_ENDPOINT_ALLOWLIST: 'minio.example.test:9000' }), false);
});

test('Stripe webhook signatures are timestamped, compared in constant time, and reject stale payloads', () => {
  const raw = Buffer.from(JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' }));
  const timestamp = 1_800_000_000; const secret = 'whsec_test';
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  assert.equal(verifyStripeSignature(raw, `t=${timestamp},v1=${digest}`, secret, { nowSeconds: timestamp, toleranceSeconds: 300 }), true);
  assert.equal(verifyStripeSignature(raw, `t=${timestamp},v1=${digest}`, secret, { nowSeconds: timestamp + 600, toleranceSeconds: 300 }), false);
  assert.equal(verifyStripeSignature(Buffer.from('modified'), `t=${timestamp},v1=${digest}`, secret, { nowSeconds: timestamp, toleranceSeconds: 300 }), false);
});

test('page document supports video, icon, and math widgets and renders bounded deterministic HTML', () => {
  const document = { schemaVersion: 1, documentId: 'systemfabric-test-document', type: 'page', title: 'Mixed media', children: [
    { id: 'vid1', type: 'widget.video', props: { assetId: '00000000-0000-4000-8000-000000000001', title: 'Demo video', controls: true }, children: [] },
    { id: 'ico1', type: 'widget.icon', props: { iconName: 'check', size: 24, title: 'Complete' }, children: [] },
    { id: 'math1', type: 'widget.math', props: { formula: 'x^2+y^2=z^2', displayMode: true }, children: [] }
  ] };
  assert.equal(validatePageDocument(document).valid, true);
  const html = renderPageDocument(document);
  assert.match(html, /<video/); assert.match(html, /\/library\/public\/00000000-0000-4000-8000-000000000001/); assert.match(html, /<svg/); assert.match(html, /sf-math/);
  assert.doesNotMatch(html, /<script\b/i);
  const invalid = structuredClone(document); invalid.children[1].props.iconName = '<script>';
  assert.equal(validatePageDocument(invalid).valid, false);
  assert.ok(createHash('sha256').update(html).digest('hex').length === 64);
});
