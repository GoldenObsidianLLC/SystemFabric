'use strict';

/**
 * EnginEx AI-Native v6.2
 *
 * Dependency-free Node.js template engine with a safe-by-default expression
 * interpreter. Templates are parsed into a small internal AST; expressions are
 * interpreted and never passed to eval(), Function(), or the Node VM by default.
 *
 * Safe syntax:
 *   {{ value }}                         HTML-escaped interpolation
 *   {{{ trustedValue }}}                only engine.safeHtml(...) values
 *   {{#if condition}}...{{else}}...{{/if}}
 *   {{#unless condition}}...{{/unless}}
 *   {{#each items as item, index}}...{{else}}...{{/each}}
 *   {{#with user as account}}...{{/with}}
 *   {{> "partials/card.html" user}}    partial with optional context
 *   {{#extends "layouts/base.html"}}...{{/extends}}
 *   {{#block "content"}}...{{/block}}
 *   {{ value | upper }}                 filter pipeline
 *
 * Legacy <?njs ... ?> templates are supported only through the explicit,
 * intentionally unsafe `{ allowUnsafeCode: true }` compatibility switch.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { types: utilTypes } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');
const { FragmentDependencyGraph, DirtyBitSet, pathMatchesDependency } = require('./lib/dirty-bitset');
const { getProfileLimits, describeProfiles } = require('./lib/performance-profiles');
const { normalizeRenderRequest, RENDER_REQUEST_SCHEMA } = require('./lib/render-request');

const VERSION = '6.2.0';
const OPEN = '{{';
const RAW_OPEN = '{{{';
const DEFAULT_EXTENSION = '.html';
const DEFAULT_LIMITS = Object.freeze({
  maxTemplateBytes: 2 * 1024 * 1024,
  maxNodes: 100_000,
  maxBlockDepth: 100,
  maxExpressionNodes: 2_000,
  maxExpressionDepth: 80,
  maxDataDepth: 40,
  maxDataStringLength: 1_000_000,
  maxDataNodes: 100_000,
  maxDataProperties: 100_000,
  maxLoopIterations: 20_000,
  maxIncludeDepth: 48,
  maxOutputLength: 8 * 1024 * 1024,
  maxRenderTimeMs: 10_000,
  cacheMaxEntries: 500
});

const DANGEROUS_KEYS = new Set([
  '__proto__', 'prototype', 'constructor', 'caller', 'callee', 'arguments',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'
]);
const ENGINE_OPTION_KEYS = new Set([
  'root', 'views', 'locals', 'helpers', 'cache', 'cacheMaxEntries', 'strictPaths',
  'maxTemplateBytes', 'maxNodes', 'maxBlockDepth', 'maxExpressionNodes', 'maxExpressionDepth',
  'maxDataDepth', 'maxDataStringLength', 'maxDataNodes', 'maxDataProperties', 'maxLoopIterations',
  'maxIncludeDepth', 'maxOutputLength', 'maxRenderTimeMs', 'allowUnsafeCode',
  'allowUnsafeRequire', 'development', 'onError', 'templateName', 'dataSchema', 'templateManifest',
  'pureHelpers', 'incremental', 'changedPaths', 'wasmSimdAccelerator', 'workerPool', 'webGpu',
  'profile', 'telemetry', 'onMetric', 'traceId', 'requestId', 'strictOutputContexts'
]);
const SAFE_HTML = new WeakSet();
const AST_CACHE = new Map();
const IN_FLIGHT = new Map();
// Renderer functions are keyed by the immutable parser AST array.
const COMPILED_RENDERERS = new WeakMap();
const FORMATTER_CACHE = new Map();
const PREPARED_DATA = new WeakMap();
const RENDER_STATS = { compiledRenderers: 0, syncRenders: 0, incrementalPatches: 0 };
let cacheGeneration = 0;
const CACHE_STATS = { hits: 0, misses: 0, parses: 0, evictions: 0, rendererCompiles: 0 };
const TELEMETRY = { enabledRenders: 0, renders: 0, errors: 0, totalDurationMs: 0, maxDurationMs: 0, outputBytes: 0, byMode: Object.create(null) };
const HTML_ESCAPE = /[&<>"']/g;
const HTML_ESCAPE_MAP = Object.freeze({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;'
});

class TemplateError extends Error {
  constructor(message, { code = 'ERR_ENGINEX_TEMPLATE', templatePath, line, column, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TemplateError';
    this.code = code;
    if (templatePath) this.templatePath = templatePath;
    if (Number.isInteger(line)) this.line = line;
    if (Number.isInteger(column)) this.column = column;
  }
}

function escapeHtml(value) {
  return toDisplayString(value).replace(HTML_ESCAPE, character => HTML_ESCAPE_MAP[character]);
}

function toDisplayString(value) {
  if (isSafeHtml(value)) return value.value;
  if (value !== null && typeof value === 'object' && utilTypes.isProxy(value)) {
    throw new TemplateError('Proxy objects cannot be rendered as template data.', { code: 'ERR_ENGINEX_UNSAFE_DATA' });
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return Number.isFinite(Date.prototype.getTime.call(value)) ? Date.prototype.toISOString.call(value) : '';
  if (Array.isArray(value)) return value.map(toDisplayString).join(',');
  return '[object Object]';
}

function safeHtml(value) {
  if (typeof value !== 'string') throw new TypeError('safeHtml accepts a string only.');
  const wrapped = Object.freeze({ value });
  SAFE_HTML.add(wrapped);
  return wrapped;
}

function isSafeHtml(value) {
  return value !== null && typeof value === 'object' && SAFE_HTML.has(value);
}

function escapeScriptJson(value) {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\u0000-\u001f\u007f\\]/.test(raw)) return '';
  // Accept local URLs and a short allowlist of useful absolute schemes.
  if (/^(?:https?:|mailto:|tel:)/i.test(raw)) return raw;
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) return '';
  return raw;
}

function cachedFormatter(CacheType, locale, options, prefix) {
  const normalized = options && isPlainObject(options) ? options : {};
  const key = `${prefix}:${String(locale)}:${JSON.stringify(normalized, Object.keys(normalized).sort())}`;
  let formatter = FORMATTER_CACHE.get(key);
  if (formatter) {
    FORMATTER_CACHE.delete(key);
    FORMATTER_CACHE.set(key, formatter);
    return formatter;
  }
  formatter = new CacheType(locale, normalized);
  FORMATTER_CACHE.set(key, formatter);
  while (FORMATTER_CACHE.size > 256) FORMATTER_CACHE.delete(FORMATTER_CACHE.keys().next().value);
  return formatter;
}

const BUILTIN_HELPERS = Object.freeze(Object.assign(Object.create(null), {
  upper: value => toDisplayString(value).toUpperCase(),
  lower: value => toDisplayString(value).toLowerCase(),
  capitalize: value => {
    const s = toDisplayString(value);
    return s ? s[0].toUpperCase() + s.slice(1) : '';
  },
  defaultValue: (value, fallback = '') => value === null || value === undefined || value === '' ? fallback : value,
  join: (value, separator = ', ') => Array.isArray(value) ? value.map(toDisplayString).join(String(separator)) : value == null ? '' : toDisplayString(value),
  length: value => {
    if (value == null) return 0;
    if (typeof value === 'string' || Array.isArray(value)) return value.length;
    if (value instanceof Map || value instanceof Set) return value.size;
    if (typeof value === 'object') return Object.keys(value).length;
    return 0;
  },
  isEmpty: value => value == null || value === '' || (Array.isArray(value) && value.length === 0) || (value instanceof Map || value instanceof Set) && value.size === 0 || isPlainObject(value) && Object.keys(value).length === 0,
  contains: (value, needle) => {
    if (typeof value === 'string') return value.includes(toDisplayString(needle));
    if (Array.isArray(value)) return value.includes(needle);
    if (value instanceof Map) return Map.prototype.has.call(value, needle);
    if (value instanceof Set) return Set.prototype.has.call(value, needle);
    return false;
  },
  startsWith: (value, prefix) => toDisplayString(value).startsWith(toDisplayString(prefix)),
  endsWith: (value, suffix) => toDisplayString(value).endsWith(toDisplayString(suffix)),
  first: value => Array.isArray(value) ? value[0] : typeof value === 'string' ? Array.from(value)[0] : undefined,
  last: value => Array.isArray(value) ? value[value.length - 1] : typeof value === 'string' ? Array.from(value).at(-1) : undefined,
  keys: value => isPlainObject(value) ? Object.keys(value) : value instanceof Map ? Array.from(Map.prototype.keys.call(value)) : [],
  values: value => isPlainObject(value) ? Object.keys(value).map(key => value[key]) : value instanceof Map ? Array.from(Map.prototype.values.call(value)) : value instanceof Set ? Array.from(Set.prototype.values.call(value)) : [],
  sum: value => Array.isArray(value) ? value.reduce((total, item) => total + Number(item || 0), 0) : 0,
  min: (...values) => Math.min(...values.map(Number)),
  max: (...values) => Math.max(...values.map(Number)),
  abs: value => Math.abs(Number(value)),
  round: (value, digits = 0) => { const factor = 10 ** Math.max(-8, Math.min(8, Number(digits) || 0)); return Math.round(Number(value) * factor) / factor; },
  formatDate: (value, locale = 'en-US', options = {}) => {
    const date = value instanceof Date ? value : new Date(String(value ?? ''));
    if (!Number.isFinite(date.getTime())) return '';
    return cachedFormatter(Intl.DateTimeFormat, locale, options, 'date').format(date);
  },
  urlencode: value => encodeURIComponent(toDisplayString(value)),
  formatNumber: (value, locale = 'en-US', options = {}) => cachedFormatter(Intl.NumberFormat, locale, options, 'number').format(Number(value)),
  formatCurrency: (value, currency = 'USD', locale = 'en-US') => cachedFormatter(Intl.NumberFormat, locale, { style: 'currency', currency: String(currency) }, 'currency').format(Number(value)),
  json: value => JSON.stringify(value),
  jsonScript: value => safeHtml(escapeScriptJson(value) ?? 'null'),
  safeUrl,
  htmlAttr: value => safeHtml(escapeHtml(value)),
  bool: value => Boolean(value),
  pluralize: (value, singular, plural) => Number(value) === 1 ? String(singular) : String(plural ?? `${singular}s`),
  truncate: (value, length = 80, suffix = '…') => {
    const text = toDisplayString(value);
    const max = Math.max(0, Math.floor(Number(length) || 0));
    return text.length <= max ? text : text.slice(0, max) + String(suffix);
  }
}));

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeLimits(options = {}) {
  const profileLimits = getProfileLimits(options.profile || 'standard-ssr');
  const limits = Object.create(null);
  for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const value = options[name] ?? profileLimits[name] ?? fallback;
    if (!Number.isSafeInteger(value) || (name === 'cacheMaxEntries' ? value < 0 : value <= 0)) {
      throw new TypeError(`${name} must be a ${name === 'cacheMaxEntries' ? 'non-negative' : 'positive'} safe integer.`);
    }
    limits[name] = value;
  }
  if (!Number.isSafeInteger(options.cacheMaxEntries ?? limits.cacheMaxEntries) || (options.cacheMaxEntries ?? limits.cacheMaxEntries) < 0) {
    throw new TypeError('cacheMaxEntries must be a non-negative safe integer.');
  }
  limits.cacheMaxEntries = options.cacheMaxEntries ?? limits.cacheMaxEntries;
  return limits;
}

function getRoot(options) {
  const root = Array.isArray(options.root ?? options.views)
    ? (options.root ?? options.views)[0]
    : (options.root ?? options.views);
  return path.resolve(root || process.cwd());
}

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveCanonicalPath(candidate, root, strictPaths, forErrorPath = candidate) {
  let realRoot;
  let realCandidate;
  try {
    [realRoot, realCandidate] = await Promise.all([fsp.realpath(root), fsp.realpath(candidate)]);
  } catch (cause) {
    throw new TemplateError(`Unable to resolve template path: ${forErrorPath}`, {
      code: 'ERR_ENGINEX_PATH_RESOLUTION', templatePath: forErrorPath, cause
    });
  }
  if (strictPaths && !withinRoot(realRoot, realCandidate)) {
    throw new TemplateError(`Template path escapes the configured root: ${forErrorPath}`, {
      code: 'ERR_ENGINEX_PATH_OUTSIDE_ROOT', templatePath: forErrorPath
    });
  }
  return realCandidate;
}

function ensureExtension(name) {
  return path.extname(name) ? name : `${name}${DEFAULT_EXTENSION}`;
}

async function resolveRootPath(templateName, options) {
  if (typeof templateName !== 'string' || templateName.trim() === '') throw new TypeError('A template path is required.');
  const root = getRoot(options);
  const withExtension = ensureExtension(templateName);
  const candidate = path.isAbsolute(withExtension) ? path.resolve(withExtension) : path.resolve(root, withExtension);
  return resolveCanonicalPath(candidate, root, options.strictPaths !== false, candidate);
}

async function resolvePartialPath(templateName, parentPath, options) {
  if (typeof templateName !== 'string' || templateName.trim() === '') {
    throw new TemplateError('A partial requires a non-empty template name.', { code: 'ERR_ENGINEX_PARTIAL_NAME', templatePath: parentPath });
  }
  const root = getRoot(options);
  const requested = ensureExtension(templateName);
  const base = path.dirname(parentPath);
  const candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(base, requested);
  return resolveCanonicalPath(candidate, root, options.strictPaths !== false, parentPath);
}

function getSignature(stats) {
  return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function trimCache(maxEntries) {
  while (AST_CACHE.size > maxEntries) {
    const oldest = AST_CACHE.keys().next().value;
    if (oldest === undefined) break;
    AST_CACHE.delete(oldest);
    CACHE_STATS.evictions++;
  }
}

function cacheGet(cacheKey) {
  const entry = AST_CACHE.get(cacheKey);
  if (!entry) return null;
  AST_CACHE.delete(cacheKey);
  AST_CACHE.set(cacheKey, entry);
  CACHE_STATS.hits++;
  return entry;
}

async function readTemplateSource(templatePath, limits, attempt = 0) {
  const before = await fsp.stat(templatePath);
  if (before.size > limits.maxTemplateBytes) {
    throw new TemplateError(`Template exceeds maxTemplateBytes (${limits.maxTemplateBytes}).`, {
      code: 'ERR_ENGINEX_TEMPLATE_LIMIT', templatePath
    });
  }
  const source = await fsp.readFile(templatePath, 'utf8');
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  if (sourceBytes > limits.maxTemplateBytes) {
    throw new TemplateError(`Template exceeds maxTemplateBytes (${limits.maxTemplateBytes}).`, {
      code: 'ERR_ENGINEX_TEMPLATE_LIMIT', templatePath
    });
  }
  const after = await fsp.stat(templatePath);
  if (getSignature(before) !== getSignature(after)) {
    if (attempt < 2) return readTemplateSource(templatePath, limits, attempt + 1);
    throw new TemplateError('Template changed repeatedly while being read; retry rendering.', {
      code: 'ERR_ENGINEX_TEMPLATE_CHANGED_DURING_READ', templatePath
    });
  }
  return { source, sourceBytes, stats: after };
}

async function loadTemplateAst(templatePath, options, limits) {
  const cacheMode = options.cache === false ? false : options.cache === 'mtime' ? 'mtime' : true;
  // Parser-policy limits are part of the key so a permissively compiled AST
  // can never bypass stricter limits supplied by a later render.
  const cacheKey = `${templatePath}\0v${VERSION}\0parse:${limits.maxTemplateBytes}:${limits.maxNodes}:${limits.maxBlockDepth}:${limits.maxExpressionNodes}:${limits.maxExpressionDepth}:contexts:${options.strictOutputContexts === true ? 'strict' : 'audit'}`;
  if (cacheMode) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      if (cached.sourceBytes > limits.maxTemplateBytes || cached.nodeCount > limits.maxNodes) {
        throw new TemplateError('Cached template exceeds the configured limits.', {
          code: 'ERR_ENGINEX_TEMPLATE_LIMIT', templatePath
        });
      }
      if (cacheMode === true) return cached.ast;
      const stats = await fsp.stat(templatePath);
      if (cached.signature === getSignature(stats)) return cached.ast;
    }
    const generation = cacheGeneration;
    const inFlightKey = `${cacheKey}\0${cacheMode}\0epoch:${generation}`;
    const pending = IN_FLIGHT.get(inFlightKey);
    if (pending) return pending;
    const compilePromise = (async () => {
      const { source, sourceBytes, stats } = await readTemplateSource(templatePath, limits);
      assertOutputContexts(source, options, templatePath);
      const compiled = compileTemplate(source, templatePath, limits);
      const entry = { ast: compiled.nodes, signature: getSignature(stats), sourceBytes, nodeCount: compiled.nodeCount };
      CACHE_STATS.parses++;
      if (limits.cacheMaxEntries > 0 && generation === cacheGeneration) {
        AST_CACHE.delete(cacheKey);
        AST_CACHE.set(cacheKey, entry);
        trimCache(limits.cacheMaxEntries);
      }
      return entry.ast;
    })();
    IN_FLIGHT.set(inFlightKey, compilePromise);
    CACHE_STATS.misses++;
    try { return await compilePromise; }
    finally { IN_FLIGHT.delete(inFlightKey); }
  }

  const { source } = await readTemplateSource(templatePath, limits);
  assertOutputContexts(source, options, templatePath);
  const compiled = compileTemplate(source, templatePath, limits);
  CACHE_STATS.misses++;
  CACHE_STATS.parses++;
  return compiled.nodes;
}

function compileTemplate(source, templatePath, limits) {
  const root = [];
  const stack = [{ type: 'root', children: root, node: null, hasElse: false }];
  let cursor = 0;
  let nodeCount = 0;
  let extendsCount = 0;

  const addNode = node => {
    nodeCount++;
    if (nodeCount > limits.maxNodes) {
      throw new TemplateError(`Template exceeds maxNodes (${limits.maxNodes}).`, {
        code: 'ERR_ENGINEX_TEMPLATE_LIMIT', templatePath
      });
    }
    stack[stack.length - 1].children.push(node);
  };

  while (cursor < source.length) {
    const mustacheIndex = source.indexOf(OPEN, cursor);
    const legacyIndex = source.indexOf('<?njs', cursor);
    let opening;
    let kind;
    if (mustacheIndex === -1 && legacyIndex === -1) {
      addNode({ type: 'text', value: source.slice(cursor) });
      cursor = source.length;
      break;
    }
    if (legacyIndex !== -1 && (mustacheIndex === -1 || legacyIndex < mustacheIndex)) {
      opening = legacyIndex;
      kind = 'legacy';
    } else {
      opening = mustacheIndex;
      kind = 'mustache';
    }
    if (opening > cursor) addNode({ type: 'text', value: source.slice(cursor, opening) });

    if (kind === 'legacy') {
      const end = source.indexOf('?>', opening + 5);
      if (end === -1) throw templateSyntaxError('Unclosed <?njs block.', source, opening, templatePath, 'ERR_ENGINEX_UNCLOSED_LEGACY_BLOCK');
      addNode({ type: 'legacy', code: source.slice(opening + 5, end) });
      cursor = end + 2;
      continue;
    }

    if (source.startsWith('{{!--', opening)) {
      const commentEnd = source.indexOf('--}}', opening + 5);
      if (commentEnd === -1) throw templateSyntaxError('Unclosed template comment.', source, opening, templatePath, 'ERR_ENGINEX_UNCLOSED_COMMENT');
      cursor = commentEnd + 4;
      continue;
    }

    const raw = source.startsWith(RAW_OPEN, opening);
    const delimiter = raw ? '}}}' : '}}';
    const contentStart = opening + (raw ? 3 : 2);
    const closing = findMustacheEnd(source, contentStart, delimiter);
    if (closing === -1) throw templateSyntaxError('Unclosed template interpolation/directive.', source, opening, templatePath, 'ERR_ENGINEX_UNCLOSED_TAG');
    const content = source.slice(contentStart, closing).trim();
    const tagPosition = opening;
    cursor = closing + delimiter.length;
    processTag(content, raw, tagPosition);
  }

  if (stack.length !== 1) {
    const frame = stack[stack.length - 1];
    throw new TemplateError(`Unclosed {{#${frame.type}}} block in ${templatePath}.`, {
      code: 'ERR_ENGINEX_UNCLOSED_BLOCK', templatePath
    });
  }
  if (extendsCount > 1) throw new TemplateError('A template may extend only one layout.', { code: 'ERR_ENGINEX_MULTIPLE_LAYOUTS', templatePath });
  if (extendsCount === 1) {
    for (const node of root) {
      if (node.type !== 'extends' && (node.type !== 'text' || node.value.trim() !== '')) {
        throw new TemplateError('A layout child may contain only whitespace and one root {{#extends}} block.', { code: 'ERR_ENGINEX_INVALID_LAYOUT', templatePath });
      }
    }
  }
  return { nodes: root, nodeCount };

  function processTag(content, raw, position) {
    if (!raw && content.startsWith('!')) return;
    if (!raw && content.startsWith('#')) {
      openBlock(content.slice(1).trim(), position);
      return;
    }
    if (!raw && content === 'else') {
      const frame = stack[stack.length - 1];
      if (!['if', 'unless', 'each'].includes(frame.type)) {
        throw templateSyntaxError('{{else}} must be inside if, unless, or each.', source, position, templatePath, 'ERR_ENGINEX_UNEXPECTED_ELSE');
      }
      if (frame.hasElse) throw templateSyntaxError('Only one {{else}} is allowed per block.', source, position, templatePath, 'ERR_ENGINEX_DUPLICATE_ELSE');
      frame.hasElse = true;
      frame.node.alternate = [];
      frame.children = frame.node.alternate;
      return;
    }
    if (!raw && content.startsWith('/')) {
      const closingType = content.slice(1).trim();
      const frame = stack.pop();
      if (!frame || frame.type === 'root' || frame.type !== closingType) {
        if (frame && frame.type !== 'root') stack.push(frame);
        throw templateSyntaxError(`Mismatched closing directive {{/${closingType}}}.`, source, position, templatePath, 'ERR_ENGINEX_MISMATCHED_BLOCK');
      }
      return;
    }
    if (!raw && content.startsWith('>')) {
      addNode(parsePartial(content.slice(1).trim(), position));
      return;
    }
    if (raw && (content.startsWith('#') || content.startsWith('/') || content === 'else' || content.startsWith('>'))) {
      throw templateSyntaxError('Raw braces are only for expressions.', source, position, templatePath, 'ERR_ENGINEX_INVALID_RAW_TAG');
    }
    if (!content) throw templateSyntaxError('Empty interpolation.', source, position, templatePath, 'ERR_ENGINEX_EMPTY_EXPRESSION');
    addNode({ type: 'interpolation', raw, expression: parseExpression(content, templatePath, position, limits, source) });
  }

  function openBlock(directive, position) {
    if (stack.length > limits.maxBlockDepth) throw templateSyntaxError(`Template block depth exceeds maxBlockDepth (${limits.maxBlockDepth}).`, source, position, templatePath, 'ERR_ENGINEX_TEMPLATE_LIMIT');
    const ifMatch = directive.match(/^(if|unless)\s+([\s\S]+)$/);
    if (ifMatch) {
      const node = { type: ifMatch[1], expression: parseExpression(ifMatch[2].trim(), templatePath, position, limits, source), children: [], alternate: null };
      addNode(node);
      stack.push({ type: node.type, node, children: node.children, hasElse: false });
      return;
    }
    const eachMatch = directive.match(/^each\s+([\s\S]+?)(?:\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?)?$/);
    if (eachMatch) {
      const node = {
        type: 'each', expression: parseExpression(eachMatch[1].trim(), templatePath, position, limits, source),
        itemName: eachMatch[2] || 'item', indexName: eachMatch[3] || 'index', children: [], alternate: null
      };
      if (DANGEROUS_KEYS.has(node.itemName) || DANGEROUS_KEYS.has(node.indexName) || node.itemName === node.indexName) {
        throw templateSyntaxError('Invalid each-loop alias.', source, position, templatePath, 'ERR_ENGINEX_INVALID_ALIAS');
      }
      addNode(node);
      stack.push({ type: 'each', node, children: node.children, hasElse: false });
      return;
    }
    const withMatch = directive.match(/^with\s+([\s\S]+?)\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (withMatch) {
      if (DANGEROUS_KEYS.has(withMatch[2])) throw templateSyntaxError('Invalid with alias.', source, position, templatePath, 'ERR_ENGINEX_INVALID_ALIAS');
      const node = { type: 'with', expression: parseExpression(withMatch[1].trim(), templatePath, position, limits, source), alias: withMatch[2], children: [] };
      addNode(node);
      stack.push({ type: 'with', node, children: node.children });
      return;
    }
    const fragmentMatch = directive.match(/^fragment\s+(["'])([^"']+)\1$/);
    if (fragmentMatch) {
      const fragmentName = fragmentMatch[2];
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(fragmentName)) {
        throw templateSyntaxError('Invalid fragment identifier.', source, position, templatePath, 'ERR_ENGINEX_INVALID_FRAGMENT');
      }
      const node = { type: 'fragment', name: fragmentName, children: [] };
      addNode(node);
      stack.push({ type: 'fragment', node, children: node.children });
      return;
    }
    const blockMatch = directive.match(/^block\s+(["'])([^"']+)\1$/);
    if (blockMatch) {
      const node = { type: 'block', name: blockMatch[2], children: [] };
      addNode(node);
      stack.push({ type: 'block', node, children: node.children });
      return;
    }
    const extendsMatch = directive.match(/^extends\s+(["'])([^"']+)\1$/);
    if (extendsMatch) {
      if (stack.length !== 1) throw templateSyntaxError('{{#extends}} is only allowed at the template root.', source, position, templatePath, 'ERR_ENGINEX_INVALID_LAYOUT');
      extendsCount++;
      const node = { type: 'extends', name: extendsMatch[2], children: [] };
      addNode(node);
      stack.push({ type: 'extends', node, children: node.children });
      return;
    }
    throw templateSyntaxError(`Unknown block directive: {{#${directive}}}.`, source, position, templatePath, 'ERR_ENGINEX_UNKNOWN_DIRECTIVE');
  }

  function parsePartial(directive, position) {
    const match = directive.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!match) throw templateSyntaxError('A partial requires a name.', source, position, templatePath, 'ERR_ENGINEX_INVALID_PARTIAL');
    let name = match[1];
    if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
      name = decodeStringLiteral(name, templatePath, position);
    }
    if (!name || name.includes('\0')) throw templateSyntaxError('Invalid partial name.', source, position, templatePath, 'ERR_ENGINEX_INVALID_PARTIAL');
    return { type: 'partial', name, context: match[2] ? parseExpression(match[2], templatePath, position, limits, source) : null };
  }
}

function templateSyntaxError(message, source, index, templatePath, code) {
  const before = source.slice(0, index);
  const line = before.split('\n').length;
  const lastNewline = before.lastIndexOf('\n');
  const column = index - lastNewline;
  return new TemplateError(`${message} (${templatePath}:${line}:${column})`, { code, templatePath, line, column });
}

function findMustacheEnd(source, start, delimiter) {
  let quote = null;
  let escaped = false;
  const stack = [];
  for (let index = start; index < source.length; index++) {
    const ch = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (stack.length === 0 && source.startsWith(delimiter, index)) return index;
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.length) {
        const open = stack[stack.length - 1];
        if ((open === '(' && ch === ')') || (open === '[' && ch === ']') || (open === '{' && ch === '}')) stack.pop();
      }
    }
  }
  return -1;
}

// ------------------------- Safe expression parser -------------------------

const OPERATOR_PRECEDENCE = Object.freeze({
  '|': 1, '??': 2, '||': 3, '&&': 4,
  '===': 5, '!==': 5, '<': 6, '<=': 6, '>': 6, '>=': 6,
  '+': 7, '-': 7, '*': 8, '/': 8, '%': 8, '**': 9
});
const OPERATOR_TOKENS = ['===', '!==', '?.', '??', '||', '&&', '<=', '>=', '==', '!=', '**', '+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '.', '|', '(', ')', '[', ']', '{', '}', ','];

function parseExpression(expressionSource, templatePath, position, limits, fullTemplateSource) {
  const parser = new ExpressionParser(expressionSource, templatePath, position, limits);
  try {
    return parser.parse();
  } catch (error) {
    if (error instanceof TemplateError && Number.isInteger(position) && typeof fullTemplateSource === 'string') {
      const before = fullTemplateSource.slice(0, position);
      error.line = before.split('\n').length;
      error.column = position - before.lastIndexOf('\n');
      if (!error.message.includes(`${templatePath}:${error.line}:${error.column}`)) {
        error.message += ` (${templatePath}:${error.line}:${error.column})`;
      }
    }
    throw error;
  }
}

class ExpressionParser {
  constructor(source, templatePath, position, limits) {
    this.source = source;
    this.templatePath = templatePath;
    this.position = position;
    this.limits = limits;
    this.index = 0;
    this.current = null;
    this.nodeCount = 0;
    this.depth = 0;
    this.next();
  }

  fail(message) {
    throw new TemplateError(`Invalid template expression "${this.source}": ${message}`, {
      code: 'ERR_ENGINEX_EXPRESSION_SYNTAX', templatePath: this.templatePath
    });
  }

  next() {
    while (/\s/.test(this.source[this.index] || '') && this.index < this.source.length) this.index++;
    if (this.index >= this.source.length) { this.current = { type: 'eof', value: '' }; return; }
    const start = this.index;
    const ch = this.source[this.index];

    if (ch === '"' || ch === "'") {
      const end = this.readStringEnd(start, ch);
      const raw = this.source.slice(start, end);
      this.index = end;
      this.current = { type: 'literal', value: decodeStringLiteral(raw, this.templatePath, this.position) };
      return;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(this.source[this.index + 1] || ''))) {
      const match = /^(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(this.source.slice(this.index));
      if (!match) this.fail('Malformed number.');
      this.index += match[0].length;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) this.fail('Number must be finite.');
      this.current = { type: 'literal', value };
      return;
    }
    if (ch === '@' || /[A-Za-z_$]/.test(ch)) {
      const match = /^(?:@[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)/.exec(this.source.slice(this.index));
      this.index += match[0].length;
      if (match[0] === 'true') this.current = { type: 'literal', value: true };
      else if (match[0] === 'false') this.current = { type: 'literal', value: false };
      else if (match[0] === 'null') this.current = { type: 'literal', value: null };
      else if (match[0] === 'undefined') this.current = { type: 'literal', value: undefined };
      else if (['new', 'function', 'class', 'thisArg', 'await', 'yield', 'delete', 'void', 'typeof', 'instanceof', 'in'].includes(match[0])) this.fail(`Keyword "${match[0]}" is not available in safe expressions.`);
      else this.current = { type: 'identifier', value: match[0] };
      return;
    }
    for (const operator of OPERATOR_TOKENS) {
      if (this.source.startsWith(operator, this.index)) {
        this.index += operator.length;
        this.current = { type: 'operator', value: operator };
        return;
      }
    }
    this.fail(`Unexpected character "${ch}".`);
  }

  readStringEnd(start, quote) {
    let i = start + 1;
    while (i < this.source.length) {
      if (this.source[i] === '\\') { i += 2; continue; }
      if (this.source[i] === quote) return i + 1;
      if (this.source[i] === '\n' || this.source[i] === '\r') this.fail('Line breaks must be escaped inside string literals.');
      i++;
    }
    this.fail('Unclosed string literal.');
  }

  consume(value) {
    if (this.current.value !== value) this.fail(`Expected "${value}", got "${this.current.value}".`);
    this.next();
  }

  node(node) {
    this.nodeCount++;
    if (this.nodeCount > this.limits.maxExpressionNodes) this.fail('Expression node limit exceeded.');
    return node;
  }

  parse() {
    const ast = this.expression(0);
    if (this.current.type !== 'eof') this.fail(`Unexpected token "${this.current.value}".`);
    return ast;
  }

  expression(minPrecedence) {
    this.depth++;
    if (this.depth > this.limits.maxExpressionDepth) this.fail('Expression nesting limit exceeded.');
    let left = this.prefix();
    left = this.postfix(left);
    while (true) {
      const operator = this.current.value;
      if (operator === '?') {
        if (1 < minPrecedence) break;
        this.next();
        const consequent = this.expression(0);
        this.consume(':');
        const alternate = this.expression(1);
        left = this.node({ type: 'conditional', test: left, consequent, alternate });
        continue;
      }
      const precedence = OPERATOR_PRECEDENCE[operator];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.next();
      if (operator === '|') {
        let filterName;
        let filterArgs = [];
        if (this.current.type !== 'identifier' || this.current.value.startsWith('@')) this.fail('A filter must be a named helper.');
        filterName = this.current.value;
        this.next();
        if (this.current.value === '(') filterArgs = this.arguments();
        left = this.node({ type: 'filter', input: left, name: filterName, args: filterArgs });
        continue;
      }
      const right = this.expression(precedence + (operator === '**' ? 0 : 1));
      left = this.node({ type: 'binary', operator, left, right });
    }
    this.depth--;
    return left;
  }

  prefix() {
    const token = this.current;
    if (token.type === 'literal') { this.next(); return this.node({ type: 'literal', value: token.value }); }
    if (token.type === 'identifier') { this.next(); return this.node({ type: 'identifier', name: token.value }); }
    if (token.value === '!' || token.value === '-' || token.value === '+') {
      this.next();
      return this.node({ type: 'unary', operator: token.value, argument: this.expression(10) });
    }
    if (token.value === '(') {
      this.next();
      const inside = this.expression(0);
      this.consume(')');
      return inside;
    }
    if (token.value === '[') {
      this.next();
      const elements = [];
      while (this.current.value !== ']') {
        if (this.current.type === 'eof') this.fail('Unclosed array literal.');
        elements.push(this.expression(0));
        if (this.current.value !== ',') break;
        this.next();
        if (this.current.value === ']') break;
      }
      this.consume(']');
      return this.node({ type: 'array', elements });
    }
    if (token.value === '{') {
      this.next();
      const properties = [];
      while (this.current.value !== '}') {
        if (this.current.type === 'eof') this.fail('Unclosed object literal.');
        const keyToken = this.current;
        let key;
        if (keyToken.type === 'identifier') { key = keyToken.value; this.next(); }
        else if (keyToken.type === 'literal' && typeof keyToken.value === 'string') { key = keyToken.value; this.next(); }
        else this.fail('Object keys must be identifiers or string literals.');
        if (DANGEROUS_KEYS.has(key)) this.fail(`Unsafe object key "${key}".`);
        this.consume(':');
        properties.push({ key, value: this.expression(0) });
        if (this.current.value !== ',') break;
        this.next();
        if (this.current.value === '}') break;
      }
      this.consume('}');
      return this.node({ type: 'object', properties });
    }
    this.fail(`Unexpected token "${token.value}".`);
  }

  postfix(left) {
    while (true) {
      if (this.current.value === '.' || this.current.value === '?.') {
        const optional = this.current.value === '?.';
        this.next();
        if (this.current.value === '[') {
          this.next();
          const property = this.expression(0);
          this.consume(']');
          left = this.node({ type: 'member', object: left, property, computed: true, optional });
        } else if (this.current.value === '(') {
          const args = this.arguments();
          left = this.node({ type: 'call', callee: left, args, optional });
        } else {
          if (this.current.type !== 'identifier') this.fail('Expected a property name after dot.');
          const property = this.current.value;
          this.next();
          if (DANGEROUS_KEYS.has(property)) this.fail(`Unsafe property "${property}".`);
          left = this.node({ type: 'member', object: left, property, computed: false, optional });
        }
        continue;
      }
      if (this.current.value === '[') {
        this.next();
        const property = this.expression(0);
        this.consume(']');
        left = this.node({ type: 'member', object: left, property, computed: true, optional: false });
        continue;
      }
      if (this.current.value === '(') {
        const args = this.arguments();
        left = this.node({ type: 'call', callee: left, args, optional: false });
        continue;
      }
      break;
    }
    return left;
  }

  arguments() {
    this.consume('(');
    const args = [];
    while (this.current.value !== ')') {
      if (this.current.type === 'eof') this.fail('Unclosed function call.');
      args.push(this.expression(0));
      if (this.current.value !== ',') break;
      this.next();
      if (this.current.value === ')') break;
    }
    this.consume(')');
    return args;
  }
}

function decodeStringLiteral(raw, templatePath, position = 0) {
  const quote = raw[0];
  if (raw.length < 2 || raw[raw.length - 1] !== quote) {
    throw new TemplateError('Invalid string literal.', { code: 'ERR_ENGINEX_EXPRESSION_STRING', templatePath });
  }
  const body = raw.slice(1, -1);
  let output = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { output += ch; continue; }
    i++;
    if (i >= body.length) throw new TemplateError('Invalid escape at end of string.', { code: 'ERR_ENGINEX_EXPRESSION_STRING', templatePath });
    const escaped = body[i];
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', "'": "'", '"': '"' };
    if (Object.hasOwn(simple, escaped)) { output += simple[escaped]; continue; }
    if (escaped === 'x') {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[\da-fA-F]{2}$/.test(hex)) throw new TemplateError('Invalid hexadecimal escape.', { code: 'ERR_ENGINEX_EXPRESSION_STRING', templatePath });
      output += String.fromCharCode(parseInt(hex, 16)); i += 2; continue;
    }
    if (escaped === 'u') {
      const hex = body.slice(i + 1, i + 5);
      if (!/^[\da-fA-F]{4}$/.test(hex)) throw new TemplateError('Invalid Unicode escape.', { code: 'ERR_ENGINEX_EXPRESSION_STRING', templatePath });
      output += String.fromCharCode(parseInt(hex, 16)); i += 4; continue;
    }
    throw new TemplateError(`Unsupported escape \\${escaped}.`, { code: 'ERR_ENGINEX_EXPRESSION_STRING', templatePath });
  }
  return output;
}

// ------------------------------ Interpreter -------------------------------

async function evaluate(ast, state) {
  checkTime(state);
  switch (ast.type) {
    case 'literal': return ast.value;
    case 'identifier': return resolveIdentifier(ast.name, state);
    case 'array': {
      const values = [];
      for (const element of ast.elements) values.push(await evaluate(element, state));
      return values;
    }
    case 'object': {
      const value = Object.create(null);
      for (const property of ast.properties) value[property.key] = await evaluate(property.value, state);
      return value;
    }
    case 'unary': {
      const value = await evaluate(ast.argument, state);
      if (ast.operator === '!') return !value;
      if (ast.operator === '+') return numeric(value);
      if (ast.operator === '-') return -numeric(value);
      throw new TemplateError(`Unsupported unary operator ${ast.operator}.`, { code: 'ERR_ENGINEX_EXPRESSION_OPERATOR' });
    }
    case 'member': {
      const object = await evaluate(ast.object, state);
      if (object === null || object === undefined) return undefined;
      const property = ast.computed ? await evaluate(ast.property, state) : ast.property;
      return safeGet(object, property);
    }
    case 'call': {
      if (ast.callee.type !== 'identifier') {
        throw new TemplateError('Only registered helper functions can be called in safe templates.', { code: 'ERR_ENGINEX_CALL_NOT_HELPER' });
      }
      const helper = state.helpers[ast.callee.name];
      if (typeof helper !== 'function') {
        throw new TemplateError(`Unknown template helper "${ast.callee.name}".`, { code: 'ERR_ENGINEX_UNKNOWN_HELPER' });
      }
      const args = [];
      for (const arg of ast.args) args.push(await evaluate(arg, state));
      return invokeHelper(helper, args, state);
    }
    case 'filter': {
      const helper = state.helpers[ast.name];
      if (typeof helper !== 'function') throw new TemplateError(`Unknown template filter "${ast.name}".`, { code: 'ERR_ENGINEX_UNKNOWN_HELPER' });
      const value = await evaluate(ast.input, state);
      const args = [value];
      for (const arg of ast.args) args.push(await evaluate(arg, state));
      return invokeHelper(helper, args, state);
    }
    case 'conditional': return templateTruthy(await evaluate(ast.test, state)) ? evaluate(ast.consequent, state) : evaluate(ast.alternate, state);
    case 'binary': return evaluateBinary(ast, state);
    default: throw new TemplateError(`Unsupported expression node ${ast.type}.`, { code: 'ERR_ENGINEX_EXPRESSION_NODE' });
  }
}

async function invokeHelper(helper, args, state) {
  checkTime(state);
  let result;
  try { result = helper(...args); }
  catch (cause) { throw new TemplateError('A template helper failed.', { code: 'ERR_ENGINEX_HELPER_FAILED', cause }); }

  // Only native Promises are awaited. Reading an arbitrary object's `then`
  // property could itself invoke an attacker-controlled getter.
  if (utilTypes.isPromise(result)) {
    const remaining = state.deadline - Date.now();
    if (remaining <= 0) throw new TemplateError('Template render time limit exceeded while awaiting a helper.', { code: 'ERR_ENGINEX_RENDER_TIMEOUT' });
    let timer;
    try {
      result = await Promise.race([
        result,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new TemplateError('Template render time limit exceeded while awaiting a helper.', { code: 'ERR_ENGINEX_RENDER_TIMEOUT' })), remaining);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  checkTime(state);
  if (result !== null && typeof result === 'object' && !isSafeHtml(result)) {
    return snapshotData(result, state.limits);
  }
  if (typeof result === 'function' || typeof result === 'symbol') {
    throw new TemplateError('Template helpers must return data, not functions or symbols.', { code: 'ERR_ENGINEX_UNSAFE_DATA' });
  }
  return result;
}

async function evaluateBinary(ast, state) {
  const left = await evaluate(ast.left, state);
  if (ast.operator === '&&') return left ? evaluate(ast.right, state) : left;
  if (ast.operator === '||') return left ? left : evaluate(ast.right, state);
  if (ast.operator === '??') return left === null || left === undefined ? evaluate(ast.right, state) : left;
  const right = await evaluate(ast.right, state);
  switch (ast.operator) {
    case '===': return left === right;
    case '!==': return left !== right;
    case '+':
      if (typeof left === 'string' || typeof right === 'string') return toDisplayString(left) + toDisplayString(right);
      return numeric(left) + numeric(right);
    case '-': return numeric(left) - numeric(right);
    case '*': return numeric(left) * numeric(right);
    case '/': return numeric(left) / numeric(right);
    case '%': return numeric(left) % numeric(right);
    case '**': return numeric(left) ** numeric(right);
    case '<': return comparable(left) < comparable(right);
    case '<=': return comparable(left) <= comparable(right);
    case '>': return comparable(left) > comparable(right);
    case '>=': return comparable(left) >= comparable(right);
    default: throw new TemplateError(`Unsupported binary operator ${ast.operator}.`, { code: 'ERR_ENGINEX_EXPRESSION_OPERATOR' });
  }
}

function numeric(value) {
  if (value === null) return 0;
  if (value === undefined) return NaN;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() === '') return 0;
  if (typeof value === 'string') return Number(value);
  throw new TemplateError('Arithmetic only accepts primitive numeric values.', { code: 'ERR_ENGINEX_EXPRESSION_TYPE' });
}

function comparable(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  throw new TemplateError('Comparison only accepts primitive values.', { code: 'ERR_ENGINEX_EXPRESSION_TYPE' });
}

function safeGet(object, property) {
  if (object !== null && typeof object === 'object' && utilTypes.isProxy(object)) {
    throw new TemplateError('Proxy objects cannot be accessed by template expressions.', { code: 'ERR_ENGINEX_UNSAFE_DATA' });
  }
  if (typeof property !== 'string' && typeof property !== 'number' && typeof property !== 'boolean' && typeof property !== 'bigint') return undefined;
  const key = String(property);
  if (DANGEROUS_KEYS.has(key) || key.includes('\0')) return undefined;
  if (object === null || object === undefined) return undefined;
  if (typeof object === 'string' || object instanceof String) {
    if (key === 'length') return String(object).length;
    if (/^(?:0|[1-9]\d*)$/.test(key)) return String(object).charAt(Number(key)) || undefined;
    return undefined;
  }
  if (Array.isArray(object)) {
    if (key === 'length') return object.length;
    if (/^(?:0|[1-9]\d*)$/.test(key)) return object[Number(key)];
  }
  if (object instanceof Map) {
    if (key === 'size') return Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(object);
    return undefined;
  }
  if (object instanceof Set) {
    if (key === 'size') return Object.getOwnPropertyDescriptor(Set.prototype, 'size').get.call(object);
    return undefined;
  }
  if (typeof object !== 'object') return undefined;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(object, key); }
  catch { return undefined; }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
  return descriptor.value;
}

function resolveIdentifier(name, state) {
  if (name === 'this') return state.contexts[state.contexts.length - 1];
  if (name === '@root') return state.rootContext;
  for (let i = state.scopes.length - 1; i >= 0; i--) {
    const value = safeGet(state.scopes[i], name);
    if (value !== undefined || ownDataPropertyExists(state.scopes[i], name)) return value;
  }
  // Never expose globals, local helper functions, prototype properties or Node APIs.
  return undefined;
}

function ownDataPropertyExists(object, key) {
  try {
    const descriptor = object && Object.getOwnPropertyDescriptor(object, key);
    return Boolean(descriptor && Object.hasOwn(descriptor, 'value'));
  } catch { return false; }
}

function snapshotData(value, limits, depth = 0, budget = { nodes: 0, properties: 0 }, seen = new WeakMap()) {
  if (isSafeHtml(value)) return value;
  if (value !== null && typeof value === 'object' && utilTypes.isProxy(value)) {
    throw new TemplateError('Proxy objects are not permitted in template data.', { code: 'ERR_ENGINEX_UNSAFE_DATA' });
  }
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > limits.maxDataStringLength) throw new TemplateError('String data exceeds the configured size limit.', { code: 'ERR_ENGINEX_DATA_LIMIT' });
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TemplateError('Template data must not contain functions or symbols.', { code: 'ERR_ENGINEX_UNSAFE_DATA' });
  }
  if (depth > limits.maxDataDepth) throw new TemplateError('Template data exceeds maxDataDepth.', { code: 'ERR_ENGINEX_DATA_LIMIT' });
  budget.nodes++;
  if (budget.nodes > limits.maxDataNodes) throw new TemplateError('Template data exceeds maxDataNodes.', { code: 'ERR_ENGINEX_DATA_LIMIT' });
  if (seen.has(value)) throw new TemplateError('Circular data is not supported in template locals.', { code: 'ERR_ENGINEX_CIRCULAR_DATA' });

  if (value instanceof Date) {
    const time = Date.prototype.getTime.call(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : '';
  }
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    let count = 0;
    for (const [key, item] of Map.prototype.entries.call(value)) {
      if (++count > limits.maxDataProperties) throw new TemplateError('Map exceeds maxDataProperties.', { code: 'ERR_ENGINEX_DATA_LIMIT' });
      copy.set(snapshotData(key, limits, depth + 1, budget, seen), snapshotData(item, limits, depth + 1, budget, seen));
    }
    seen.delete(value);
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    let count = 0;
    for (const item of Set.prototype.values.call(value)) {
      if (++count > limits.maxDataProperties) throw new TemplateError('Set exceeds maxDataProperties.', { code: 'ERR_ENGINEX_DATA_LIMIT' });
      copy.add(snapshotData(item, limits, depth + 1, budget, seen));
    }
    seen.delete(value);
    return copy;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxDataProperties) throw new TemplateError('Array exceeds maxDataProperties.', { code: 'ERR_ENGINEX_DATA_LIMIT' });
    const copy = [];
    seen.set(value, copy);
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new TemplateError('Accessor properties are not permitted in template data.', { code: 'ERR_ENGINEX_UNSAFE_DATA' });
      copy.push(descriptor ? snapshotData(descriptor.value, limits, depth + 1, budget, seen) : null);
    }
    seen.delete(value);
    return copy;
  }

  let prototype;
  try { prototype = Object.getPrototypeOf(value); }
  catch (cause) { throw new TemplateError('Unable to inspect template data object.', { code: 'ERR_ENGINEX_UNSAFE_DATA', cause }); }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TemplateError('Only plain objects, arrays, Date, Map, and Set are supported as template data.', { code: 'ERR_ENGINEX_UNSAFE_DATA' });
  }
  const copy = Object.create(null);
  seen.set(value, copy);
  const keys = Object.keys(value);
  budget.properties += keys.length;
  if (budget.properties > limits.maxDataProperties) throw new TemplateError('Template data exceeds maxDataProperties.', { code: 'ERR_ENGINEX_DATA_LIMIT' });
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TemplateError(`Accessor property "${key}" is not permitted in template data.`, { code: 'ERR_ENGINEX_UNSAFE_DATA' });
    }
    copy[key] = snapshotData(descriptor.value, limits, depth + 1, budget, seen);
  }
  seen.delete(value);
  return copy;
}

function createHelpers(options) {
  if (options.helpers === undefined) return BUILTIN_HELPERS;
  const helpers = Object.assign(Object.create(null), BUILTIN_HELPERS);
  if (options.helpers !== undefined) {
    if (!isPlainObject(options.helpers)) throw new TypeError('helpers must be a plain object of trusted functions.');
    for (const [name, fn] of Object.entries(options.helpers)) {
      if (DANGEROUS_KEYS.has(name) || typeof fn !== 'function') throw new TypeError(`Invalid template helper: ${name}`);
      helpers[name] = fn;
    }
  }
  return helpers;
}

function checkTime(state) {
  if (Date.now() > state.deadline) throw new TemplateError('Template render time limit exceeded.', { code: 'ERR_ENGINEX_RENDER_TIMEOUT' });
}

function templateTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number' && (value === 0 || Number.isNaN(value))) return false;
  if (typeof value === 'string' && value.length === 0) return false;
  return true;
}

function iterateEntries(value, limit, templatePath) {
  if (value == null) return [];
  if (typeof value === 'object' && utilTypes.isProxy(value)) throw new TemplateError('Proxy objects cannot be iterated in templates.', { code: 'ERR_ENGINEX_UNSAFE_DATA', templatePath });
  let entries = [];
  if (Array.isArray(value)) {
    if (value.length > limit) throw new TemplateError(`Loop exceeds maxLoopIterations (${limit}).`, { code: 'ERR_ENGINEX_LOOP_LIMIT', templatePath });
    entries = value.map((item, index) => [index, item]);
  } else if (typeof value === 'string') {
    const chars = Array.from(value);
    if (chars.length > limit) throw new TemplateError(`Loop exceeds maxLoopIterations (${limit}).`, { code: 'ERR_ENGINEX_LOOP_LIMIT', templatePath });
    entries = chars.map((item, index) => [index, item]);
  } else if (value instanceof Map) {
    if (value.size > limit) throw new TemplateError(`Loop exceeds maxLoopIterations (${limit}).`, { code: 'ERR_ENGINEX_LOOP_LIMIT', templatePath });
    entries = Array.from(Map.prototype.entries.call(value));
  } else if (value instanceof Set) {
    if (value.size > limit) throw new TemplateError(`Loop exceeds maxLoopIterations (${limit}).`, { code: 'ERR_ENGINEX_LOOP_LIMIT', templatePath });
    let index = 0;
    entries = Array.from(Set.prototype.values.call(value), item => [index++, item]);
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > limit) throw new TemplateError(`Loop exceeds maxLoopIterations (${limit}).`, { code: 'ERR_ENGINEX_LOOP_LIMIT', templatePath });
    entries = keys.map(key => [key, value[key]]);
  }
  return entries;
}

function getStateLocals(options, limits) {
  let source;
  if (options.locals !== undefined) source = options.locals;
  else {
    source = Object.create(null);
    for (const [key, value] of Object.entries(options)) if (!ENGINE_OPTION_KEYS.has(key)) source[key] = value;
  }
  return snapshotLocals(source, limits);
}

function snapshotLocals(source, limits) {
  if (source === null || source === undefined) source = Object.create(null);
  if (!isPlainObject(source) && !Array.isArray(source)) throw new TypeError('locals must be a plain object or array.');
  return snapshotData(source, limits);
}

function prepareData(data, options = {}) {
  const limits = mergeLimits(options);
  const snapshot = snapshotLocals(data, limits);
  assertPreparedCompatible(snapshot, new WeakSet());
  freezePreparedData(snapshot, new WeakSet());
  // The snapshot is stored privately; callers receive an opaque token rather
  // than a reference to the data graph. This prevents external mutation.
  return createPreparedToken(snapshot);
}

function createPreparedToken(snapshot) {
  const token = Object.freeze(Object.create(null));
  PREPARED_DATA.set(token, snapshot);
  return token;
}

function assertPreparedCompatible(value, seen) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Map || value instanceof Set) {
    throw new TemplateError('Prepared data supports only arrays and plain objects; Map and Set are not supported in immutable prepared snapshots.', { code: 'ERR_ENGINEX_PREPARED_DATA_TYPE' });
  }
  for (const key of Object.keys(value)) assertPreparedCompatible(value[key], seen);
}

function freezePreparedData(value, seen) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) freezePreparedData(value[key], seen);
  return Object.freeze(value);
}

function parseModelPath(pathValue) {
  if (typeof pathValue !== 'string' || !pathValue || pathValue.length > 1024) throw new TypeError('A data path must be a non-empty string of at most 1024 characters.');
  const parts = pathValue.split('.');
  if (parts.some(part => !part || DANGEROUS_KEYS.has(part) || part.includes('\0'))) throw new TypeError('Data paths must not contain empty or prototype-sensitive segments.');
  return parts;
}

function readDataPath(root, parts) {
  let current = root;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function cloneContainerForPath(current, nextPart, limits) {
  if (Array.isArray(current)) return current.slice();
  if (current === null || current === undefined) return /^\d+$/.test(nextPart) ? [] : Object.create(null);
  if (!isPlainObject(current)) throw new TypeError('Reactive-model path traverses a non-container value.');
  const clone = Object.create(null);
  const keys = Object.keys(current);
  if (keys.length > limits.maxDataProperties) throw new TemplateError('Reactive model exceeds maxDataProperties.', { code: 'ERR_ENGINEX_DATA_LIMIT' });
  for (const key of keys) clone[key] = current[key];
  return clone;
}

function setModelPath(current, parts, depth, value, limits) {
  const key = parts[depth];
  const next = cloneContainerForPath(current, key, limits);
  if (Array.isArray(next)) {
    if (!/^(?:0|[1-9]\d*)$/.test(key)) throw new TypeError('Array path segments must be canonical non-negative indexes.');
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index > limits.maxDataProperties || (depth === parts.length - 1 && index > next.length)) throw new RangeError('Reactive-model array index exceeds the supported bound.');
    if (depth === parts.length - 1) next[index] = value;
    else next[index] = setModelPath(next[index], parts, depth + 1, value, limits);
  } else {
    if (depth === parts.length - 1) next[key] = value;
    else next[key] = setModelPath(next[key], parts, depth + 1, value, limits);
  }
  return Object.freeze(next);
}

function deleteModelPath(current, parts, depth, limits) {
  if (current === null || typeof current !== 'object' || !Object.hasOwn(current, parts[depth])) return { changed: false, value: current };
  const key = parts[depth];
  const clone = cloneContainerForPath(current, key, limits);
  if (depth === parts.length - 1) {
    if (Array.isArray(clone)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key)) throw new TypeError('Array path segments must be canonical non-negative indexes.');
      clone.splice(Number(key), 1);
    } else delete clone[key];
    return { changed: true, value: Object.freeze(clone) };
  }
  const result = deleteModelPath(current[key], parts, depth + 1, limits);
  if (!result.changed) return { changed: false, value: current };
  clone[key] = result.value;
  return { changed: true, value: Object.freeze(clone) };
}

function createReactiveModel(initialData, options = {}) {
  const limits = mergeLimits(options);
  let current = snapshotLocals(initialData, limits);
  assertPreparedCompatible(current, new WeakSet());
  freezePreparedData(current, new WeakSet());
  let token = createPreparedToken(current);
  let version = 0;
  let changes = new Set(['*']);
  const publishSnapshot = () => { token = createPreparedToken(current); version++; };
  return Object.freeze({
    get version() { return version; },
    get value() { return current; },
    snapshot() { return token; },
    get(pathValue) { return readDataPath(current, parseModelPath(pathValue)); },
    set(pathValue, newValue) {
      const parts = parseModelPath(pathValue);
      const sanitized = snapshotData(newValue, limits);
      assertPreparedCompatible(sanitized, new WeakSet());
      freezePreparedData(sanitized, new WeakSet());
      const previous = readDataPath(current, parts);
      if (Object.is(previous, sanitized)) return false;
      current = setModelPath(current, parts, 0, sanitized, limits);
      if (!changes.has('*')) {
        if (parts.length > 1 && Array.isArray(readDataPath(current, parts.slice(0, -1))) && /^(?:0|[1-9]\d*)$/.test(parts[parts.length - 1])) changes.add(parts.slice(0, -1).join('.'));
        else changes.add(parts.join('.'));
      }
      publishSnapshot();
      return true;
    },
    delete(pathValue) {
      const parts = parseModelPath(pathValue);
      const result = deleteModelPath(current, parts, 0, limits);
      if (!result.changed) return false;
      current = result.value;
      if (!changes.has('*')) {
        changes.add(parts.slice(0, -1).join('.') || '*');
        changes.delete('');
        if (changes.has('*')) changes = new Set(['*']);
      }
      publishSnapshot();
      return true;
    },
    replace(nextData) {
      const next = snapshotLocals(nextData, limits);
      assertPreparedCompatible(next, new WeakSet());
      freezePreparedData(next, new WeakSet());
      current = next;
      changes = new Set(['*']);
      publishSnapshot();
      return this;
    },
    drainChanges() {
      const output = [...changes];
      changes = new Set();
      return output;
    },
    renderInto(session, renderOptions = {}) {
      if (!session || typeof session.render !== 'function') throw new TypeError('renderInto requires an EnginEx incremental session.');
      const changedPaths = [...changes];
      const result = session.render(token, { ...renderOptions, changedPaths });
      changes = new Set();
      return result;
    }
  });
}

function makeState(options, limits, rootLocals, cachedHelpers) {
  return {
    options, limits, rootContext: rootLocals, scopes: [rootLocals], contexts: [rootLocals],
    helpers: cachedHelpers || createHelpers(options), layouts: new Map(), activePaths: [], activePathSet: new Set(),
    iterationCount: 0, outputLength: 0, emitCheckCounter: 0, deadline: Date.now() + limits.maxRenderTimeMs
  };
}

function makeCompiledState(options, limits, rootLocals, helpers) {
  // The compiled backend omits interpreter-only maps and path tracking.
  return { options, limits, rootContext: rootLocals, scopes: [rootLocals], contexts: [rootLocals],
    helpers, iterationCount: 0, outputLength: 0, emitCheckCounter: 0, deadline: Date.now() + limits.maxRenderTimeMs };
}


// ----------------------- Compiled synchronous backend ---------------------
// This compiler emits JavaScript only from the already-parsed, restricted AST.
// Template source text and expression source are never concatenated as code:
// all text/name literals pass through JSON.stringify and operators come from
// the allow-listed parser AST. The generated function closes over no app data.
function jsLiteral(value) {
  if (value === undefined) return 'void 0';
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function canFoldScalar(value) {
  return value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function foldedLiteral(value) {
  return canFoldScalar(value) ? { type: 'literal', value } : null;
}

/**
 * Small, semantics-preserving constant folder. It folds only the pure scalar
 * subset of the EnginEx expression language; objects, arrays, calls and member
 * access remain runtime operations. A failed or non-finite fold is left alone.
 */
