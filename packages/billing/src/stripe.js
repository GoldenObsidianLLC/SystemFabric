'use strict';
const { createHmac, timingSafeEqual, createHash, randomUUID } = require('node:crypto');

function billingError(message, code = 'ERR_SYSTEMFABRIC_BILLING_CONFIG', statusCode = 400) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
function verifyStripeSignature(rawBody, header, secret, { nowSeconds = Math.floor(Date.now()/1000), toleranceSeconds = 300 } = {}) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || typeof secret !== 'string' || !secret) return false;
  const fields = Object.create(null);
  for (const item of header.split(',')) { const i=item.indexOf('='); if (i < 0) continue; const k=item.slice(0,i), v=item.slice(i+1); if (k === 't' || k === 'v1') (fields[k] ||= []).push(v); }
  const timestamp = Number(fields.t?.[0]); if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds-timestamp)>toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return (fields.v1 || []).some(value => { if (!/^[a-f0-9]{64}$/i.test(value)) return false; const got=Buffer.from(value,'hex'); return got.length===expected.length && timingSafeEqual(got,expected); });
}
async function createStripeCheckoutSession({ secretKey, mode = 'payment', lineItems, successUrl, cancelUrl, customerEmail, metadata = {}, idempotencyKey = randomUUID(), fetchImpl = fetch, subscriptionMetadata = null, expiresAt = null }) {
  if (typeof secretKey !== 'string' || !secretKey.startsWith('sk_')) throw billingError('STRIPE_SECRET_KEY is not configured.', 'ERR_SYSTEMFABRIC_BILLING_DISABLED', 503);
  if (!['payment','subscription'].includes(mode) || !Array.isArray(lineItems) || lineItems.length < 1 || lineItems.length > 100) throw billingError('Checkout mode or line items are invalid.');
  for (const item of lineItems) if (!item || !/^[A-Z]{3}$/.test(item.currency) || !Number.isSafeInteger(item.unitAmount) || item.unitAmount < 0 || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000 || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 250) throw billingError('A checkout line item is invalid.');
  for (const value of [successUrl,cancelUrl]) { let u; try { u=new URL(value); } catch { throw billingError('Success and cancellation URLs must be absolute URLs.'); } if (!['https:','http:'].includes(u.protocol) || u.username || u.password || (process.env.NODE_ENV === 'production' && u.protocol !== 'https:')) throw billingError('Checkout URLs must use HTTPS in production and cannot contain credentials.'); }
  if (expiresAt !== null) {
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < now + 30 * 60 || expiresAt > now + 24 * 60 * 60) throw billingError('Checkout expiration must be between 30 minutes and 24 hours from now.');
  }
  const form = new URLSearchParams(); form.set('mode',mode); form.set('success_url',successUrl); form.set('cancel_url',cancelUrl);
  if (expiresAt !== null) form.set('expires_at', String(expiresAt));
  if (customerEmail) { if (typeof customerEmail !== 'string' || customerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw billingError('Customer email is invalid.'); form.set('customer_email',customerEmail); }
  for (const [key,value] of Object.entries(metadata)) { if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || String(value).length > 500) throw billingError('Checkout metadata is invalid.'); form.set(`metadata[${key}]`,String(value)); }
  lineItems.forEach((item,i) => { form.set(`line_items[${i}][quantity]`,String(item.quantity)); form.set(`line_items[${i}][price_data][currency]`,item.currency.toLowerCase()); form.set(`line_items[${i}][price_data][unit_amount]`,String(item.unitAmount)); form.set(`line_items[${i}][price_data][product_data][name]`,item.name); if (item.description) form.set(`line_items[${i}][price_data][product_data][description]`,String(item.description).slice(0,500)); if (mode === 'subscription' && item.interval && ['month','year'].includes(item.interval)) { form.set(`line_items[${i}][price_data][recurring][interval]`,item.interval); form.set(`line_items[${i}][price_data][recurring][interval_count]`,String(Math.max(1,Math.min(12,item.intervalCount||1)))); } });
  if (subscriptionMetadata) for (const [key,value] of Object.entries(subscriptionMetadata)) form.set(`subscription_data[metadata][${key}]`,String(value));
  let response;
  try {
    response = await fetchImpl('https://api.stripe.com/v1/checkout/sessions',{ method:'POST', headers:{ authorization:`Bearer ${secretKey}`, 'content-type':'application/x-www-form-urlencoded', 'idempotency-key':idempotencyKey }, body:form.toString() });
  } catch (cause) {
    const error = billingError('Payment provider request outcome is unknown. Retry with the same idempotency key to recover the session.', 'ERR_SYSTEMFABRIC_BILLING_OUTCOME_UNKNOWN', 502);
    error.cause = cause;
    throw error;
  }
  let raw;
  try { raw = await response.text(); } catch (cause) {
    const error = billingError('Payment provider response was interrupted. Retry with the same idempotency key to recover the session.', 'ERR_SYSTEMFABRIC_BILLING_OUTCOME_UNKNOWN', 502);
    error.cause = cause;
    throw error;
  }
  if (!response.ok && Number(response.status) >= 500) throw billingError('Payment provider response is ambiguous. Retry with the same idempotency key to recover the session.', 'ERR_SYSTEMFABRIC_BILLING_OUTCOME_UNKNOWN', 502);
  let data; try { data=JSON.parse(raw); } catch { throw billingError('Payment provider returned an unreadable response.','ERR_SYSTEMFABRIC_BILLING_PROVIDER',502); }
  if (!response.ok) throw billingError('Payment provider rejected checkout.','ERR_SYSTEMFABRIC_BILLING_PROVIDER',502);
  if (typeof data.url !== 'string' || typeof data.id !== 'string') throw billingError('Payment provider returned an incomplete checkout session.','ERR_SYSTEMFABRIC_BILLING_PROVIDER',502);
  return { id:data.id, url:data.url, mode:data.mode, status:data.status, paymentStatus:data.payment_status, customerId:data.customer || null, subscriptionId:data.subscription || null };
}
function digestWebhookBody(rawBody) { return createHash('sha256').update(rawBody).digest('hex'); }
module.exports = { verifyStripeSignature, createStripeCheckoutSession, digestWebhookBody, billingError };
