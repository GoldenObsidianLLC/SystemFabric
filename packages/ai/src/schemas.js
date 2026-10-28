'use strict';

const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const propsSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    text: nullable({ type: 'string' }),
    level: nullable({ type: 'integer', enum: [1, 2, 3, 4, 5, 6] }),
    url: nullable({ type: 'string' }),
    assetId: nullable({ type: 'string' }),
    alt: nullable({ type: 'string' }),
    className: nullable({ type: 'string' })
  },
  required: ['text', 'level', 'url', 'assetId', 'alt', 'className']
};
const PAGE_DOCUMENT_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'documentId', 'type', 'title', 'children'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    documentId: { type: 'string' },
    type: { type: 'string', enum: ['page'] },
    title: { type: 'string' },
    children: { type: 'array', items: { $ref: '#/$defs/node' } }
  },
  $defs: {
    node: {
      type: 'object', additionalProperties: false,
      required: ['id', 'type', 'props', 'children'],
      properties: {
        id: { type: 'string' },
        type: { type: 'string', enum: ['section', 'column', 'container', 'widget.heading', 'widget.text', 'widget.button', 'widget.image'] },
        props: propsSchema,
        children: { type: 'array', items: { $ref: '#/$defs/node' } }
      }
    }
  }
};
const TEXT_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['text'],
  properties: { text: { type: 'string' } }
};
const SEO_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'description', 'keywords'],
  properties: {
    title: { type: 'string' }, description: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } }
  }
};
const TRANSLATION_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['translatedText', 'targetLanguage'],
  properties: { translatedText: { type: 'string' }, targetLanguage: { type: 'string' } }
};

module.exports = { PAGE_DOCUMENT_OUTPUT_SCHEMA, TEXT_RESULT_SCHEMA, SEO_RESULT_SCHEMA, TRANSLATION_RESULT_SCHEMA };
