'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeCart, validateProduct, calculateLineTotal } = require('../../../packages/commerce/src/validation');
const { createStripeCheckoutSession, createStripeRefund, normalizeStripeRefundStatus } = require('../../../packages/billing/src/stripe');
const { releaseOrderStockReservations } = require('../../../packages/commerce/src/stock-reservations');
const { isBoundedJsonObject } = require('./request-validation');

function productInput(body) {
  return { slug: body.slug, name: body.name, description: body.description || '', productType: body.productType || 'simple', status: body.status || 'draft', currency: body.currency || 'USD', priceMinor: body.priceMinor, compareAtPriceMinor: body.compareAtPriceMinor ?? null, sku: body.sku || null, inventoryQuantity: body.inventoryQuantity === undefined ? null : body.inventoryQuantity, stockStatus: body.stockStatus || (body.inventoryQuantity === 0 ? 'out_of_stock' : 'in_stock'), requiresShipping: body.requiresShipping === true, weightGrams: body.weightGrams ?? null, images: body.images || [], attributes: body.attributes || {}, metadata: body.metadata || {} };
}

function checkoutOrderResponse(row) {
  return { id: row.id, order_number: row.order_number, status: row.status, currency: row.currency, total_minor: row.total_minor, provider_session_id: row.provider_session_id || null, metadata: { checkoutUrl: row.metadata?.checkoutUrl || null, checkoutExpiresAt: row.metadata?.checkoutExpiresAt || null }, created_at: row.created_at };
}

/**
 * Handle the site-scoped commerce and membership route family.
 *
 * Interface: HTTP request/response, parsed URL, authenticated actor, site and
 * capability guards, bounded body reader, response/error constructors, and
 * the PostgreSQL/Stripe dependencies used by these routes. Every database
 * query retains its site predicate; payment state and inventory transitions
 * remain owned by their existing transactional persistence modules.
 * Returns false only when the path/method is not owned by this route family.
 */
