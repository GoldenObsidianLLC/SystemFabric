'use strict';

function escapeHtml(value) { return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
const FORBIDDEN_TEX = /\\(?:href|url|includegraphics|write(?:18)?|input|include|html|htmlClass|htmlId|htmlStyle|class|style|def|gdef|newcommand|renewcommand|csname|special|immediate|openout|read|usepackage)(?![A-Za-z])/i;
function validateFormula(tex) {
  const errors = [];
  if (typeof tex !== 'string' || tex.length < 1 || tex.length > 10000) errors.push('formula must be a string of 1–10000 characters');
  else {
    if (FORBIDDEN_TEX.test(tex)) errors.push('formula contains a command that is not permitted');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(tex)) errors.push('formula contains control characters');
    let depth = 0; for (const char of tex) { if (char === '{') depth += 1; if (char === '}') depth -= 1; if (depth < 0) break; }
    if (depth !== 0) errors.push('formula has unbalanced braces');
  }
  return { valid: errors.length === 0, errors };
}
function renderMath(tex, { displayMode = false, katex = null } = {}) {
  const validation = validateFormula(tex);
  if (!validation.valid) { const error = new Error('Math formula failed validation.'); error.code = 'ERR_SYSTEMFABRIC_MATH_INVALID'; error.statusCode = 422; error.details = validation.errors; throw error; }
  // `katex: false` explicitly exercises the safe escaped fallback even when
  // the optional KaTeX package is installed in the current environment.
  let renderer = katex === false ? null : katex;
  if (katex === null || katex === undefined) { try { renderer = require('katex'); } catch { renderer = null; } }
  if (!renderer || typeof renderer.renderToString !== 'function') {
    const escaped = escapeHtml(tex);
    return { html: `<code class="sf-math-unavailable" role="math" aria-label="Mathematical formula">${escaped}</code>`, rendered: false, engine: null, warnings: ['Install the optional KaTeX dependency to enable full TeX rendering.'] };
  }
  try {
    const html = renderer.renderToString(tex, { displayMode: displayMode === true, output: 'htmlAndMathml', throwOnError: true, strict: 'error', trust: false, maxSize: 10, maxExpand: 1000 });
    return { html, rendered: true, engine: 'katex', warnings: [] };
  } catch (cause) {
    const error = new Error('Math formula could not be rendered.'); error.code = 'ERR_SYSTEMFABRIC_MATH_RENDER'; error.statusCode = 422; error.cause = cause; throw error;
  }
}
module.exports = { renderMath, validateFormula, escapeMathHtml: escapeHtml };
