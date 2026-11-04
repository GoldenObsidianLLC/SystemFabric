'use strict';

const enginex = require('../../../vendor/enginex');
const { validatePageDocument, styleToCss, isSafeUrl } = require('../../domain/src/page-document');
const { cssVariables } = require('../../domain/src/design-system');
const { renderIcon } = require('../../icons/src/catalog');
const { renderMath } = require('../../math/src/renderer');
const { escapeHtmlText } = require('../../security/src/output-encoding');
const MAX_RENDERED_OUTPUT_BYTES = 2 * 1024 * 1024;

const compiled = Object.freeze({
  heading: [1, 2, 3, 4, 5, 6].map(level => enginex.compileSource(`<h${level} class="{{ nodeClass }}">{{ text }}</h${level}>`, { profile: 'standard-ssr' })),
  text: enginex.compileSource('<p class="{{ nodeClass }}">{{ text }}</p>', { profile: 'standard-ssr' }),
  button: enginex.compileSource('<a class="vsh-button {{ nodeClass }}" href="{{ safeUrl(url) }}">{{ text }}</a>', { profile: 'standard-ssr' }),
  image: enginex.compileSource('<img class="{{ nodeClass }}" src="{{ safeUrl(url) }}" alt="{{ alt }}" loading="lazy">', { profile: 'standard-ssr' }),
  video: enginex.compileSource('<video class="{{ nodeClass }}" controls preload="metadata" src="{{ safeUrl(url) }}" title="{{ title }}" poster="{{ safeUrl(poster) }}"></video>', { profile: 'standard-ssr' }),
  listItem: enginex.compileSource('<li>{{ text }}</li>', { profile: 'standard-ssr' }),
  quote: enginex.compileSource('<figure class="{{ nodeClass }}"><blockquote><p>{{ text }}</p></blockquote></figure>', { profile: 'standard-ssr' }),
  quoteCite: enginex.compileSource('<figcaption>{{ cite }}</figcaption>', { profile: 'standard-ssr' }),
  divider: enginex.compileSource('<hr class="{{ nodeClass }}" aria-hidden="true">', { profile: 'standard-ssr' }),
  spacer: enginex.compileSource('<div class="{{ nodeClass }}" style="height:{{ height }}" aria-hidden="true"></div>', { profile: 'standard-ssr' }),
  containerOpen: enginex.compileSource('<{{ tag }} class="{{ className }}">', { profile: 'standard-ssr' }),
  queryItem: enginex.compileSource('<article class="vsh-query-item"><h3><a href="{{ safeUrl(url) }}">{{ title }}</a></h3><p>{{ excerpt }}</p></article>', { profile: 'standard-ssr' })
});

function safeClassName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9 _-]{0,120}$/.test(value) ? value.trim() : '';
}