function foldExpression(ast) {
  if (!ast || typeof ast !== 'object') return ast;
  if (ast.type === 'literal' || ast.type === 'identifier') return ast;
  if (ast.type === 'unary') {
    const argument = foldExpression(ast.argument);
    if (argument.type === 'literal' && canFoldScalar(argument.value)) {
      try {
        let result;
        if (ast.operator === '!') result = !argument.value;
        else if (ast.operator === '+') result = numeric(argument.value);
        else if (ast.operator === '-') result = -numeric(argument.value);
        else return { ...ast, argument };
        return foldedLiteral(result) || { ...ast, argument };
      } catch { return argument === ast.argument ? ast : { ...ast, argument }; }
    }
    return argument === ast.argument ? ast : { ...ast, argument };
  }
  if (ast.type === 'binary') {
    const left = foldExpression(ast.left);
    const right = foldExpression(ast.right);
    if (left.type === 'literal' && canFoldScalar(left.value)) {
      if (ast.operator === '&&') return left.value ? right : left;
      if (ast.operator === '||') return left.value ? left : right;
      if (ast.operator === '??') return left.value === null || left.value === undefined ? right : left;
    }
    if (left.type === 'literal' && right.type === 'literal' && canFoldScalar(left.value) && canFoldScalar(right.value)) {
      const a = left.value;
      const b = right.value;
      try {
        let result;
        switch (ast.operator) {
          case '===': result = a === b; break;
          case '!==': result = a !== b; break;
          case '+': result = typeof a === 'string' || typeof b === 'string' ? toDisplayString(a) + toDisplayString(b) : numeric(a) + numeric(b); break;
          case '-': result = numeric(a) - numeric(b); break;
          case '*': result = numeric(a) * numeric(b); break;
          case '/': result = numeric(a) / numeric(b); break;
          case '%': result = numeric(a) % numeric(b); break;
          case '**': result = numeric(a) ** numeric(b); break;
          case '<': result = comparable(a) < comparable(b); break;
          case '<=': result = comparable(a) <= comparable(b); break;
          case '>': result = comparable(a) > comparable(b); break;
          case '>=': result = comparable(a) >= comparable(b); break;
          default: return left === ast.left && right === ast.right ? ast : { ...ast, left, right };
        }
        return foldedLiteral(result) || (left === ast.left && right === ast.right ? ast : { ...ast, left, right });
      } catch { /* Preserve runtime errors and exact error timing. */ }
    }
    return left === ast.left && right === ast.right ? ast : { ...ast, left, right };
  }
  if (ast.type === 'conditional') {
    const test = foldExpression(ast.test);
    if (test.type === 'literal' && canFoldScalar(test.value)) {
      return foldExpression(templateTruthy(test.value) ? ast.consequent : ast.alternate);
    }
    const consequent = foldExpression(ast.consequent);
    const alternate = foldExpression(ast.alternate);
    return test === ast.test && consequent === ast.consequent && alternate === ast.alternate ? ast : { ...ast, test, consequent, alternate };
  }
  if (ast.type === 'member') {
    const object = foldExpression(ast.object);
    const property = ast.computed ? foldExpression(ast.property) : ast.property;
    return object === ast.object && property === ast.property ? ast : { ...ast, object, property };
  }
  if (ast.type === 'call') {
    const args = ast.args.map(foldExpression);
    return args.every((arg, index) => arg === ast.args[index]) ? ast : { ...ast, args };
  }
  if (ast.type === 'filter') {
    const input = foldExpression(ast.input);
    const args = ast.args.map(foldExpression);
    return input === ast.input && args.every((arg, index) => arg === ast.args[index]) ? ast : { ...ast, input, args };
  }
  return ast;
}

