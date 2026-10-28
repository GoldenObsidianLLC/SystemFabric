'use strict';

const NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const FIELD_RE = /^[a-z][A-Za-z0-9_]{0,62}$/;
const FIELD_TYPES = new Set(['string','number','boolean','date','enum','assetRef','relationRef','richDocument']);
const CAPABILITIES = new Set(['read','create','edit','submitForReview','publish','archive']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateContentTypeDefinition(definition) {
  const errors = [];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return { valid: false, errors: ['definition must be an object'] };
  if (definition.apiVersion !== 1) errors.push('apiVersion must be 1');
  if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) errors.push('name must be a valid lowercase slug');
  if (typeof definition.label !== 'string' || !definition.label.trim() || definition.label.length > 180) errors.push('label must be 1–180 characters');
  if (!['git','admin'].includes(definition.source)) errors.push('source must be git or admin');
  if (!Number.isInteger(definition.version) || definition.version < 1) errors.push('version must be a positive integer');
  if (!Array.isArray(definition.fields) || definition.fields.length > 200) errors.push('fields must be an array with at most 200 entries');
  else {
    const names = new Set();
    for (let i=0;i<definition.fields.length;i++) {
      const field = definition.fields[i]; const p = `fields[${i}]`;
      if (!field || typeof field !== 'object' || Array.isArray(field)) { errors.push(`${p} must be an object`); continue; }
      if (typeof field.name !== 'string' || !FIELD_RE.test(field.name)) errors.push(`${p}.name is invalid`);
      else if (names.has(field.name)) errors.push(`${p}.name is duplicated`); else names.add(field.name);
      if (!FIELD_TYPES.has(field.type)) errors.push(`${p}.type is invalid`);
      if (typeof field.required !== 'boolean') errors.push(`${p}.required must be boolean`);
      if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 100_000)) errors.push(`${p}.maxLength must be 1–100000`);
      if (field.type === 'enum' && (!Array.isArray(field.enum) || !field.enum.length || field.enum.length > 100 || field.enum.some(x => typeof x !== 'string' || x.length > 200))) errors.push(`${p}.enum must contain 1–100 strings`);
      if (field.default !== undefined && (typeof field.default === 'function' || (typeof field.default === 'object' && field.default !== null && Buffer.byteLength(JSON.stringify(field.default)) > 32_000))) errors.push(`${p}.default is not supported or is too large`);
    }
  }
  if (!Array.isArray(definition.capabilities) || definition.capabilities.some(c => !CAPABILITIES.has(c))) errors.push('capabilities contains unsupported values');
  if (!['author-can-publish','review-required','owner-only'].includes(definition.publicationPolicy)) errors.push('publicationPolicy is invalid');
  return { valid: errors.length === 0, errors };
}

function validateRecordValues(definition, values) {
  const errors = [];
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { valid: false, errors: ['values must be an object'] };
  const fields = Array.isArray(definition?.fields) ? definition.fields : [];
  const allowed = new Set(fields.map(field => field.name));
  for (const key of Object.keys(values)) if (!allowed.has(key)) errors.push(`Unknown field: ${key}`);
  for (const field of fields) {
    const value = values[field.name]; const exists = Object.hasOwn(values, field.name) && value !== null && value !== '';
    if (!exists) { if (field.required) errors.push(`${field.name} is required`); continue; }
    switch (field.type) {
      case 'string': if (typeof value !== 'string' || value.length > (field.maxLength || 20_000)) errors.push(`${field.name} must be a string up to ${field.maxLength || 20_000} characters`); break;
      case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${field.name} must be a finite number`); break;
      case 'boolean': if (typeof value !== 'boolean') errors.push(`${field.name} must be a boolean`); break;
      case 'date': if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value) || !Number.isFinite(Date.parse(value))) errors.push(`${field.name} must be an ISO date or datetime`); break;
      case 'enum': if (typeof value !== 'string' || !field.enum.includes(value)) errors.push(`${field.name} must be one of the configured enum values`); break;
      case 'assetRef': if (typeof value !== 'string' || !UUID_RE.test(value)) errors.push(`${field.name} must be a media UUID`); break;
      case 'relationRef': if (typeof value !== 'string' || !UUID_RE.test(value)) errors.push(`${field.name} must be a content UUID`); break;
      case 'richDocument': if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 200_000) errors.push(`${field.name} must be an object of at most 200 KiB`); break;
      default: errors.push(`${field.name} has an unsupported type`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { validateContentTypeDefinition, validateRecordValues, FIELD_TYPES, CAPABILITIES, NAME_RE };
