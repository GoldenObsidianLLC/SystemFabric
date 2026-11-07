'use strict';
const { createHmac, timingSafeEqual, createHash, randomUUID } = require('node:crypto');

function billingError(message, code = 'ERR_VIRGOSCORPIO_HUB_BILLING_CONFIG', statusCode = 400) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
function verifyStripeSignature(rawBody, header, secret, { nowSeconds = Math.floor(Date.now()/1000), toleranceSeconds = 300 } = {}) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || typeof secret !== 'string' || !secret) return false;
  const fields = Object.create(null);
  for (const item of header.split(',')) { const i=item.indexOf('='); if (i < 0) continue; const k=item.slice(0,i), v=item.slice(i+1); if (k === 't' || k === 'v1') (fields[k] ||= []).push(v); }
  const timestamp = Number(fields.t?.[0]); if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds-timestamp)>toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return (fields.v1 || []).some(value => { if (!/^[a-f0-9]{64}$/i.test(value)) return false; const got=Buffer.from(value,'hex'); return got.length===expected.length && timingSafeEqual(got,expected); });
}
async function createStripeCheckoutSession({ secretKey, mode = 'payment', lineItems, successUrl, cancelUrl, customerEmail, metadata = {}, idempotencyKey = randomUUID(), fetchImpl = fetch, subscriptionMetadata = null, expiresAt = null, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (typeof secretKey !== 'string' || !secretKey.startsWith('sk_')) throw billingError('STRIPE_SECRET_KEY is not configured.', 'ERR_VIRGOSCORPIO_HUB_BILLING_DISABLED', 503);
  if (!['payment','subscription'].includes(mode) || !Array.isArray(lineItems) || lineItems.length < 1 || lineItems.length > 100) throw billingError('Checkout mode or line items are invalid.');
  for (const item of lineItems) if (!item || !/^[A-Z]{3}$/.test(item.currency) || !Number.isSafeInteger(item.unitAmount) || item.unitAmount < 0 || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000 || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 250) throw billingError('A checkout line item is invalid.');
  for (const value of [successUrl,cancelUrl]) { let u; try { u=new URL(value); } catch { throw billingError('Success and cancellation URLs must be absolute URLs.'); } if (!['https:','http:'].includes(u.protocol) || u.username || u.password || (process.env.NODE_ENV === 'production' && u.protocol !== 'https:')) throw billingError('Checkout URLs must use HTTPS in production and cannot contain credentials.'); }
  if (expiresAt !== null) {
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 ||
        !Number.isSafeInteger(expiresAt) || expiresAt < nowSeconds + 30 * 60 || expiresAt > nowSeconds + 24 * 60 * 60) {
      throw billingError('Checkout expiration must be between 30 minutes and 24 hours from now.');
    }
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
    const error = billingError('Payment provider request outcome is unknown. Retry with the same idempotency key to recover the session.', 'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN', 502);
    error.cause = cause;
    throw error;
  }
  let raw;
  try { raw = await response.text(); } catch (cause) {
    const error = billingError('Payment provider response was interrupted. Retry with the same idempotency key to recover the session.', 'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN', 502);
    error.cause = cause;
    throw error;
  }
  if (!response.ok && Number(response.status) >= 500) throw billingError('Payment provider response is ambiguous. Retry with the same idempotency key to recover the session.', 'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN', 502);
  let data; try { data=JSON.parse(raw); } catch { throw billingError('Payment provider returned an unreadable response.','ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER',502); }
  if (!response.ok) throw billingError('Payment provider rejected checkout.','ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER',502);
  if (typeof data.url !== 'string' || typeof data.id !== 'string') throw billingError('Payment provider returned an incomplete checkout session.','ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER',502);
  return { id:data.id, url:data.url, mode:data.mode, status:data.status, paymentStatus:data.payment_status, customerId:data.customer || null, subscriptionId:data.subscription || null };
}
async function createStripeRefund({
  secretKey,
  paymentIntentId,
  amountMinor,
  reason = 'requested_by_customer',
  idempotencyKey,
  metadata = {},
  fetchImpl = fetch
}) {
  if (typeof secretKey !== 'string' || !secretKey.startsWith('sk_')) {
    throw billingError('STRIPE_SECRET_KEY is not configured.', 'ERR_VIRGOSCORPIO_HUB_BILLING_DISABLED', 503);
  }
  if (typeof paymentIntentId !== 'string' || !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) {
    throw billingError('A valid Stripe payment intent is required.');
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
    throw billingError('Refund amount must be a positive safe integer.');
  }
  if (!['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)) {
    throw billingError('Refund reason is invalid.');
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,255}$/.test(idempotencyKey)) {
    throw billingError('Refund idempotency key is invalid.');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw billingError('Refund metadata must be an object.');
  }

  const form = new URLSearchParams();
  form.set('payment_intent', paymentIntentId);
  form.set('amount', String(amountMinor));
  form.set('reason', reason);
  for (const [key, value] of Object.entries(metadata)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || typeof value !== 'string' || value.length > 500) {
      throw billingError('Refund metadata is invalid.');
    }
    form.set(`metadata[${key}]`, value);
  }

  let response;
  try {
    response = await fetchImpl('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': idempotencyKey
      },
      body: form.toString()
    });
  } catch (cause) {
    const error = billingError(
      'Refund provider outcome is unknown. Retry with the same idempotency key to recover the refund.',
      'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN',
      502
    );
    error.cause = cause;
    throw error;
  }

  let raw;
  try {
    raw = await response.text();
  } catch (cause) {
    const error = billingError(
      'Refund provider response was interrupted. Retry with the same idempotency key to recover the refund.',
      'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN',
      502
    );
    error.cause = cause;
    throw error;
  }

  const statusCode = Number(response.status);
  if (!response.ok && (statusCode >= 500 || statusCode === 429)) {
    throw billingError(
      'Refund provider outcome is unknown. Retry with the same idempotency key to recover the refund.',
      'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN',
      502
    );
  }
  if (!response.ok) {
    throw billingError('Payment provider rejected the refund.', 'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER', 502);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw billingError(
      'Refund provider response was unreadable; the refund outcome must be reconciled.',
      'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN',
      502
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw billingError(
      'Refund provider response had an invalid shape; the refund outcome must be reconciled.',
      'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN',
      502
    );
  }

  const returnedPaymentIntentId = typeof data.payment_intent === 'string'
    ? data.payment_intent
    : data.payment_intent && typeof data.payment_intent.id === 'string'
      ? data.payment_intent.id
      : null;
  const validStatuses = new Set(['pending', 'requires_action', 'succeeded', 'failed', 'canceled']);
  if (
    typeof data.id !== 'string' || !/^re_[A-Za-z0-9]+$/.test(data.id) ||
    returnedPaymentIntentId !== paymentIntentId ||
    data.amount !== amountMinor ||
    typeof data.currency !== 'string' || !/^[a-zA-Z]{3}$/.test(data.currency) ||
    !validStatuses.has(data.status)
  ) {
    throw billingError(
      'Refund provider response did not match the requested payment and amount; reconcile before retrying.',
      'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN',
      502
    );
  }

  return {
    id: data.id,
    paymentIntentId: returnedPaymentIntentId,
    amount: data.amount,
    currency: data.currency.toUpperCase(),
    reason: data.reason || reason,
    status: data.status
  };
}

