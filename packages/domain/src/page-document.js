'use strict';

const { randomUUID } = require('node:crypto');

const DOCUMENT_SCHEMA_VERSION = 1;
const MAX_NODES = 250;
const MAX_DEPTH = 12;
const MAX_TEXT_LENGTH = 20_000;
const ALLOWED_NODE_TYPES = new Set([
  'section', 'column', 'container',
  'widget.heading', 'widget.text', 'widget.button', 'widget.image', 'widget.video', 'widget.icon', 'widget.math', 'widget.list', 'widget.quote', 'widget.divider', 'widget.spacer', 'widget.query-loop'
]);
const CONTAINER_TYPES = new Set(['section', 'column', 'container']);
const ALLOWED_PROPS = new Set(['text', 'level', 'url', 'assetId', 'posterAssetId', 'alt', 'title', 'iconName', 'size', 'formula', 'displayMode', 'controls', 'className', 'styles', 'responsiveStyles', 'items', 'ordered', 'cite', 'height', 'source', 'contentType', 'limit', 'columns', 'emptyText']);
const TYPE_PROPS = Object.freeze({
  section: new Set(['className','styles','responsiveStyles']), column: new Set(['className','styles','responsiveStyles']), container: new Set(['className','styles','responsiveStyles']),
  'widget.heading': new Set(['text','level','className','styles','responsiveStyles']), 'widget.text': new Set(['text','className','styles','responsiveStyles']),
  'widget.button': new Set(['text','url','className','styles','responsiveStyles']), 'widget.image': new Set(['assetId','alt','className','styles','responsiveStyles']),
  'widget.video': new Set(['assetId','posterAssetId','title','controls','className','styles','responsiveStyles']),
  'widget.icon': new Set(['iconName','size','title','className','styles','responsiveStyles']),
  'widget.math': new Set(['formula','displayMode','className','styles','responsiveStyles']),
  'widget.list': new Set(['items','ordered','className','styles','responsiveStyles']), 'widget.quote': new Set(['text','cite','className','styles','responsiveStyles']),
  'widget.divider': new Set(['className','styles','responsiveStyles']), 'widget.spacer': new Set(['height','className','styles','responsiveStyles']),
  'widget.query-loop': new Set(['source','contentType','limit','columns','emptyText','className','styles','responsiveStyles'])
});
const STYLE_RULES = Object.freeze({
  color: /^(#[0-9a-f]{3,8}|[a-z]{1,24})$/i, backgroundColor: /^(#[0-9a-f]{3,8}|transparent|[a-z]{1,24})$/i,
  fontSize: /^(?:0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|vw|vh|%))$/, lineHeight: /^(?:normal|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%)?)$/,
  fontWeight: /^(?:normal|bold|[1-9]00)$/, textAlign: /^(?:left|center|right|justify)$/,
  padding: /^(?:0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%))(?:\s+(?:0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%))){0,3}$/,
  margin: /^(?:auto|0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%))(?:\s+(?:auto|0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%))){0,3}$/,
  gap: /^(?:0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%))$/, borderRadius: /^(?:0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%))$/,
  width: /^(?:auto|100%|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%|vw))$/, maxWidth: /^(?:none|100%|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%|vw))$/, minHeight: /^(?:auto|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%|vh))$/,
  display: /^(?:block|flex|grid|inline-block)$/, flexDirection: /^(?:row|row-reverse|column|column-reverse)$/,
  alignItems: /^(?:start|center|end|stretch|baseline)$/, justifyContent: /^(?:start|center|end|stretch|space-between|space-around|space-evenly)$/
});
const RESPONSIVE_BREAKPOINTS = new Set(['tablet', 'mobile']);

function validateStyles(styles, path, errors) {
  if (styles === undefined) return;
  if (!isPlainObject(styles)) { errors.push(`${path} must be an object`); return; }
  if (Object.keys(styles).length > 24) errors.push(`${path} contains too many style rules`);
  for (const [key, value] of Object.entries(styles)) {
    const pattern = STYLE_RULES[key];
    if (!pattern) { errors.push(`${path}.${key} is not an approved style property`); continue; }
    if (typeof value !== 'string' || value.length > 80 || !pattern.test(value.trim())) errors.push(`${path}.${key} has an invalid style value`);
  }
}

