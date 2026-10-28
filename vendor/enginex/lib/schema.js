'use strict';

const { types: utilTypes } = require('node:util');

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const FORMATS = new Set(['date-time', 'date', 'time', 'email', 'hostname', 'ipv4', 'ipv6', 'uri', 'uri-reference']);
const ALLOWED_KEYWORDS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties']);
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor', 'caller', 'callee', 'arguments']);

class SchemaDefinitionError extends TypeError {
  constructor(message) { super(message); this.name = 'SchemaDefinitionError'; this.code = 'ERR_ENGINEX_SCHEMA_DEFINITION'; }
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function safeValue(object, key, fallback) {
  if (!isRecord(object)) return fallback;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return fallback;
  if (!Object.hasOwn(descriptor, 'value')) throw new SchemaDefinitionError(`Schema keyword "${key}" must be a data property.`);
  return descriptor.value;
}
function primitiveType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}
function matchesType(value, type) {
  const actual = primitiveType(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'integer') return actual === 'integer';
  return actual === type;
}
function issue(path, keyword, message) { return { path: path || '/', keyword, message }; }
function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
function validateSchemaDefinition(schema) {
  if (!isRecord(schema)) throw new SchemaDefinitionError('Data schema must be a plain JSON Schema object.');
  let count = 0;
  const seen = new WeakSet();
  function walk(current, depth) {
    if (depth > 40) throw new SchemaDefinitionError('Schema depth exceeds 40.');
    if (!isRecord(current)) throw new SchemaDefinitionError('Schema nodes must be plain objects.');
    if (seen.has(current)) throw new SchemaDefinitionError('Circular schema definitions are not permitted.');
    seen.add(current);
    if (++count > 5000) throw new SchemaDefinitionError('Schema exceeds 5000 nodes.');
    const keys = Object.keys(current);
    for (const key of keys) {
      if (DANGEROUS.has(key)) throw new SchemaDefinitionError(`Dangerous schema key "${key}" is not allowed.`);
      if (!ALLOWED_KEYWORDS.has(key)) throw new SchemaDefinitionError(`Unsupported JSON Schema keyword "${key}". Use only documented EnginEx-supported keywords or install a full JSON Schema validator.`);
      const d = Object.getOwnPropertyDescriptor(current, key);
      if (!d || !Object.hasOwn(d, 'value')) throw new SchemaDefinitionError(`Accessor schema keyword "${key}" is not permitted.`);
    }
    const type = safeValue(current, 'type', undefined);
    if (type !== undefined) {
      const list = Array.isArray(type) ? type : [type];
      if (!list.length || list.some(item => !TYPES.has(item))) throw new SchemaDefinitionError('Unsupported JSON Schema type.');
    }
    if (safeValue(current, '$ref', undefined) !== undefined || safeValue(current, '$dynamicRef', undefined) !== undefined) {
      throw new SchemaDefinitionError('$ref and $dynamicRef are not supported by the dependency-free validator. Inline the schema instead.');
    }
    for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
      const value = safeValue(current, keyword, undefined);
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw new SchemaDefinitionError(`Schema "${keyword}" must be a finite number.`);
    }
    for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
      const value = safeValue(current, keyword, undefined);
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new SchemaDefinitionError(`Schema "${keyword}" must be a non-negative safe integer.`);
    }
    const required = safeValue(current, 'required', undefined);
    if (required && (required.some(item => typeof item !== 'string') || new Set(required).size !== required.length)) throw new SchemaDefinitionError('Schema "required" must contain unique string property names.');
    const enumValues = safeValue(current, 'enum', undefined);
    if (enumValues && enumValues.length === 0) throw new SchemaDefinitionError('Schema "enum" must not be empty.');
    const properties = safeValue(current, 'properties', undefined);
    if (properties !== undefined) {
      if (!isRecord(properties)) throw new SchemaDefinitionError('Schema "properties" must be an object.');
      for (const key of Object.keys(properties)) walk(safeValue(properties, key), depth + 1);
    }
    const items = safeValue(current, 'items', undefined);
    if (items !== undefined) walk(items, depth + 1);
    const additional = safeValue(current, 'additionalProperties', undefined);
    if (isRecord(additional)) walk(additional, depth + 1);
    for (const keyword of ['enum', 'required']) {
      const value = safeValue(current, keyword, undefined);
      if (value !== undefined && !Array.isArray(value)) throw new SchemaDefinitionError(`Schema "${keyword}" must be an array.`);
    }
    const format = safeValue(current, 'format', undefined);
    if (format !== undefined && !FORMATS.has(format)) throw new SchemaDefinitionError(`Unsupported format "${format}".`);
    const pattern = safeValue(current, 'pattern', undefined);
    if (pattern !== undefined) {
      if (typeof pattern !== 'string' || pattern.length > 256) throw new SchemaDefinitionError('Schema pattern must be a string of at most 256 characters.');
      // Avoid the most common catastrophic-backtracking constructions. Use a
      // full JSON Schema implementation for untrusted or complex schema sources.
      if (/\([^)]*[+*][^)]*\)[+*{]|\([^)]*\|[^)]*\)[+*{]|\\[1-9]/.test(pattern)) {
        throw new SchemaDefinitionError('Schema pattern contains a potentially expensive regular expression.');
      }
      try { new RegExp(pattern, 'u'); } catch { throw new SchemaDefinitionError('Schema pattern is not a valid regular expression.'); }
    }
    seen.delete(current);
  }
  walk(schema, 0);
  return schema;
}