function expressionToJavaScript(ast, compileContext = null) {
  const optimized = foldExpression(ast);
  if (optimized !== ast) return expressionToJavaScript(optimized, compileContext);
  switch (ast.type) {
    case 'literal': return jsLiteral(ast.value);
    case 'identifier': return `rt.resolve(state,${jsLiteral(ast.name)})`;
    case 'array': return `[${ast.elements.map(value => expressionToJavaScript(value, compileContext)).join(',')}]`;
    case 'object': return `rt.object([${ast.properties.map(property => `[${jsLiteral(property.key)},${expressionToJavaScript(property.value, compileContext)}]`).join(',')}])`;
    case 'unary': {
      const value = expressionToJavaScript(ast.argument, compileContext);
      if (ast.operator === '!') return `(!(${value}))`;
      if (ast.operator === '+') return `rt.numeric(${value})`;
      if (ast.operator === '-') return `(-rt.numeric(${value}))`;
      throw new TemplateError(`Unsupported unary operator ${ast.operator}.`, { code: 'ERR_ENGINEX_EXPRESSION_OPERATOR' });
    }
    case 'member': {
      const object = expressionToJavaScript(ast.object, compileContext);
      const property = ast.computed ? expressionToJavaScript(ast.property, compileContext) : jsLiteral(ast.property);
      return `rt.get(${object},${property})`;
    }
    case 'call': {
      if (ast.callee.type !== 'identifier') throw new TemplateError('Only registered helper functions can be called in safe templates.', { code: 'ERR_ENGINEX_CALL_NOT_HELPER' });
      const name = ast.callee.name;
      const args = ast.args.map(value => expressionToJavaScript(value, compileContext));
      const optimized = compileStaticFormatterInvocation(name, ast.args, args, compileContext);
      if (optimized) return optimized;
      return `rt.call(state,${jsLiteral(name)},[${args.join(',')}])`;
    }
    case 'filter': {
      const filterArgsAst = [ast.input, ...ast.args];
      const args = filterArgsAst.map(value => expressionToJavaScript(value, compileContext));
      const optimized = compileStaticFormatterInvocation(ast.name, filterArgsAst, args, compileContext);
      if (optimized) return optimized;
      return `rt.call(state,${jsLiteral(ast.name)},[${args.join(',')}])`;
    }
    case 'conditional':
      return `(rt.truthy(${expressionToJavaScript(ast.test, compileContext)})?${expressionToJavaScript(ast.consequent, compileContext)}:${expressionToJavaScript(ast.alternate, compileContext)})`;
    case 'binary': {
      const left = expressionToJavaScript(ast.left, compileContext);
      const right = expressionToJavaScript(ast.right, compileContext);
      switch (ast.operator) {
        case '&&': return `((${left})&&(${right}))`;
        case '||': return `((${left})||(${right}))`;
        case '??': return `((${left})??(${right}))`;
        case '+': return `rt.plus(${left},${right})`;
        case '-': return `(rt.numeric(${left})-rt.numeric(${right}))`;
        case '*': return `(rt.numeric(${left})*rt.numeric(${right}))`;
        case '/': return `(rt.numeric(${left})/rt.numeric(${right}))`;
        case '%': return `(rt.numeric(${left})%rt.numeric(${right}))`;
        case '**': return `(rt.numeric(${left})**rt.numeric(${right}))`;
        case '===': return `((${left})===(${right}))`;
        case '!==': return `((${left})!==(${right}))`;
        case '<': return `(rt.comparable(${left})<rt.comparable(${right}))`;
        case '<=': return `(rt.comparable(${left})<=rt.comparable(${right}))`;
        case '>': return `(rt.comparable(${left})>rt.comparable(${right}))`;
        case '>=': return `(rt.comparable(${left})>=rt.comparable(${right}))`;
        default: throw new TemplateError(`Unsupported binary operator ${ast.operator}.`, { code: 'ERR_ENGINEX_EXPRESSION_OPERATOR' });
      }
    }
    default: throw new TemplateError(`Unsupported expression node ${ast.type}.`, { code: 'ERR_ENGINEX_EXPRESSION_NODE' });
  }
}



