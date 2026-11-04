'use strict';

const HTML_ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
});

/**
 * Encode an untrusted value for an HTML text or quoted-attribute context.
 * This does not make input safe for JavaScript, CSS, URL, or raw HTML contexts.
 */
function escapeHtmlText(value) {
  return String(value).replace(/[&<>"']/g, character => HTML_ESCAPE_MAP[character]);
}

module.exports = { escapeHtmlText };