function styleToCss(styles) {
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) return '';
  return Object.entries(styles).filter(([key, value]) => STYLE_RULES[key]?.test(String(value).trim())).map(([key, value]) => `${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}:${String(value).trim()}`).join(';');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSafeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  if (value.startsWith('/')) return !value.startsWith('//') && !/[\r\n\\]/.test(value);
  if (value.startsWith('#')) return !/[\s\r\n]/.test(value) && value.length <= 300;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function validatePageDocument(document) {
  const errors = [];
  if (!isPlainObject(document)) return { valid: false, errors: ['document must be an object'] };
  if (document.schemaVersion !== DOCUMENT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${DOCUMENT_SCHEMA_VERSION}`);
  if (document.type !== 'page') errors.push('type must be "page"');
  if (typeof document.documentId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(document.documentId)) errors.push('documentId must be a short stable identifier');
  if (typeof document.title !== 'string' || document.title.trim().length < 1 || document.title.length > 180) errors.push('title must be 1–180 characters');
  if (!Array.isArray(document.children)) errors.push('children must be an array');

  let nodeCount = 0;
  const ids = new Set();
  function visit(node, depth, path) {
    nodeCount += 1;
    if (nodeCount > MAX_NODES) { errors.push(`node count exceeds ${MAX_NODES}`); return; }
    if (depth > MAX_DEPTH) { errors.push(`tree depth exceeds ${MAX_DEPTH} at ${path}`); return; }
    if (!isPlainObject(node)) { errors.push(`${path} must be an object`); return; }
    if (typeof node.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(node.id)) errors.push(`${path}.id must be a short stable identifier`);
    else if (ids.has(node.id)) errors.push(`${path}.id is duplicated`);
    else ids.add(node.id);
    if (!ALLOWED_NODE_TYPES.has(node.type)) errors.push(`${path}.type is not an approved widget type`);
    if (!isPlainObject(node.props)) errors.push(`${path}.props must be an object`);
    else {
      for (const key of Object.keys(node.props)) {
        if (!ALLOWED_PROPS.has(key) || !TYPE_PROPS[node.type]?.has(key)) errors.push(`${path}.props.${key} is not allowed for ${node.type}`);
      }
      const props = node.props;
      validateStyles(props.styles, `${path}.props.styles`, errors);
      if (props.responsiveStyles !== undefined) {
        if (!isPlainObject(props.responsiveStyles)) errors.push(`${path}.props.responsiveStyles must be an object`);
        else for (const [breakpoint, rules] of Object.entries(props.responsiveStyles)) {
          if (!RESPONSIVE_BREAKPOINTS.has(breakpoint)) errors.push(`${path}.props.responsiveStyles.${breakpoint} is not an approved breakpoint`);
          else validateStyles(rules, `${path}.props.responsiveStyles.${breakpoint}`, errors);
        }
      }
      if (CONTAINER_TYPES.has(node.type)) {
        if (props.className !== undefined && props.className !== null && (typeof props.className !== 'string' || !/^[A-Za-z0-9 _-]{0,120}$/.test(props.className))) errors.push(`${path}.props.className is invalid`);
        if (props.text !== undefined || props.url !== undefined || props.assetId !== undefined) errors.push(`${path} container cannot set widget-only props`);
      } else if (node.type === 'widget.heading') {
        if (typeof props.text !== 'string' || props.text.length > MAX_TEXT_LENGTH) errors.push(`${path}.props.text must be a string up to ${MAX_TEXT_LENGTH} characters`);
        if (![1, 2, 3, 4, 5, 6].includes(props.level)) errors.push(`${path}.props.level must be an integer from 1 to 6`);
      } else if (node.type === 'widget.text') {
        if (typeof props.text !== 'string' || props.text.length > MAX_TEXT_LENGTH) errors.push(`${path}.props.text must be a string up to ${MAX_TEXT_LENGTH} characters`);
      } else if (node.type === 'widget.button') {
        if (typeof props.text !== 'string' || props.text.length > 500) errors.push(`${path}.props.text must be a string up to 500 characters`);
        if (!isSafeUrl(props.url)) errors.push(`${path}.props.url must be a relative path or http(s) URL`);
      } else if (node.type === 'widget.image') {
        if (typeof props.assetId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(props.assetId)) errors.push(`${path}.props.assetId must reference an asset identifier`);
        if (typeof props.alt !== 'string' || props.alt.length > 1000) errors.push(`${path}.props.alt must be a string up to 1000 characters`);
      } else if (node.type === 'widget.video') {
        if (typeof props.assetId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(props.assetId)) errors.push(`${path}.props.assetId must reference a video asset identifier`);
        if (props.posterAssetId !== undefined && props.posterAssetId !== null && (typeof props.posterAssetId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(props.posterAssetId))) errors.push(`${path}.props.posterAssetId is invalid`);
        if (props.title !== undefined && (typeof props.title !== 'string' || props.title.length > 180)) errors.push(`${path}.props.title must be up to 180 characters`);
        if (props.controls !== undefined && typeof props.controls !== 'boolean') errors.push(`${path}.props.controls must be boolean`);
      } else if (node.type === 'widget.icon') {
        if (typeof props.iconName !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,60}$/.test(props.iconName)) errors.push(`${path}.props.iconName is invalid`);
        if (props.size !== undefined && (!Number.isInteger(props.size) || props.size < 8 || props.size > 128)) errors.push(`${path}.props.size must be an integer from 8 to 128`);
        if (props.title !== undefined && (typeof props.title !== 'string' || props.title.length > 180)) errors.push(`${path}.props.title must be up to 180 characters`);
      } else if (node.type === 'widget.math') {
        if (typeof props.formula !== 'string' || props.formula.length < 1 || props.formula.length > 10000) errors.push(`${path}.props.formula must be a string of 1–10000 characters`);
        if (props.displayMode !== undefined && typeof props.displayMode !== 'boolean') errors.push(`${path}.props.displayMode must be boolean`);
      } else if (node.type === 'widget.quote') {
        if (typeof props.text !== 'string' || props.text.length > MAX_TEXT_LENGTH) errors.push(`${path}.props.text must be a string up to ${MAX_TEXT_LENGTH} characters`);
        if (props.cite !== undefined && (typeof props.cite !== 'string' || props.cite.length > 300)) errors.push(`${path}.props.cite must be a string up to 300 characters`);
      } else if (node.type === 'widget.list') {
        if (!Array.isArray(props.items) || props.items.length < 1 || props.items.length > 100 || props.items.some(item => typeof item !== 'string' || item.length > 2000)) errors.push(`${path}.props.items must contain 1–100 strings of at most 2000 characters`);
        if (props.ordered !== undefined && typeof props.ordered !== 'boolean') errors.push(`${path}.props.ordered must be a boolean`);
      } else if (node.type === 'widget.spacer') {
        if (typeof props.height !== 'string' || !/^(?:[0-9]+(?:\.[0-9]+)?(?:px|rem|em|vh))$/.test(props.height)) errors.push(`${path}.props.height must be a CSS length in px, rem, em, or vh`);
      } else if (node.type === 'widget.query-loop') {
        if (props.source !== 'latest-published') errors.push(`${path}.props.source must be latest-published`);
        if (typeof props.contentType !== 'string' || !/^[a-z][a-z0-9_-]{0,49}$/.test(props.contentType)) errors.push(`${path}.props.contentType must be a content type slug`);
        if (!Number.isInteger(props.limit) || props.limit < 1 || props.limit > 12) errors.push(`${path}.props.limit must be an integer from 1 to 12`);
        if (!Number.isInteger(props.columns) || props.columns < 1 || props.columns > 4) errors.push(`${path}.props.columns must be an integer from 1 to 4`);
        if (typeof props.emptyText !== 'string' || props.emptyText.length > 500) errors.push(`${path}.props.emptyText must be a string up to 500 characters`);
      }
    }
    if (!Array.isArray(node.children)) errors.push(`${path}.children must be an array`);
    else {
      if (!CONTAINER_TYPES.has(node.type) && node.children.length > 0) errors.push(`${path} widget type cannot contain children`);
      node.children.forEach((child, index) => visit(child, depth + 1, `${path}.children[${index}]`));
    }
  }
  if (Array.isArray(document.children)) document.children.forEach((child, index) => visit(child, 1, `children[${index}]`));
  return { valid: errors.length === 0, errors, nodeCount };
}

function normalizeGeneratedDocument(document) {
  const clone = structuredClone(document);
  clone.schemaVersion = DOCUMENT_SCHEMA_VERSION;
  clone.documentId = randomUUID();
  function visit(node) {
    node.id = randomUUID();
    if (!node.props || typeof node.props !== 'object' || Array.isArray(node.props)) node.props = {};
    if (!Array.isArray(node.children)) node.children = [];
    if (CONTAINER_TYPES.has(node.type)) {
      node.props = Object.fromEntries(['className', 'styles', 'responsiveStyles'].filter(key => node.props[key] !== undefined && node.props[key] !== null).map(key => [key, node.props[key]]));
    } else if (node.type === 'widget.heading') {
      node.props = { text: node.props.text ?? '', level: node.props.level ?? 2, ...(node.props.styles ? { styles: node.props.styles } : {}), ...(node.props.responsiveStyles ? { responsiveStyles: node.props.responsiveStyles } : {}) };
    } else if (node.type === 'widget.text') {
      node.props = { text: node.props.text ?? '', ...(node.props.styles ? { styles: node.props.styles } : {}), ...(node.props.responsiveStyles ? { responsiveStyles: node.props.responsiveStyles } : {}) };
    } else if (node.type === 'widget.button') {
      node.props = { text: node.props.text ?? 'Learn more', url: node.props.url ?? '/', ...(node.props.styles ? { styles: node.props.styles } : {}), ...(node.props.responsiveStyles ? { responsiveStyles: node.props.responsiveStyles } : {}) };
    } else if (node.type === 'widget.image') {
      node.props = { assetId: node.props.assetId ?? 'placeholder', alt: node.props.alt ?? '', ...(node.props.styles ? { styles: node.props.styles } : {}), ...(node.props.responsiveStyles ? { responsiveStyles: node.props.responsiveStyles } : {}) };
    } else if (node.type === 'widget.video') {
      node.props = { assetId: node.props.assetId ?? 'replace-with-video-asset-id', title: node.props.title ?? '', controls: node.props.controls !== false, ...(node.props.posterAssetId ? { posterAssetId: node.props.posterAssetId } : {}), ...(node.props.styles ? { styles: node.props.styles } : {}), ...(node.props.responsiveStyles ? { responsiveStyles: node.props.responsiveStyles } : {}) };
    } else if (node.type === 'widget.icon') {
      node.props = { iconName: node.props.iconName ?? 'check', size: node.props.size ?? 24, ...(node.props.title ? { title: node.props.title } : {}), ...(node.props.styles ? { styles: node.props.styles } : {}), ...(node.props.responsiveStyles ? { responsiveStyles: node.props.responsiveStyles } : {}) };
    } else if (node.type === 'widget.math') {
      node.props = { formula: node.props.formula ?? 'x^2 + y^2 = z^2', displayMode: node.props.displayMode === true, ...(node.props.styles ? { styles: node.props.styles } : {}), ...(node.props.responsiveStyles ? { responsiveStyles: node.props.responsiveStyles } : {}) };
    } else if (node.type === 'widget.quote') {
      node.props = { text: node.props.text ?? '', cite: node.props.cite ?? '', ...(node.props.styles ? { styles: node.props.styles } : {}), ...(node.props.responsiveStyles ? { responsiveStyles: node.props.responsiveStyles } : {}) };
    } else if (node.type === 'widget.list') {
      node.props = { items: Array.isArray(node.props.items) ? node.props.items : ['List item'], ordered: node.props.ordered === true, ...(node.props.styles ? { styles: node.props.styles } : {}), ...(node.props.responsiveStyles ? { responsiveStyles: node.props.responsiveStyles } : {}) };
    } else if (node.type === 'widget.spacer') {
      node.props = { height: node.props.height ?? '24px', ...(node.props.styles ? { styles: node.props.styles } : {}), ...(node.props.responsiveStyles ? { responsiveStyles: node.props.responsiveStyles } : {}) };
    } else if (node.type === 'widget.query-loop') {
      node.props = { source: node.props.source ?? 'latest-published', contentType: node.props.contentType ?? 'post', limit: node.props.limit ?? 3, columns: node.props.columns ?? 3, emptyText: node.props.emptyText ?? 'No items found.', ...(node.props.styles ? { styles: node.props.styles } : {}), ...(node.props.responsiveStyles ? { responsiveStyles: node.props.responsiveStyles } : {}) };
    }
    node.children.forEach(visit);
  }
  clone.children = Array.isArray(clone.children) ? clone.children : [];
  clone.children.forEach(visit);
  const validation = validatePageDocument(clone);
  if (!validation.valid) {
    const error = new Error(`Generated page document failed validation: ${validation.errors.join('; ')}`);
    error.code = 'ERR_SYSTEMFABRIC_INVALID_DOCUMENT';
    error.details = validation.errors;
    throw error;
  }
  return clone;
}

module.exports = {
  DOCUMENT_SCHEMA_VERSION,
  ALLOWED_NODE_TYPES,
  CONTAINER_TYPES,
  TYPE_PROPS,
  validatePageDocument,
  normalizeGeneratedDocument,
  isSafeUrl,
  validateStyles,
  styleToCss,
  STYLE_RULES,
  RESPONSIVE_BREAKPOINTS
};