function compileStaticFormatterInvocation(name, argsAst, args, compileContext) {
  if (!compileContext || !['formatNumber', 'formatCurrency', 'formatDate'].includes(name)) return null;
  const staticConfig = staticFormatterConfig(name, argsAst);
  if (!staticConfig) return null;
  const formatterKey = `${name}:${JSON.stringify([staticConfig.locale, staticConfig.options, staticConfig.currency])}`;
  let formatterIndex = compileContext.formatterIndexes.get(formatterKey);
  if (formatterIndex === undefined) {
    try {
      const formatter = name === 'formatDate'
        ? new Intl.DateTimeFormat(staticConfig.locale, staticConfig.options)
        : new Intl.NumberFormat(staticConfig.locale, name === 'formatCurrency'
          ? { ...staticConfig.options, style: 'currency', currency: staticConfig.currency }
          : staticConfig.options);
      formatterIndex = compileContext.formatters.length;
      compileContext.formatters.push({ name, formatter });
      compileContext.formatterIndexes.set(formatterKey, formatterIndex);
    } catch { return null; }
  }
  const fastMethod = name === 'formatDate' ? 'formatDate' : 'formatNumber';
  return `(state.helpers[${jsLiteral(name)}]===rt.builtins[${jsLiteral(name)}]?rt.staticFormat(${jsLiteral(fastMethod)},formatters[${formatterIndex}].formatter,${args[0] || 'void 0'}):rt.call(state,${jsLiteral(name)},[${args.join(',')}]))`;
}

function staticFormatterConfig(name, args) {
  if (args.length > 3) return null;
  const readStatic = node => {
    if (!node) return { ok: false };
    if (node.type === 'literal') return { ok: true, value: node.value };
    if (node.type === 'object') {
      const value = Object.create(null);
      for (const property of node.properties) {
        if (DANGEROUS_KEYS.has(property.key) || property.value.type !== 'literal') return { ok: false };
        value[property.key] = property.value.value;
      }
      return { ok: true, value };
    }
    return { ok: false };
  };
  const defaults = name === 'formatCurrency'
    ? { locale: 'en-US', options: {}, currency: 'USD' }
    : { locale: 'en-US', options: {}, currency: null };
  if (args.length >= 2) {
    const second = readStatic(args[1]);
    if (!second.ok) return null;
    if (name === 'formatCurrency') defaults.currency = String(second.value === undefined ? 'USD' : second.value);
    else defaults.locale = second.value === undefined ? 'en-US' : second.value;
  }
  if (args.length >= 3) {
    const third = readStatic(args[2]);
    if (!third.ok) return null;
    if (name === 'formatCurrency') defaults.locale = third.value === undefined ? 'en-US' : third.value;
    else {
      if (third.value === null || typeof third.value !== 'object' || Array.isArray(third.value)) return null;
      defaults.options = third.value;
    }
  }
  if (typeof defaults.locale !== 'string') return null;
  if (name === 'formatCurrency' && !/^[A-Z]{3}$/.test(defaults.currency)) return null;
  return defaults;
}