async function handleCommerceRoute(ctx) {
  const { req, res, url, actor, siteIdFor, requireCapability, readJson, sendJson, fail, requestId, localPool, env, identity, maxBody } = ctx;
  const pathName = url.pathname;
  const method = req.method;
  const products=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/products$/i);
  const product=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/products\/([0-9a-f-]{36})$/i);
  if((products&&['GET','POST'].includes(method))||(product&&['GET','PUT','DELETE'].includes(method))){
    if(!localPool)throw fail(503,'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED','Commerce requires PostgreSQL.');const siteId=products?.[1]||product[1];const body=['POST','PUT','DELETE'].includes(method)?await readJson(req,Math.min(maxBody,300_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });await requireCapability(actor,siteId,method==='GET'?'commerce:read':'commerce:manage');
    if(products&&method==='GET'){const result=await localPool.query('SELECT id,slug,name,description,product_type,status,currency,price_minor,compare_at_price_minor,sku,inventory_quantity,stock_status,requires_shipping,weight_grams,images,attributes,metadata,version,created_at,updated_at FROM commerce_products WHERE site_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4',[siteId,url.searchParams.get('status'),Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||50)),Math.max(0,Number(url.searchParams.get('offset'))||0)]);return sendJson(res,200,{products:result.rows,requestId});}
    if(products&&method==='POST'){const input=productInput(body),validation=validateProduct(input,{requireStatus:true});if(!validation.valid)throw fail(422,validation.code,'Product validation failed.',validation.errors);const q=await localPool.query(`INSERT INTO commerce_products(site_id,slug,name,description,product_type,status,currency,price_minor,compare_at_price_minor,sku,inventory_quantity,stock_status,requires_shipping,weight_grams,images,attributes,metadata,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18)
      RETURNING id,site_id,slug,name,description,product_type,status,currency,price_minor,compare_at_price_minor,sku,inventory_quantity,stock_status,requires_shipping,weight_grams,images,attributes,metadata,version,created_at,updated_at`,[siteId,input.slug,input.name.trim(),input.description,input.productType,input.status,input.currency,input.priceMinor,input.compareAtPriceMinor,input.sku,input.inventoryQuantity,input.stockStatus,input.requiresShipping,input.weightGrams,JSON.stringify(input.images),JSON.stringify(input.attributes),JSON.stringify(input.metadata),actor.user.id||null]);return sendJson(res,201,{product:q.rows[0],requestId});}
    if(product&&method==='GET'){const q=await localPool.query('SELECT * FROM commerce_products WHERE site_id=$1 AND id=$2',[siteId,product[2]]);if(!q.rows[0])throw fail(404,'ERR_VIRGOSCORPIO_HUB_PRODUCT_NOT_FOUND','Product not found.');return sendJson(res,200,{product:q.rows[0],requestId});}
    if(product&&method==='DELETE'){const q=await localPool.query("UPDATE commerce_products SET status='archived',version=version+1,updated_at=now() WHERE site_id=$1 AND id=$2 AND version=$3 RETURNING id,status,version",[siteId,product[2],Number(body.expectedVersion)]);if(!q.rows[0])throw fail(409,'ERR_VIRGOSCORPIO_HUB_VERSION_CONFLICT','Product missing or version is stale.');return sendJson(res,200,{product:q.rows[0],requestId});}
    if(product&&method==='PUT'){const input=productInput(body),validation=validateProduct(input,{requireStatus:true});if(!validation.valid)throw fail(422,validation.code,'Product validation failed.',validation.errors);const q=await localPool.query(`UPDATE commerce_products SET slug=$3,name=$4,description=$5,product_type=$6,status=$7,currency=$8,price_minor=$9,compare_at_price_minor=$10,sku=$11,inventory_quantity=$12,stock_status=$13,requires_shipping=$14,weight_grams=$15,images=$16::jsonb,attributes=$17::jsonb,metadata=$18::jsonb,version=version+1,updated_at=now() WHERE site_id=$1 AND id=$2 AND version=$19 RETURNING *`,[siteId,product[2],input.slug,input.name.trim(),input.description,input.productType,input.status,input.currency,input.priceMinor,input.compareAtPriceMinor,input.sku,input.inventoryQuantity,input.stockStatus,input.requiresShipping,input.weightGrams,JSON.stringify(input.images),JSON.stringify(input.attributes),JSON.stringify(input.metadata),Number(body.expectedVersion)]);if(!q.rows[0])throw fail(409,'ERR_VIRGOSCORPIO_HUB_VERSION_CONFLICT','Product missing or version is stale.');return sendJson(res,200,{product:q.rows[0],requestId});}
  }

  const orders=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/commerce\/orders(?:\/([0-9a-f-]{36}))?$/i);
  if(orders&&['GET','POST'].includes(method)){
    if(!localPool)throw fail(503,'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED','Orders require PostgreSQL.');const siteId=orders[1];const body=method==='POST'?await readJson(req,Math.min(maxBody,150_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });await requireCapability(actor,siteId,method==='GET'?'commerce:read':'commerce:manage');
    if(method==='GET'){const result=await localPool.query('SELECT id,order_number,customer_id,email,status,currency,subtotal_minor,discount_minor,tax_minor,shipping_minor,total_minor,provider,provider_session_id,created_at,updated_at FROM commerce_orders WHERE site_id=$1 ORDER BY created_at DESC LIMIT $2',[siteId,Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||50))]);return sendJson(res,200,{orders:result.rows,requestId});}
    // Admin-created orders are possible, but payment checkout is handled through the customer-facing endpoint below.
    throw fail(409,'ERR_VIRGOSCORPIO_HUB_CHECKOUT_ENDPOINT','Use the public checkout endpoint; administrators cannot set order totals directly.');
  }
  const orderRefunds = pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/commerce\/orders\/([0-9a-f-]{36})\/refunds$/i);
  if (method === 'POST' && orderRefunds) {
    if (!localPool) throw fail(503, 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', 'Refunds require PostgreSQL.');
    const siteId = orderRefunds[1];
    const orderId = orderRefunds[2];
    const body = await readJson(req, Math.min(maxBody, 16_000));
    await siteIdFor({ req, url, body, actor, routeSiteId: siteId });
    await requireCapability(actor, siteId, 'commerce:manage');

    if (typeof env.STRIPE_SECRET_KEY !== 'string' || !env.STRIPE_SECRET_KEY.startsWith('sk_')) {
      throw fail(503, 'ERR_VIRGOSCORPIO_HUB_BILLING_DISABLED', 'Stripe refunds are not configured.');
    }
    if (!isBoundedJsonObject(body, 16_000)) {
      throw fail(400, 'ERR_VIRGOSCORPIO_HUB_REFUND_REQUEST_INVALID', 'Refund request must be a JSON object.');
    }
    const amountMinor = body.amountMinor;
    const reason = body.reason === undefined ? 'requested_by_customer' : body.reason;
    const bodyIdempotencyKey = body.idempotencyKey;
    const headerIdempotencyKey = req.headers?.['idempotency-key'];
    if (bodyIdempotencyKey && headerIdempotencyKey && bodyIdempotencyKey !== headerIdempotencyKey) {
      throw fail(400, 'ERR_VIRGOSCORPIO_HUB_REFUND_IDEMPOTENCY', 'The body and Idempotency-Key header must match when both are supplied.');
    }
    const idempotencyKey = headerIdempotencyKey || bodyIdempotencyKey;
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
      throw fail(422, 'ERR_VIRGOSCORPIO_HUB_REFUND_AMOUNT', 'Refund amount must be a positive safe integer in the order currency minor unit.');
    }
    if (!['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)) {
      throw fail(422, 'ERR_VIRGOSCORPIO_HUB_REFUND_REASON', 'Refund reason is invalid.');
    }
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(idempotencyKey)) {
      throw fail(400, 'ERR_VIRGOSCORPIO_HUB_REFUND_IDEMPOTENCY', 'A valid refund idempotency key is required.');
    }

    let refund;
    let paymentIntentId;
    let refundIsReplay = false;
    const client = await localPool.connect();
    try {
      await client.query('BEGIN');
      const orderResult = await client.query(
        'SELECT id,status,currency,total_minor,provider,provider_payment_id FROM commerce_orders WHERE site_id=$1 AND id=$2 FOR UPDATE',
        [siteId, orderId]
      );
      const order = orderResult.rows[0];
      if (!order) throw fail(404, 'ERR_VIRGOSCORPIO_HUB_ORDER_NOT_FOUND', 'Order not found.');
      if (order.provider !== 'stripe' || typeof order.provider_payment_id !== 'string' || !/^pi_[A-Za-z0-9]+$/.test(order.provider_payment_id)) {
        throw fail(409, 'ERR_VIRGOSCORPIO_HUB_REFUND_PAYMENT_UNAVAILABLE', 'This order has no confirmed Stripe payment available for refund.');
      }
      paymentIntentId = order.provider_payment_id;
      const currency = String(order.currency || '').toUpperCase();

      const existingResult = await client.query(
        'SELECT id,site_id,order_id,provider,provider_refund_id,amount_minor,currency,reason,status,created_at,updated_at FROM commerce_refunds WHERE site_id=$1 AND order_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [siteId, orderId, idempotencyKey]
      );
      refund = existingResult.rows[0] || null;
      if (refund) {
        refundIsReplay = true;
        if (
          refund.provider !== 'stripe' ||
          BigInt(refund.amount_minor) !== BigInt(amountMinor) ||
          String(refund.currency).toUpperCase() !== currency ||
          String(refund.reason) !== reason
        ) {
          throw fail(409, 'ERR_VIRGOSCORPIO_HUB_REFUND_IDEMPOTENCY_CONFLICT', 'This refund idempotency key was already used with different refund parameters.');
        }
        if (['succeeded', 'failed', 'cancelled'].includes(refund.status)) {
          await client.query('COMMIT');
          return sendJson(res, 200, {
            refund: {
              id: refund.id,
              providerRefundId: refund.provider_refund_id || null,
              amountMinor: Number(refund.amount_minor),
              currency: String(refund.currency).toUpperCase(),
              reason: refund.reason,
              status: refund.status
            },
            idempotentReplay: true,
            requestId
          });
        }
      } else {
        if (!['paid', 'processing', 'fulfilled'].includes(order.status)) {
          throw fail(409, 'ERR_VIRGOSCORPIO_HUB_REFUND_ORDER_STATE', 'Only a paid, processing, or fulfilled order can be refunded.');
        }
        const reservedResult = await client.query(
          "SELECT COALESCE(SUM(amount_minor),0)::text AS reserved_minor FROM commerce_refunds WHERE site_id=$1 AND order_id=$2 AND status IN ('requested','pending','succeeded')",
          [siteId, orderId]
        );
        const alreadyReserved = BigInt(reservedResult.rows[0]?.reserved_minor || '0');
        const orderTotal = BigInt(order.total_minor);
        if (alreadyReserved + BigInt(amountMinor) > orderTotal) {
          throw fail(409, 'ERR_VIRGOSCORPIO_HUB_REFUND_EXCEEDS_BALANCE', 'Refund amount exceeds the remaining refundable order balance.');
        }
        const inserted = await client.query(
          "INSERT INTO commerce_refunds(site_id,order_id,provider,amount_minor,currency,reason,status,created_by,idempotency_key) VALUES($1,$2,'stripe',$3,$4,$5,'requested',$6,$7) RETURNING id,site_id,order_id,provider,provider_refund_id,amount_minor,currency,reason,status,created_at,updated_at",
          [siteId, orderId, amountMinor, currency, reason, actor?.user?.id || null, idempotencyKey]
        );
        refund = inserted.rows[0];
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    let providerRefund;
    try {
      providerRefund = await createStripeRefund({
        secretKey: env.STRIPE_SECRET_KEY,
        paymentIntentId,
        amountMinor: Number(refund.amount_minor),
        reason: refund.reason,
        idempotencyKey: `vsh_refund_${refund.id}`,
        metadata: { site_id: siteId, order_id: orderId, refund_id: refund.id }
      });
    } catch (error) {
      if (error.code !== 'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN') {
        const update = await localPool.connect();
        try {
          await update.query('BEGIN');
          await update.query(
            "UPDATE commerce_refunds SET status='failed',updated_at=now() WHERE site_id=$1 AND order_id=$2 AND id=$3 AND provider='stripe' AND status IN ('requested','pending')",
            [siteId, orderId, refund.id]
          );
          await update.query('COMMIT');
        } catch {
          await update.query('ROLLBACK').catch(() => {});
          throw fail(502, 'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN', 'Refund rejection could not be recorded; retry with the same idempotency key.');
        } finally {
          update.release();
        }
      }
      if (error.code === 'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN') {
        throw fail(502, error.code, 'Refund provider outcome is unknown. Retry with the same idempotency key to recover the existing refund.');
      }
      throw fail(502, error.code || 'ERR_VIRGOSCORPIO_HUB_BILLING_PROVIDER', 'Stripe rejected the refund request.');
    }

    if (providerRefund.currency !== String(refund.currency).toUpperCase()) {
      throw fail(502, 'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN', 'Stripe refund currency did not match the order. Reconcile before retrying with the same idempotency key.');
    }

    const internalStatus = normalizeStripeRefundStatus(providerRefund.status);
    const persist = await localPool.connect();
    let savedRefund;
    try {
      await persist.query('BEGIN');
      // Match the webhook and request-reservation lock order (order, then refund)
      // so an in-flight webhook cannot deadlock local provider-response persistence.
      const persistOrder = await persist.query(
        `SELECT id
           FROM commerce_orders
          WHERE site_id=$1 AND id=$2 AND provider='stripe' AND provider_payment_id=$3
          FOR UPDATE`,
        [siteId, orderId, paymentIntentId]
      );
      if (!persistOrder.rows[0]) {
        throw fail(502, 'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN', 'Stripe accepted the refund but the local order binding changed. Reconcile before retrying.');
      }
      const saved = await persist.query(
        `UPDATE commerce_refunds
            SET provider_refund_id=COALESCE(provider_refund_id,$4),
                status=CASE WHEN status IN ('succeeded','failed','cancelled') THEN status ELSE $5 END,
                updated_at=now()
          WHERE site_id=$1 AND order_id=$2 AND id=$3 AND provider='stripe'
            AND (provider_refund_id IS NULL OR provider_refund_id=$4)
          RETURNING id,provider_refund_id,amount_minor,currency,reason,status`,
        [siteId, orderId, refund.id, providerRefund.id, internalStatus]
      );
      savedRefund = saved.rows[0] || null;
      if (!savedRefund) {
        throw fail(502, 'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN', 'Stripe created a refund but its local provider binding did not match. Reconcile before retrying.');
      }
      if (savedRefund.status === 'succeeded') {
        await persist.query(
          `UPDATE commerce_orders
              SET status='refunded',updated_at=now()
            WHERE site_id=$1 AND id=$2 AND provider='stripe'
              AND status IN ('paid','processing','fulfilled')
              AND (SELECT COALESCE(SUM(r.amount_minor),0)
                     FROM commerce_refunds r
                    WHERE r.site_id=$1 AND r.order_id=$2 AND r.provider='stripe' AND r.status='succeeded') >= total_minor`,
          [siteId, orderId]
        );
      }
      await persist.query('COMMIT');
    } catch (error) {
      await persist.query('ROLLBACK').catch(() => {});
      if (error.code) throw error;
      throw fail(502, 'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN', 'Stripe accepted the refund but local status persistence did not complete. Retry with the same idempotency key.');
    } finally {
      persist.release();
    }

    await identity?.audit({
      siteId,
      actorId: actor?.user?.id || null,
      action: 'commerce.refund_requested',
      targetType: 'commerce-refund',
      targetId: savedRefund.id,
      requestId,
      details: { amountMinor: Number(savedRefund.amount_minor), currency: String(savedRefund.currency).toUpperCase(), status: savedRefund.status }
    });
    return sendJson(res, 200, {
      refund: {
        id: savedRefund.id,
        providerRefundId: savedRefund.provider_refund_id,
        amountMinor: Number(savedRefund.amount_minor),
        currency: String(savedRefund.currency).toUpperCase(),
        reason: savedRefund.reason,
        status: savedRefund.status
      },
      idempotentReplay: refundIsReplay,
      requestId
    });
  }

  const orderCheckout = pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/commerce\/checkout$/i);
  if (method === 'POST' && orderCheckout) {
    if (!localPool) throw fail(503, 'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED', 'Checkout requires PostgreSQL.');
    const siteId = orderCheckout[1];
    const body = await readJson(req, Math.min(maxBody, 150_000));
    await siteIdFor({ req, url, body, actor, routeSiteId: siteId });

    const cart = normalizeCart(body.items);
    if (!cart.valid) throw fail(422, cart.code, 'Cart validation failed.', cart.errors);
    const email = typeof body.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ? body.email : actor.user.email;
    if (typeof email !== 'string' || !email) throw fail(400, 'ERR_VIRGOSCORPIO_HUB_CHECKOUT_EMAIL', 'A valid customer email is required.');
    const idempotencyKey = typeof body.idempotencyKey === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(body.idempotencyKey) ? body.idempotencyKey : randomUUID();
    const existingResult = await localPool.query(
      'SELECT id,order_number,status,customer_id,email,currency,total_minor,metadata,provider_session_id,created_at FROM commerce_orders WHERE site_id=$1 AND idempotency_key=$2',
      [siteId, idempotencyKey]
    );
    const existing = existingResult.rows[0];

    // A retry must never silently return an empty checkout URL. If a previous
    // request committed its order but lost the response from Stripe/database,
    // replay the exact saved Stripe parameters using the same provider key.
    if (existing) {
      const ownsExistingOrder = existing.customer_id
        ? Boolean(actor?.user?.id) && String(existing.customer_id) === String(actor.user.id)
        : typeof existing.email === 'string' && existing.email.toLowerCase() === email.toLowerCase();
      if (!ownsExistingOrder) throw fail(404, 'ERR_VIRGOSCORPIO_HUB_CHECKOUT_ORDER_NOT_FOUND', 'Checkout order not found.');
      if (existing.status !== 'pending_payment') {
        if (existing.status === 'paid' || existing.status === 'processing' || existing.status === 'fulfilled') {
          return sendJson(res, 200, { order: checkoutOrderResponse(existing), checkoutUrl: null, paymentComplete: true, idempotentReplay: true, requestId });
        }
        throw fail(409, 'ERR_VIRGOSCORPIO_HUB_CHECKOUT_KEY_CLOSED', 'This idempotency key is attached to a closed checkout. Start a new checkout with a new idempotency key.');
      }
      if (typeof existing.metadata?.checkoutUrl === 'string' && existing.metadata.checkoutUrl) {
        return sendJson(res, 200, { order: checkoutOrderResponse(existing), checkoutUrl: existing.metadata.checkoutUrl, idempotentReplay: true, requestId });
      }
      const snapshot = existing.metadata?.checkoutLineItems;
      const checkoutExpiresAt = Number(existing.metadata?.checkoutExpiresAt);
      if (!Array.isArray(snapshot) || snapshot.length < 1 || !Number.isSafeInteger(checkoutExpiresAt) || checkoutExpiresAt < Math.floor(Date.now() / 1000) + 30 * 60) {
        throw fail(409, 'ERR_VIRGOSCORPIO_HUB_CHECKOUT_RECOVERY', 'The pending checkout has no recoverable session snapshot or is near expiration. Reconcile the order before retrying with a new idempotency key.');
      }
      const finiteStockLines = snapshot.filter(item => item.stockReserved === true).length;
      if (finiteStockLines) {
        const holds = await localPool.query(
          "SELECT count(*)::int AS count FROM commerce_stock_reservations WHERE site_id=$1 AND order_id=$2 AND status='reserved' AND expires_at>now()",
          [siteId, existing.id]
        );
        if (Number(holds.rows[0]?.count || 0) !== finiteStockLines) {
          throw fail(409, 'ERR_VIRGOSCORPIO_HUB_CHECKOUT_STOCK_HOLD', 'Inventory holds are no longer intact. The checkout cannot be safely recreated; reconcile the order first.');
        }
      }
      const recovered = await createStripeCheckoutSession({
        secretKey: env.STRIPE_SECRET_KEY,
        mode: 'payment',
        lineItems: snapshot.map(item => ({ currency: item.currency, unitAmount: item.unitAmount, quantity: item.quantity, name: item.name, ...(item.description ? { description: item.description } : {}) })),
        successUrl: env.STRIPE_CHECKOUT_SUCCESS_URL,
        cancelUrl: env.STRIPE_CHECKOUT_CANCEL_URL,
        customerEmail: existing.email,
        metadata: { site_id: siteId, order_id: existing.id },
        idempotencyKey: `vsh_${existing.id}`,
        expiresAt: checkoutExpiresAt
      });
      const recoveredOrder = await localPool.query(
        `UPDATE commerce_orders
            SET provider_session_id=$3,
                metadata=jsonb_set(jsonb_set(COALESCE(metadata,'{}'::jsonb),'{checkoutUrl}',to_jsonb($4::text),true),'{checkoutExpiresAt}',to_jsonb($5::bigint),true),
                updated_at=now()
          WHERE site_id=$1 AND id=$2 AND status='pending_payment'
          RETURNING id,order_number,status,currency,total_minor,provider_session_id,metadata,created_at`,
        [siteId, existing.id, recovered.id, recovered.url, checkoutExpiresAt]
      );
      if (recoveredOrder.rows[0]) return sendJson(res, 200, { order: checkoutOrderResponse(recoveredOrder.rows[0]), checkoutUrl: recovered.url, idempotentReplay: true, requestId });
      const latest = await localPool.query('SELECT id,order_number,status,currency,total_minor,provider_session_id,metadata,created_at FROM commerce_orders WHERE site_id=$1 AND id=$2', [siteId, existing.id]);
      if (latest.rows[0]?.status === 'paid') return sendJson(res, 200, { order: checkoutOrderResponse(latest.rows[0]), checkoutUrl: null, paymentComplete: true, idempotentReplay: true, requestId });
      throw fail(409, 'ERR_VIRGOSCORPIO_HUB_CHECKOUT_RECOVERY_RACE', 'Checkout state changed while recovering the provider session. Reload the order before continuing.');
    }

    const client = await localPool.connect();
    let order;
    const items = [];
    const checkoutExpiresAt = Math.floor(Date.now() / 1000) + 23 * 60 * 60;
    try {
      await client.query('BEGIN');
      const ids = cart.items.map(item => item.productId);
      const rows = await client.query(
        "SELECT * FROM commerce_products WHERE site_id=$1 AND id=ANY($2::uuid[]) AND status='published' ORDER BY id FOR UPDATE",
        [siteId, ids]
      );
      if (rows.rows.length !== ids.length) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_CART_PRODUCT', 'One or more products are unavailable.');
      const byId = new Map(rows.rows.map(row => [row.id, row]));
      const currencies = new Set(rows.rows.map(row => row.currency));
      if (currencies.size !== 1) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_CART_CURRENCY', 'All products in one checkout must use the same currency.');
      let subtotal = 0;
      for (const line of cart.items) {
        const product = byId.get(line.productId);
        if (product.stock_status === 'out_of_stock') throw fail(409, 'ERR_VIRGOSCORPIO_HUB_STOCK', 'A product is out of stock.');
        const lineTotal = calculateLineTotal(Number(product.price_minor), line.quantity);
        subtotal += lineTotal;
        if (!Number.isSafeInteger(subtotal)) throw fail(422, 'ERR_VIRGOSCORPIO_HUB_CART_TOTAL', 'Cart total exceeds supported price range.');
        let stockReserved = false;
        if (product.inventory_quantity !== null) {
          const stock = await client.query(
            "UPDATE commerce_products SET inventory_quantity=inventory_quantity-$3,stock_status=CASE WHEN inventory_quantity-$3<=0 THEN 'out_of_stock' ELSE 'in_stock' END,version=version+1,updated_at=now() WHERE site_id=$1 AND id=$2 AND inventory_quantity >= $3 RETURNING id",
            [siteId, product.id, line.quantity]
          );
          if (!stock.rows[0]) throw fail(409, 'ERR_VIRGOSCORPIO_HUB_STOCK', 'Insufficient stock for a product.');
          stockReserved = true;
        }
        items.push({ productId: product.id, name: product.name, sku: product.sku, quantity: line.quantity, unitPrice: Number(product.price_minor), lineTotal, stockReserved });
      }
      const total = subtotal;
      const checkoutLineItems = items.map(item => ({
        currency: [...currencies][0], unitAmount: item.unitPrice, quantity: item.quantity, name: item.name,
        ...(item.sku ? { description: `SKU ${item.sku}` } : {}), stockReserved: item.stockReserved
      }));
      const metadataSnapshot = JSON.stringify({ checkoutExpiresAt, checkoutLineItems, customerEmail: email });
      const inserted = await client.query(
        `INSERT INTO commerce_orders(site_id,customer_id,email,status,currency,subtotal_minor,discount_minor,tax_minor,shipping_minor,total_minor,provider,idempotency_key,metadata)
         VALUES($1,$2,$3,'pending_payment',$4,$5,0,0,0,$5,'stripe',$6,$7::jsonb) RETURNING *`,
        [siteId, actor.user.id || null, email, [...currencies][0], total, idempotencyKey, metadataSnapshot]
      );
      order = inserted.rows[0];
      for (const item of items) {
        await client.query(
          'INSERT INTO commerce_order_items(order_id,product_id,name_snapshot,sku_snapshot,quantity,unit_price_minor,line_total_minor,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
          [order.id, item.productId, item.name, item.sku, item.quantity, item.unitPrice, item.lineTotal, JSON.stringify({ stockReserved: item.stockReserved })]
        );
        if (item.stockReserved) {
          await client.query(
            "INSERT INTO commerce_stock_reservations(site_id,order_id,product_id,quantity,status,expires_at) VALUES($1,$2,$3,$4,'reserved',to_timestamp($5)) ON CONFLICT(order_id,product_id) DO NOTHING",
            [siteId, order.id, item.productId, item.quantity, checkoutExpiresAt]
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw error;
    }
    client.release();

    const checkoutLineItems = items.map(item => ({
      currency: order.currency, unitAmount: item.unitPrice, quantity: item.quantity, name: item.name,
      ...(item.sku ? { description: `SKU ${item.sku}` } : {})
    }));
    let checkout;
    try {
      checkout = await createStripeCheckoutSession({
        secretKey: env.STRIPE_SECRET_KEY, mode: 'payment', lineItems: checkoutLineItems,
        successUrl: env.STRIPE_CHECKOUT_SUCCESS_URL, cancelUrl: env.STRIPE_CHECKOUT_CANCEL_URL,
        customerEmail: email, metadata: { site_id: siteId, order_id: order.id },
        idempotencyKey: `vsh_${order.id}`, expiresAt: checkoutExpiresAt
      });
    } catch (error) {
      // A transport failure or provider 5xx may occur after the session was
      // created. Keep both order and stock hold pending so an identical retry
      // can recover the session with Stripe's idempotency key.
      if (error.code === 'ERR_VIRGOSCORPIO_HUB_BILLING_OUTCOME_UNKNOWN') throw error;
      const tx = await localPool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query("UPDATE commerce_orders SET status='failed',updated_at=now() WHERE site_id=$1 AND id=$2 AND status='pending_payment'", [siteId, order.id]);
        await releaseOrderStockReservations(tx, { siteId, orderId: order.id, status: 'released' });
        await tx.query('COMMIT');
      } catch (releaseError) {
        await tx.query('ROLLBACK').catch(() => {});
        error.stockReleaseFailed = true;
      } finally { tx.release(); }
      throw error;
    }
    const saved = await localPool.query(
      `UPDATE commerce_orders
          SET provider_session_id=$3,
              metadata=jsonb_set(jsonb_set(COALESCE(metadata,'{}'::jsonb),'{checkoutUrl}',to_jsonb($4::text),true),'{checkoutExpiresAt}',to_jsonb($5::bigint),true),
              updated_at=now()
        WHERE site_id=$1 AND id=$2
        RETURNING id,order_number,status,currency,total_minor,provider_session_id,metadata,created_at`,
      [siteId, order.id, checkout.id, checkout.url, checkoutExpiresAt]
    );
    if (!saved.rows[0]) throw fail(500, 'ERR_VIRGOSCORPIO_HUB_CHECKOUT_ORDER_SAVE', 'Checkout session was created but the order response could not be saved; retry with the same idempotency key to recover it.');
    return sendJson(res, 201, { order: checkoutOrderResponse(saved.rows[0]), checkoutUrl: checkout.url, requestId });
  }

  const planCollection=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/memberships\/plans$/i);
  if(planCollection&&['GET','POST'].includes(method)){
    if(!localPool)throw fail(503,'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED','Membership plans require PostgreSQL.');const siteId=planCollection[1];const body=method==='POST'?await readJson(req,Math.min(maxBody,64_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });await requireCapability(actor,siteId,method==='GET'?'content:read':'memberships:manage');
    if(method==='GET'){const result=await localPool.query('SELECT id,site_id,slug,name,description,price_minor,currency,interval_unit,interval_count,access_rules,active,version,created_at,updated_at FROM membership_plans WHERE site_id=$1 ORDER BY created_at DESC',[siteId]);return sendJson(res,200,{plans:result.rows,requestId});}
    if(typeof body.slug!=='string'||!/^[a-z0-9][a-z0-9-]{0,100}$/.test(body.slug)||typeof body.name!=='string'||!body.name.trim()||body.name.length>180||!Number.isSafeInteger(body.priceMinor)||body.priceMinor<0||!['one_time','month','year'].includes(body.intervalUnit)||!Number.isInteger(body.intervalCount||1)||(body.intervalCount||1)<1||(body.intervalCount||1)>12||!/^[A-Z]{3}$/.test(body.currency||'USD')||!isBoundedJsonObject(body.accessRules||{},16_384))throw fail(422,'ERR_VIRGOSCORPIO_HUB_MEMBERSHIP_PLAN_INVALID','Plan must specify a valid slug, name, price, currency, interval, and accessRules object.');
    const q=await localPool.query('INSERT INTO membership_plans(site_id,slug,name,description,price_minor,currency,interval_unit,interval_count,access_rules,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *',[siteId,body.slug,body.name.trim(),String(body.description||'').slice(0,8000),body.priceMinor,body.currency||'USD',body.intervalUnit,body.intervalCount||1,JSON.stringify(body.accessRules||{}),body.active!==false]);return sendJson(res,201,{plan:q.rows[0],requestId});
  }
  const membershipCheckout=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/memberships\/checkout$/i);
  if(method==='POST'&&membershipCheckout){if(!localPool)throw fail(503,'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED','Membership checkout requires PostgreSQL.');if(!actor.user.id)throw fail(401,'ERR_VIRGOSCORPIO_HUB_UNAUTHORIZED','A user account is required for membership checkout.');const siteId=membershipCheckout[1],body=await readJson(req,Math.min(maxBody,32_000));await siteIdFor({ req, url, body, actor, routeSiteId: siteId });const q=await localPool.query('SELECT * FROM membership_plans WHERE site_id=$1 AND id=$2 AND active=true',[siteId,body.planId]);const plan=q.rows[0];if(!plan)throw fail(404,'ERR_VIRGOSCORPIO_HUB_MEMBERSHIP_PLAN_NOT_FOUND','Membership plan not found.');const mode=plan.interval_unit==='one_time'?'payment':'subscription';const checkout=await createStripeCheckoutSession({secretKey:env.STRIPE_SECRET_KEY,mode,lineItems:[{currency:plan.currency,unitAmount:Number(plan.price_minor),quantity:1,name:plan.name,description:plan.description,interval:mode==='subscription'?plan.interval_unit:undefined,intervalCount:plan.interval_count}],successUrl:env.STRIPE_CHECKOUT_SUCCESS_URL,cancelUrl:env.STRIPE_CHECKOUT_CANCEL_URL,customerEmail:actor.user.email,metadata:{site_id:siteId,membership_plan_id:plan.id,user_id:actor.user.id,purchase_type:'membership'},subscriptionMetadata:{site_id:siteId,membership_plan_id:plan.id,user_id:actor.user.id,purchase_type:'membership'},idempotencyKey:`vsh_mem_${siteId}_${actor.user.id}_${plan.id}_${randomUUID()}`});const saved=await localPool.query('INSERT INTO paid_memberships(site_id,user_id,plan_id,status,provider,provider_customer_id,provider_subscription_id) VALUES($1,$2,$3,\'pending\',\'stripe\',$4,$5) RETURNING id,status,plan_id,provider_subscription_id',[siteId,actor.user.id,plan.id,checkout.customerId,checkout.subscriptionId]);return sendJson(res,201,{membership:saved.rows[0],checkoutUrl:checkout.url,requestId});}
  const memberships=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/memberships$/i);
  if(method==='GET'&&memberships){if(!localPool)throw fail(503,'ERR_VIRGOSCORPIO_HUB_DATABASE_DISABLED','Memberships require PostgreSQL.');const siteId=memberships[1];await siteIdFor({ req, url, body: {}, actor, routeSiteId: siteId });await requireCapability(actor,siteId,'memberships:manage');const result=await localPool.query('SELECT m.id,m.user_id,u.email,u.display_name,m.plan_id,p.name AS plan_name,m.status,m.provider,m.current_period_start,m.current_period_end,m.cancel_at_period_end,m.created_at FROM paid_memberships m JOIN users u ON u.id=m.user_id JOIN membership_plans p ON p.id=m.plan_id WHERE m.site_id=$1 ORDER BY m.created_at DESC LIMIT 500',[siteId]);return sendJson(res,200,{memberships:result.rows,requestId});}
  return false;
}

module.exports = { handleCommerceRoute, productInput };
