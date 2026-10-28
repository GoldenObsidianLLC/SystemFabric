'use strict';

const PLUGIN_NAME = /^[a-z][a-z0-9._-]{1,99}$/;
const CAPABILITIES = new Set(['render:widget', 'editor:widget', 'content:read', 'content:write', 'media:read', 'search:query', 'http:approved-endpoints']);

function validatePluginManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { valid: false, errors: ['manifest must be an object'] };
  if (manifest.apiVersion !== 1) errors.push('apiVersion must be 1');
  if (typeof manifest.name !== 'string' || !PLUGIN_NAME.test(manifest.name)) errors.push('name must be a lowercase package-safe identifier');
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) errors.push('version must be a semantic version');
  if (typeof manifest.title !== 'string' || manifest.title.trim().length < 1 || manifest.title.length > 120) errors.push('title must be 1–120 characters');
  if (typeof manifest.description !== 'string' || manifest.description.length > 2000) errors.push('description must be a string up to 2000 characters');
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.some(x => typeof x !== 'string' || !CAPABILITIES.has(x))) errors.push(`capabilities must contain only: ${[...CAPABILITIES].join(', ')}`);
  if (manifest.widgets !== undefined && (!Array.isArray(manifest.widgets) || manifest.widgets.length > 100 || manifest.widgets.some(x => !x || typeof x !== 'object' || typeof x.name !== 'string' || typeof x.title !== 'string'))) errors.push('widgets must be an array of at most 100 {name,title,...} records');
  if (manifest.hooks !== undefined && (!Array.isArray(manifest.hooks) || manifest.hooks.length > 100 || manifest.hooks.some(x => !x || typeof x !== 'object' || typeof x.name !== 'string' || !/^[a-z][a-z0-9_.:-]{1,99}$/.test(x.name)))) errors.push('hooks must be an array of valid named hooks');
  const allowed = new Set(['apiVersion', 'name', 'version', 'title', 'description', 'capabilities', 'widgets', 'hooks', 'homepage', 'license', 'publisher']);
  for (const key of Object.keys(manifest)) if (!allowed.has(key)) errors.push(`unknown manifest field: ${key}`);
  return { valid: errors.length === 0, errors };
}

function validatePinnedImageDigest(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._/:@-]{0,240}@sha256:[a-f0-9]{64}$/.test(value);
}

module.exports = { validatePluginManifest, validatePinnedImageDigest, PLUGIN_NAME, CAPABILITIES: [...CAPABILITIES] };