function compileRenderer(nodes, templatePath) {
  const cached = COMPILED_RENDERERS.get(nodes);
  if (cached) return cached;
  let variableId = 0;
  const compileContext = { formatters: [], formatterIndexes: new Map() };
  const temp = prefix => `_${prefix}${variableId++}`;
  function compileNodes(inputNodes) {
    const merged = [];
    for (const node of inputNodes || []) {
      if (node.type === 'if' || node.type === 'unless') {
        const constant = foldExpression(node.expression);
        if (constant.type === 'literal' && canFoldScalar(constant.value)) {
          const condition = templateTruthy(constant.value);
          const useChildren = node.type === 'if' ? condition : !condition;
          // Flatten compile-time-known branches, then continue normal coalescing.
          merged.push(...(useChildren ? node.children : (node.alternate || [])));
          continue;
        }
      }
      const last = merged[merged.length - 1];
      if (node.type === 'text' && last && last.type === 'text') {
        // Merge into a new node: never mutate the cached AST during compilation.
        merged[merged.length - 1] = { type: 'text', value: last.value + node.value };
      } else merged.push(node);
    }
    const extendsNode = merged.find(node => node.type === 'extends');
    if (extendsNode) {
      const blockEntries = [];
      const seen = new Set();
      for (const node of extendsNode.children) {
        if (node.type === 'block') {
          if (seen.has(node.name)) throw new TemplateError(`Duplicate layout block: ${node.name}`, { code: 'ERR_ENGINEX_DUPLICATE_BLOCK', templatePath });
          seen.add(node.name);
          const body = compileNodes(node.children);
          blockEntries.push(`[${jsLiteral(node.name)},{templatePath:${jsLiteral(templatePath)},render:function(state,out,overrides,active){${body}}}]`);
        } else if (node.type !== 'text' || node.value.trim() !== '') {
          throw new TemplateError('Only named {{#block}} declarations are allowed inside {{#extends}}.', { code: 'ERR_ENGINEX_INVALID_LAYOUT', templatePath });
        }
      }
      return `return rt.extend(state,templatePath,${jsLiteral(extendsNode.name)},new Map([${blockEntries.join(',')}]),out,active);`;
    }
    const code = [];
    for (const node of merged) {
      switch (node.type) {
        case 'text':
          if (node.value) code.push(`rt.emit(out,${jsLiteral(node.value)},state,templatePath);`);
          break;
        case 'interpolation': {
          const expr = expressionToJavaScript(node.expression, compileContext);
          if (node.raw) code.push(`rt.emit(out,rt.raw(${expr}),state,templatePath);`);
          else code.push(`rt.emit(out,rt.escape(${expr},state),state,templatePath);`);
          break;
        }
        case 'if': {
          const expr = expressionToJavaScript(node.expression, compileContext);
          code.push(`if(rt.truthy(${expr})){${compileNodes(node.children)}}else{${compileNodes(node.alternate || [])}}`);
          break;
        }
        case 'unless': {
          const expr = expressionToJavaScript(node.expression, compileContext);
          code.push(`if(!rt.truthy(${expr})){${compileNodes(node.children)}}else{${compileNodes(node.alternate || [])}}`);
          break;
        }
        case 'with': {
          const val = temp('withValue');
          const frame = temp('withFrame');
          code.push(`{const ${val}=${expressionToJavaScript(node.expression, compileContext)};if(${val}!==null&&${val}!==void 0){const ${frame}=Object.create(null);${frame}[${jsLiteral(node.alias)}]=${val};state.scopes.push(${frame});state.contexts.push(${val});try{${compileNodes(node.children)}}finally{state.scopes.pop();state.contexts.pop();}}}`);
          break;
        }
        case 'each': {
          const source = temp('source');
          const entries = temp('entries');
          const index = temp('index');
          const pair = temp('pair');
          const value = temp('item');
          const frame = temp('frame');
          const body = compileNodes(node.children);
          const loopBody = (itemExpression, keyExpression, lengthExpression) =>
            `rt.tickLoop(state,templatePath);const ${value}=${itemExpression};${frame}[${jsLiteral(node.itemName)}]=${value};${frame}[${jsLiteral(node.indexName)}]=${index};${frame}['@index']=${index};${frame}['@key']=${keyExpression};${frame}['@first']=(${index}===0);${frame}['@last']=(${index}===${lengthExpression}-1);state.contexts[state.contexts.length-1]=${value};rt.checkTime(state);${body}`;
          const arrayLoop = `if(${source}.length===0){${compileNodes(node.alternate || [])}}else{rt.assertArrayLoop(${source}.length,state,templatePath);const ${frame}=Object.create(null);state.scopes.push(${frame});state.contexts.push(void 0);try{for(let ${index}=0;${index}<${source}.length;${index}++){${loopBody(`${source}[${index}]`, index, `${source}.length`)}}}finally{state.scopes.pop();state.contexts.pop();}}`;
          const genericLoop = `const ${entries}=rt.entries(${source},state,templatePath);if(${entries}.length===0){${compileNodes(node.alternate || [])}}else{const ${frame}=Object.create(null);state.scopes.push(${frame});state.contexts.push(void 0);try{for(let ${index}=0;${index}<${entries}.length;${index}++){const ${pair}=${entries}[${index}];${loopBody(`${pair}[1]`, `${pair}[0]`, `${entries}.length`)}}}finally{state.scopes.pop();state.contexts.pop();}}`;
          code.push(`{const ${source}=${expressionToJavaScript(node.expression, compileContext)};if(rt.isArray(${source})){${arrayLoop}}else{${genericLoop}}}`);
          break;
        }
        case 'partial': {
          const context = node.context ? expressionToJavaScript(node.context, compileContext) : 'void 0';
          code.push(`rt.partial(state,templatePath,${jsLiteral(node.name)},${context},out,overrides,active);`);
          break;
        }
        case 'block': {
          const override = temp('override');
          code.push(`{const ${override}=overrides&&overrides.get(${jsLiteral(node.name)});if(${override}){${override}.render(state,out,overrides,active);}else{${compileNodes(node.children)}}}`);
          break;
        }
        case 'fragment':
          code.push(compileNodes(node.children));
          break;
        case 'extends': break;
        case 'legacy':
          throw new TemplateError('Legacy <?njs ?> blocks cannot be compiled by the safe renderer.', { code: 'ERR_ENGINEX_UNSAFE_CODE_DISABLED', templatePath });
        default: throw new TemplateError(`Unknown compiled node type ${node.type}.`, { code: 'ERR_ENGINEX_UNKNOWN_NODE', templatePath });
      }
    }
    return code.join('');
  }
  const body = compileNodes(nodes);
  // Function is only given compiler-generated statements. User text and names
  // enter generated source exclusively as JSON-escaped literals; expressions
  // are translated from the restricted parser AST, never copied as source.
  const factory = new Function('rt', 'templatePath', 'formatters', `"use strict"; return function renderCompiled(state,out,overrides,active){${body}\n};`);
  const renderer = factory(COMPILED_RUNTIME, templatePath, compileContext.formatters);
  COMPILED_RENDERERS.set(nodes, renderer);
  CACHE_STATS.rendererCompiles++;
  RENDER_STATS.compiledRenderers++;
  return renderer;
}

const COMPILED_RUNTIME = Object.freeze({
  builtins: BUILTIN_HELPERS,
  staticFormat: (type, formatter, value) => {
    if (type === 'formatDate') {
      const date = value instanceof Date ? value : new Date(String(value ?? ''));
      return Number.isFinite(date.getTime()) ? formatter.format(date) : '';
    }
    return formatter.format(Number(value));
  },
  resolve: (state, name) => resolveIdentifier(name, state),
  get: safeGet,
  object: entries => {
    const output = Object.create(null);
    for (const [key, value] of entries) {
      if (DANGEROUS_KEYS.has(key)) throw new TemplateError(`Unsafe object key "${key}".`, { code: 'ERR_ENGINEX_UNSAFE_DATA' });
      output[key] = value;
    }
    return output;
  },
  numeric,
  comparable,
  truthy: templateTruthy,
  plus: (left, right) => typeof left === 'string' || typeof right === 'string' ? toDisplayString(left) + toDisplayString(right) : numeric(left) + numeric(right),
  escape: (value, state) => state && typeof state.escapeHtml === 'function' ? state.escapeHtml(value) : escapeHtml(value),
  raw: value => {
    if (!isSafeHtml(value)) throw new TemplateError('Raw interpolation requires a value created by engine.safeHtml() or a trusted JSON helper.', { code: 'ERR_ENGINEX_UNSAFE_RAW_OUTPUT' });
    return value.value;
  },
  emit: (out, chunk, state, templatePath) => {
    if (!chunk) return;
    // Avoid a Date.now() call for every tiny HTML node; loop/helper paths also
    // check deadlines. Static/dynamic output still checks the clock regularly.
    state.emitCheckCounter++;
    if ((state.emitCheckCounter & 63) === 0 || chunk.length > 64 * 1024) checkTime(state);
    state.outputLength += chunk.length;
    if (state.outputLength > state.limits.maxOutputLength) throw new TemplateError(`Rendered output exceeds maxOutputLength (${state.limits.maxOutputLength}).`, { code: 'ERR_ENGINEX_OUTPUT_LIMIT', templatePath });
    out.push(chunk);
  },
  call: (state, name, args) => {
    checkTime(state);
    const helper = state.helpers[name];
    if (typeof helper !== 'function') throw new TemplateError(`Unknown template helper "${name}".`, { code: 'ERR_ENGINEX_UNKNOWN_HELPER' });
    let result;
    try { result = helper(...args); }
    catch (cause) { throw new TemplateError('A template helper failed.', { code: 'ERR_ENGINEX_HELPER_FAILED', cause }); }
    if (utilTypes.isPromise(result)) {
      // Attach a rejection handler so the deliberate sync-path error does not
      // create an unhandled-rejection process warning.
      result.catch(() => {});
      throw new TemplateError(`Helper "${name}" returned a Promise; use renderAsync() for asynchronous helpers.`, { code: 'ERR_ENGINEX_ASYNC_HELPER' });
    }
    if (result !== null && typeof result === 'object' && !isSafeHtml(result)) return snapshotData(result, state.limits);
    if (typeof result === 'function' || typeof result === 'symbol') throw new TemplateError('Template helpers must return data, not functions or symbols.', { code: 'ERR_ENGINEX_UNSAFE_DATA' });
    return result;
  },
  isArray: Array.isArray,
  assertArrayLoop: (length, state, templatePath) => { if (length > state.limits.maxLoopIterations - state.iterationCount) throw new TemplateError(`Loop exceeds maxLoopIterations (${state.limits.maxLoopIterations}).`, { code: 'ERR_ENGINEX_LOOP_LIMIT', templatePath }); },
  entries: (value, state, templatePath) => iterateEntries(value, state.limits.maxLoopIterations - state.iterationCount, templatePath),
  tickLoop: (state, templatePath) => {
    state.iterationCount++;
    if (state.iterationCount > state.limits.maxLoopIterations) throw new TemplateError('Render exceeded maxLoopIterations.', { code: 'ERR_ENGINEX_LOOP_LIMIT', templatePath });
  },
  checkTime,
  partial: (state, parentPath, name, context, out, overrides, active) => {
    const dependencyKey = `${parentPath}\0partial\0${name}`;
    const pathForPartial = state.bundle.dependencyPaths.get(dependencyKey);
    if (!pathForPartial) throw new TemplateError(`Unresolved partial "${name}".`, { code: 'ERR_ENGINEX_PARTIAL_NOT_FOUND', templatePath: parentPath });
    const hasContext = context !== undefined && context !== null;
    if (hasContext && !isPlainObject(context) && !Array.isArray(context)) throw new TemplateError('Partial context must evaluate to a plain object or array.', { code: 'ERR_ENGINEX_PARTIAL_CONTEXT', templatePath: parentPath });
    if (hasContext) {
      const cleanContext = snapshotData(context, state.limits);
      state.scopes.push(cleanContext); state.contexts.push(cleanContext);
      try { invokeCompiledPath(state, pathForPartial, out, overrides, active); }
      finally { state.scopes.pop(); state.contexts.pop(); }
    } else invokeCompiledPath(state, pathForPartial, out, overrides, active);
  },
  extend: (state, parentPath, name, childOverrides, out, active) => {
    const layoutPath = state.bundle.dependencyPaths.get(`${parentPath}\0layout\0${name}`);
    if (!layoutPath) throw new TemplateError(`Unresolved layout "${name}".`, { code: 'ERR_ENGINEX_LAYOUT_NOT_FOUND', templatePath: parentPath });
    const merged = new Map(childOverrides);
    if (state.currentOverrides) for (const [key, value] of state.currentOverrides) merged.set(key, value);
    invokeCompiledPath(state, layoutPath, out, merged, active);
  }
});

function invokeCompiledPath(state, templatePath, out, overrides, active) {
  const record = state.bundle.templates.get(templatePath);
  if (!record) throw new TemplateError(`Template dependency was not loaded: ${templatePath}`, { code: 'ERR_ENGINEX_DEPENDENCY_NOT_LOADED', templatePath });
  if (active.set.has(templatePath)) throw new TemplateError(`Circular include detected: ${active.stack.concat(templatePath).join(' -> ')}`, { code: 'ERR_ENGINEX_CIRCULAR_INCLUDE', templatePath });
  if (active.stack.length >= state.limits.maxIncludeDepth + 1) throw new TemplateError(`Maximum include depth (${state.limits.maxIncludeDepth}) exceeded.`, { code: 'ERR_ENGINEX_INCLUDE_DEPTH', templatePath });
  const previousOverrides = state.currentOverrides;
  active.stack.push(templatePath); active.set.add(templatePath); state.currentOverrides = overrides;
  try { record.renderer(state, out, overrides, active); }
  catch (error) {
    if (error instanceof TemplateError && !error.templatePath) error.templatePath = templatePath;
    throw error;
  } finally {
    active.stack.pop(); active.set.delete(templatePath); state.currentOverrides = previousOverrides;
  }
}

function collectDependencyNodes(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.type === 'partial' || node.type === 'extends') out.push({ type: node.type, name: node.name });
    if (node.children) collectDependencyNodes(node.children, out);
    if (node.alternate) collectDependencyNodes(node.alternate, out);
  }
  return out;
}

async function loadTemplateBundle(templateName, options = {}) {
  if (options.allowUnsafeCode) throw new TemplateError('The compiled safe renderer does not support unsafe legacy code.', { code: 'ERR_ENGINEX_UNSAFE_API' });
  const limits = mergeLimits(options);
  const rootPath = await resolveRootPath(templateName, options);
  const bundle = { rootPath, options: { ...options }, limits, helpers: createHelpers(options), templates: new Map(), dependencyPaths: new Map() };
  async function visit(templatePath) {
    if (bundle.templates.has(templatePath)) return;
    const ast = await loadTemplateAst(templatePath, options, limits);
    if (containsLegacyCode(ast)) throw new TemplateError('Legacy <?njs ?> blocks cannot be loaded into the safe compiled renderer.', { code: 'ERR_ENGINEX_UNSAFE_CODE_DISABLED', templatePath });
    const record = { path: templatePath, ast, renderer: compileRenderer(ast, templatePath) };
    bundle.templates.set(templatePath, record);
    const dependencies = collectDependencyNodes(ast);
    for (const dependency of dependencies) {
      const cacheKey = `${templatePath}\0${dependency.type === 'extends' ? 'layout' : 'partial'}\0${dependency.name}`;
      if (bundle.dependencyPaths.has(cacheKey)) continue;
      const dependencyPath = await resolvePartialPath(dependency.name, templatePath, options);
      bundle.dependencyPaths.set(cacheKey, dependencyPath);
      await visit(dependencyPath);
    }
  }
  await visit(rootPath);
  bundle.fragments = collectFragmentDefinitions(bundle.templates.get(rootPath).ast, rootPath, options.pureHelpers);
  bundle.dependencyGraph = new FragmentDependencyGraph(bundle.fragments);
  return bundle;
}

function renderCompiledBundleCore(bundle, data, renderOptions = {}) {
  const hasOverrides = renderOptions && Object.keys(renderOptions).length > 0;
  const options = hasOverrides ? { ...bundle.options, ...renderOptions } : bundle.options;
  const limits = hasOverrides ? mergeLimits(options) : bundle.limits;
  const preparedSnapshot = data !== null && typeof data === 'object' ? PREPARED_DATA.get(data) : undefined;
  const locals = preparedSnapshot || snapshotLocals(data, limits);
  const helpers = !hasOverrides || !Object.hasOwn(renderOptions, 'helpers') ? bundle.helpers || createHelpers(options) : createHelpers(options);
  const state = makeCompiledState(options, limits, locals, helpers);
  const accelerator = options.wasmSimdAccelerator;
  if (accelerator && typeof accelerator.escapeHtmlAscii === 'function') {
    state.escapeHtml = value => { const escaped = accelerator.escapeHtmlAscii(toDisplayString(value)); return escaped === null ? escapeHtml(value) : escaped; };
  }
  state.bundle = bundle;
  const out = [];
  invokeCompiledPath(state, bundle.rootPath, out, null, { stack: [], set: new Set() });
  RENDER_STATS.syncRenders++;
  return { html: out.join(''), snapshot: state.rootContext };
}

function telemetryEnabled(options) {
  return Boolean(options && (options.telemetry === true || typeof options.onMetric === 'function'));
}

function publishRenderMetric(options, mode, startedAt, outcome, outputBytes = 0, errorCode = null, traceId = null) {
  if (!telemetryEnabled(options)) return;
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  TELEMETRY.enabledRenders++;
  TELEMETRY.renders++;
  if (outcome !== 'ok') TELEMETRY.errors++;
  TELEMETRY.totalDurationMs += durationMs;
  TELEMETRY.maxDurationMs = Math.max(TELEMETRY.maxDurationMs, durationMs);
  TELEMETRY.outputBytes += outputBytes;
  const key = `${mode}:${outcome}`;
  const aggregate = TELEMETRY.byMode[key] || (TELEMETRY.byMode[key] = { renders: 0, errors: 0, totalDurationMs: 0, maxDurationMs: 0, outputBytes: 0 });
  aggregate.renders++;
  if (outcome !== 'ok') aggregate.errors++;
  aggregate.totalDurationMs += durationMs;
  aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, durationMs);
  aggregate.outputBytes += outputBytes;
  if (typeof options.onMetric === 'function') {
    const metric = Object.freeze({ type: 'enginex.render', mode, outcome, durationMs, outputBytes, ...(errorCode ? { errorCode } : {}), ...(traceId ? { traceId } : {}) });
    try { options.onMetric(metric); } catch { /* Observability must never break rendering. */ }
  }
}

