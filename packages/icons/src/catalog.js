'use strict';

// A deliberately curated inline SVG catalog. Arbitrary SVG uploads remain disallowed.
const ICONS = Object.freeze({
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  arrowDown: '<path d="M12 4v16m-7-7 7 7 7-7"/>',
  arrowRight: '<path d="M4 12h16m-7-7 7 7-7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  externalLink: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  play: '<path d="m7 4 14 8-14 8z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.6.9L16 20h-8l-.2-1.8a8 8 0 0 1-1.6-.9l-1.7.7-1.4-2.4 1.4-1.1a8 8 0 0 1 0-1.8l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.6-.9L8 7h8l.2 1.8a8 8 0 0 1 1.6.9l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1-.1 2.5Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM20 8v6m3-3h-6"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>'
});

function listIcons() { return Object.keys(ICONS).sort().map(name => ({ name, category: name === 'user' || name === 'users' ? 'people' : ['folder','file','document','image','video'].includes(name) ? 'media' : 'interface' })); }
function renderIcon(name, { size = 24, title = null, strokeWidth = 1.8 } = {}) {
  if (!Object.hasOwn(ICONS, name)) { const error = new Error('Unknown icon name.'); error.code = 'ERR_SYSTEMFABRIC_ICON_NOT_FOUND'; error.statusCode = 404; throw error; }
  if (!Number.isInteger(size) || size < 8 || size > 128 || !Number.isFinite(strokeWidth) || strokeWidth < 1 || strokeWidth > 3) { const error = new Error('Icon size or stroke width is out of range.'); error.code = 'ERR_SYSTEMFABRIC_ICON_OPTIONS'; error.statusCode = 400; throw error; }
  const escapedTitle = title === null ? '' : `<title>${String(title).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</title>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" role="img" aria-hidden="${title === null ? 'true' : 'false'}">${escapedTitle}${ICONS[name]}</svg>`;
}
module.exports = { ICONS, listIcons, renderIcon };
