'use strict';

const { listIcons, renderIcon } = require('../../../packages/icons/src/catalog');
const { renderMath } = require('../../../packages/math/src/renderer');
const { optimizeImage, optimizeVideoToWebm } = require('../../../packages/media/src/optimizer');
const { normalizeCart, validateProduct, calculateLineTotal } = require('../../../packages/commerce/src/validation');
const { validateProfile, validateGroup, cleanText } = require('../../../packages/community/src/validation');
const { validateIpPattern } = require('../../../packages/security/src/firewall');
const { cloudConfigStatus, createCloudStorageAdapterFromEnv, probeCloudStorageAdapter, resolveCloudCredentialReference, cloudEndpointAllowed } = require('../../../packages/cloud/src/storage-adapters');
const { createStripeCheckoutSession } = require('../../../packages/billing/src/stripe');
const { validateMenuItems } = require('../../../packages/domain/src/navigation');
const { randomUUID } = require('node:crypto');
const { handleCommunityWorkflowRoute } = require('../../../packages/community/src/workflows');
const { releaseOrderStockReservations } = require('../../../packages/commerce/src/stock-reservations');

function safeObject(value, maxBytes = 32_000) { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Buffer.byteLength(JSON.stringify(value)) <= maxBytes); }
function validUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function productInput(body) { return { slug: body.slug, name: body.name, description: body.description || '', productType: body.productType || 'simple', status: body.status || 'draft', currency: body.currency || 'USD', priceMinor: body.priceMinor, compareAtPriceMinor: body.compareAtPriceMinor ?? null, sku: body.sku || null, inventoryQuantity: body.inventoryQuantity === undefined ? null : body.inventoryQuantity, stockStatus: body.stockStatus || (body.inventoryQuantity === 0 ? 'out_of_stock' : 'in_stock'), requiresShipping: body.requiresShipping === true, weightGrams: body.weightGrams ?? null, images: body.images || [], attributes: body.attributes || {}, metadata: body.metadata || {} }; }
function checkoutOrderResponse(row) { return { id: row.id, order_number: row.order_number, status: row.status, currency: row.currency, total_minor: row.total_minor, provider_session_id: row.provider_session_id || null, metadata: { checkoutUrl: row.metadata?.checkoutUrl || null, checkoutExpiresAt: row.metadata?.checkoutExpiresAt || null }, created_at: row.created_at }; }
function presentationValid(value) {
  const errors=[]; if (!safeObject(value, 16_384)) return { valid:false, errors:['presentation must be a small JSON object'] };
  const allowed=new Set(['megaMenu','layout','width','columns','showDescriptions','showImages','showIcons','featuredContentId','mobileMode','trigger']);
  for(const key of Object.keys(value)) if(!allowed.has(key)) errors.push(`presentation.${key} is not permitted`);
  if(value.megaMenu!==undefined&&typeof value.megaMenu!=='boolean') errors.push('megaMenu must be boolean');
  if(value.layout!==undefined&&!['columns','tabs','flyout','grid'].includes(value.layout)) errors.push('layout must be columns, tabs, flyout, or grid');
  if(value.width!==undefined&&!['container','wide','full'].includes(value.width)) errors.push('width must be container, wide, or full');
  if(value.columns!==undefined&&(!Number.isInteger(value.columns)||value.columns<1||value.columns>6)) errors.push('columns must be from 1 to 6');
  for(const key of ['showDescriptions','showImages','showIcons']) if(value[key]!==undefined&&typeof value[key]!=='boolean') errors.push(`${key} must be boolean`);
  if(value.mobileMode!==undefined&&!['accordion','drilldown','collapse'].includes(value.mobileMode)) errors.push('mobileMode is invalid');
  if(value.trigger!==undefined&&!['hover','click','focus'].includes(value.trigger)) errors.push('trigger is invalid');
  if(value.featuredContentId!==undefined&&value.featuredContentId!==null&&!validUuid(value.featuredContentId)) errors.push('featuredContentId must be a UUID');
  return {valid:errors.length===0,errors};
}