function renderCompiledBundle(bundle, data, renderOptions = {}) {
  const options = { ...bundle.options, ...renderOptions };
  if (!telemetryEnabled(options)) return renderCompiledBundleCore(bundle, data, renderOptions);
  const startedAt = process.hrtime.bigint();
  try {
    const result = renderCompiledBundleCore(bundle, data, renderOptions);
    publishRenderMetric(options, 'compiled-sync', startedAt, 'ok', Buffer.byteLength(result.html, 'utf8'), null, options.traceId);
    return result;
  } catch (error) {
    publishRenderMetric(options, 'compiled-sync', startedAt, 'error', 0, error && error.code || 'ERR_ENGINEX_RENDER', options.traceId);
    throw error;
  }
}

function pathOfExpression(ast, aliases = new Map()) {
  if (!ast) return null;
  if (ast.type === 'identifier') {
    if (['this', '@root', '@index', '@key', '@first', '@last'].includes(ast.name)) return ast.name === '@root' ? '@root' : null;
    return aliases.has(ast.name) ? aliases.get(ast.name) : ast.name;
  }
  if (ast.type === 'member') {
    const base = pathOfExpression(ast.object, aliases);
    if (!base) return null;
    let property;
    if (!ast.computed && typeof ast.property === 'string') property = ast.property;
    else if (ast.computed && ast.property && ast.property.type === 'literal' && (typeof ast.property.value === 'string' || typeof ast.property.value === 'number')) property = String(ast.property.value);
    else return base;
    return base === '@root' ? property : `${base}.${property}`;
  }
  return null;
}

function collectExpressionDependencies(ast, aliases, output, customHelpers, pureHelpers) {
  if (!ast || typeof ast !== 'object') return;
  const directPath = pathOfExpression(ast, aliases);
  if (directPath) {
    output.add(directPath);
    if (ast.type === 'member' && ast.computed && ast.property && typeof ast.property === 'object') collectExpressionDependencies(ast.property, aliases, output, customHelpers, pureHelpers);
    return;
  }
  if (ast.type === 'call') {
    if (ast.callee && ast.callee.type === 'identifier' && !Object.hasOwn(BUILTIN_HELPERS, ast.callee.name) && !pureHelpers.has(ast.callee.name)) customHelpers.add(ast.callee.name);
    for (const arg of ast.args) collectExpressionDependencies(arg, aliases, output, customHelpers, pureHelpers);
    return;
  }
  if (ast.type === 'filter') {
    if (!Object.hasOwn(BUILTIN_HELPERS, ast.name) && !pureHelpers.has(ast.name)) customHelpers.add(ast.name);
    collectExpressionDependencies(ast.input, aliases, output, customHelpers, pureHelpers);
    for (const arg of ast.args) collectExpressionDependencies(arg, aliases, output, customHelpers, pureHelpers);
    return;
  }
  for (const [key, child] of Object.entries(ast)) {
    if (key === 'callee') continue;
    if (Array.isArray(child)) {
      for (const entry of child) {
        if (entry && entry.type) collectExpressionDependencies(entry, aliases, output, customHelpers, pureHelpers);
        else if (entry && entry.value && entry.value.type) collectExpressionDependencies(entry.value, aliases, output, customHelpers, pureHelpers);
      }
    } else if (child && child.type) collectExpressionDependencies(child, aliases, output, customHelpers, pureHelpers);
  }
}

function collectFragmentDefinitions(rootNodes, templatePath, pureHelperNames = []) {
  const pureHelpers = new Set(Array.isArray(pureHelperNames) ? pureHelperNames : []);
  const fragments = [];
  const ids = new Set();
  function visit(nodes, aliases = new Map(), inFragment = null) {
    for (const node of nodes || []) {
      if (node.type === 'fragment') {
        if (inFragment) throw new TemplateError('Nested {{#fragment}} blocks are not supported.', { code: 'ERR_ENGINEX_NESTED_FRAGMENT', templatePath });
        if (ids.has(node.name)) throw new TemplateError(`Duplicate fragment identifier "${node.name}".`, { code: 'ERR_ENGINEX_DUPLICATE_FRAGMENT', templatePath });
        ids.add(node.name);
        const dependencies = new Set();
        const customHelpers = new Set();
        visit(node.children, new Map(aliases), { node, dependencies, customHelpers });
        const alwaysDirty = customHelpers.size > 0 || dependencies.has('*');
        fragments.push({ id: node.name, templatePath, nodes: node.children, renderer: compileRenderer(node.children, templatePath), dependencies: [...dependencies].filter(value => value !== '@root').sort(), alwaysDirty, helpers: [...customHelpers].sort() });
        continue;
      }
      const target = inFragment ? inFragment.dependencies : new Set();
      const custom = inFragment ? inFragment.customHelpers : new Set();
      if (node.type === 'interpolation') collectExpressionDependencies(node.expression, aliases, target, custom, pureHelpers);
      else if (node.type === 'if' || node.type === 'unless') {
        collectExpressionDependencies(node.expression, aliases, target, custom, pureHelpers);
        visit(node.children, aliases, inFragment); visit(node.alternate || [], aliases, inFragment);
      } else if (node.type === 'each') {
        collectExpressionDependencies(node.expression, aliases, target, custom, pureHelpers);
        const nextAliases = new Map(aliases);
        const basePath = pathOfExpression(node.expression, aliases);
        nextAliases.set(node.itemName, basePath ? `${basePath}.*` : '*');
        nextAliases.set(node.indexName, null);
        visit(node.children, nextAliases, inFragment); visit(node.alternate || [], aliases, inFragment);
      } else if (node.type === 'with') {
        collectExpressionDependencies(node.expression, aliases, target, custom, pureHelpers);
        const nextAliases = new Map(aliases); nextAliases.set(node.alias, pathOfExpression(node.expression, aliases) || '*');
        visit(node.children, nextAliases, inFragment);
      } else if (node.type === 'partial') {
        if (inFragment) inFragment.dependencies.add('*');
        if (node.context) collectExpressionDependencies(node.context, aliases, target, custom, pureHelpers);
      } else if (node.type === 'block' || node.type === 'extends') visit(node.children, aliases, inFragment);
    }
  }
  visit(rootNodes);
  return fragments;
}

function diffDataPaths(previous, current, prefix = '', output = []) {
  if (Object.is(previous, current)) return output;
  if (previous instanceof Date || current instanceof Date) {
    if (String(previous) !== String(current)) output.push(prefix || '*');
    return output;
  }
  const previousContainer = previous !== null && typeof previous === 'object';
  const currentContainer = current !== null && typeof current === 'object';
  if (!previousContainer || !currentContainer || Array.isArray(previous) !== Array.isArray(current) || previous instanceof Map || current instanceof Map || previous instanceof Set || current instanceof Set) {
    output.push(prefix || '*');
    return output;
  }
  const oldKeys = Object.keys(previous);
  const newKeys = Object.keys(current);
  const allKeys = new Set([...oldKeys, ...newKeys]);
  for (const key of allKeys) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(previous, key) || !Object.hasOwn(current, key)) output.push(childPath);
    else diffDataPaths(previous[key], current[key], childPath, output);
  }
  return output;
}

function createIncrementalSession(bundle) {
  let previousSnapshot = null;
  let revision = 0;
  let previousDirtyMask = new DirtyBitSet(bundle.fragments.length);
  return Object.freeze({
    render(data, options = {}) {
      if (previousSnapshot === null) {
        const result = renderCompiledBundle(bundle, data, options);
        previousSnapshot = result.snapshot;
        revision++;
        return { type: 'full', html: result.html, revision, changedPaths: ['*'] };
      }
      const limits = mergeLimits({ ...bundle.options, ...options });
      const preparedSnapshot = data !== null && typeof data === 'object' ? PREPARED_DATA.get(data) : undefined;
      const currentSnapshot = preparedSnapshot || getStateLocals({ ...bundle.options, ...options, locals: data }, limits);
      const changedPaths = Array.isArray(options.changedPaths)
        ? options.changedPaths.filter(value => typeof value === 'string' && value.length > 0)
        : diffDataPaths(previousSnapshot, currentSnapshot);
      previousSnapshot = currentSnapshot;
      revision++;
      if (bundle.fragments.length === 0) {
        const rendered = renderCompiledBundle(bundle, data, options);
        return { type: 'full', html: rendered.html, revision, changedPaths };
      }
      if (changedPaths.includes('*')) {
        const rendered = renderCompiledBundle(bundle, data, options);
        return { type: 'full', html: rendered.html, revision, changedPaths };
      }
      const dirtyMask = bundle.dependencyGraph.dirtyFragmentMask(changedPaths);
      // XOR reports transitions between dirty sets; intersection still selects fragments
      // to update for this render. Dirty state is deliberately not accumulated with XOR.
      const dirtyTransitions = previousDirtyMask.xor(dirtyMask);
      previousDirtyMask = dirtyMask.clone();
      const selected = dirtyMask.indices().map(index => bundle.fragments[index]);
      const renderOptions = { ...bundle.options, ...options, locals: currentSnapshot };
      const state = makeState(renderOptions, limits, currentSnapshot);
      const accelerator = renderOptions.wasmSimdAccelerator;
      if (accelerator && typeof accelerator.escapeHtmlAscii === 'function') {
        state.escapeHtml = value => { const escaped = accelerator.escapeHtmlAscii(toDisplayString(value)); return escaped === null ? escapeHtml(value) : escaped; };
      }
      state.bundle = bundle;
      const active = { stack: [bundle.rootPath], set: new Set([bundle.rootPath]) };
      const patches = [];
      for (const fragment of selected) {
        const out = [];
        fragment.renderer(state, out, null, active);
        patches.push({ id: fragment.id, selector: `[data-enginex-fragment="${fragment.id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`, html: out.join(''), dependencies: fragment.dependencies });
      }
      RENDER_STATS.incrementalPatches += patches.length;
      return { type: 'patches', patches, revision, changedPaths, dirtyFragments: dirtyMask.indices(), dirtyTransitions: dirtyTransitions.indices() };
    },
    reset() { previousSnapshot = null; revision = 0; previousDirtyMask = new DirtyBitSet(bundle.fragments.length); },
    get revision() { return revision; }
  });
}

async function* renderNodes(nodes, templatePath, state, blockOverrides = null) {
  checkTime(state);
  const extendsNode = nodes.find(node => node.type === 'extends');
  if (extendsNode) {
    const blocks = new Map();
    for (const node of extendsNode.children) {
      if (node.type === 'block') {
        if (blocks.has(node.name)) throw new TemplateError(`Duplicate layout block: ${node.name}`, { code: 'ERR_ENGINEX_DUPLICATE_BLOCK', templatePath });
        blocks.set(node.name, { nodes: node.children, templatePath });
      }
      else if (node.type !== 'text' || node.value.trim() !== '') {
        throw new TemplateError('Only named {{#block}} declarations are allowed inside {{#extends}}.', {
          code: 'ERR_ENGINEX_INVALID_LAYOUT', templatePath
        });
      }
    }
    if (blockOverrides) {
      for (const [name, override] of blockOverrides) blocks.set(name, override);
    }
    const layoutPath = await resolvePartialPath(extendsNode.name, templatePath, state.options);
    yield* renderFile(layoutPath, state, blocks);
    return;
  }

  for (const node of nodes) {
    checkTime(state);
    switch (node.type) {
      case 'text': yield* emit(node.value, state, templatePath); break;
      case 'interpolation': {
        const value = await evaluate(node.expression, state);
        if (node.raw) {
          if (!isSafeHtml(value)) throw new TemplateError('Raw interpolation requires a value created by engine.safeHtml() or a trusted JSON helper.', {
            code: 'ERR_ENGINEX_UNSAFE_RAW_OUTPUT', templatePath
          });
          yield* emit(value.value, state, templatePath);
        } else {
          yield* emit(escapeHtml(value), state, templatePath);
        }
        break;
      }
      case 'if': {
        const condition = await evaluate(node.expression, state);
        yield* renderNodes(templateTruthy(condition) ? node.children : (node.alternate || []), templatePath, state, blockOverrides);
        break;
      }
      case 'unless': {
        const condition = await evaluate(node.expression, state);
        yield* renderNodes(!templateTruthy(condition) ? node.children : (node.alternate || []), templatePath, state, blockOverrides);
        break;
      }
      case 'with': {
        const value = await evaluate(node.expression, state);
        if (value !== null && value !== undefined) {
          const frame = Object.create(null);
          frame[node.alias] = value;
          state.scopes.push(frame);
          state.contexts.push(value);
          try { yield* renderNodes(node.children, templatePath, state, blockOverrides); }
          finally { state.scopes.pop(); state.contexts.pop(); }
        }
        break;
      }
      case 'each': {
        const value = await evaluate(node.expression, state);
        const remaining = state.limits.maxLoopIterations - state.iterationCount;
        const entries = iterateEntries(value, remaining, templatePath);
        if (entries.length === 0) {
          yield* renderNodes(node.alternate || [], templatePath, state, blockOverrides);
          break;
        }
        for (let index = 0; index < entries.length; index++) {
          state.iterationCount++;
          if (state.iterationCount > state.limits.maxLoopIterations) throw new TemplateError('Render exceeded maxLoopIterations.', { code: 'ERR_ENGINEX_LOOP_LIMIT', templatePath });
          const [key, valueForItem] = entries[index];
          const frame = Object.create(null);
          frame[node.itemName] = valueForItem;
          frame[node.indexName] = index;
          frame['@index'] = index;
          frame['@key'] = key;
          frame['@first'] = index === 0;
          frame['@last'] = index === entries.length - 1;
          state.scopes.push(frame);
          state.contexts.push(valueForItem);
          try { yield* renderNodes(node.children, templatePath, state, blockOverrides); }
          finally { state.scopes.pop(); state.contexts.pop(); }
        }
        break;
      }
      case 'partial': {
        const context = node.context ? await evaluate(node.context, state) : undefined;
        const partialPath = await resolvePartialPath(node.name, templatePath, state.options);
        if (context !== undefined && context !== null) {
          if (!isPlainObject(context) && !Array.isArray(context)) throw new TemplateError('Partial context must evaluate to a plain object or array.', { code: 'ERR_ENGINEX_PARTIAL_CONTEXT', templatePath });
          const cleanContext = snapshotData(context, state.limits);
          state.scopes.push(cleanContext);
          state.contexts.push(cleanContext);
          try { yield* renderFile(partialPath, state, blockOverrides); }
          finally { state.scopes.pop(); state.contexts.pop(); }
        } else {
          yield* renderFile(partialPath, state, blockOverrides);
        }
        break;
      }
      case 'fragment':
        yield* renderNodes(node.children, templatePath, state, blockOverrides);
        break;
      case 'block': {
        const override = blockOverrides && blockOverrides.get(node.name);
        yield* renderNodes(override ? override.nodes : node.children, override ? override.templatePath : templatePath, state, blockOverrides);
        break;
      }
      case 'extends': break;
      case 'legacy':
        if (!state.options.allowUnsafeCode) {
          throw new TemplateError('Legacy <?njs ... ?> blocks execute arbitrary JavaScript. Set allowUnsafeCode: true only for trusted templates.', {
            code: 'ERR_ENGINEX_UNSAFE_CODE_DISABLED', templatePath
          });
        }
        throw new TemplateError('Unsafe legacy blocks are handled by the explicitly selected compatibility engine.', {
          code: 'ERR_ENGINEX_UNSAFE_COMPAT_DISPATCH', templatePath
        });
      default: throw new TemplateError(`Unknown compiled node type ${node.type}.`, { code: 'ERR_ENGINEX_UNKNOWN_NODE', templatePath });
    }
  }
}

async function* emit(chunk, state, templatePath) {
  if (!chunk) return;
  state.outputLength += chunk.length;
  if (state.outputLength > state.limits.maxOutputLength) {
    throw new TemplateError(`Rendered output exceeds maxOutputLength (${state.limits.maxOutputLength}).`, {
      code: 'ERR_ENGINEX_OUTPUT_LIMIT', templatePath
    });
  }
  yield chunk;
}

async function* renderFile(templatePath, state, blockOverrides = null) {
  checkTime(state);
  if (state.activePathSet.has(templatePath)) {
    throw new TemplateError(`Circular include detected: ${state.activePaths.concat(templatePath).join(' -> ')}`, {
      code: 'ERR_ENGINEX_CIRCULAR_INCLUDE', templatePath
    });
  }
  if (state.activePaths.length >= state.limits.maxIncludeDepth + 1) {
    throw new TemplateError(`Maximum include depth (${state.limits.maxIncludeDepth}) exceeded.`, {
      code: 'ERR_ENGINEX_INCLUDE_DEPTH', templatePath
    });
  }
  state.activePaths.push(templatePath);
  state.activePathSet.add(templatePath);
  try {
    const ast = await loadTemplateAst(templatePath, state.options, state.limits);
    yield* renderNodes(ast, templatePath, state, blockOverrides);
  } catch (error) {
    if (error instanceof TemplateError && !error.templatePath) error.templatePath = templatePath;
    throw error;
  } finally {
    state.activePaths.pop();
    state.activePathSet.delete(templatePath);
  }
}

async function* renderStreamInternal(templateName, options = {}) {
  const observe = telemetryEnabled(options);
  const startedAt = observe ? process.hrtime.bigint() : null;
  let outputBytes = 0;
  let outcome = 'ok';
  let failureCode = null;
  try {
    if (options.allowUnsafeCode) {
      // The compatibility path is deliberately separate from the secure interpreter.
      throw new TemplateError('Use engine.unsafe(...) to render legacy <?njs ?> templates.', { code: 'ERR_ENGINEX_UNSAFE_API' });
    }
    const limits = mergeLimits(options);
    const rootPath = await resolveRootPath(templateName, options);
    const locals = getStateLocals(options, limits);
    const state = makeState(options, limits, locals);
    if (!observe) {
      yield* renderFile(rootPath, state);
      return;
    }
    for await (const chunk of renderFile(rootPath, state)) {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      yield chunk;
    }
  } catch (error) {
    outcome = 'error';
    failureCode = error && error.code || 'ERR_ENGINEX_RENDER';
    throw error;
  } finally {
    if (observe) publishRenderMetric(options, 'async-stream', startedAt, outcome, outputBytes, failureCode, options.traceId);
  }
}

