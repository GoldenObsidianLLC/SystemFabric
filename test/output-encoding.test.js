'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtmlText } = require('../packages/security/src/output-encoding');

test('escapeHtmlText encodes all five HTML-sensitive characters in one pass', () => {
  assert.equal(
    escapeHtmlText(`& < > " '`),
    '&amp; &lt; &gt; &quot; &#39;'
  );
});

test('escapeHtmlText prevents attribute and text markup injection without double encoding', () => {
  assert.equal(
    escapeHtmlText(`"><img src=x onerror=alert(1)>&`),
    '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;'
  );
  assert.equal(escapeHtmlText('&amp;'), '&amp;amp;');
  assert.equal(escapeHtmlText(null), 'null');
});
