'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'apps', 'admin', 'assets', 'katex');
let katexRoot;
try { katexRoot = path.dirname(require.resolve('katex', { paths: [root] })); }
catch { console.log('KaTeX is not installed; math widgets will use the safe escaped-text fallback.'); process.exit(0); }
const source = katexRoot;
const css = path.join(source, 'katex.min.css');
const fonts = path.join(source, 'fonts');
if (!fs.existsSync(css) || !fs.existsSync(fonts)) { console.warn('KaTeX package files were incomplete; not materializing renderer assets.'); process.exit(0); }
fs.mkdirSync(path.join(destination, 'fonts'), { recursive: true });
fs.copyFileSync(css, path.join(destination, 'katex.min.css'));
for (const entry of fs.readdirSync(fonts)) {
  if (!/^KaTeX_[A-Za-z0-9_-]+\.(?:woff2?|ttf)$/.test(entry)) continue;
  fs.copyFileSync(path.join(fonts, entry), path.join(destination, 'fonts', entry));
}
console.log('Materialized KaTeX stylesheet and fonts into apps/admin/assets/katex.');