async function render(templateName, options = {}) {
  const chunks = [];
  for await (const chunk of renderStreamInternal(templateName, options)) chunks.push(chunk);
  return chunks.join('');
}

function renderStream(templateName, options = {}) {
  return renderStreamInternal(templateName, options);
}

async function renderTo(templateName, options = {}, writable) {
  if (!writable || typeof writable.write !== 'function') throw new TypeError('renderTo requires a writable stream.');
  for await (const chunk of renderStream(templateName, options)) {
    if (!writable.write(chunk)) await new Promise((resolve, reject) => {
      const cleanup = () => {
        writable.removeListener('drain', onDrain);
        writable.removeListener('error', onError);
        writable.removeListener('close', onClose);
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error('Writable stream closed before draining template output.')); };
      writable.once('drain', onDrain);
      writable.once('error', onError);
      writable.once('close', onClose);
    });
  }
}

function engine(templateName, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  options = options && typeof options === 'object' ? options : {};
  if (options.allowUnsafeCode) {
    const legacyOptions = {
      ...options,
      root: options.root ?? options.views ?? process.cwd(),
      strictPaths: options.strictPaths !== false,
      allowRequire: options.allowUnsafeRequire === true
    };
    delete legacyOptions.allowUnsafeCode;
    delete legacyOptions.allowUnsafeRequire;
    const legacy = require('./engine-legacy');
    return legacy(templateName, legacyOptions, callback);
  }
  const promise = render(templateName, options);
  if (typeof callback === 'function') {
    promise.then(html => callback(null, html), error => callback(error));
    return undefined;
  }
  return promise;
}

async function renderSource(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('Template source must be a string.');
  if (options.allowUnsafeCode) throw new TemplateError('Inline source rendering never enables unsafe legacy JavaScript.', { code: 'ERR_ENGINEX_UNSAFE_API' });
  const limits = mergeLimits(options);
  if (Buffer.byteLength(source, 'utf8') > limits.maxTemplateBytes) {
    throw new TemplateError(`Template exceeds maxTemplateBytes (${limits.maxTemplateBytes}).`, { code: 'ERR_ENGINEX_TEMPLATE_LIMIT' });
  }
  const root = getRoot(options);
  const name = options.templateName ?? '__enginex_inline__.html';
  if (typeof name !== 'string' || name.trim() === '' || path.isAbsolute(name)) {
    throw new TypeError('templateName must be a non-empty relative path.');
  }
  const virtualPath = path.resolve(root, ensureExtension(name));
  if (options.strictPaths !== false && !withinRoot(root, virtualPath)) {
    throw new TemplateError('Inline templateName escapes the configured root.', { code: 'ERR_ENGINEX_PATH_OUTSIDE_ROOT', templatePath: name });
  }
  assertOutputContexts(source, options, virtualPath);
  const compiled = compileTemplate(source, virtualPath, limits);
  if (containsLegacyCode(compiled.nodes)) {
    throw new TemplateError('Legacy <?njs ... ?> blocks are disabled by safe inline rendering.', { code: 'ERR_ENGINEX_UNSAFE_CODE_DISABLED', templatePath: virtualPath });
  }
  const locals = getStateLocals(options, limits);
  const state = makeState(options, limits, locals);
  const chunks = [];
  for await (const chunk of renderNodes(compiled.nodes, virtualPath, state)) chunks.push(chunk);
  return chunks.join('');
}

function renderSourceStream(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('Template source must be a string.');
  if (options.allowUnsafeCode) throw new TemplateError('Inline source rendering never enables unsafe legacy JavaScript.', { code: 'ERR_ENGINEX_UNSAFE_API' });
  const limits = mergeLimits(options);
  if (Buffer.byteLength(source, 'utf8') > limits.maxTemplateBytes) {
    throw new TemplateError(`Template exceeds maxTemplateBytes (${limits.maxTemplateBytes}).`, { code: 'ERR_ENGINEX_TEMPLATE_LIMIT' });
  }
  const root = getRoot(options);
  const name = options.templateName ?? '__enginex_inline__.html';
  if (typeof name !== 'string' || name.trim() === '' || path.isAbsolute(name)) {
    throw new TypeError('templateName must be a non-empty relative path.');
  }
  const virtualPath = path.resolve(root, ensureExtension(name));
  if (options.strictPaths !== false && !withinRoot(root, virtualPath)) {
    throw new TemplateError('Inline templateName escapes the configured root.', { code: 'ERR_ENGINEX_PATH_OUTSIDE_ROOT', templatePath: name });
  }
  assertOutputContexts(source, options, virtualPath);
  const compiled = compileTemplate(source, virtualPath, limits);
  if (containsLegacyCode(compiled.nodes)) {
    throw new TemplateError('Legacy <?njs ... ?> blocks are disabled by safe inline rendering.', { code: 'ERR_ENGINEX_UNSAFE_CODE_DISABLED', templatePath: virtualPath });
  }
  const locals = getStateLocals(options, limits);
  const state = makeState(options, limits, locals);
  return renderNodes(compiled.nodes, virtualPath, state);
}

function getOutputContextDiagnostics(source) {
  if (typeof source !== 'string' || !source.includes('{{')) return [];

  const diagnostics = [];
  const tokenPattern = /{{{?[\s\S]*?}}}?/g;
  const state = {
    inTag: false,
    quote: '',
    inScript: false,
    inStyle: false,
    tagChars: []
  };
  let scanOffset = 0;
  let match;

  // Advance context state exactly once over ordinary template text. This avoids
  // repeatedly slicing the entire source prefix for each interpolation.
  function advanceContext(endOffset) {
    for (let index = scanOffset; index < endOffset; index++) {
      const character = source[index];
      if (!state.inTag) {
        if (character === '<') {
          state.inTag = true;
          state.quote = '';
          state.tagChars = ['<'];
        }
        continue;
      }

      state.tagChars.push(character);
      if (state.quote) {
        if (character === state.quote) state.quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        state.quote = character;
        continue;
      }
      if (character === '>') {
        const tag = state.tagChars.join('').toLowerCase();
        const closing = /^<\s*\//.test(tag);
        if (/^<\s*\/?\s*script\b/.test(tag)) state.inScript = !closing;
        if (/^<\s*\/?\s*style\b/.test(tag)) state.inStyle = !closing;
        state.inTag = false;
        state.quote = '';
        state.tagChars = [];
      }
    }
    scanOffset = endOffset;
  }

  while ((match = tokenPattern.exec(source))) {
    advanceContext(match.index);
    const token = match[0];
    const offset = match.index;

    // Template comments and structural directives aren't output expressions.
    if (token.startsWith('{{!--') || token.startsWith('{{!') || /^{{\s*(?:#|\/|>|\^|else\b)/.test(token)) {
      scanOffset = match.index + token.length;
      continue;
    }

    const currentTag = state.inTag ? state.tagChars.join('') : '';
    const insideTag = state.inTag;
    const raw = token.startsWith('{{{');
    const expression = raw ? token.slice(3, -3).trim() : token.slice(2, -2).trim();
    const usesJsonScript = raw && /^jsonScript\s*\([\s\S]*\)$/.test(expression);
    const usesSafeUrl = /^(?:safeUrl)\s*\([\s\S]*\)$/.test(expression);
    const add = (code, message, suggestion) => diagnostics.push({ code, severity: 'warning', message, suggestion, offset });

    if (state.inScript && !usesJsonScript) {
      add('WARN_ENGINEX_SCRIPT_CONTEXT', 'Interpolation inside <script> is not JavaScript-context escaped.', 'Move dynamic data outside the script or use raw output from the built-in jsonScript() helper for a complete JSON value.');
    }
    if (state.inStyle) {
      add('WARN_ENGINEX_STYLE_CONTEXT', 'Interpolation inside <style> is not CSS-context escaped.', 'Keep dynamic values out of CSS source or validate and encode them for the exact CSS property.');
    }
    if (insideTag && /\bon[a-z][\w:-]*\s*=\s*(?:"[^"]*|'[^']*|[^\s>]*)$/i.test(currentTag)) {
      add('WARN_ENGINEX_EVENT_HANDLER_CONTEXT', 'Interpolation appears in an inline event-handler attribute.', 'Avoid inline event handlers; attach events from trusted JavaScript instead.');
    }
    if (insideTag && /\bstyle\s*=\s*(?:"[^"]*|'[^']*|[^\s>]*)$/i.test(currentTag)) {
      add('WARN_ENGINEX_STYLE_ATTRIBUTE_CONTEXT', 'Interpolation appears in a style attribute and generic HTML escaping is not CSS validation.', 'Use a fixed CSS class or a strict allow-list of CSS values.');
    }
    if (insideTag && !usesSafeUrl && /\b(?:href|src|action|formaction|xlink:href)\s*=\s*(?:"[^"]*|'[^']*|[^\s>]*)$/i.test(currentTag)) {
      add('WARN_ENGINEX_URL_CONTEXT', 'Interpolation appears in a URL-valued attribute; HTML escaping alone does not validate URL schemes.', "Use the built-in safeUrl() helper and separately enforce the application's destination policy.");
    }
    if (raw && !usesJsonScript) {
      add('WARN_ENGINEX_RAW_OUTPUT', 'Raw interpolation bypasses ordinary HTML escaping and requires explicitly trusted output.', 'Use escaped interpolation unless the value is branded safe HTML from a trusted/sanitized source.');
    }
    scanOffset = match.index + token.length;
  }
  return diagnostics;
}

function assertOutputContexts(source, options, templatePath) {
  if (options.strictOutputContexts !== true) return;
  const diagnostics = getOutputContextDiagnostics(source);
  if (!diagnostics.length) return;
  const first = diagnostics[0];
  throw new TemplateError(`${first.message} ${first.suggestion}`, {
    code: 'ERR_ENGINEX_UNSAFE_OUTPUT_CONTEXT', templatePath
  });
}

function analyzeSource(source, options = {}) {
  const diagnostics = [];
  const helperNames = new Set(Object.keys(BUILTIN_HELPERS));
  if (options.helpers && isPlainObject(options.helpers)) {
    for (const [name, fn] of Object.entries(options.helpers)) if (typeof fn === 'function') helperNames.add(name);
  }
  const dataReferences = new Set();
  const helperCalls = new Set();
  const filters = new Set();
  const partials = new Set();
  const layouts = new Set();
  const blocks = new Set();
  const features = new Set();
  let compiled;

  if (typeof source !== 'string') {
    return { valid: false, diagnostics: [{ code: 'ERR_ENGINEX_SOURCE_TYPE', severity: 'error', message: 'Template source must be a string.' }], dataReferences: [], helperCalls: [], filters: [], partials: [], layouts: [], blocks: [], features: [] };
  }

  const limits = mergeLimits(options);
  if (Buffer.byteLength(source, 'utf8') > limits.maxTemplateBytes) {
    return { valid: false, diagnostics: [{ code: 'ERR_ENGINEX_TEMPLATE_LIMIT', severity: 'error', message: `Template exceeds maxTemplateBytes (${limits.maxTemplateBytes}).` }], dataReferences: [], helperCalls: [], filters: [], partials: [], layouts: [], blocks: [], features: [] };
  }

  try {
    compiled = compileTemplate(source, options.templateName || '<inline>', limits);
  } catch (error) {
    return {
      valid: false,
      diagnostics: [{ code: error.code || 'ERR_ENGINEX_TEMPLATE_SYNTAX', severity: 'error', message: error.message, ...(Number.isInteger(error.line) ? { line: error.line } : {}), ...(Number.isInteger(error.column) ? { column: error.column } : {}) }],
      dataReferences: [], helperCalls: [], filters: [], partials: [], layouts: [], blocks: [], features: []
    };
  }

  function rootReferenceName(node) {
    const properties = [];
    let current = node;
    while (current && current.type === 'member') {
      let propertyName;
      if (!current.computed && typeof current.property === 'string') propertyName = current.property;
      else if (current.computed && current.property && current.property.type === 'literal' && typeof current.property.value === 'string') propertyName = current.property.value;
      else return null;
      properties.push(propertyName);
      current = current.object;
    }
    if (current && current.type === 'identifier' && current.name === '@root' && properties.length) return properties[properties.length - 1];
    return null;
  }

  function visitExpression(node, parent = null, aliases = new Set()) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'member') {
      const rootName = rootReferenceName(node);
      if (rootName && !aliases.has(rootName)) dataReferences.add(rootName);
    }
    if (node.type === 'identifier') {
      if (parent && parent.type === 'call' && parent.callee === node) return;
      if (!aliases.has(node.name) && !['this', '@root', '@index', '@key', '@first', '@last'].includes(node.name)) dataReferences.add(node.name);
      return;
    }
    if (node.type === 'call') {
      if (node.callee && node.callee.type === 'identifier') {
        helperCalls.add(node.callee.name);
        if (!helperNames.has(node.callee.name)) diagnostics.push({ code: 'ERR_ENGINEX_UNKNOWN_HELPER', severity: 'error', message: `Unknown template helper "${node.callee.name}". Register it in the helper allow-list.`, helper: node.callee.name });
      } else {
        diagnostics.push({ code: 'ERR_ENGINEX_CALL_NOT_HELPER', severity: 'error', message: 'Only direct calls to explicitly registered helpers are supported.' });
      }
    }
    if (node.type === 'filter') {
      filters.add(node.name);
      helperCalls.add(node.name);
      if (!helperNames.has(node.name)) diagnostics.push({ code: 'ERR_ENGINEX_UNKNOWN_HELPER', severity: 'error', message: `Unknown template filter "${node.name}". Register it in the helper allow-list.`, helper: node.name });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'callee' && node.type === 'call') continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && typeof child.type === 'string') visitExpression(child, node, aliases);
          else if (key === 'properties' && child && child.value) visitExpression(child.value, node, aliases);
        }
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        visitExpression(value, node, aliases);
      }
    }
    if (node.type === 'call' && node.callee) visitExpression(node.callee, node, aliases);
  }

  function visitNodes(nodes, aliases = new Set()) {
    for (const node of nodes || []) {
      if (node.type === 'interpolation') {
        features.add(node.raw ? 'raw-interpolation' : 'escaped-interpolation');
        visitExpression(node.expression, null, aliases);
      } else if (node.type === 'if' || node.type === 'unless') {
        features.add('conditionals');
        visitExpression(node.expression, null, aliases);
        visitNodes(node.children, aliases);
        visitNodes(node.alternate, aliases);
      } else if (node.type === 'each') {
        features.add('loops');
        visitExpression(node.expression, null, aliases);
        const loopAliases = new Set(aliases);
        loopAliases.add(node.itemName);
        loopAliases.add(node.indexName);
        for (const builtin of ['@index', '@key', '@first', '@last']) loopAliases.add(builtin);
        visitNodes(node.children, loopAliases);
        visitNodes(node.alternate, aliases);
      } else if (node.type === 'with') {
        features.add('context-aliases');
        visitExpression(node.expression, null, aliases);
        const contextAliases = new Set(aliases);
        contextAliases.add(node.alias);
        visitNodes(node.children, contextAliases);
      } else if (node.type === 'partial') {
        features.add('partials');
        partials.add(node.name);
        if (node.context) visitExpression(node.context, null, aliases);
      } else if (node.type === 'extends') {
        features.add('layouts');
        layouts.add(node.name);
        visitNodes(node.children, aliases);
      } else if (node.type === 'fragment') {
        features.add('incremental-fragments');
        blocks.add(`fragment:${node.name}`);
        visitNodes(node.children, aliases);
      } else if (node.type === 'block') {
        features.add('blocks');
        blocks.add(node.name);
        visitNodes(node.children, aliases);
      } else if (node.type === 'legacy') {
        diagnostics.push({ code: 'ERR_ENGINEX_UNSAFE_CODE_DISABLED', severity: 'error', message: 'Legacy <?njs ?> blocks execute JavaScript and are not supported by the safe engine.' });
      }
    }
  }

  visitNodes(compiled.nodes);
  diagnostics.push(...getOutputContextDiagnostics(source).map(item => ({ ...item, severity: options.strictOutputContexts === true ? 'error' : 'warning' })));
  if (source.includes('{{!--') || /{{![\s\S]*?}}/.test(source)) features.add('comments');
  if (source.includes('|')) features.add('filter-pipelines');
  const errors = diagnostics.filter(item => item.severity === 'error');
  return {
    valid: errors.length === 0,
    diagnostics,
    nodeCount: compiled.nodeCount,
    dataReferences: [...dataReferences].sort(),
    helperCalls: [...helperCalls].sort(),
    filters: [...filters].sort(),
    partials: [...partials].sort(),
    layouts: [...layouts].sort(),
    blocks: [...blocks].sort(),
    features: [...features].sort(),
    grammarVersion: 'enginex-template-1'
  };
}

