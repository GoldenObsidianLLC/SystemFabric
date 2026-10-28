'use strict';

const KEY_RE = /^[a-z][a-z0-9_-]{0,32}$/;
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const LENGTH_RE = /^(?:0|(?:\d+(?:\.\d+)?)(?:px|rem|em|%|vw|vh))$/;
const FONT_RE = /^[a-zA-Z0-9 ,"'_-]{1,160}$/;
const ALLOWED_GROUPS = new Set(['colors', 'spacing', 'radii', 'fontSizes', 'fontFamilies', 'fontWeights', 'breakpoints']);
const FONT_WEIGHTS = new Set(['100','200','300','400','500','600','700','800','900','normal','bold']);

function validateDesignTokens(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['tokens must be an object'] };
  for (const key of Object.keys(input)) if (!ALLOWED_GROUPS.has(key)) errors.push(`tokens.${key} is not a supported token group`);
  for (const group of Object.keys(input)) {
    if (!ALLOWED_GROUPS.has(group)) continue;
    const value = input[group];
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`tokens.${group} must be an object`); continue; }
    const entries = Object.entries(value);
    if (entries.length > 100) errors.push(`tokens.${group} may contain at most 100 entries`);
    for (const [name, token] of entries) {
      if (!KEY_RE.test(name)) errors.push(`tokens.${group}.${name} has an invalid token name`);
      if (group === 'colors') { if (typeof token !== 'string' || !HEX_RE.test(token)) errors.push(`tokens.colors.${name} must be a hex color`); }
      else if (['spacing','radii','fontSizes'].includes(group)) { if (typeof token !== 'string' || !LENGTH_RE.test(token)) errors.push(`tokens.${group}.${name} must be a CSS length`); }
      else if (group === 'fontFamilies') { if (typeof token !== 'string' || !FONT_RE.test(token) || /[{};\\]/.test(token)) errors.push(`tokens.fontFamilies.${name} contains unsupported characters`); }
      else if (group === 'fontWeights') { if (!FONT_WEIGHTS.has(String(token))) errors.push(`tokens.fontWeights.${name} is not a supported font weight`); }
      else if (group === 'breakpoints') { if (!Number.isInteger(token) || token < 240 || token > 2560) errors.push(`tokens.breakpoints.${name} must be an integer from 240 to 2560`); }
    }
  }
  return { valid: errors.length === 0, errors };
}

function cssVariables(tokens) {
  const validation = validateDesignTokens(tokens);
  if (!validation.valid) { const error = new Error(`Design tokens are invalid: ${validation.errors.join('; ')}`); error.code = 'ERR_SYSTEMFABRIC_DESIGN_TOKENS_INVALID'; error.details = validation.errors; throw error; }
  const rows = [];
  for (const group of ['colors','spacing','radii','fontSizes','fontFamilies','fontWeights']) {
    for (const [name, value] of Object.entries(tokens[group] || {})) rows.push(`--sf-${group.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}-${name}:${value}`);
  }
  return `:root{${rows.join(';')}}`;
}
module.exports = { validateDesignTokens, cssVariables, ALLOWED_GROUPS };