function renderPageDocument(document, { assetUrl = id => `/media/${encodeURIComponent(id)}`, libraryAssetUrl = id => `/library/public/${encodeURIComponent(id)}`, dynamicData = {}, designTokens = {} } = {}) {
  const validation = validatePageDocument(document);
  if (!validation.valid) {
    const error = new Error(`Page document is invalid: ${validation.errors.join('; ')}`);
    error.code = 'ERR_VIRGOSCORPIO_HUB_INVALID_DOCUMENT'; error.details = validation.errors; throw error;
  }

  const cssRules = [];
  const nodeClasses = new Map();
  function collectStyles(node) {
    const classToken = `vsh-node-${node.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    nodeClasses.set(node.id, classToken);
    const desktop = styleToCss(node.props.styles);
    const tablet = styleToCss(node.props.responsiveStyles?.tablet);
    const mobile = styleToCss(node.props.responsiveStyles?.mobile);
    if (desktop) cssRules.push(`.${classToken}{${desktop}}`);
    if (tablet) cssRules.push(`@media(max-width:900px){.${classToken}{${tablet}}}`);
    if (mobile) cssRules.push(`@media(max-width:600px){.${classToken}{${mobile}}}`);
    for (const child of node.children) collectStyles(child);
  }
  for (const node of document.children) collectStyles(node);

  function renderNode(node) {
    const children = node.children.map(renderNode).join('');
    const nodeClass = nodeClasses.get(node.id);
    const className = `${safeClassName(node.props.className || '')} ${nodeClass}`.trim();
    switch (node.type) {
      case 'section':
      case 'column':
      case 'container': {
        const tag = node.type === 'section' ? 'section' : 'div';
        const classNames = `${className} ${node.type === 'section' ? 'vsh-section' : node.type === 'column' ? 'vsh-column' : 'vsh-container'}`.trim();
        const open = compiled.containerOpen.render({ tag, className: classNames });
        return `${open}${children}${tag === 'section' ? '</section>' : '</div>'}`;
      }
      case 'widget.heading': return compiled.heading[node.props.level - 1].render({ nodeClass: className, text: node.props.text });
      case 'widget.text': return compiled.text.render({ nodeClass: className, text: node.props.text });
      case 'widget.button': return compiled.button.render({ nodeClass: className, text: node.props.text, url: node.props.url });
      case 'widget.image': return compiled.image.render({ nodeClass: className, url: assetUrl(node.props.assetId), alt: node.props.alt });
      case 'widget.video': {
        const video = compiled.video.render({ nodeClass: className, url: libraryAssetUrl(node.props.assetId), title: node.props.title || 'Video', poster: node.props.posterAssetId ? libraryAssetUrl(node.props.posterAssetId) : '' });
        return node.props.controls === false ? video.replace(' controls ', ' ') : video;
      }
      case 'widget.icon': return `<span class="${escapeHtmlText(className)}">${renderIcon(node.props.iconName, { size: node.props.size || 24, title: node.props.title || null })}</span>`;
      case 'widget.math': { const rendered = renderMath(node.props.formula, { displayMode: node.props.displayMode === true }); return `<div class="vsh-math ${escapeHtmlText(className)}${node.props.displayMode ? ' vsh-math-display' : ''}">${rendered.html}</div>`; }
      case 'widget.list': {
        const items = node.props.items.map(text => compiled.listItem.render({ text })).join('');
        return node.props.ordered ? `<ol class="${escapeHtmlText(className)}">${items}</ol>` : `<ul class="${escapeHtmlText(className)}">${items}</ul>`;
      }
      case 'widget.quote': {
        const quote = compiled.quote.render({ nodeClass: className, text: node.props.text });
        return node.props.cite ? quote.replace('</figure>', `${compiled.quoteCite.render({ cite: node.props.cite })}</figure>`) : quote;
      }
      case 'widget.divider': return compiled.divider.render({ nodeClass: className });
      case 'widget.spacer': return compiled.spacer.render({ nodeClass: className, height: node.props.height });
      case 'widget.query-loop': {
        const rows = Array.isArray(dynamicData[node.id]) ? dynamicData[node.id].slice(0, node.props.limit) : [];
        const gridClass = `vsh-query-loop vsh-cols-${node.props.columns} ${className}`.trim();
        const items = rows.map(item => {
          const url = typeof item?.url === 'string' && isSafeUrl(item.url) ? item.url : '/';
          return compiled.queryItem.render({ url, title: String(item?.title || ''), excerpt: String(item?.excerpt || '') });
        }).join('');
        return `<div class="${escapeHtmlText(gridClass)}">${items || `<p class="vsh-query-empty">${escapeHtmlText(node.props.emptyText || 'No items found.')}</p>`}</div>`;
      }
      default: throw new Error(`Renderer has no implementation for ${node.type}`);
    }
  }

  const body = document.children.map(renderNode).join('');
  const safeCss = cssRules.join('\n');
  const tokenCss = cssVariables(designTokens);
  const katexStylesheet = (() => { try { const entry = require.resolve('katex'); return require('node:fs').existsSync(require('node:path').join(require('node:path').dirname(entry), 'katex.min.css')) ? '<link rel="stylesheet" href="/assets/katex/katex.min.css">' : ''; } catch { return ''; } })();
  const html = `<!doctype html><html lang="${escapeHtmlText(document.locale || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${katexStylesheet}<title>${enginex.compileSource('{{ title }}').render({ title: document.title })}</title><style>${tokenCss}body{font-family:var(--vsh-font-families-body,system-ui,sans-serif);line-height:1.5;margin:0}.vsh-section{padding:2rem 1rem;max-width:72rem;margin-inline:auto}.vsh-column,.vsh-container{min-width:0}.vsh-button{display:inline-block;padding:.7rem 1rem;text-decoration:none;border-radius:.35rem;background:#18212f;color:#fff}.vsh-button:focus-visible{outline:3px solid #8ab4ff;outline-offset:2px}img{max-width:100%;height:auto}.vsh-query-loop{display:grid;gap:1rem}.vsh-cols-1{grid-template-columns:repeat(1,minmax(0,1fr))}.vsh-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.vsh-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.vsh-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}.vsh-query-item{min-width:0;padding:1rem;border:1px solid #e2e8f0;border-radius:.5rem}.vsh-query-item h3{margin-top:0}.vsh-query-item a{overflow-wrap:anywhere}.vsh-query-empty{grid-column:1/-1}.vsh-math{overflow-x:auto;max-width:100%}.vsh-math-display{text-align:center;margin:1rem 0}video{display:block;max-width:100%;height:auto;border-radius:.35rem}@media(max-width:700px){.vsh-query-loop{grid-template-columns:1fr!important}}${safeCss}</style></head><body><main>${body}</main></body></html>`;
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_RENDERED_OUTPUT_BYTES) {
    const error = new Error(`Rendered output exceeds ${MAX_RENDERED_OUTPUT_BYTES} bytes.`);
    error.code = 'ERR_VIRGOSCORPIO_HUB_RENDER_OUTPUT_LIMIT'; error.statusCode = 413; throw error;
  }
  return html;
}

module.exports = { renderPageDocument, MAX_RENDERED_OUTPUT_BYTES, rendererInfo: { name: 'enginex-ai-native', version: enginex.version } };