function validateData(data, schema, options = {}) {
  validateSchemaDefinition(schema);
  const maxIssues = Number.isSafeInteger(options.maxIssues) ? Math.max(1, Math.min(options.maxIssues, 1000)) : 100;
  const issues = [];
  const active = new WeakSet();

  function add(path, keyword, message) {
    if (issues.length < maxIssues) issues.push(issue(path, keyword, message));
  }
  function safeDataValue(object, key, pointer) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      add(pointer, 'data', 'Accessor properties are not allowed in template data.');
      return undefined;
    }
    return descriptor.value;
  }
  function visit(value, nodeSchema, pointer, depth) {
    if (issues.length >= maxIssues) return;
    if (depth > 40) { add(pointer, 'depth', 'Data/schema nesting exceeds 40.'); return; }
    if (value !== null && typeof value === 'object') {
      if (utilTypes.isProxy(value)) { add(pointer, 'data', 'Proxy objects are not allowed in template data.'); return; }
      if (active.has(value)) { add(pointer, 'data', 'Circular data is not valid JSON data.'); return; }
    }
    const schemaType = safeValue(nodeSchema, 'type', undefined);
    if (schemaType !== undefined) {
      const accepted = Array.isArray(schemaType) ? schemaType : [schemaType];
      if (!accepted.some(type => matchesType(value, type))) {
        add(pointer, 'type', `Expected ${accepted.join(' or ')}, received ${primitiveType(value)}.`);
        return;
      }
    }
    const enumValues = safeValue(nodeSchema, 'enum', undefined);
    if (enumValues && !enumValues.some(candidate => jsonEqual(value, candidate))) add(pointer, 'enum', 'Value is not one of the permitted enum values.');
    const constValue = safeValue(nodeSchema, 'const', undefined);
    if (constValue !== undefined && !jsonEqual(value, constValue)) add(pointer, 'const', 'Value does not match the required constant.');

    if (typeof value === 'string') {
      const length = Array.from(value).length;
      const min = safeValue(nodeSchema, 'minLength', undefined);
      const max = safeValue(nodeSchema, 'maxLength', undefined);
      if (min !== undefined && length < min) add(pointer, 'minLength', `String is shorter than ${min} characters.`);
      if (max !== undefined && length > max) add(pointer, 'maxLength', `String is longer than ${max} characters.`);
      const pattern = safeValue(nodeSchema, 'pattern', undefined);
      if (pattern && value.length <= 100_000 && !new RegExp(pattern, 'u').test(value)) add(pointer, 'pattern', 'String does not match the required pattern.');
      const format = safeValue(nodeSchema, 'format', undefined);
      if (format && !validFormat(value, format)) add(pointer, 'format', `String is not a valid ${format}.`);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      for (const [keyword, predicate, label] of [
        ['minimum', (a, b) => a >= b, 'at least'], ['maximum', (a, b) => a <= b, 'at most'],
        ['exclusiveMinimum', (a, b) => a > b, 'greater than'], ['exclusiveMaximum', (a, b) => a < b, 'less than']
      ]) {
        const bound = safeValue(nodeSchema, keyword, undefined);
        if (bound !== undefined && !predicate(value, bound)) add(pointer, keyword, `Number must be ${label} ${bound}.`);
      }
    }

    if (Array.isArray(value)) {
      active.add(value);
      const min = safeValue(nodeSchema, 'minItems', undefined);
      const max = safeValue(nodeSchema, 'maxItems', undefined);
      if (min !== undefined && value.length < min) add(pointer, 'minItems', `Array must contain at least ${min} items.`);
      if (max !== undefined && value.length > max) add(pointer, 'maxItems', `Array must contain at most ${max} items.`);
      if (safeValue(nodeSchema, 'uniqueItems', false) === true) {
        const serials = new Set();
        for (const item of value) {
          let serial; try { serial = JSON.stringify(item); } catch { serial = String(item); }
          if (serials.has(serial)) { add(pointer, 'uniqueItems', 'Array items must be unique.'); break; }
          serials.add(serial);
        }
      }
      const itemSchema = safeValue(nodeSchema, 'items', undefined);
      if (itemSchema) {
        const limit = Math.min(value.length, 100_000);
        for (let i = 0; i < limit; i++) visit(safeDataValue(value, String(i), `${pointer}/${i}`), itemSchema, `${pointer}/${i}`, depth + 1);
      }
      active.delete(value);
      return;
    }

    if (isRecord(value)) {
      active.add(value);
      const keys = Object.keys(value);
      const required = safeValue(nodeSchema, 'required', undefined) || [];
      for (const key of required) if (!Object.hasOwn(value, key)) add(`${pointer}/${escapePointer(key)}`, 'required', `Required property "${key}" is missing.`);
      const properties = safeValue(nodeSchema, 'properties', undefined) || Object.create(null);
      const additional = safeValue(nodeSchema, 'additionalProperties', true);
      const min = safeValue(nodeSchema, 'minProperties', undefined);
      const max = safeValue(nodeSchema, 'maxProperties', undefined);
      if (min !== undefined && keys.length < min) add(pointer, 'minProperties', `Object must contain at least ${min} properties.`);
      if (max !== undefined && keys.length > max) add(pointer, 'maxProperties', `Object must contain at most ${max} properties.`);
      for (const key of keys) {
        if (DANGEROUS.has(key)) { add(`${pointer}/${escapePointer(key)}`, 'propertyName', 'Prototype-sensitive property names are not allowed.'); continue; }
        const childPath = `${pointer}/${escapePointer(key)}`;
        const childValue = safeDataValue(value, key, childPath);
        if (Object.hasOwn(properties, key)) visit(childValue, safeValue(properties, key), childPath, depth + 1);
        else if (additional === false) add(childPath, 'additionalProperties', `Property "${key}" is not defined by the schema.`);
        else if (isRecord(additional)) visit(childValue, additional, childPath, depth + 1);
      }
      active.delete(value);
      return;
    }
  }
  visit(data, schema, '', 0);
  return { valid: issues.length === 0, issues, truncated: issues.length >= maxIssues };
}

function validFormat(value, format) {
  switch (format) {
    case 'date-time': return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
    case 'time': return /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value);
    case 'email': return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'hostname': return value.length <= 253 && /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)(?:\.(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?))*$/i.test(value);
    case 'ipv4': return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(part => Number(part) <= 255);
    case 'ipv6': return value.includes(':') && /^[0-9a-f:]+$/i.test(value) && value.split('::').length <= 2;
    case 'uri': try { const u = new URL(value); return Boolean(u.protocol); } catch { return false; }
    case 'uri-reference': if (value === '') return true; try { new URL(value, 'https://example.invalid/'); return true; } catch { return false; }
    default: return true;
  }
}
function escapePointer(segment) { return String(segment).replace(/~/g, '~0').replace(/\//g, '~1'); }

module.exports = { validateData, validateSchemaDefinition, SchemaDefinitionError };
