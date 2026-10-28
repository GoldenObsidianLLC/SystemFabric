'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPageText } = require('../packages/db/src/postgres-store');

 test('search text extraction indexes visible content instead of JSON property names', () => {
  const text = extractPageText({
    title: 'Ignored by extractor because title is indexed separately',
    children: [
      { type: 'widget.heading', props: { text: 'Architecture', level: 2 }, children: [] },
      { type: 'widget.image', props: { alt: 'System diagram' }, children: [] },
      { type: 'container', props: {}, children: [{ type: 'widget.text', props: { text: 'PostgreSQL and graph relationships' }, children: [] }] }
    ]
  });
  assert.equal(text, 'Architecture System diagram PostgreSQL and graph relationships');
  assert.ok(!text.includes('widget.heading'));
  assert.ok(extractPageText({ children: [{ props: { text: 'abcdef' }, children: [] }] }, 3).length <= 3);
});