/**
 * Retrieves the current Stripe subscription snapshot.
 *
 * Webhook snapshots are immutable and Stripe does not guarantee delivery order.
 * Call this after locking the locally bound membership row so concurrent event
 * handlers serialize and each applies the provider's current state, not a stale
 * event-time snapshot.
 */
async function retrieveStripeSubscription({
  secretKey,
  subscriptionId,
  fetchImpl = fetch,
  timeoutMs = 5000
}) {
  if (typeof secretKey !== 'string' || !secretKey.startsWith('sk_')) {
    throw billingError('STRIPE_SECRET_KEY is required to reconcile subscription events.', 'ERR_VIRGOSCORPIO_HUB_BILLING_DISABLED', 503);
  }
  if (typeof subscriptionId !== 'string' || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
    throw billingError('A valid Stripe subscription ID is required.', 'ERR_VIRGOSCORPIO_HUB_BILLING_WEBHOOK_INVALID', 400);
  }
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw billingError('Stripe subscription retrieval is not configured.', 'ERR_VIRGOSCORPIO_HUB_BILLING_CONFIG', 503);
  }

  let response;
  try {
    response = await fetchImpl(
      'https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(subscriptionId),
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer ' + secretKey,
          accept: 'application/json'
        },
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
  } catch (cause) {
    const error = billingError(
      'Stripe subscription state could not be retrieved. The webhook will be retried.',
      'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER_UNAVAILABLE',
      503
    );
    error.cause = cause;
    throw error;
  }

  let raw;
  try {
    raw = await response.text();
  } catch (cause) {
    const error = billingError(
      'Stripe subscription response was interrupted. The webhook will be retried.',
      'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER_UNAVAILABLE',
      503
    );
    error.cause = cause;
    throw error;
  }

  if (!response.ok) {
    const temporary = Number(response.status) === 429 || Number(response.status) >= 500;
    throw billingError(
      'Stripe subscription state could not be retrieved. The webhook will be retried.',
      temporary ? 'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER_UNAVAILABLE' : 'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER',
      temporary ? 503 : 502
    );
  }

  let subscription;
  try {
    subscription = JSON.parse(raw);
  } catch {
    throw billingError(
      'Stripe returned an unreadable subscription response. The webhook will be retried.',
      'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER_UNAVAILABLE',
      503
    );
  }

  if (
    !subscription ||
    typeof subscription !== 'object' ||
    Array.isArray(subscription) ||
    subscription.id !== subscriptionId ||
    typeof subscription.status !== 'string' ||
    !subscription.metadata ||
    typeof subscription.metadata !== 'object' ||
    Array.isArray(subscription.metadata)
  ) {
    throw billingError(
      'Stripe returned a subscription response that did not match the requested resource.',
      'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER',
      502
    );
  }

  return subscription;
}

function normalizeStripeRefundStatus(status) {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'canceled') return 'cancelled';
  return 'pending';
}

function digestWebhookBody(rawBody) { return createHash('sha256').update(rawBody).digest('hex'); }
module.exports = {
  verifyStripeSignature,
  createStripeCheckoutSession,
  createStripeRefund,
  retrieveStripeSubscription,
  normalizeStripeRefundStatus,
  digestWebhookBody,
  billingError
};
