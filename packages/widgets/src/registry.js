'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ALLOWED_NODE_TYPES } = require('../../domain/src/page-document');

const DEFAULT_WIDGET_CONFIG = path.resolve(__dirname, '../../../config/widgets/core.widgets.json');

function createWidgetRegistry({ configPath = DEFAULT_WIDGET_CONFIG, extensions = [] } = {}) {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (parsed.apiVersion !== 1 || !Array.isArray(parsed.widgets)) throw new Error('Unsupported widget configuration manifest.');
  const map = new Map();
  for (const widget of [...parsed.widgets, ...extensions]) {
    if (!widget || typeof widget.name !== 'string' || !widget.name || !Number.isInteger(widget.version)) throw new Error('Widget manifest requires name and integer version.');
    if (map.has(widget.name)) throw new Error(`Duplicate widget registration: ${widget.name}`);
    map.set(widget.name, Object.freeze({ ...widget }));
  }
  for (const name of ALLOWED_NODE_TYPES) if (!map.has(name)) throw new Error(`Required core widget is missing: ${name}`);
  return Object.freeze({
    get(name) { return map.get(name); },
    has(name) { return map.has(name); },
    list() { return [...map.values()].sort((a, b) => a.name.localeCompare(b.name)); },
    validate(name, props) {
      const widget = map.get(name);
      if (!widget) return { valid: false, errors: [`Unknown widget: ${name}`] };
      if (!props || typeof props !== 'object' || Array.isArray(props)) return { valid: false, errors: ['Widget props must be an object.'] };
      return { valid: true, errors: [] };
    }
  });
}

module.exports = { createWidgetRegistry };