engine.render = render;
engine.renderStream = renderStream;
function createLoadedTemplate(bundle, templateName, flags = {}) {
  const loaded = {
    name: templateName,
    path: bundle.rootPath,
    rendererKind: flags.rendererKind || 'compiled-sync',
    fragments: bundle.fragments.map(({ id, dependencies, alwaysDirty, helpers }) => ({ id, dependencies, alwaysDirty, helpers })),
    render(locals = bundle.options.locals ?? Object.create(null), renderOptions = {}) {
      return renderCompiledBundle(bundle, locals, renderOptions).html;
    },
    prepareData(data, dataOptions = {}) {
      return prepareData(data, { ...bundle.options, ...dataOptions });
    },
    renderPrepared(prepared, renderOptions = {}) {
      if (!prepared || typeof prepared !== 'object' || !PREPARED_DATA.has(prepared)) throw new TypeError('renderPrepared requires a value returned by prepareData().');
      return renderCompiledBundle(bundle, prepared, renderOptions).html;
    },
    renderAsync(locals = bundle.options.locals ?? Object.create(null), renderOptions = {}) {
      if (flags.precompiledManifest) throw new TemplateError('The AST manifest renderer is synchronous; use render() or load source templates for async helpers.', { code: 'ERR_ENGINEX_PRECOMPILED_ASYNC_UNAVAILABLE' });
      return render(bundle.rootPath, { ...bundle.options, ...renderOptions, locals });
    },
    renderStream(locals = bundle.options.locals ?? Object.create(null), renderOptions = {}) {
      if (flags.precompiledManifest) throw new TemplateError('The AST manifest renderer emits compiled synchronous output; use render() for this artifact.', { code: 'ERR_ENGINEX_PRECOMPILED_STREAM_UNAVAILABLE' });
      return renderStream(bundle.rootPath, { ...bundle.options, ...renderOptions, locals });
    },
    renderTo(locals = bundle.options.locals ?? Object.create(null), writable, renderOptions = {}) {
      if (flags.precompiledManifest) {
        const html = renderCompiledBundle(bundle, locals, renderOptions).html;
        return new Promise((resolve, reject) => { writable.write(html, error => error ? reject(error) : resolve()); });
      }
      return renderTo(bundle.rootPath, { ...bundle.options, ...renderOptions, locals }, writable);
    },
    createIncrementalSession() {
      return createIncrementalSession(bundle);
    }
  };
  return Object.freeze(loaded);
}

engine.load = async function load(templateName, options = {}) {
  const bundle = await loadTemplateBundle(templateName, options);
  return createLoadedTemplate(bundle, templateName);
};

const MANIFEST_FORMAT = 'enginex-precompiled-ast-v1';
const TEMPLATE_AST_TYPES = new Set(['text', 'interpolation', 'if', 'unless', 'each', 'with', 'partial', 'extends', 'block', 'fragment', 'legacy']);
const EXPRESSION_AST_TYPES = new Set(['literal', 'identifier', 'array', 'object', 'unary', 'member', 'call', 'filter', 'conditional', 'binary']);

async function walkTemplateFiles(rootDirectory, output = []) {
  for (const entry of await fsp.readdir(rootDirectory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
    const full = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) await walkTemplateFiles(full, output);
    else if (entry.isFile() && /\.html?$/i.test(entry.name)) output.push(full);
    // Symlinks are intentionally not followed while discovering templates.
  }
  return output;
}

function manifestTemplateId(rootDirectory, fullPath) {
  const relative = path.relative(rootDirectory, fullPath).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative) || relative.includes('\0')) {
    throw new TemplateError('Template path cannot be represented safely in a precompiled manifest.', { code: 'ERR_ENGINEX_MANIFEST_PATH' });
  }
  return relative;
}

function validateManifestId(id) {
  return typeof id === 'string' && id.length > 0 && !id.includes('\0') && !id.includes('\\') && !path.posix.isAbsolute(id) && !id.split('/').some(part => part === '..' || part === '.');
}

function validateManifestNodes(nodes, limits) {
  if (!Array.isArray(nodes)) throw new TemplateError('Manifest template AST must be an array.', { code: 'ERR_ENGINEX_MANIFEST_AST' });
  let count = 0;
  const seen = new WeakSet();
  function visit(value, depth = 0) {
    if (depth > limits.maxBlockDepth + limits.maxExpressionDepth + 16) throw new TemplateError('Manifest AST nesting limit exceeded.', { code: 'ERR_ENGINEX_MANIFEST_LIMIT' });
    if (typeof value === 'string') {
      if (value.length > limits.maxTemplateBytes) throw new TemplateError('Manifest AST string exceeds limit.', { code: 'ERR_ENGINEX_MANIFEST_LIMIT' });
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) throw new TemplateError('Manifest AST must not contain cycles.', { code: 'ERR_ENGINEX_MANIFEST_AST' });
    seen.add(value);
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); seen.delete(value); return; }
    if (typeof value.type === 'string') {
      count++;
      if (count > limits.maxNodes) throw new TemplateError('Manifest AST node limit exceeded.', { code: 'ERR_ENGINEX_MANIFEST_LIMIT' });
      if (!TEMPLATE_AST_TYPES.has(value.type) && !EXPRESSION_AST_TYPES.has(value.type)) throw new TemplateError(`Unknown manifest AST node type ${value.type}.`, { code: 'ERR_ENGINEX_MANIFEST_AST' });
      if (value.type === 'legacy') throw new TemplateError('Unsafe legacy template nodes are not allowed in compiled manifests.', { code: 'ERR_ENGINEX_UNSAFE_CODE_DISABLED' });
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
    seen.delete(value);
  }
  visit(nodes);
  return count;
}

engine.buildManifest = async function buildManifest(rootDirectory, options = {}) {
  if (typeof rootDirectory !== 'string' || !rootDirectory) throw new TypeError('rootDirectory must be a directory path.');
  const realRoot = await fsp.realpath(path.resolve(rootDirectory));
  const files = (options.templates || await walkTemplateFiles(realRoot)).map(file => path.isAbsolute(file) ? file : path.resolve(realRoot, file));
  if (files.length === 0) throw new TemplateError('No .html or .htm templates were found.', { code: 'ERR_ENGINEX_MANIFEST_EMPTY' });
  const templateRecords = new Map();
  const dependencyRecords = new Map();
  const buildOptions = { ...options, root: realRoot, views: realRoot, cache: true, allowUnsafeCode: false };
  for (const file of files) {
    const entryId = manifestTemplateId(realRoot, await fsp.realpath(file));
    const bundle = await loadTemplateBundle(entryId, buildOptions);
    for (const [absolute, record] of bundle.templates) {
      const id = manifestTemplateId(realRoot, absolute);
      if (!templateRecords.has(id)) {
        const sourceText = await fsp.readFile(absolute, 'utf8');
        templateRecords.set(id, { id, sourceHash: createHash('sha256').update(sourceText, 'utf8').digest('hex'), nodes: record.ast });
      }
    }
    for (const [key, target] of bundle.dependencyPaths) {
      const [parent, type, name] = key.split('\0');
      const edge = { parent: manifestTemplateId(realRoot, parent), type, name, target: manifestTemplateId(realRoot, target) };
      dependencyRecords.set(`${edge.parent}\0${edge.type}\0${edge.name}`, edge);
    }
  }
  const entryCandidate = options.entry ? ensureExtension(options.entry).replace(/\\/g, '/') : manifestTemplateId(realRoot, files.slice().sort()[0]);
  if (!validateManifestId(entryCandidate) || !templateRecords.has(entryCandidate)) throw new TemplateError(`Manifest entry template not found: ${entryCandidate}`, { code: 'ERR_ENGINEX_MANIFEST_ENTRY' });
  return {
    format: MANIFEST_FORMAT,
    engineVersion: VERSION,
    entry: entryCandidate,
    templates: [...templateRecords.values()].sort((a, b) => a.id.localeCompare(b.id)),
    dependencies: [...dependencyRecords.values()].sort((a, b) => `${a.parent}\0${a.type}\0${a.name}`.localeCompare(`${b.parent}\0${b.type}\0${b.name}`)),
    grammarVersion: 'enginex-template-1',
    build: { templateCount: templateRecords.size, dependencyCount: dependencyRecords.size, kind: 'validated-ast-manifest', reproducible: true }
  };
};

engine.writeManifest = async function writeManifest(rootDirectory, outputPath, options = {}) {
  const manifest = await engine.buildManifest(rootDirectory, options);
  const fullOutput = path.resolve(outputPath);
  await fsp.mkdir(path.dirname(fullOutput), { recursive: true });
  const temporary = `${fullOutput}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fsp.rename(temporary, fullOutput);
  return { path: fullOutput, ...manifest.build };
};

engine.loadPrecompiled = async function loadPrecompiled(manifestPath, options = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath) throw new TypeError('manifestPath must be a JSON file path.');
  const fullPath = path.resolve(manifestPath);
  const stat = await fsp.stat(fullPath);
  const maxManifestBytes = options.maxManifestBytes ?? 64 * 1024 * 1024;
  if (stat.size > maxManifestBytes) throw new TemplateError('Precompiled manifest exceeds maxManifestBytes.', { code: 'ERR_ENGINEX_MANIFEST_LIMIT' });
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(fullPath, 'utf8')); }
  catch (cause) { throw new TemplateError('Unable to parse precompiled manifest JSON.', { code: 'ERR_ENGINEX_MANIFEST_JSON', cause }); }
  if (!manifest || manifest.format !== MANIFEST_FORMAT || manifest.engineVersion !== VERSION || !Array.isArray(manifest.templates) || !Array.isArray(manifest.dependencies)) {
    throw new TemplateError('Unsupported or incompatible precompiled manifest.', { code: 'ERR_ENGINEX_MANIFEST_VERSION' });
  }
  const limits = mergeLimits(options);
  if (manifest.templates.length > limits.cacheMaxEntries * 20) throw new TemplateError('Manifest contains too many templates.', { code: 'ERR_ENGINEX_MANIFEST_LIMIT' });
  const templates = new Map();
  for (const item of manifest.templates) {
    if (!item || !validateManifestId(item.id) || templates.has(item.id)) throw new TemplateError('Invalid or duplicate template id in manifest.', { code: 'ERR_ENGINEX_MANIFEST_PATH' });
    if (item.sourceHash !== undefined && (typeof item.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.sourceHash))) throw new TemplateError('Invalid sourceHash in precompiled manifest.', { code: 'ERR_ENGINEX_MANIFEST_HASH' });
    validateManifestNodes(item.nodes, limits);
    const ast = item.nodes;
    templates.set(item.id, { path: item.id, ast, renderer: compileRenderer(ast, item.id) });
  }
  const entry = options.entry ? ensureExtension(options.entry).replace(/\\/g, '/') : manifest.entry;
  if (!validateManifestId(entry) || !templates.has(entry)) throw new TemplateError(`Entry is missing from precompiled manifest: ${entry}`, { code: 'ERR_ENGINEX_MANIFEST_ENTRY' });
  const dependencyPaths = new Map();
  for (const dependency of manifest.dependencies) {
    if (!dependency || !validateManifestId(dependency.parent) || !templates.has(dependency.parent) || !validateManifestId(dependency.target) || !templates.has(dependency.target) || !['partial', 'layout'].includes(dependency.type) || typeof dependency.name !== 'string' || dependency.name.includes('\0')) {
      throw new TemplateError('Invalid dependency in precompiled manifest.', { code: 'ERR_ENGINEX_MANIFEST_DEPENDENCY' });
    }
    dependencyPaths.set(`${dependency.parent}\0${dependency.type}\0${dependency.name}`, dependency.target);
  }
  const bundle = { rootPath: entry, options: { ...options }, limits, helpers: createHelpers(options), templates, dependencyPaths };
  bundle.fragments = collectFragmentDefinitions(templates.get(entry).ast, entry, options.pureHelpers);
  bundle.dependencyGraph = new FragmentDependencyGraph(bundle.fragments);
  return createLoadedTemplate(bundle, entry, { rendererKind: 'compiled-manifest', precompiledManifest: true });
};
engine.renderSync = async function renderSync(templateName, options = {}) {
  const loaded = await engine.load(templateName, options);
  return loaded.render(options.locals ?? Object.create(null));
};
engine.compileSource = function compileSource(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('Template source must be a string.');
  if (options.allowUnsafeCode) throw new TemplateError('Safe source compilation does not permit legacy JavaScript.', { code: 'ERR_ENGINEX_UNSAFE_API' });
  const limits = mergeLimits(options);
  if (Buffer.byteLength(source, 'utf8') > limits.maxTemplateBytes) throw new TemplateError(`Template exceeds maxTemplateBytes (${limits.maxTemplateBytes}).`, { code: 'ERR_ENGINEX_TEMPLATE_LIMIT' });
  const templatePath = path.resolve(getRoot(options), ensureExtension(options.templateName || '__enginex_inline__.html'));
  if (options.strictPaths !== false && !withinRoot(getRoot(options), templatePath)) throw new TemplateError('Inline template path escapes the configured root.', { code: 'ERR_ENGINEX_PATH_OUTSIDE_ROOT' });
  assertOutputContexts(source, options, templatePath);
  const compiled = compileTemplate(source, templatePath, limits);
  if (containsLegacyCode(compiled.nodes)) throw new TemplateError('Safe source compilation does not permit legacy JavaScript.', { code: 'ERR_ENGINEX_UNSAFE_CODE_DISABLED' });
  const renderer = compileRenderer(compiled.nodes, templatePath);
  const inlineBundle = { rootPath: templatePath, options: { ...options }, limits, helpers: createHelpers(options), templates: new Map([[templatePath, { path: templatePath, ast: compiled.nodes, renderer }]]), dependencyPaths: new Map(), fragments: [], dependencyGraph: new FragmentDependencyGraph([]) };
  return Object.freeze({
    templateName: options.templateName || '<inline>',
    nodeCount: compiled.nodeCount,
    render(data = Object.create(null), renderOptions = {}) {
      return renderCompiledBundle(inlineBundle, data, renderOptions).html;
    },
    prepareData(data, dataOptions = {}) { return prepareData(data, { ...options, ...dataOptions }); },
    renderPrepared(prepared, renderOptions = {}) {
      if (!prepared || typeof prepared !== 'object' || !PREPARED_DATA.has(prepared)) throw new TypeError('renderPrepared requires a value returned by prepareData().');
      return renderCompiledBundle(inlineBundle, prepared, renderOptions).html;
    }
  });
};
engine.renderTo = renderTo;
engine.renderSource = renderSource;
engine.renderSourceStream = renderSourceStream;
engine.analyzeSource = analyzeSource;
engine.validateSource = analyzeSource;
engine.analyzeOutputContexts = getOutputContextDiagnostics;
engine.getBuiltinHelpers = () => Object.keys(BUILTIN_HELPERS).sort();
engine.precompile = async (templateName, options = {}) => {
  if (options.allowUnsafeCode) throw new TemplateError('Unsafe legacy templates cannot be precompiled by the safe engine.', { code: 'ERR_ENGINEX_UNSAFE_API' });
  const limits = mergeLimits(options);
  const templatePath = await resolveRootPath(templateName, options);
  const ast = await loadTemplateAst(templatePath, options, limits);
  if (containsLegacyCode(ast)) throw new TemplateError('Legacy <?njs ?> blocks are disabled by the safe precompiler.', { code: 'ERR_ENGINEX_UNSAFE_CODE_DISABLED', templatePath });
  return templatePath;
};
engine.clearCache = function clearCache(templateName) {
  cacheGeneration++;
  if (!templateName) { AST_CACHE.clear(); IN_FLIGHT.clear(); return; }
  IN_FLIGHT.clear();
  const absolute = path.resolve(templateName);
  for (const key of AST_CACHE.keys()) if (key.startsWith(`${absolute}\0`)) AST_CACHE.delete(key);
  try {
    const real = fs.realpathSync(absolute);
    for (const key of AST_CACHE.keys()) if (key.startsWith(`${real}\0`)) AST_CACHE.delete(key);
  } catch { /* file may have been removed */ }
};
engine.cacheStats = () => ({ ...CACHE_STATS, renderersCompiled: RENDER_STATS.compiledRenderers, syncRenders: RENDER_STATS.syncRenders, incrementalPatches: RENDER_STATS.incrementalPatches, formatterCacheSize: FORMATTER_CACHE.size, size: AST_CACHE.size, inFlight: IN_FLIGHT.size });
engine.DirtyBitSet = DirtyBitSet;
engine.FragmentDependencyGraph = FragmentDependencyGraph;
engine.pathMatchesDependency = pathMatchesDependency;

function containsLegacyCode(nodes) {
  for (const node of nodes) {
    if (node.type === 'legacy') return true;
    if (node.children && containsLegacyCode(node.children)) return true;
    if (node.alternate && containsLegacyCode(node.alternate)) return true;
  }
  return false;
}
engine.prepareData = (data, options = {}) => prepareData(data, options);
engine.createReactiveModel = (data, options = {}) => createReactiveModel(data, options);
engine.getPerformanceProfiles = () => describeProfiles();
engine.renderRequestSchema = RENDER_REQUEST_SCHEMA;
engine.normalizeRenderRequest = normalizeRenderRequest;
engine.renderRequest = async function renderRequest(input) {
  const request = normalizeRenderRequest(input);
  const options = { ...request.options, locals: request.data, profile: request.profile, traceId: request.traceId, telemetry: true };
  if (request.mode === 'stream') {
    return Object.freeze({ requestId: request.requestId, traceId: request.traceId, mode: request.mode, stream: engine.renderStream(request.template, options) });
  }
  if (request.mode === 'sync') {
    const loaded = await engine.load(request.template, options);
    return Object.freeze({ requestId: request.requestId, traceId: request.traceId, mode: request.mode, html: loaded.render(request.data, { profile: request.profile, telemetry: true, traceId: request.traceId, onMetric: request.options.onMetric }) });
  }
  const html = await engine(request.template, options);
  return Object.freeze({ requestId: request.requestId, traceId: request.traceId, mode: request.mode, html });
};
engine.telemetryStats = () => ({ ...TELEMETRY, byMode: Object.fromEntries(Object.entries(TELEMETRY.byMode).map(([key, value]) => [key, { ...value }])) });
engine.resetTelemetry = () => {
  TELEMETRY.enabledRenders = 0; TELEMETRY.renders = 0; TELEMETRY.errors = 0;
  TELEMETRY.totalDurationMs = 0; TELEMETRY.maxDurationMs = 0; TELEMETRY.outputBytes = 0;
  for (const key of Object.keys(TELEMETRY.byMode)) delete TELEMETRY.byMode[key];
};
engine.safeHtml = safeHtml;
engine.escapeHtml = escapeHtml;
engine.TemplateError = TemplateError;
engine.version = VERSION;
engine.__engine = engine;
engine.__express = engine;
engine.unsafe = function unsafe(templateName, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  return engine(templateName, { ...(options || {}), allowUnsafeCode: true }, callback);
};

module.exports = engine;