async function handlePlatformRoute(ctx) {
  const { req,res,url,actor,siteIdFor,requireCapability,readJson,sendJson,fail,requestId,localPool,libraryStore,firewall,env,identity,maxBody,store } = ctx;
  const communityWorkflowHandled = await handleCommunityWorkflowRoute(ctx);
  if (communityWorkflowHandled) return true;
  const pathName=url.pathname; const method=req.method;
  if (method==='GET' && pathName==='/api/v1/icon-library') return sendJson(res,200,{icons:listIcons(),catalogVersion:1,requestId});
  const iconMatch=pathName.match(/^\/api\/v1\/icon-library\/([A-Za-z][A-Za-z0-9]{0,60})$/);
  if(method==='GET'&&iconMatch){const size=Number(url.searchParams.get('size')||24);const strokeWidth=Number(url.searchParams.get('strokeWidth')||1.8);return sendJson(res,200,{name:iconMatch[1],svg:renderIcon(iconMatch[1],{size,strokeWidth,title:url.searchParams.get('title')||null}),requestId});}
  if(method==='POST'&&pathName==='/api/v1/math/render'){
    const body=await readJson(req,Math.min(maxBody,24_000)); if(body.siteId){const siteId=await siteIdFor({req,url,body,actor});await requireCapability(actor,siteId,'content:edit');}
    const rendered=renderMath(body.formula,{displayMode:body.displayMode===true});return sendJson(res,200,{...rendered,requestId});
  }

  const libraryCollection=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/library\/items$/i);
  const libraryItem=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/library\/items\/([0-9a-f-]{36})(?:\/(versions|optimize|download))?$/i);
  if ((libraryCollection&&['GET','POST'].includes(method))||(libraryItem&&['GET','PATCH','DELETE','POST','PUT'].includes(method))) {
    if(!libraryStore||!localPool) throw fail(503,'ERR_SYSTEMFABRIC_LIBRARY_DISABLED','File and document libraries require PostgreSQL and configured storage.');
    const siteId=libraryCollection?.[1]||libraryItem[1]; const body=['POST','PATCH','PUT','DELETE'].includes(method)&&libraryItem?.[3]!=='download'?await readJson(req,ctx.maxLibraryBody||maxBody):{};
    await siteIdFor({ req, url, body, actor, routeSiteId: siteId }); await requireCapability(actor,siteId,method==='GET'?'library:manage':'library:manage');
    if(libraryCollection){
      if(method==='GET') return sendJson(res,200,{items:await libraryStore.list({siteId,category:url.searchParams.get('category')||'all',query:url.searchParams.get('q')||'',limit:url.searchParams.get('limit')||50,offset:url.searchParams.get('offset')||0}),libraryKinds:['image','video','audio','document','file','font'],requestId});
      const category=body.category;
      const asset=await libraryStore.upload({siteId,actorId:actor.user.id,category,dataBase64:body.dataBase64,mimeType:body.mimeType,fileName:body.fileName,displayName:body.displayName,altText:body.altText||'',caption:body.caption||'',description:body.description||'',isPublic:body.isPublic===true,metadata:body.metadata||{}});
      await identity?.audit({siteId,actorId:actor.user.id,action:'library.asset_uploaded',targetType:'library-asset',targetId:asset.id,requestId,details:{kind:asset.asset_kind,mimeType:asset.mime_type,byteSize:asset.byte_size,sha256:asset.sha256}});
      return sendJson(res,201,{item:asset,url:asset.is_public?`/library/public/${asset.id}`:null,requestId});
    }
    const id=libraryItem[2], action=libraryItem[3];
    if(method==='GET'&&action==='download'){const value=await libraryStore.getBufferById({siteId,id});if(!value)throw fail(404,'ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND','Library asset not found.');const safeName=String(value.asset.original_name||'download').replace(/[\r\n\"\\]/g,'_').slice(0,240);res.writeHead(200,{'content-type':value.asset.mime_type,'content-length':value.data.length,'content-disposition':`attachment; filename="${safeName}"`,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(value.data);return true;}
    if(method==='PUT'&&!action){const item=await libraryStore.replaceVersion({siteId,id,actorId:actor.user.id,expectedVersion:body.expectedVersion,dataBase64:body.dataBase64,mimeType:body.mimeType,fileName:body.fileName});await identity?.audit({siteId,actorId:actor.user.id,action:'library.asset_version_replaced',targetType:'library-asset',targetId:id,requestId,details:{version:item.version,mimeType:item.mime_type,sha256:item.sha256}});return sendJson(res,200,{item,requestId});}
    if(method==='GET'&&action==='versions'){const history=await libraryStore.history({siteId,id});if(!history)throw fail(404,'ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND','Library asset not found.');return sendJson(res,200,{versions:history,requestId});}
    if(method==='POST'&&action==='optimize'){
      const value=await libraryStore.getBufferById({siteId,id});if(!value)throw fail(404,'ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND','Library asset not found.');
      await libraryStore.markOptimization({siteId,id,status:'processing',details:{requestedAt:new Date().toISOString()}});
      try {
        let result;
        if(value.asset.asset_kind==='image') result=await optimizeImage(value.data);
        else if(value.asset.asset_kind==='video'&&value.asset.mime_type==='video/mp4') result=await optimizeVideoToWebm(value.data,{maxBytes:ctx.maxOptimizerBytes||100*1024*1024});
        else { await libraryStore.markOptimization({siteId,id,status:'skipped',details:{optimizationReason:'no-optimizer-for-this-media-type'}});return sendJson(res,200,{optimization:{status:'skipped',reason:'no-optimizer-for-this-media-type'},requestId}); }
        if(!result.optimized){const status='skipped';await libraryStore.markOptimization({siteId,id,status,details:{optimizationReason:result.reason,bytesSaved:result.bytesSaved||0}});return sendJson(res,200,{optimization:{status,reason:result.reason,bytesSaved:result.bytesSaved||0},requestId});}
        const variant=await libraryStore.createVariant({siteId,id,variantKey:result.mimeType==='image/webp'?'webp-optimized':'webm-optimized',data:result.buffer,mimeType:result.mimeType});
        await libraryStore.markOptimization({siteId,id,status:'optimized',details:{optimizationReason:result.reason,bytesSaved:result.bytesSaved,variantId:variant.id}});
        return sendJson(res,200,{optimization:{status:'optimized',variant,bytesSaved:result.bytesSaved},requestId});
      } catch(error){await libraryStore.markOptimization({siteId,id,status:error.code==='ERR_SYSTEMFABRIC_OPTIMIZER_UNAVAILABLE'?'skipped':'failed',details:{optimizationReason:error.code||'optimizer-failed'}});if(error.statusCode)throw error;return sendJson(res,200,{optimization:{status:error.code==='ERR_SYSTEMFABRIC_OPTIMIZER_UNAVAILABLE'?'skipped':'failed',reason:error.code||'optimizer-failed'},requestId});}
    }
    if(method==='GET'){const item=await libraryStore.get({siteId,id});if(!item)throw fail(404,'ERR_SYSTEMFABRIC_LIBRARY_NOT_FOUND','Library asset not found.');return sendJson(res,200,{item,versions:await libraryStore.history({siteId,id}),requestId});}
    if(method==='PATCH'){const item=await libraryStore.updateMetadata({siteId,id,actorId:actor.user.id,expectedVersion:body.expectedVersion,patch:body.patch});return sendJson(res,200,{item,requestId});}
    if(method==='DELETE'){const deleted=await libraryStore.delete({siteId,id,expectedVersion:body.expectedVersion});return sendJson(res,200,{deleted:true,...deleted,requestId});}
  }
  const docVersion=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/content\/([0-9a-f-]{36})\/version$/i);
  if(method==='GET'&&docVersion){if(!localPool)throw fail(503,'ERR_SYSTEMFABRIC_DATABASE_DISABLED','Document version controls require PostgreSQL.');const siteId=docVersion[1];await siteIdFor({ req, url, body: {}, actor, routeSiteId: siteId });await requireCapability(actor,siteId,'content:read');const row=await localPool.query('SELECT id,site_id,content_type,slug,locale,title,status,schema_version,version,body,published_at,updated_at FROM content_items WHERE site_id=$1 AND id=$2 AND deleted_at IS NULL',[siteId,docVersion[2]]);if(!row.rows[0])throw fail(404,'ERR_SYSTEMFABRIC_CONTENT_NOT_FOUND','Content was not found.');const revisionCount=await localPool.query('SELECT count(*)::integer AS count,max(version)::integer AS latest_version FROM content_revisions WHERE content_id=$1',[docVersion[2]]);const item=row.rows[0];return sendJson(res,200,{documentId:item.body?.documentId||item.id,contentId:item.id,version:item.version,schemaVersion:item.schema_version,status:item.status,publishedAt:item.published_at,updatedAt:item.updated_at,revisionCount:revisionCount.rows[0].count,latestRevisionVersion:revisionCount.rows[0].latest_version,requestId});}

  const products=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/products$/i);
  const product=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/products\/([0-9a-f-]{36})$/i);
  if((products&&['GET','POST'].includes(method))||(product&&['GET','PUT','DELETE'].includes(method))){
    if(!localPool)throw fail(503,'ERR_SYSTEMFABRIC_DATABASE_DISABLED','Commerce requires PostgreSQL.');const siteId=products?.[1]||product[1];const body=['POST','PUT','DELETE'].includes(method)?await readJson(req,Math.min(maxBody,300_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });await requireCapability(actor,siteId,method==='GET'?'commerce:read':'commerce:manage');
    if(products&&method==='GET'){const result=await localPool.query('SELECT id,slug,name,description,product_type,status,currency,price_minor,compare_at_price_minor,sku,inventory_quantity,stock_status,requires_shipping,weight_grams,images,attributes,metadata,version,created_at,updated_at FROM commerce_products WHERE site_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4',[siteId,url.searchParams.get('status'),Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||50)),Math.max(0,Number(url.searchParams.get('offset'))||0)]);return sendJson(res,200,{products:result.rows,requestId});}
    if(products&&method==='POST'){const input=productInput(body),validation=validateProduct(input,{requireStatus:true});if(!validation.valid)throw fail(422,validation.code,'Product validation failed.',validation.errors);const q=await localPool.query(`INSERT INTO commerce_products(site_id,slug,name,description,product_type,status,currency,price_minor,compare_at_price_minor,sku,inventory_quantity,stock_status,requires_shipping,weight_grams,images,attributes,metadata,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18)
      RETURNING id,site_id,slug,name,description,product_type,status,currency,price_minor,compare_at_price_minor,sku,inventory_quantity,stock_status,requires_shipping,weight_grams,images,attributes,metadata,version,created_at,updated_at`,[siteId,input.slug,input.name.trim(),input.description,input.productType,input.status,input.currency,input.priceMinor,input.compareAtPriceMinor,input.sku,input.inventoryQuantity,input.stockStatus,input.requiresShipping,input.weightGrams,JSON.stringify(input.images),JSON.stringify(input.attributes),JSON.stringify(input.metadata),actor.user.id||null]);return sendJson(res,201,{product:q.rows[0],requestId});}
    if(product&&method==='GET'){const q=await localPool.query('SELECT * FROM commerce_products WHERE site_id=$1 AND id=$2',[siteId,product[2]]);if(!q.rows[0])throw fail(404,'ERR_SYSTEMFABRIC_PRODUCT_NOT_FOUND','Product not found.');return sendJson(res,200,{product:q.rows[0],requestId});}
    if(product&&method==='DELETE'){const q=await localPool.query("UPDATE commerce_products SET status='archived',version=version+1,updated_at=now() WHERE site_id=$1 AND id=$2 AND version=$3 RETURNING id,status,version",[siteId,product[2],Number(body.expectedVersion)]);if(!q.rows[0])throw fail(409,'ERR_SYSTEMFABRIC_VERSION_CONFLICT','Product missing or version is stale.');return sendJson(res,200,{product:q.rows[0],requestId});}
    if(product&&method==='PUT'){const input=productInput(body),validation=validateProduct(input,{requireStatus:true});if(!validation.valid)throw fail(422,validation.code,'Product validation failed.',validation.errors);const q=await localPool.query(`UPDATE commerce_products SET slug=$3,name=$4,description=$5,product_type=$6,status=$7,currency=$8,price_minor=$9,compare_at_price_minor=$10,sku=$11,inventory_quantity=$12,stock_status=$13,requires_shipping=$14,weight_grams=$15,images=$16::jsonb,attributes=$17::jsonb,metadata=$18::jsonb,version=version+1,updated_at=now() WHERE site_id=$1 AND id=$2 AND version=$19 RETURNING *`,[siteId,product[2],input.slug,input.name.trim(),input.description,input.productType,input.status,input.currency,input.priceMinor,input.compareAtPriceMinor,input.sku,input.inventoryQuantity,input.stockStatus,input.requiresShipping,input.weightGrams,JSON.stringify(input.images),JSON.stringify(input.attributes),JSON.stringify(input.metadata),Number(body.expectedVersion)]);if(!q.rows[0])throw fail(409,'ERR_SYSTEMFABRIC_VERSION_CONFLICT','Product missing or version is stale.');return sendJson(res,200,{product:q.rows[0],requestId});}
  }

  const orders=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/commerce\/orders(?:\/([0-9a-f-]{36}))?$/i);
  if(orders&&['GET','POST'].includes(method)){
    if(!localPool)throw fail(503,'ERR_SYSTEMFABRIC_DATABASE_DISABLED','Orders require PostgreSQL.');const siteId=orders[1];const body=method==='POST'?await readJson(req,Math.min(maxBody,150_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });await requireCapability(actor,siteId,method==='GET'?'commerce:read':'commerce:manage');
    if(method==='GET'){const result=await localPool.query('SELECT id,order_number,customer_id,email,status,currency,subtotal_minor,discount_minor,tax_minor,shipping_minor,total_minor,provider,provider_session_id,created_at,updated_at FROM commerce_orders WHERE site_id=$1 ORDER BY created_at DESC LIMIT $2',[siteId,Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||50))]);return sendJson(res,200,{orders:result.rows,requestId});}
    // Admin-created orders are possible, but payment checkout is handled through the customer-facing endpoint below.
    throw fail(409,'ERR_SYSTEMFABRIC_CHECKOUT_ENDPOINT','Use the public checkout endpoint; administrators cannot set order totals directly.');
  }
  const orderCheckout = pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/commerce\/checkout$/i);
  if (method === 'POST' && orderCheckout) {
    if (!localPool) throw fail(503, 'ERR_SYSTEMFABRIC_DATABASE_DISABLED', 'Checkout requires PostgreSQL.');
    const siteId = orderCheckout[1];
    const body = await readJson(req, Math.min(maxBody, 150_000));
    await siteIdFor({ req, url, body, actor, routeSiteId: siteId });

    const cart = normalizeCart(body.items);
    if (!cart.valid) throw fail(422, cart.code, 'Cart validation failed.', cart.errors);
    const email = typeof body.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ? body.email : actor.user.email;
    if (typeof email !== 'string' || !email) throw fail(400, 'ERR_SYSTEMFABRIC_CHECKOUT_EMAIL', 'A valid customer email is required.');
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
      if (!ownsExistingOrder) throw fail(404, 'ERR_SYSTEMFABRIC_CHECKOUT_ORDER_NOT_FOUND', 'Checkout order not found.');
      if (existing.status !== 'pending_payment') {
        if (existing.status === 'paid' || existing.status === 'processing' || existing.status === 'fulfilled') {
          return sendJson(res, 200, { order: checkoutOrderResponse(existing), checkoutUrl: null, paymentComplete: true, idempotentReplay: true, requestId });
        }
        throw fail(409, 'ERR_SYSTEMFABRIC_CHECKOUT_KEY_CLOSED', 'This idempotency key is attached to a closed checkout. Start a new checkout with a new idempotency key.');
      }
      if (typeof existing.metadata?.checkoutUrl === 'string' && existing.metadata.checkoutUrl) {
        return sendJson(res, 200, { order: checkoutOrderResponse(existing), checkoutUrl: existing.metadata.checkoutUrl, idempotentReplay: true, requestId });
      }
      const snapshot = existing.metadata?.checkoutLineItems;
      const checkoutExpiresAt = Number(existing.metadata?.checkoutExpiresAt);
      if (!Array.isArray(snapshot) || snapshot.length < 1 || !Number.isSafeInteger(checkoutExpiresAt) || checkoutExpiresAt < Math.floor(Date.now() / 1000) + 30 * 60) {
        throw fail(409, 'ERR_SYSTEMFABRIC_CHECKOUT_RECOVERY', 'The pending checkout has no recoverable session snapshot or is near expiration. Reconcile the order before retrying with a new idempotency key.');
      }
      const finiteStockLines = snapshot.filter(item => item.stockReserved === true).length;
      if (finiteStockLines) {
        const holds = await localPool.query(
          "SELECT count(*)::int AS count FROM commerce_stock_reservations WHERE site_id=$1 AND order_id=$2 AND status='reserved' AND expires_at>now()",
          [siteId, existing.id]
        );
        if (Number(holds.rows[0]?.count || 0) !== finiteStockLines) {
          throw fail(409, 'ERR_SYSTEMFABRIC_CHECKOUT_STOCK_HOLD', 'Inventory holds are no longer intact. The checkout cannot be safely recreated; reconcile the order first.');
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
        idempotencyKey: `sf_${existing.id}`,
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
      throw fail(409, 'ERR_SYSTEMFABRIC_CHECKOUT_RECOVERY_RACE', 'Checkout state changed while recovering the provider session. Reload the order before continuing.');
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
      if (rows.rows.length !== ids.length) throw fail(422, 'ERR_SYSTEMFABRIC_CART_PRODUCT', 'One or more products are unavailable.');
      const byId = new Map(rows.rows.map(row => [row.id, row]));
      const currencies = new Set(rows.rows.map(row => row.currency));
      if (currencies.size !== 1) throw fail(422, 'ERR_SYSTEMFABRIC_CART_CURRENCY', 'All products in one checkout must use the same currency.');
      let subtotal = 0;
      for (const line of cart.items) {
        const product = byId.get(line.productId);
        if (product.stock_status === 'out_of_stock') throw fail(409, 'ERR_SYSTEMFABRIC_STOCK', 'A product is out of stock.');
        const lineTotal = calculateLineTotal(Number(product.price_minor), line.quantity);
        subtotal += lineTotal;
        if (!Number.isSafeInteger(subtotal)) throw fail(422, 'ERR_SYSTEMFABRIC_CART_TOTAL', 'Cart total exceeds supported price range.');
        let stockReserved = false;
        if (product.inventory_quantity !== null) {
          const stock = await client.query(
            "UPDATE commerce_products SET inventory_quantity=inventory_quantity-$3,stock_status=CASE WHEN inventory_quantity-$3<=0 THEN 'out_of_stock' ELSE 'in_stock' END,version=version+1,updated_at=now() WHERE site_id=$1 AND id=$2 AND inventory_quantity >= $3 RETURNING id",
            [siteId, product.id, line.quantity]
          );
          if (!stock.rows[0]) throw fail(409, 'ERR_SYSTEMFABRIC_STOCK', 'Insufficient stock for a product.');
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
        idempotencyKey: `sf_${order.id}`, expiresAt: checkoutExpiresAt
      });
    } catch (error) {
      // A transport failure or provider 5xx may occur after the session was
      // created. Keep both order and stock hold pending so an identical retry
      // can recover the session with Stripe's idempotency key.
      if (error.code === 'ERR_SYSTEMFABRIC_BILLING_OUTCOME_UNKNOWN') throw error;
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
    if (!saved.rows[0]) throw fail(500, 'ERR_SYSTEMFABRIC_CHECKOUT_ORDER_SAVE', 'Checkout session was created but the order response could not be saved; retry with the same idempotency key to recover it.');
    return sendJson(res, 201, { order: checkoutOrderResponse(saved.rows[0]), checkoutUrl: checkout.url, requestId });
  }

  const planCollection=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/memberships\/plans$/i);
  if(planCollection&&['GET','POST'].includes(method)){
    if(!localPool)throw fail(503,'ERR_SYSTEMFABRIC_DATABASE_DISABLED','Membership plans require PostgreSQL.');const siteId=planCollection[1];const body=method==='POST'?await readJson(req,Math.min(maxBody,64_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });await requireCapability(actor,siteId,method==='GET'?'content:read':'memberships:manage');
    if(method==='GET'){const result=await localPool.query('SELECT id,site_id,slug,name,description,price_minor,currency,interval_unit,interval_count,access_rules,active,version,created_at,updated_at FROM membership_plans WHERE site_id=$1 ORDER BY created_at DESC',[siteId]);return sendJson(res,200,{plans:result.rows,requestId});}
    if(typeof body.slug!=='string'||!/^[a-z0-9][a-z0-9-]{0,100}$/.test(body.slug)||typeof body.name!=='string'||!body.name.trim()||body.name.length>180||!Number.isSafeInteger(body.priceMinor)||body.priceMinor<0||!['one_time','month','year'].includes(body.intervalUnit)||!Number.isInteger(body.intervalCount||1)||(body.intervalCount||1)<1||(body.intervalCount||1)>12||!/^[A-Z]{3}$/.test(body.currency||'USD')||!safeObject(body.accessRules||{},16_384))throw fail(422,'ERR_SYSTEMFABRIC_MEMBERSHIP_PLAN_INVALID','Plan must specify a valid slug, name, price, currency, interval, and accessRules object.');
    const q=await localPool.query('INSERT INTO membership_plans(site_id,slug,name,description,price_minor,currency,interval_unit,interval_count,access_rules,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *',[siteId,body.slug,body.name.trim(),String(body.description||'').slice(0,8000),body.priceMinor,body.currency||'USD',body.intervalUnit,body.intervalCount||1,JSON.stringify(body.accessRules||{}),body.active!==false]);return sendJson(res,201,{plan:q.rows[0],requestId});
  }
  const membershipCheckout=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/memberships\/checkout$/i);
  if(method==='POST'&&membershipCheckout){if(!localPool)throw fail(503,'ERR_SYSTEMFABRIC_DATABASE_DISABLED','Membership checkout requires PostgreSQL.');if(!actor.user.id)throw fail(401,'ERR_SYSTEMFABRIC_UNAUTHORIZED','A user account is required for membership checkout.');const siteId=membershipCheckout[1],body=await readJson(req,Math.min(maxBody,32_000));await siteIdFor({ req, url, body, actor, routeSiteId: siteId });const q=await localPool.query('SELECT * FROM membership_plans WHERE site_id=$1 AND id=$2 AND active=true',[siteId,body.planId]);const plan=q.rows[0];if(!plan)throw fail(404,'ERR_SYSTEMFABRIC_MEMBERSHIP_PLAN_NOT_FOUND','Membership plan not found.');const mode=plan.interval_unit==='one_time'?'payment':'subscription';const checkout=await createStripeCheckoutSession({secretKey:env.STRIPE_SECRET_KEY,mode,lineItems:[{currency:plan.currency,unitAmount:Number(plan.price_minor),quantity:1,name:plan.name,description:plan.description,interval:mode==='subscription'?plan.interval_unit:undefined,intervalCount:plan.interval_count}],successUrl:env.STRIPE_CHECKOUT_SUCCESS_URL,cancelUrl:env.STRIPE_CHECKOUT_CANCEL_URL,customerEmail:actor.user.email,metadata:{site_id:siteId,membership_plan_id:plan.id,user_id:actor.user.id,purchase_type:'membership'},subscriptionMetadata:{site_id:siteId,membership_plan_id:plan.id,user_id:actor.user.id,purchase_type:'membership'},idempotencyKey:`sf_mem_${siteId}_${actor.user.id}_${plan.id}_${randomUUID()}`});const saved=await localPool.query('INSERT INTO paid_memberships(site_id,user_id,plan_id,status,provider,provider_customer_id,provider_subscription_id) VALUES($1,$2,$3,\'pending\',\'stripe\',$4,$5) RETURNING id,status,plan_id,provider_subscription_id',[siteId,actor.user.id,plan.id,checkout.customerId,checkout.subscriptionId]);return sendJson(res,201,{membership:saved.rows[0],checkoutUrl:checkout.url,requestId});}
  const memberships=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/memberships$/i);
  if(method==='GET'&&memberships){if(!localPool)throw fail(503,'ERR_SYSTEMFABRIC_DATABASE_DISABLED','Memberships require PostgreSQL.');const siteId=memberships[1];await siteIdFor({ req, url, body: {}, actor, routeSiteId: siteId });await requireCapability(actor,siteId,'memberships:manage');const result=await localPool.query('SELECT m.id,m.user_id,u.email,u.display_name,m.plan_id,p.name AS plan_name,m.status,m.provider,m.current_period_start,m.current_period_end,m.cancel_at_period_end,m.created_at FROM paid_memberships m JOIN users u ON u.id=m.user_id JOIN membership_plans p ON p.id=m.plan_id WHERE m.site_id=$1 ORDER BY m.created_at DESC LIMIT 500',[siteId]);return sendJson(res,200,{memberships:result.rows,requestId});}

  const communityProfile=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/community\/profile$/i);
  if(communityProfile&&['GET','PUT'].includes(method)){if(!localPool||!actor.user.id)throw fail(503,'ERR_SYSTEMFABRIC_COMMUNITY_DISABLED','Community profiles require a signed-in user and PostgreSQL.');const siteId=communityProfile[1];const body=method==='PUT'?await readJson(req,Math.min(maxBody,32_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });if(method==='GET'){const q=await localPool.query('SELECT display_name,bio,avatar_asset_id,website_url,visibility,metadata,version,updated_at FROM social_profiles WHERE site_id=$1 AND user_id=$2',[siteId,actor.user.id]);return sendJson(res,200,{profile:q.rows[0]||null,requestId});}const v=validateProfile(body);if(!v.valid)throw fail(422,'ERR_SYSTEMFABRIC_PROFILE_INVALID','Profile validation failed.',v.errors);const profile=await localPool.query(`INSERT INTO social_profiles(site_id,user_id,display_name,bio,avatar_asset_id,website_url,visibility,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(site_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,bio=EXCLUDED.bio,avatar_asset_id=EXCLUDED.avatar_asset_id,website_url=EXCLUDED.website_url,visibility=EXCLUDED.visibility,metadata=EXCLUDED.metadata,version=social_profiles.version+1,updated_at=now() WHERE $9::integer IS NULL OR social_profiles.version=$9 RETURNING display_name,bio,avatar_asset_id,website_url,visibility,metadata,version,updated_at`,[siteId,actor.user.id,body.displayName.trim(),body.bio||'',body.avatarAssetId||null,body.websiteUrl||null,body.visibility||'members',JSON.stringify(body.metadata||{}),body.expectedVersion==null?null:Number(body.expectedVersion)]);if(!profile.rows[0])throw fail(409,'ERR_SYSTEMFABRIC_VERSION_CONFLICT','Profile version is stale.');return sendJson(res,200,{profile:profile.rows[0],requestId});}
  const groups=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/community\/groups(?:\/([0-9a-f-]{36})\/(join|members))?$/i);
  if(groups&&((!groups[2]&&['GET','POST'].includes(method))||(groups[2]&&method==='POST'))){if(!localPool||!actor.user.id)throw fail(503,'ERR_SYSTEMFABRIC_COMMUNITY_DISABLED','Community groups require PostgreSQL and a signed-in user.');const siteId=groups[1],body=method==='POST'?await readJson(req,Math.min(maxBody,32_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });
    if(!groups[2]&&method==='GET'){const q=await localPool.query(`SELECT g.id,g.slug,g.name,g.description,g.privacy,g.created_by,g.created_at,(SELECT count(*)::int FROM social_group_memberships gm WHERE gm.group_id=g.id AND gm.status='active') member_count,(SELECT status FROM social_group_memberships gm WHERE gm.group_id=g.id AND gm.user_id=$2) my_status FROM social_groups g WHERE g.site_id=$1 AND (g.privacy='public' OR g.created_by=$2 OR EXISTS(SELECT 1 FROM social_group_memberships gm WHERE gm.group_id=g.id AND gm.user_id=$2 AND gm.status='active')) ORDER BY g.created_at DESC LIMIT 200`,[siteId,actor.user.id]);return sendJson(res,200,{groups:q.rows,requestId});}
    if(!groups[2]&&method==='POST'){await requireCapability(actor,siteId,'content:create');const v=validateGroup(body);if(!v.valid)throw fail(422,'ERR_SYSTEMFABRIC_GROUP_INVALID','Group validation failed.',v.errors);const client=await localPool.connect();try{await client.query('BEGIN');const q=await client.query('INSERT INTO social_groups(site_id,slug,name,description,privacy,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[siteId,body.slug,body.name.trim(),body.description||'',body.privacy||'public',actor.user.id]);await client.query("INSERT INTO social_group_memberships(group_id,user_id,role,status) VALUES($1,$2,'owner','active')",[q.rows[0].id,actor.user.id]);await client.query('COMMIT');return sendJson(res,201,{group:q.rows[0],requestId});}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}}
    if(groups[3]==='join'){const g=await localPool.query('SELECT id,privacy FROM social_groups WHERE site_id=$1 AND id=$2',[siteId,groups[2]]);if(!g.rows[0])throw fail(404,'ERR_SYSTEMFABRIC_GROUP_NOT_FOUND','Group not found.');const status=g.rows[0].privacy==='public'?'active':'pending';const q=await localPool.query('INSERT INTO social_group_memberships(group_id,user_id,role,status) VALUES($1,$2,\'member\',$3) ON CONFLICT(group_id,user_id) DO UPDATE SET status=CASE WHEN social_group_memberships.status=\'banned\' THEN \'banned\' ELSE EXCLUDED.status END RETURNING group_id,user_id,role,status,created_at',[groups[2],actor.user.id,status]);if(q.rows[0].status==='banned')throw fail(403,'ERR_SYSTEMFABRIC_GROUP_BANNED','You cannot rejoin this group.');return sendJson(res,200,{membership:q.rows[0],requestId});}
    if(groups[3]==='members'){await requireCapability(actor,siteId,'community:moderate');const q=await localPool.query('SELECT u.id,u.display_name,u.email,gm.role,gm.status,gm.created_at FROM social_group_memberships gm JOIN users u ON u.id=gm.user_id JOIN social_groups g ON g.id=gm.group_id WHERE g.site_id=$1 AND g.id=$2 ORDER BY gm.created_at',[siteId,groups[2]]);return sendJson(res,200,{members:q.rows,requestId});}
  }
  const feed=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/community\/feed$/i);
  if(feed&&['GET','POST'].includes(method)){if(!localPool||!actor.user.id)throw fail(503,'ERR_SYSTEMFABRIC_COMMUNITY_DISABLED','Community feed requires PostgreSQL and a signed-in user.');const siteId=feed[1],body=method==='POST'?await readJson(req,Math.min(maxBody,32_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });if(method==='GET'){const q=await localPool.query(`SELECT a.id,a.actor_id,u.display_name,a.group_id,a.activity_type,a.body,a.visibility,a.parent_id,a.metadata,a.created_at FROM social_activities a JOIN users u ON u.id=a.actor_id WHERE a.site_id=$1 AND a.deleted_at IS NULL AND (a.visibility='public' OR a.visibility='members' OR a.actor_id=$2 OR (a.group_id IS NOT NULL AND EXISTS(SELECT 1 FROM social_group_memberships gm WHERE gm.group_id=a.group_id AND gm.user_id=$2 AND gm.status='active'))) ORDER BY a.created_at DESC LIMIT $3`,[siteId,actor.user.id,Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||30))]);return sendJson(res,200,{activities:q.rows,requestId});}const text=cleanText(body.body,10000);if(!text)throw fail(400,'ERR_SYSTEMFABRIC_ACTIVITY_INVALID','Activity body must contain 1–10000 characters.');const visibility=body.visibility||'members';if(!['public','members','private','group'].includes(visibility))throw fail(400,'ERR_SYSTEMFABRIC_ACTIVITY_INVALID','Activity visibility is invalid.');if(visibility==='group'&&!validUuid(body.groupId))throw fail(400,'ERR_SYSTEMFABRIC_ACTIVITY_GROUP_REQUIRED','A group is required for group visibility.');if(body.groupId){const member=await localPool.query("SELECT 1 FROM social_group_memberships gm JOIN social_groups g ON g.id=gm.group_id WHERE g.site_id=$1 AND gm.group_id=$2 AND gm.user_id=$3 AND gm.status='active'",[siteId,body.groupId,actor.user.id]);if(!member.rows[0])throw fail(403,'ERR_SYSTEMFABRIC_GROUP_MEMBERSHIP','Active group membership is required to post in this group.');}const q=await localPool.query('INSERT INTO social_activities(site_id,actor_id,group_id,activity_type,body,visibility,parent_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id,site_id,actor_id,group_id,activity_type,body,visibility,parent_id,metadata,created_at',[siteId,actor.user.id,body.groupId||null,body.activityType==='comment'?'comment':body.groupId?'group_post':'status',text,visibility,body.parentId||null,JSON.stringify({})]);return sendJson(res,201,{activity:q.rows[0],requestId});}
  const friendRequest=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/community\/friends(?:\/([0-9a-f-]{36}))?$/i);
  if(friendRequest&&['GET','POST','PUT','DELETE'].includes(method)){if(!localPool||!actor.user.id)throw fail(503,'ERR_SYSTEMFABRIC_COMMUNITY_DISABLED','Friendships require PostgreSQL and a signed-in user.');const siteId=friendRequest[1],target=friendRequest[2];await siteIdFor({ req, url, body: {}, actor, routeSiteId: siteId });if(method==='GET'){const q=await localPool.query(`SELECT f.requester_id,f.addressee_id,f.status,f.created_at,u1.display_name AS requester_name,u2.display_name AS addressee_name FROM social_friendships f JOIN users u1 ON u1.id=f.requester_id JOIN users u2 ON u2.id=f.addressee_id WHERE f.site_id=$1 AND (f.requester_id=$2 OR f.addressee_id=$2) ORDER BY f.created_at DESC LIMIT 200`,[siteId,actor.user.id]);return sendJson(res,200,{friendships:q.rows,requestId});}if(!target||!validUuid(target)||target===actor.user.id)throw fail(400,'ERR_SYSTEMFABRIC_FRIEND_INVALID','A different valid user ID is required.');if(method==='POST'){const member=await localPool.query('SELECT 1 FROM site_memberships WHERE site_id=$1 AND user_id=$2',[siteId,target]);if(!member.rows[0])throw fail(404,'ERR_SYSTEMFABRIC_COMMUNITY_USER_NOT_FOUND','User is not a member of this site.');const q=await localPool.query("INSERT INTO social_friendships(site_id,requester_id,addressee_id,status) VALUES($1,$2,$3,'pending') ON CONFLICT(site_id,requester_id,addressee_id) DO UPDATE SET status=CASE WHEN social_friendships.status='blocked' THEN 'blocked' ELSE social_friendships.status END,updated_at=now() RETURNING *",[siteId,actor.user.id,target]);return sendJson(res,201,{friendship:q.rows[0],requestId});}if(method==='PUT'){const q=await localPool.query("UPDATE social_friendships SET status='accepted',updated_at=now() WHERE site_id=$1 AND requester_id=$2 AND addressee_id=$3 AND status='pending' RETURNING *",[siteId,target,actor.user.id]);if(!q.rows[0])throw fail(404,'ERR_SYSTEMFABRIC_FRIEND_REQUEST_NOT_FOUND','Pending friend request not found.');return sendJson(res,200,{friendship:q.rows[0],requestId});}const q=await localPool.query('DELETE FROM social_friendships WHERE site_id=$1 AND ((requester_id=$2 AND addressee_id=$3) OR (requester_id=$3 AND addressee_id=$2)) RETURNING site_id',[siteId,actor.user.id,target]);return sendJson(res,200,{removed:Boolean(q.rowCount),requestId});}

  const firewallCollection=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/security\/firewall-rules$/i);const firewallItem=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/security\/firewall-rules\/([0-9a-f-]{36})$/i);
  if((firewallCollection&&['GET','POST'].includes(method))||(firewallItem&&method==='DELETE')){if(!localPool||!firewall)throw fail(503,'ERR_SYSTEMFABRIC_FIREWALL_DISABLED','Firewall rule management requires PostgreSQL.');const siteId=firewallCollection?.[1]||firewallItem[1];const body=method==='POST'?await readJson(req,Math.min(maxBody,32_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });await requireCapability(actor,siteId,'security:manage');if(method==='GET'){const q=await localPool.query('SELECT id,site_id,action,scope,pattern,reason,enabled,created_by,created_at,updated_at FROM firewall_rules WHERE site_id=$1 OR site_id IS NULL ORDER BY created_at DESC LIMIT 500',[siteId]);return sendJson(res,200,{rules:q.rows,requestId});}if(method==='POST'){if(!['allow','deny','challenge','rate_limit'].includes(body.action)||!['ip','cidr','path','user_agent'].includes(body.scope)||!validateIpPattern(body.scope,body.pattern)||typeof body.reason!=='string'||body.reason.length>500)throw fail(422,'ERR_SYSTEMFABRIC_FIREWALL_RULE_INVALID','Firewall rule action, scope, pattern, or reason is invalid.');const q=await localPool.query('INSERT INTO firewall_rules(site_id,action,scope,pattern,reason,enabled,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,site_id,action,scope,pattern,reason,enabled,created_by,created_at,updated_at',[siteId,body.action,body.scope,body.pattern,body.reason,body.enabled!==false,actor.user.id||null]);firewall.clearCache();await localPool.query('INSERT INTO site_security_events(site_id,request_id,event_type,severity,actor_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[siteId,requestId,'firewall.rule_created','medium',actor.user.id||null,JSON.stringify({ruleId:q.rows[0].id,action:body.action,scope:body.scope})]);return sendJson(res,201,{rule:q.rows[0],requestId});}const q=await localPool.query('DELETE FROM firewall_rules WHERE site_id=$1 AND id=$2 RETURNING id',[siteId,firewallItem[2]]);if(!q.rows[0])throw fail(404,'ERR_SYSTEMFABRIC_FIREWALL_RULE_NOT_FOUND','Firewall rule not found.');firewall.clearCache();return sendJson(res,200,{deleted:true,requestId});}

  const cloudConnections=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/cloud\/connections(?:\/([0-9a-f-]{36})\/(test|disable))?$/i);
  if(cloudConnections&&((!cloudConnections[2]&&['GET','POST'].includes(method))||(cloudConnections[2]&&method==='POST'))){if(!localPool)throw fail(503,'ERR_SYSTEMFABRIC_DATABASE_DISABLED','Cloud integration settings require PostgreSQL.');const siteId=cloudConnections[1],body=method==='POST'?await readJson(req,Math.min(maxBody,32_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });await requireCapability(actor,siteId,'cloud:manage');if(!cloudConnections[2]&&method==='GET'){const q=await localPool.query('SELECT id,site_id,provider,name,config,credential_reference,status,last_health_check_at,created_at,updated_at FROM cloud_connections WHERE site_id=$1 ORDER BY created_at DESC',[siteId]);return sendJson(res,200,{connections:q.rows,availableProviders:['aws-s3','s3-compatible','google-cloud-storage','azure-blob','cloudflare-r2','minio'],requestId});}if(!cloudConnections[2]&&method==='POST'){const validation=cloudConfigStatus({provider:body.provider,credentialReference:body.credentialReference,config:body.config||{}});const endpointAllowed=!(body.config||{}).endpoint||cloudEndpointAllowed((body.config||{}).endpoint,env);if(!validation.valid||!endpointAllowed)throw fail(422,'ERR_SYSTEMFABRIC_CLOUD_CONFIG_INVALID','Cloud connection failed validation.',[...validation.errors,...(!endpointAllowed?['endpoint must match the deployment allowlist in production']:[])]);if(typeof body.name!=='string'||!body.name.trim()||body.name.length>180)throw fail(400,'ERR_SYSTEMFABRIC_CLOUD_CONFIG_INVALID','Connection name is required.');const q=await localPool.query('INSERT INTO cloud_connections(site_id,provider,name,config,credential_reference,status) VALUES($1,$2,$3,$4::jsonb,$5,\'configured\') RETURNING id,site_id,provider,name,config,credential_reference,status,created_at,updated_at',[siteId,body.provider,body.name.trim(),JSON.stringify(body.config||{}),body.credentialReference]);return sendJson(res,201,{connection:q.rows[0],note:'Credentials are held by the configured secret manager; this record does not store secret values.',requestId});}if(cloudConnections[3]==='disable'){const q=await localPool.query("UPDATE cloud_connections SET status='disabled',updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING id,status",[siteId,cloudConnections[2]]);if(!q.rows[0])throw fail(404,'ERR_SYSTEMFABRIC_CLOUD_CONNECTION_NOT_FOUND','Cloud connection not found.');return sendJson(res,200,{connection:q.rows[0],requestId});}if(cloudConnections[3]==='test'){const q=await localPool.query('SELECT id,provider,config,credential_reference,status FROM cloud_connections WHERE site_id=$1 AND id=$2',[siteId,cloudConnections[2]]);if(!q.rows[0])throw fail(404,'ERR_SYSTEMFABRIC_CLOUD_CONNECTION_NOT_FOUND','Cloud connection not found.');const connection=q.rows[0];const credentialStatus=resolveCloudCredentialReference({provider:connection.provider,reference:connection.credential_reference,env});const configured=credentialStatus.ok;let test={status:'unhealthy',provider:connection.provider,credentialReferenceConfigured:configured,credentialReferenceMode:credentialStatus.mode||'unsupported',liveProbeAttempted:false,liveObjectStoreOperationPerformed:false};if(configured){try{const config=connection.config||{};const providerMap={'aws-s3':'aws-s3','s3-compatible':'s3-compatible','cloudflare-r2':'cloudflare-r2','minio':'minio','google-cloud-storage':'google-cloud-storage','azure-blob':'azure-blob'};const expected=providerMap[connection.provider];if(!expected)throw new Error('unsupported provider');const bucket=config.bucket||env.LIBRARY_STORAGE_BUCKET||env.S3_BUCKET||env.GCS_BUCKET;const container=config.container||env.LIBRARY_STORAGE_CONTAINER||env.AZURE_STORAGE_CONTAINER;if(['aws-s3','s3-compatible','cloudflare-r2','minio','google-cloud-storage'].includes(expected)&&(!bucket||typeof bucket!=='string'))throw new Error('bucket is not configured');if(expected==='azure-blob'&&(!container||typeof container!=='string'))throw new Error('container is not configured');const probeEnv={...env,LIBRARY_STORAGE_PROVIDER:expected,LIBRARY_STORAGE_BUCKET:bucket,LIBRARY_STORAGE_CONTAINER:container,LIBRARY_STORAGE_ENDPOINT:config.endpoint||env.LIBRARY_STORAGE_ENDPOINT,LIBRARY_STORAGE_REGION:config.region||env.LIBRARY_STORAGE_REGION,S3_FORCE_PATH_STYLE:config.forcePathStyle===true?'true':(config.forcePathStyle===false?'false':env.S3_FORCE_PATH_STYLE),GOOGLE_CLOUD_PROJECT:config.projectId||env.GOOGLE_CLOUD_PROJECT};const adapter=createCloudStorageAdapterFromEnv({env:probeEnv});test={...test,liveProbeAttempted:Boolean(adapter)};const result=await probeCloudStorageAdapter(adapter);test={status:'healthy',provider:connection.provider,credentialReferenceConfigured:true,credentialReferenceMode:credentialStatus.mode,liveProbeAttempted:true,liveObjectStoreOperationPerformed:true,probe:result};}catch(error){test={...test,status:'unhealthy',errorCode:error.code||'ERR_SYSTEMFABRIC_CLOUD_PROBE_FAILED',message:'Live storage probe failed. Verify provider credentials, bucket/container configuration, and permissions.'};}}else test={...test,status:'unhealthy',message:credentialStatus.message||'Credential reference could not be resolved by this runtime.'};await localPool.query('UPDATE cloud_connections SET status=$3,last_health_check_at=now(),updated_at=now() WHERE site_id=$1 AND id=$2',[siteId,cloudConnections[2],test.status]);return sendJson(res,200,{test,requestId});}}

  const megaMenus=pathName.match(/^\/api\/v1\/sites\/([0-9a-f-]{36})\/mega-menus(?:\/([a-z0-9][a-z0-9-]{0,100}))?$/i);
  if(megaMenus&&((!megaMenus[2]&&['GET','POST'].includes(method))||(megaMenus[2]&&['PUT','DELETE'].includes(method)) )){if(!localPool)throw fail(503,'ERR_SYSTEMFABRIC_DATABASE_DISABLED','Mega menus require PostgreSQL.');const siteId=megaMenus[1],body=['POST','PUT'].includes(method)?await readJson(req,Math.min(maxBody,256_000)):{};await siteIdFor({ req, url, body, actor, routeSiteId: siteId });await requireCapability(actor,siteId,method==='GET'?'content:read':'site:manage');if(!megaMenus[2]&&method==='GET'){const q=await localPool.query("SELECT id,slug,name,version,items,presentation,created_at,updated_at FROM navigation_menus WHERE site_id=$1 AND presentation->>'megaMenu'='true' ORDER BY name",[siteId]);return sendJson(res,200,{menus:q.rows,requestId});}if(!megaMenus[2]&&method==='POST'||megaMenus[2]&&method==='PUT'){if(!/^[a-z0-9][a-z0-9-]{0,100}$/.test(String(body.slug||megaMenus[2]||''))||typeof body.name!=='string'||!body.name.trim()||body.name.length>180)throw fail(400,'ERR_SYSTEMFABRIC_MEGA_MENU_METADATA','Mega menu slug and name are required.');const validItems=validateMenuItems(body.items||[]);if(!validItems.valid)throw fail(422,'ERR_SYSTEMFABRIC_MENU_INVALID','Mega-menu items failed validation.',validItems.errors);const presentation={megaMenu:true,layout:'columns',width:'wide',columns:3,showDescriptions:false,showImages:false,showIcons:true,mobileMode:'accordion',trigger:'click',...(body.presentation||{})};const v=presentationValid(presentation);if(!v.valid)throw fail(422,'ERR_SYSTEMFABRIC_MEGA_MENU_PRESENTATION','Mega-menu presentation failed validation.',v.errors);if(method==='POST'){const q=await localPool.query('INSERT INTO navigation_menus(site_id,slug,name,items,presentation,updated_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6) RETURNING id,slug,name,version,items,presentation,created_at,updated_at',[siteId,body.slug,body.name.trim(),JSON.stringify(body.items||[]),JSON.stringify(presentation),actor.user.id||null]);return sendJson(res,201,{menu:q.rows[0],requestId});}const q=await localPool.query('UPDATE navigation_menus SET name=$3,items=$4::jsonb,presentation=$5::jsonb,version=version+1,updated_by=$6,updated_at=now() WHERE site_id=$1 AND slug=$2 AND version=$7 RETURNING id,slug,name,version,items,presentation,created_at,updated_at',[siteId,megaMenus[2],body.name.trim(),JSON.stringify(body.items||[]),JSON.stringify(presentation),actor.user.id||null,Number(body.expectedVersion)]);if(!q.rows[0])throw fail(409,'ERR_SYSTEMFABRIC_VERSION_CONFLICT','Mega menu is missing or stale.');return sendJson(res,200,{menu:q.rows[0],requestId});}const q=await localPool.query("DELETE FROM navigation_menus WHERE site_id=$1 AND slug=$2 AND presentation->>'megaMenu'='true' RETURNING slug",[siteId,megaMenus[2]]);if(!q.rows[0])throw fail(404,'ERR_SYSTEMFABRIC_MEGA_MENU_NOT_FOUND','Mega menu not found.');return sendJson(res,200,{deleted:true,requestId});}

  return false;
}
module.exports = { handlePlatformRoute, presentationValid, productInput, validUuid };
