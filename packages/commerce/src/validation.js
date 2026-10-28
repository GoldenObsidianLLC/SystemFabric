'use strict';
function validationError(code, errors) { return { valid: false, code, errors }; }
function validateProduct(input, { requireStatus = false } = {}) {
  const errors=[];
  if (!input || typeof input!=='object' || Array.isArray(input)) return validationError('ERR_SYSTEMFABRIC_PRODUCT_INVALID',['product must be an object']);
  if (typeof input.slug!=='string'||!/^[a-z0-9][a-z0-9-]{0,180}$/.test(input.slug)) errors.push('slug must be a lowercase URL-safe identifier');
  if (typeof input.name!=='string'||!input.name.trim()||input.name.length>240) errors.push('name must contain 1–240 characters');
  if (!['simple','variable','downloadable','virtual','subscription'].includes(input.productType||'simple')) errors.push('productType is invalid');
  if (!/^[A-Z]{3}$/.test(input.currency||'USD')) errors.push('currency must be a three-letter uppercase code');
  if (!Number.isSafeInteger(input.priceMinor)||input.priceMinor<0) errors.push('priceMinor must be a non-negative safe integer in minor currency units');
  if (input.compareAtPriceMinor!==undefined&&input.compareAtPriceMinor!==null&&(!Number.isSafeInteger(input.compareAtPriceMinor)||input.compareAtPriceMinor<input.priceMinor)) errors.push('compareAtPriceMinor must be greater than or equal to priceMinor');
  if (input.inventoryQuantity!==undefined&&input.inventoryQuantity!==null&&(!Number.isInteger(input.inventoryQuantity)||input.inventoryQuantity<0)) errors.push('inventoryQuantity must be a non-negative integer or null');
  if (input.requiresShipping!==undefined&&typeof input.requiresShipping!=='boolean') errors.push('requiresShipping must be boolean');
  if (input.description!==undefined&&(typeof input.description!=='string'||input.description.length>100000)) errors.push('description must be up to 100000 characters');
  if (input.images!==undefined&&(!Array.isArray(input.images)||input.images.length>50||input.images.some(id=>typeof id!=='string'||id.length>100))) errors.push('images must be an array of at most 50 asset identifiers');
  if (input.attributes!==undefined&&(!input.attributes||typeof input.attributes!=='object'||Array.isArray(input.attributes)||Buffer.byteLength(JSON.stringify(input.attributes))>32000)) errors.push('attributes must be a small JSON object');
  if (requireStatus && !['draft','published','archived'].includes(input.status)) errors.push('status must be draft, published, or archived');
  return { valid:errors.length===0,code:'ERR_SYSTEMFABRIC_PRODUCT_INVALID',errors };
}
function normalizeCart(items) {
  if (!Array.isArray(items)||items.length<1||items.length>100) return validationError('ERR_SYSTEMFABRIC_CART_INVALID',['items must contain 1–100 product lines']);
  const quantities=new Map(); const errors=[];
  for(const [index,item] of items.entries()) {
    if(!item||typeof item!=='object'||typeof item.productId!=='string'||!/^[0-9a-f-]{36}$/i.test(item.productId)||!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>1000) { errors.push(`items[${index}] is invalid`); continue; }
    quantities.set(item.productId,(quantities.get(item.productId)||0)+item.quantity);
  }
  if ([...quantities.values()].some(q=>q>1000)) errors.push('combined quantity for a product cannot exceed 1000');
  return { valid:errors.length===0, errors, items:[...quantities].map(([productId,quantity])=>({productId,quantity})) };
}
function calculateLineTotal(unitPriceMinor,quantity) { if(!Number.isSafeInteger(unitPriceMinor)||unitPriceMinor<0||!Number.isInteger(quantity)||quantity<1||!Number.isSafeInteger(unitPriceMinor*quantity)) throw new RangeError('Price calculation is outside the safe integer range.'); return unitPriceMinor*quantity; }
module.exports = { validateProduct, normalizeCart, calculateLineTotal };
