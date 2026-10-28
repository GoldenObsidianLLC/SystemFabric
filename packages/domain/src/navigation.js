'use strict';
const { isSafeUrl } = require('./page-document');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,100}$/;
function validateMenuItems(items) {
  const errors = []; let count = 0; const ids = new Set();
  function visit(list, depth, path) {
    if (!Array.isArray(list)) { errors.push(`${path} must be an array`); return; }
    if (depth > 5) { errors.push(`${path} exceeds the maximum menu depth`); return; }
    for (const [index, item] of list.entries()) {
      count += 1; const current = `${path}[${index}]`;
      if (count > 500) { errors.push('menu has more than 500 items'); return; }
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${current} must be an object`); continue; }
      if (typeof item.id !== 'string' || !SLUG_RE.test(item.id) || ids.has(item.id)) errors.push(`${current}.id must be a unique safe identifier`); else ids.add(item.id);
      if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 180) errors.push(`${current}.label must contain 1–180 characters`);
      if (!['page','url','collection','separator'].includes(item.type)) errors.push(`${current}.type is invalid`);
      if (item.type === 'url' && !isSafeUrl(item.url)) errors.push(`${current}.url must be a relative or HTTP(S) URL`);
      if (item.type === 'page' && (typeof item.contentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.contentId))) errors.push(`${current}.contentId must be a content UUID`);
      if (item.type === 'collection' && (typeof item.collectionSlug !== 'string' || !SLUG_RE.test(item.collectionSlug))) errors.push(`${current}.collectionSlug is invalid`);
      if (item.children !== undefined) visit(item.children, depth + 1, `${current}.children`);
    }
  }
  visit(items, 1, 'items'); return { valid: errors.length === 0, errors, count };
}
module.exports = { validateMenuItems };
