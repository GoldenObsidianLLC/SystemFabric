'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const state = {
    user: null, sites: [], siteId: '', pages: [], document: null, contentId: null, version: null, status: 'draft',
    selectedNodeId: null, dirty: false, undo: [], redo: [], dragComponent: null, dragNodeId: null, breakpoint: 'desktop',
    slugTouched: false, toastTimer: null, lastSavedDocument: null
  };
  const styleFields = [
    ['backgroundColor', 'Background color', 'text', '#ffffff'], ['color', 'Text color', 'text', '#202b3a'],
    ['fontSize', 'Font size', 'text', '16px'], ['fontWeight', 'Font weight', 'select', ['normal','bold','400','500','600','700','800']],
    ['textAlign', 'Text alignment', 'select', ['left','center','right','justify']], ['padding', 'Padding', 'text', '16px'],
    ['margin', 'Margin', 'text', '0'], ['gap', 'Gap', 'text', '12px'], ['borderRadius', 'Corner radius', 'text', '0'],
    ['width', 'Width', 'text', '100%'], ['maxWidth', 'Max width', 'text', '100%'], ['minHeight', 'Minimum height', 'text', 'auto'],
    ['display', 'Display', 'select', ['block','flex','grid','inline-block']], ['flexDirection', 'Flex direction', 'select', ['row','column','row-reverse','column-reverse']],
    ['alignItems', 'Align items', 'select', ['start','center','end','stretch','baseline']], ['justifyContent', 'Justify content', 'select', ['start','center','end','space-between','space-around','space-evenly']]
  ];
  const containerTypes = new Set(['section', 'column', 'container']);
  const labels = { section: 'Section', column: 'Column', container: 'Container', 'widget.heading': 'Heading', 'widget.text': 'Text', 'widget.button': 'Button', 'widget.image': 'Image', 'widget.video': 'Video', 'widget.icon': 'Icon', 'widget.math': 'Math formula', 'widget.list': 'List', 'widget.quote': 'Quote', 'widget.divider': 'Divider', 'widget.spacer': 'Spacer', 'widget.query-loop': 'Query Loop' };

  function notify(message, error = false) {
    const toast = $('toast'); toast.textContent = message; toast.classList.toggle('error', error); toast.classList.add('show');
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  }
  function setStatus(message, dirty = state.dirty) {
    $('save-status').textContent = message; $('dirty-status').textContent = dirty ? 'Unsaved changes' : 'All changes saved';
    $('dirty-status').style.color = dirty ? '#e4bd7c' : '#72dba7';
  }
  function slugify(text) { return String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180); }
  function csrfFromCookie() { const match = document.cookie.match(/(?:^|;\s*)sf_csrf=([^;]+)/); return match ? match[1] : ''; }
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const method = (options.method || 'GET').toUpperCase();
    if (options.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (['POST','PUT','PATCH','DELETE'].includes(method)) {
      const csrf = csrfFromCookie(); if (csrf) headers.set('x-csrf-token', csrf);
    }
    const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin' });
    const contentType = response.headers.get('content-type') || '';
    const value = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/v1/auth/login') showLogin();
      throw new Error(value?.error || value?.message || `Request failed (${response.status}).`);
    }
    return value;
  }
  function showLogin(message = '') {
    $('app-shell').classList.add('hidden'); $('login-shell').classList.remove('hidden'); $('login-status').textContent = message;
  }
  function showApp() { $('login-shell').classList.add('hidden'); $('app-shell').classList.remove('hidden'); }
  async function loadAuth() {
    try {
      const result = await api('/api/v1/auth/me'); state.user = result.user; state.sites = result.sites || [];
      $('user-label').textContent = state.user.displayName || state.user.email;
      const savedSite = sessionStorage.getItem('sf-site-id');
      state.siteId = state.sites.some(s => s.siteId === savedSite) ? savedSite : (state.sites[0]?.siteId || state.sites[0]?.id || '');
      if (!state.siteId) { showApp(); $('site-select').innerHTML = ''; notify('Your account has no site memberships. Ask a site owner for access.', true); return; }
      renderSiteSelect(); showApp(); await loadPages(); await offerDraftRecovery();
    } catch { showLogin('Sign in with your SystemFabric account.'); if (new URL(location.href).searchParams.get('mfa') === 'required') { $('mfa-challenge-panel').classList.remove('hidden'); $('login-status').textContent = 'Your organization sign-in succeeded. Enter your authenticator code to finish.'; $('mfa-code').focus(); } }
  }
  function renderSiteSelect() {
    const select = $('site-select'); select.replaceChildren();
    for (const site of state.sites) {
      const option = document.createElement('option'); option.value = site.siteId || site.id; option.textContent = site.siteName || site.name || site.siteSlug || 'Site'; select.append(option);
    }
    select.value = state.siteId;
  }
  function siteHeaders(extra = {}) { return { 'x-systemfabric-site-id': state.siteId, ...extra }; }
  function currentSiteCapabilities() {
    const site = state.sites.find(s => (s.siteId || s.id) === state.siteId);
    return new Set(site?.capabilities || []);
  }
  function may(capability) { const caps = currentSiteCapabilities(); return caps.has('*') || caps.has('site:manage') || caps.has(capability); }

  async function loadPages() {
    if (!state.siteId) return;
    const result = await api(`/api/v1/pages?siteId=${encodeURIComponent(state.siteId)}`);
    state.pages = result.items || []; renderPageList();
  }
  function renderPageList() {
    const q = $('page-search').value.trim().toLowerCase(); const host = $('page-list'); host.replaceChildren();
    const items = state.pages.filter(page => `${page.title} ${page.slug} ${page.status}`.toLowerCase().includes(q));
    if (!items.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = q ? 'No matching pages.' : 'No pages yet. Create your first draft.'; host.append(empty); return; }
    for (const page of items) {
      const button = document.createElement('button'); button.className = `page-item${page.id === state.contentId ? ' active' : ''}`; button.type = 'button';
      const text = document.createElement('span'); text.className = 'page-name'; text.textContent = page.title || '(Untitled)';
      const meta = document.createElement('small'); meta.textContent = page.status.replace('_', ' '); button.append(text, meta);
      button.addEventListener('click', () => { void loadPage(page.id); }); host.append(button);
    }
  }
  function newNode(type) {
    const id = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
    let props = {};
    if (type === 'section') props = { className: 'sf-section', styles: { padding: '32px 20px', backgroundColor: '#f5f7fa' } };
    else if (type === 'column') props = { className: 'sf-column', styles: { padding: '16px' } };
    else if (type === 'container') props = { className: 'sf-container', styles: { padding: '16px' } };
    else if (type === 'widget.heading') props = { text: 'Your heading', level: 2, styles: { fontSize: '32px', color: '#182438', margin: '0 0 12px' } };
    else if (type === 'widget.text') props = { text: 'Write a clear, helpful paragraph that explains the value you provide.', styles: { fontSize: '16px', lineHeight: '1.6', color: '#344155', margin: '0 0 14px' } };
    else if (type === 'widget.button') props = { text: 'Learn more', url: '/', styles: { backgroundColor: '#253b5a', color: '#ffffff', padding: '11px 16px', borderRadius: '5px' } };
    else if (type === 'widget.image') props = { assetId: 'replace-with-asset-id', alt: 'Describe this image', styles: { maxWidth: '100%' } };
    else if (type === 'widget.video') props = { assetId: 'replace-with-video-asset-id', title: 'Video', controls: true, styles: { maxWidth: '100%' } };
    else if (type === 'widget.icon') props = { iconName: 'check', size: 24, title: 'Check' };
    else if (type === 'widget.math') props = { formula: 'x^2 + y^2 = z^2', displayMode: true }; 
    else if (type === 'widget.list') props = { items: ['First item', 'Second item', 'Third item'], ordered: false, styles: { lineHeight: '1.7', margin: '0 0 16px' } };
    else if (type === 'widget.quote') props = { text: 'An inspiring quotation goes here.', cite: 'Attribution', styles: { padding: '16px', backgroundColor: '#f5f7fa', borderRadius: '8px' } };
    else if (type === 'widget.divider') props = { styles: { margin: '24px 0', color: '#d4dbe5' } };
    else if (type === 'widget.spacer') props = { height: '24px' };
    else if (type === 'widget.query-loop') props = { source: 'latest-published', contentType: 'post', limit: 3, columns: 3, emptyText: 'No items found.', styles: { gap: '16px' } };
    return { id, type, props, children: [] };
  }
  function makeInitialDocument() {
    return { schemaVersion: 1, documentId: globalThis.crypto?.randomUUID?.() || `doc-${Date.now()}`, type: 'page', title: 'Untitled page', children: [newNode('section')] };
  }
  async function loadPage(id) {
    try {
      const result = await api(`/api/v1/pages/${encodeURIComponent(id)}?siteId=${encodeURIComponent(state.siteId)}`);
      const content = result.content; state.document = structuredClone(content.body); state.contentId = content.id; state.version = content.version; state.status = content.status;
      state.selectedNodeId = null; state.dirty = false; state.undo = []; state.redo = []; state.lastSavedDocument = JSON.stringify(state.document);
      $('document-title').value = content.title; $('page-slug').value = content.slug;
      state.slugTouched = true; sessionStorage.removeItem(recoveryKey()); updateVersionLabel(); renderAll(); saveRecovery(); setStatus(`Loaded ${content.title}`, false); notify('Page loaded.');
    } catch (error) { notify(error.message, true); }
  }

  async function offerDraftRecovery() {
    const prefix = `systemfabric:draft:${state.user?.id || 'user'}:${state.siteId}:`;
    const candidates = [];
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index); if (!key?.startsWith(prefix)) continue;
      try { const value = JSON.parse(sessionStorage.getItem(key) || 'null'); if (value?.document && Date.now() - Number(value.savedAt || 0) < 7 * 24 * 60 * 60_000) candidates.push({ key, value, contentId: key.slice(prefix.length) === 'new' ? null : key.slice(prefix.length) }); } catch { /* Ignore malformed recovery entries. */ }
    }
    candidates.sort((a, b) => Number(b.value.savedAt || 0) - Number(a.value.savedAt || 0));
    const latest = candidates[0]; if (!latest || !window.confirm(`Restore unsaved local work from ${new Date(latest.value.savedAt).toLocaleString()}?`)) return;
    const validation = await api('/api/v1/pages/validate', { method: 'POST', body: JSON.stringify({ document: latest.value.document }) });
    if (!validation.valid) { notify('Local recovery data failed validation and was not restored.', true); return; }
    state.document = structuredClone(latest.value.document); state.contentId = latest.contentId; state.version = Number(latest.value.version) || null; state.status = 'draft'; state.dirty = true; state.selectedNodeId = null; state.slugTouched = true;
    $('document-title').value = state.document.title; $('page-slug').value = latest.value.slug || slugify(state.document.title); renderAll(); markDirty(); notify('Recovered local draft. Save to persist it; version conflicts are checked by the server.');
  }

  function recoveryKey() { return `systemfabric:draft:${state.user?.id || 'user'}:${state.siteId}:${state.contentId || 'new'}`; }
  function saveRecovery() {
    if (!state.document) return;
    try { sessionStorage.setItem(recoveryKey(), JSON.stringify({ document: state.document, slug: $('page-slug').value, savedAt: Date.now(), version: state.version })); } catch { /* Recovery is best-effort only. */ }
  }
  function markDirty() {
    state.dirty = true; setStatus('Changes not saved', true); saveRecovery(); updateUndoButtons();
  }
  function snapshot() { if (state.document) state.undo.push(structuredClone(state.document)); if (state.undo.length > 60) state.undo.shift(); state.redo.length = 0; }
  function mutate(operation) { snapshot(); operation(); markDirty(); renderAll(); }
  function updateUndoButtons() { $('undo').disabled = state.undo.length === 0; $('redo').disabled = state.redo.length === 0; }
  function undo() {
    if (!state.undo.length) return; state.redo.push(structuredClone(state.document)); state.document = state.undo.pop(); state.dirty = true; markDirty(); renderAll();
  }
  function redo() {
    if (!state.redo.length) return; state.undo.push(structuredClone(state.document)); state.document = state.redo.pop(); state.dirty = true; markDirty(); renderAll();
  }
  function walkNodes(list, callback, parent = null) { for (let i = 0; i < list.length; i++) { const node = list[i]; callback(node, list, i, parent); if (Array.isArray(node.children)) walkNodes(node.children, callback, node); } }
  function findNode(id) { let found = null; if (!state.document) return null; walkNodes(state.document.children, node => { if (node.id === id) found = node; }); return found; }
  function findNodeContainer(id) { let found = null; walkNodes(state.document.children, (node, list, index, parent) => { if (node.id === id) found = { node, list, index, parent }; }); return found; }
  function insertionList(targetId) {
    if (!targetId) return state.document.children;
    const target = findNode(targetId); return target && containerTypes.has(target.type) ? target.children : state.document.children;
  }
  function addComponent(type, targetId = null) {
    if (!state.document) state.document = makeInitialDocument();
    mutate(() => {
      const node = newNode(type); const target = targetId ? findNode(targetId) : null;
      const list = target && containerTypes.has(target.type) ? target.children : state.document.children;
      list.push(node); state.selectedNodeId = node.id;
    });
  }
  function moveNode(id, targetId = null) {
    if (!id || id === targetId) return;
    const source = findNodeContainer(id); if (!source) return;
    const target = targetId ? findNode(targetId) : null;
    if (target && !containerTypes.has(target.type)) return;
    // Prevent placing a container inside one of its descendants.
    if (target && containerTypes.has(source.node.type)) {
      let contains = false; walkNodes(source.node.children, node => { if (node.id === target.id) contains = true; }); if (contains) return;
    }
    mutate(() => { source.list.splice(source.index, 1); const destination = target ? target.children : state.document.children; destination.push(source.node); state.selectedNodeId = source.node.id; });
  }
  function duplicateNode(id) {
    const item = findNodeContainer(id); if (!item) return;
    const clone = structuredClone(item.node);
    walkNodes([clone], node => { node.id = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^A-Za-z0-9_-]/g,'').slice(0,80); });
    mutate(() => { item.list.splice(item.index + 1, 0, clone); state.selectedNodeId = clone.id; });
  }
  function removeNode(id) {
    const item = findNodeContainer(id); if (!item) return;
    mutate(() => { item.list.splice(item.index, 1); state.selectedNodeId = item.list[Math.max(0, item.index - 1)]?.id || null; });
  }
  function shiftNode(id, direction) {
    const item = findNodeContainer(id); if (!item) return; const next = item.index + direction; if (next < 0 || next >= item.list.length) return;
    mutate(() => { [item.list[item.index], item.list[next]] = [item.list[next], item.list[item.index]]; });
  }
  function applySafeStyles(element, styles) {
    const safe = styles && typeof styles === 'object' ? styles : {};
    const allowed = new Set(styleFields.map(field => field[0]));
    const lengthRule = /^(?:auto|0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|vw|vh|%))(?:\s+(?:auto|0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%))){0,3}$/;
    const colorRule = /^(#[0-9a-f]{3,8}|transparent|[a-z]{1,24})$/i;
    for (const [key, value] of Object.entries(safe)) {
      if (!allowed.has(key) || typeof value !== 'string' || value.length > 80) continue;
      let valid = false;
      if (['color','backgroundColor'].includes(key)) valid = colorRule.test(value);
      else if (key === 'lineHeight') valid = /^(?:normal|[0-9]+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?(?:px|rem|em|%))$/.test(value);
      else if (['fontSize','gap','borderRadius','width','maxWidth','minHeight','padding','margin'].includes(key)) valid = lengthRule.test(value);
      else if (key === 'fontWeight') valid = /^(normal|bold|[1-9]00)$/.test(value);
      else if (key === 'textAlign') valid = /^(left|center|right|justify)$/.test(value);
      else if (key === 'display') valid = /^(block|flex|grid|inline-block)$/.test(value);
      else if (key === 'flexDirection') valid = /^(row|row-reverse|column|column-reverse)$/.test(value);
      else if (key === 'alignItems') valid = /^(start|center|end|stretch|baseline)$/.test(value);
      else if (key === 'justifyContent') valid = /^(start|center|end|stretch|space-between|space-around|space-evenly)$/.test(value);
      if (valid) element.style[key] = value;
    }
  }
  function renderNode(node) {
    let element;
    if (node.type === 'section') element = document.createElement('section');
    else if (node.type === 'container' || node.type === 'column') element = document.createElement('div');
    else if (node.type === 'widget.heading') element = document.createElement(`h${Math.max(1,Math.min(6,Number(node.props.level)||2))}`);
    else if (node.type === 'widget.text') element = document.createElement('p');
    else if (node.type === 'widget.button') element = document.createElement('a');
    else if (node.type === 'widget.image') element = document.createElement('img');
    else if (node.type === 'widget.video') element = document.createElement('video');
    else if (node.type === 'widget.icon' || node.type === 'widget.math') element = document.createElement('div');
    else if (node.type === 'widget.list') element = document.createElement(node.props.ordered ? 'ol' : 'ul');
    else if (node.type === 'widget.quote') element = document.createElement('figure');
    else if (node.type === 'widget.divider') element = document.createElement('hr');
    else if (node.type === 'widget.spacer' || node.type === 'widget.query-loop') element = document.createElement('div');
    else return document.createTextNode('Unsupported component');
    element.classList.add('sf-node');
    const classToken = node.type === 'section' ? 'builder-section' : node.type === 'column' ? 'builder-column' : node.type === 'container' ? 'builder-container' : node.type === 'widget.heading' ? 'builder-heading' : node.type === 'widget.text' ? 'builder-text' : node.type === 'widget.button' ? 'builder-button' : node.type === 'widget.image' ? 'builder-image' : node.type === 'widget.video' ? 'builder-video' : node.type === 'widget.icon' ? 'builder-icon' : node.type === 'widget.math' ? 'builder-math' : node.type === 'widget.list' ? 'builder-list' : node.type === 'widget.quote' ? 'builder-quote' : node.type === 'widget.divider' ? 'builder-divider' : node.type === 'widget.query-loop' ? 'builder-query-loop' : 'builder-spacer';
    element.classList.add(classToken);
    if (typeof node.props.className === 'string' && /^[A-Za-z0-9 _-]{0,120}$/.test(node.props.className)) for (const name of node.props.className.split(/\s+/).filter(Boolean)) element.classList.add(name);
    const activeStyles = state.breakpoint === 'desktop' ? node.props.styles : (node.props.responsiveStyles?.[state.breakpoint] || {});
    applySafeStyles(element, { ...(node.props.styles || {}), ...(activeStyles || {}) });
    element.dataset.nodeId = node.id; element.draggable = true;
    if (node.id === state.selectedNodeId) element.classList.add('selected');
    if (node.type === 'widget.heading' || node.type === 'widget.text') element.textContent = node.props.text || '';
    if (node.type === 'widget.button') { element.textContent = node.props.text || 'Button'; element.href = '#'; element.addEventListener('click', event => event.preventDefault()); element.title = node.props.url || '/'; }
    if (node.type === 'widget.list') { for (const item of (node.props.items || [])) { const li = document.createElement('li'); li.textContent = item; element.append(li); } }
    if (node.type === 'widget.quote') { const blockquote = document.createElement('blockquote'); blockquote.textContent = node.props.text || ''; element.append(blockquote); if (node.props.cite) { const cite = document.createElement('figcaption'); cite.textContent = node.props.cite; element.append(cite); } }
    if (node.type === 'widget.spacer') element.style.height = /^(?:[0-9]+(?:\.[0-9]+)?(?:px|rem|em|vh))$/.test(node.props.height || '') ? node.props.height : '24px';
    if (node.type === 'widget.query-loop') { element.classList.add('query-loop-preview'); element.style.gridTemplateColumns = `repeat(${Math.max(1, Math.min(4, Number(node.props.columns) || 3))}, minmax(0, 1fr))`; for (let i = 0; i < Math.min(3, Number(node.props.limit) || 3); i++) { const card = document.createElement('article'); card.className = 'query-loop-card'; const heading = document.createElement('strong'); heading.textContent = `Published ${node.props.contentType || 'post'} ${i + 1}`; const body = document.createElement('p'); body.textContent = 'Preview card · populated from published content at render time'; card.append(heading, body); element.append(card); } }
    if (node.type === 'widget.image') { element.src = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(node.props.assetId || '') ? `/media/${encodeURIComponent(node.props.assetId)}` : '/assets/image-placeholder.svg'; element.alt = node.props.alt || ''; element.title = `Asset ID: ${node.props.assetId || '(unset)'}`; }
    if (node.type === 'widget.video') { element.controls = node.props.controls !== false; element.preload = 'metadata'; element.title = node.props.title || 'Video'; element.poster = node.props.posterAssetId && /^[0-9a-f-]{36}$/i.test(node.props.posterAssetId) ? `/library/public/${encodeURIComponent(node.props.posterAssetId)}` : ''; if (/^[0-9a-f-]{36}$/i.test(node.props.assetId || '')) { const source = document.createElement('source'); source.src = `/library/public/${encodeURIComponent(node.props.assetId)}`; source.type = 'video/mp4'; element.append(source); } else element.textContent = 'Select a video asset in the Platform Hub'; }
    if (node.type === 'widget.icon') element.textContent = `Icon: ${node.props.iconName || 'check'} (size ${node.props.size || 24})`;
    if (node.type === 'widget.math') element.textContent = `Math: ${node.props.formula || 'x^2 + y^2 = z^2'}`;
    if (containerTypes.has(node.type)) {
      if (!node.children.length) { const hint = document.createElement('div'); hint.className = 'drop-hint'; hint.textContent = 'Drop components here'; hint.style.cssText = 'font-size:11px;color:#8b97aa;padding:8px;text-align:center;pointer-events:none'; element.append(hint); }
      else for (const child of node.children) element.append(renderNode(child));
    }
    element.addEventListener('click', event => { event.stopPropagation(); state.selectedNodeId = node.id; renderAll(); });
    element.addEventListener('dragstart', event => { event.stopPropagation(); state.dragNodeId = node.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-systemfabric-node', node.id); });
    element.addEventListener('dragover', event => { if (containerTypes.has(node.type)) { event.preventDefault(); event.dataTransfer.dropEffect = state.dragComponent ? 'copy' : 'move'; element.classList.add('drag-over'); } });
    element.addEventListener('dragleave', () => element.classList.remove('drag-over'));
    element.addEventListener('drop', event => {
      if (!containerTypes.has(node.type)) return; event.preventDefault(); event.stopPropagation(); element.classList.remove('drag-over');
      const component = event.dataTransfer.getData('application/x-systemfabric-component'); const nodeId = event.dataTransfer.getData('application/x-systemfabric-node');
      if (component) addComponent(component, node.id); else if (nodeId) moveNode(nodeId, node.id);
    });
    return element;
  }
  function renderCanvas() {
    const host = $('canvas-root'); host.replaceChildren();
    if (!state.document) return;
    if (!state.document.children.length) { const empty = document.createElement('div'); empty.className = 'empty-canvas'; empty.innerHTML = '<div class="empty-symbol">＋</div><h3>Start building your page</h3><p>Drag a component from the left, or click any component to add it.</p>'; host.append(empty); }
    else for (const node of state.document.children) host.append(renderNode(node));
    $('node-count').textContent = `${countNodes()} component${countNodes() === 1 ? '' : 's'}`;
  }
  function onRootDragOver(event) { if (event.target === $('canvas-root') || event.target.closest('#empty-canvas')) { event.preventDefault(); event.dataTransfer.dropEffect = state.dragComponent ? 'copy' : 'move'; } }
  function onRootDrop(event) {
    if (!(event.target === $('canvas-root') || event.target.closest('#empty-canvas'))) return;
    event.preventDefault(); const component = event.dataTransfer.getData('application/x-systemfabric-component'); const nodeId = event.dataTransfer.getData('application/x-systemfabric-node');
    if (component) addComponent(component); else if (nodeId) moveNode(nodeId, null);
  }
  function countNodes() { let count = 0; if (state.document) walkNodes(state.document.children, () => count++); return count; }
  function renderAll() {
    $('document-title').value = state.document?.title || '';
    renderCanvas(); renderSelection(); renderPageList(); updateVersionLabel(); updateUndoButtons(); updateWorkflowControls();
    $('dirty-status').textContent = state.dirty ? 'Unsaved changes' : 'All changes saved'; $('dirty-status').style.color = state.dirty ? '#e4bd7c' : '#72dba7';
  }
  function updateVersionLabel() { $('version-label').textContent = state.contentId ? `v${state.version || 1} · ${state.status.replace('_',' ')}` : 'New draft'; $('canvas-status').textContent = `${state.status.replace('_',' ')} editor`; }
  function renderSelection() {
    const node = findNode(state.selectedNodeId); $('settings-fields').replaceChildren(); $('style-fields').replaceChildren();
    $('selected-name').textContent = node ? labels[node.type] || node.type : 'No selection'; $('selected-id').textContent = node ? `ID: ${node.id}` : 'Choose a component on the canvas.';
    $('node-actions').classList.toggle('hidden', !node);
    if (node) {
      addField($('settings-fields'), 'Component ID', node.id, { disabled: true });
      if (node.type.startsWith('widget.')) {
        if (['widget.heading','widget.text','widget.button'].includes(node.type)) addField($('settings-fields'), 'Text', node.props.text || '', { textarea: true, onChange: value => setProp(node.id, 'text', value) });
        if (node.type === 'widget.heading') addField($('settings-fields'), 'Heading level', String(node.props.level || 2), { select: ['1','2','3','4','5','6'], onChange: value => setProp(node.id, 'level', Number(value)) });
        if (node.type === 'widget.button') addField($('settings-fields'), 'Destination URL', node.props.url || '/', { onChange: value => setProp(node.id, 'url', value) });
        if (node.type === 'widget.quote') { addField($('settings-fields'), 'Quote text', node.props.text || '', { textarea: true, onChange: value => setProp(node.id, 'text', value) }); addField($('settings-fields'), 'Attribution', node.props.cite || '', { onChange: value => setProp(node.id, 'cite', value) }); }
        if (node.type === 'widget.list') { addField($('settings-fields'), 'List items (one per line)', (node.props.items || []).join('\n'), { textarea: true, onChange: value => setProp(node.id, 'items', value.split(/\r?\n/).filter(item => item.length > 0).slice(0, 100)) }); addField($('settings-fields'), 'List style', node.props.ordered ? 'ordered' : 'unordered', { select: ['unordered','ordered'], onChange: value => setProp(node.id, 'ordered', value === 'ordered') }); }
        if (node.type === 'widget.spacer') addField($('settings-fields'), 'Height', node.props.height || '24px', { select: ['8px','16px','24px','32px','48px','64px','2rem','4rem'], onChange: value => setProp(node.id, 'height', value) });
        if (node.type === 'widget.query-loop') { addField($('settings-fields'), 'Source', node.props.source || 'latest-published', { select: ['latest-published'], onChange: value => setProp(node.id, 'source', value) }); addField($('settings-fields'), 'Content type', node.props.contentType || 'post', { onChange: value => setProp(node.id, 'contentType', value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 50) || 'post') }); addField($('settings-fields'), 'Maximum items', String(node.props.limit || 3), { select: ['1','2','3','4','6','8','9','12'], onChange: value => setProp(node.id, 'limit', Number(value)) }); addField($('settings-fields'), 'Columns', String(node.props.columns || 3), { select: ['1','2','3','4'], onChange: value => setProp(node.id, 'columns', Number(value)) }); addField($('settings-fields'), 'Empty label', node.props.emptyText || 'No items found.', { onChange: value => setProp(node.id, 'emptyText', value.slice(0, 500)) }); }
        if (node.type === 'widget.video') { addField($('settings-fields'), 'Video asset ID', node.props.assetId || '', { onChange: value => setProp(node.id, 'assetId', value) }); addField($('settings-fields'), 'Video title', node.props.title || '', { onChange: value => setProp(node.id, 'title', value.slice(0, 180)) }); addField($('settings-fields'), 'Poster asset ID', node.props.posterAssetId || '', { onChange: value => setProp(node.id, 'posterAssetId', value || null) }); addField($('settings-fields'), 'Controls', node.props.controls === false ? 'off' : 'on', { select: ['on','off'], onChange: value => setProp(node.id, 'controls', value === 'on') }); const link = document.createElement('a'); link.className='secondary'; link.href='/platform'; link.textContent='Open media library'; link.target='_blank'; link.rel='noopener noreferrer'; $('settings-fields').append(link); }
        if (node.type === 'widget.icon') { addField($('settings-fields'), 'Icon name', node.props.iconName || 'check', { onChange: value => setProp(node.id, 'iconName', value.replace(/[^A-Za-z0-9]/g, '').slice(0, 61) || 'check') }); addField($('settings-fields'), 'Icon size', String(node.props.size || 24), { select: ['16','20','24','32','40','48','64'], onChange: value => setProp(node.id, 'size', Number(value)) }); addField($('settings-fields'), 'Accessible title', node.props.title || '', { onChange: value => setProp(node.id, 'title', value.slice(0, 180)) }); }
        if (node.type === 'widget.math') { addField($('settings-fields'), 'TeX formula', node.props.formula || '', { textarea: true, onChange: value => setProp(node.id, 'formula', value.slice(0, 10000)) }); addField($('settings-fields'), 'Display mode', node.props.displayMode ? 'display' : 'inline', { select: ['inline','display'], onChange: value => setProp(node.id, 'displayMode', value === 'display') }); }
        if (node.type === 'widget.image') { addField($('settings-fields'), 'Asset ID', node.props.assetId || '', { onChange: value => setProp(node.id, 'assetId', value) }); addField($('settings-fields'), 'Alternative text', node.props.alt || '', { onChange: value => setProp(node.id, 'alt', value) }); const upload = document.createElement('button'); upload.type='button'; upload.className='secondary'; upload.textContent='Upload image'; upload.addEventListener('click',()=>{ const input=document.createElement('input'); input.type='file'; input.accept='image/png,image/jpeg,image/webp,image/gif'; input.onchange=()=>{ const file=input.files?.[0]; if(!file)return; if(file.size>10*1024*1024){notify('Image must be 10 MiB or smaller.',true);return;} const reader=new FileReader(); reader.onload=async()=>{ try{const dataUrl=String(reader.result||'');const dataBase64=dataUrl.split(',')[1]||'';const result=await api('/api/v1/media/uploads',{method:'POST',headers:siteHeaders(),body:JSON.stringify({siteId:state.siteId,dataBase64,mimeType:file.type,altText:findNode(node.id)?.props.alt||'',public:true})});setProp(node.id,'assetId',result.asset.id);notify('Image uploaded.');}catch(error){notify(error.message,true);} };reader.readAsDataURL(file); }; input.click(); }); $('settings-fields').append(upload); }
      }
      addField($('settings-fields'), 'CSS class names', node.props.className || '', { onChange: value => setProp(node.id, 'className', value) });
      $('move-up').disabled = !findNodeContainer(node.id) || findNodeContainer(node.id).index === 0;
      $('move-down').disabled = !findNodeContainer(node.id) || findNodeContainer(node.id).index === findNodeContainer(node.id).list.length - 1;
      $('duplicate-node').disabled = false; $('remove-node').disabled = false;
      const styles = state.breakpoint === 'desktop' ? (node.props.styles ||= {}) : ((node.props.responsiveStyles ||= {})[state.breakpoint] ||= {});
      for (const [key, label, type, values] of styleFields) {
        if (type === 'select') addField($('style-fields'), label, styles[key] || '', { select: values, placeholder: 'Default', onChange: value => setStyle(node.id, key, value) });
        else addField($('style-fields'), label, styles[key] || '', { placeholder: values, onChange: value => setStyle(node.id, key, value) });
      }
    }
  }
  function addField(host, label, value, options = {}) {
    const wrapper = document.createElement('label'); wrapper.textContent = label;
    let control;
    if (options.select) { control = document.createElement('select'); const blank = document.createElement('option'); blank.value = ''; blank.textContent = options.placeholder || 'Choose'; control.append(blank); for (const item of options.select) { const option = document.createElement('option'); option.value = item; option.textContent = item; control.append(option); } }
    else if (options.textarea) control = document.createElement('textarea');
    else { control = document.createElement('input'); control.type = 'text'; }
    control.value = value ?? ''; control.disabled = Boolean(options.disabled); if (options.placeholder) control.placeholder = options.placeholder; control.autocomplete = 'off';
    control.addEventListener('change', () => { if (options.onChange) options.onChange(control.value); }); wrapper.append(control); host.append(wrapper);
  }
  function setProp(nodeId, key, value) { mutate(() => { const node = findNode(nodeId); if (node) node.props[key] = value; }); }
  function setStyle(nodeId, key, value) {
    mutate(() => { const node = findNode(nodeId); if (!node) return; const styles = state.breakpoint === 'desktop' ? (node.props.styles ||= {}) : (((node.props.responsiveStyles ||= {})[state.breakpoint]) ||= {}); if (!value.trim()) delete styles[key]; else styles[key] = value.trim(); });
  }
  function updateWorkflowControls() {
    const draft = ['draft','archived'].includes(state.status); $('workflow-button').classList.toggle('hidden', !draft);
    $('workflow-button').textContent = state.status === 'archived' ? 'Reopen as draft' : 'Submit for review';
    $('approve-button').classList.toggle('hidden', state.status !== 'in_review' || !may('content:approve'));
    $('publish-button').classList.toggle('hidden', state.status !== 'approved' || !may('content:publish'));
    $('schedule-button').classList.toggle('hidden', state.status !== 'approved' || !may('content:publish'));
    $('unpublish-button').classList.toggle('hidden', state.status !== 'published' || !may('content:publish'));
    $('archive-button').classList.toggle('hidden', !may('content:archive'));
    $('save-button').disabled = !state.dirty && Boolean(state.contentId);
    $('save-button').textContent = state.contentId ? 'Save draft' : 'Save draft';
  }
  function activateInspector(tab) {
    for (const button of document.querySelectorAll('.inspector-tabs button')) button.classList.toggle('active', button.dataset.tab === tab);
    for (const panel of ['settings','styles','document']) $(`inspector-${panel}`).classList.toggle('hidden', panel !== tab);
  }
  async function saveDraft() {
    if (!state.document) state.document = makeInitialDocument();
    state.document.title = $('document-title').value.trim() || 'Untitled page';
    let slug = slugify($('page-slug').value || state.document.title); if (!slug) slug = 'untitled';
    const payload = { siteId: state.siteId, id: state.contentId || undefined, expectedVersion: state.contentId ? state.version : undefined, document: state.document, slug, locale: 'en', reviewed: true, note: 'Saved from SystemFabric Studio' };
    $('save-button').disabled = true; setStatus('Saving draft…');
    const previousRecoveryKey = recoveryKey();
    try {
      const result = await api('/api/v1/pages/drafts', { method: 'POST', headers: siteHeaders(), body: JSON.stringify(payload) });
      const content = result.content; state.contentId = content.id; state.version = content.version; state.status = content.status; state.dirty = false; state.lastSavedDocument = JSON.stringify(state.document);
      sessionStorage.removeItem(previousRecoveryKey); sessionStorage.removeItem(recoveryKey()); await loadPages(); renderAll(); setStatus(`Saved as draft · version ${state.version}`, false); notify('Draft saved. The published version, if any, remains unchanged.');
    } catch (error) { setStatus(error.message, true); notify(error.message, true); }
    finally { updateWorkflowControls(); }
  }
  async function workflow(action, extra = {}) {
    if (state.dirty) {
      const priorStatus = state.status; await saveDraft(); if (state.dirty) return;
      if (!['draft','archived'].includes(priorStatus) && action !== 'submit-review') { notify('Your changes were saved as a new draft. Submit it for review and approval before publishing again.', true); return; }
    }
    if (!state.contentId) { notify('Save the draft before using publication workflow actions.', true); return; }
    const confirmMessages = { publish: 'Publish this approved page now?', archive: 'Archive this page and remove its published route?', unpublish: 'Unpublish this page? The public route will stop resolving.' };
    if (confirmMessages[action] && !window.confirm(confirmMessages[action])) return;
    try {
      const result = await api(`/api/v1/pages/${state.contentId}/${action}`, { method: 'POST', headers: siteHeaders(), body: JSON.stringify({ siteId: state.siteId, expectedVersion: state.version, ...extra }) });
      state.status = result.content.status; state.version = result.content.version; await loadPages(); renderAll(); notify(`Workflow updated: ${state.status.replace('_',' ')}.`);
    } catch (error) { notify(error.message, true); }
  }
  async function openRevisions() {
    if (!state.contentId) return notify('Save the page first.', true);
    try {
      const result = await api(`/api/v1/pages/${state.contentId}/revisions?siteId=${encodeURIComponent(state.siteId)}`);
      const host = $('revision-list'); host.replaceChildren();
      if (!result.revisions.length) { host.textContent = 'No revisions recorded.'; }
      for (const revision of result.revisions) {
        const card = document.createElement('div'); card.className = 'revision-item'; const title = document.createElement('h3'); title.textContent = `Version ${revision.version}`;
        const meta = document.createElement('p'); meta.textContent = `${new Date(revision.created_at).toLocaleString()} · ${revision.change_summary || 'Saved revision'}`;
        const restore = document.createElement('button'); restore.className = 'secondary'; restore.textContent = 'Restore as a new draft'; restore.addEventListener('click', async () => {
          try { const output = await api(`/api/v1/pages/${state.contentId}/restore/${revision.version}`, { method: 'POST', headers: siteHeaders(), body: JSON.stringify({ siteId: state.siteId, expectedVersion: state.version }) });
            state.document = structuredClone(output.content.body); state.version = output.content.version; state.status = output.content.status; state.dirty = false; $('document-title').value = output.content.title; $('page-slug').value = output.content.slug; $('revisions-dialog').close(); renderAll(); notify(`Revision ${revision.version} restored into a new draft version.`); await loadPages();
          } catch (error) { notify(error.message, true); }
        }); card.append(title, meta, restore); host.append(card);
      }
      $('revisions-dialog').showModal();
    } catch (error) { notify(error.message, true); }
  }
  async function preview() {
    try {
      if (!state.document) throw new Error('Create or load a page first.');
      const check = await api('/api/v1/pages/validate', { method: 'POST', body: JSON.stringify({ document: state.document }) });
      if (!check.valid) throw new Error(check.errors.join('; '));
      const response = await fetch('/api/v1/preview', { method: 'POST', credentials: 'same-origin', headers: { ...siteHeaders(), 'content-type':'application/json', ...(csrfFromCookie() ? { 'x-csrf-token': csrfFromCookie() } : {}) }, body: JSON.stringify({ document: state.document }) });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Preview failed.'); }
      $('preview-frame').srcdoc = await response.text(); $('preview-dialog').showModal();
    } catch (error) { notify(error.message, true); }
  }
  function downloadJson() {
    if (!state.document) return;
    const blob = new Blob([JSON.stringify(state.document, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `${slugify(state.document.title) || 'page'}.systemfabric.json`; link.click(); URL.revokeObjectURL(url);
  }
  function createNewPage() {
    if (state.dirty && !window.confirm('Discard the current unsaved changes and create a new page?')) return;
    const discardedRecoveryKey = recoveryKey(); sessionStorage.removeItem(discardedRecoveryKey);
    state.document = makeInitialDocument(); state.contentId = null; state.version = null; state.status = 'draft'; state.selectedNodeId = null; state.dirty = true; state.undo = []; state.redo = []; state.slugTouched = false;
    $('document-title').value = state.document.title; $('page-slug').value = 'untitled'; state.pages = state.pages; renderAll(); markDirty(); notify('New draft started.');
  }
  function handlePalette() {
    for (const button of document.querySelectorAll('[data-component]')) {
      button.addEventListener('click', () => addComponent(button.dataset.component));
      button.addEventListener('dragstart', event => { state.dragComponent = button.dataset.component; state.dragNodeId = null; event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-systemfabric-component', button.dataset.component); });
      button.addEventListener('dragend', () => { state.dragComponent = null; document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); });
    }
  }

  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('login-status').textContent = 'Signing in…';
    try {
      const result = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: $('login-email').value, password: $('login-password').value }) });
      $('login-password').value = '';
      if (result.mfaRequired) { $('mfa-challenge-panel').classList.remove('hidden'); $('mfa-code').focus(); $('login-status').textContent = 'Verify your identity to finish signing in.'; return; }
      $('mfa-challenge-panel').classList.add('hidden'); await loadAuth();
    } catch (error) { $('login-status').textContent = error.message; }
  });
  $('mfa-verify').addEventListener('click', async () => {
    $('login-status').textContent = 'Verifying code…';
    try { await api('/api/v1/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ code: $('mfa-code').value.trim() }) }); $('mfa-code').value = ''; $('mfa-challenge-panel').classList.add('hidden'); await loadAuth(); }
    catch (error) { $('login-status').textContent = error.message; }
  });
  $('mfa-code').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('mfa-verify').click(); } });
  $('mfa-cancel').addEventListener('click', () => { $('mfa-challenge-panel').classList.add('hidden'); $('mfa-code').value = ''; $('login-status').textContent = 'Sign-in challenge canceled.'; });
  $('forgot-password').addEventListener('click', async () => {
    const email = window.prompt('Enter the email address for your SystemFabric account:'); if (!email) return;
    try { const result = await api('/api/v1/auth/password-reset/request', { method: 'POST', body: JSON.stringify({ email }) }); $('login-status').textContent = result.message || 'If an active account matches that address, reset instructions will be sent.'; }
    catch (error) { $('login-status').textContent = error.message; }
  });
  $('logout').addEventListener('click', async () => { try { await api('/api/v1/auth/logout', { method: 'POST', body: '{}' }); } catch {} sessionStorage.clear(); state.user = null; showLogin('You are signed out.'); });
  $('security-button').addEventListener('click', () => { $('security-dialog').showModal(); $('security-status').textContent = ''; $('mfa-enroll-panel').classList.add('hidden'); $('mfa-recovery-panel').classList.add('hidden'); $('mfa-disable-panel').classList.add('hidden'); });
  $('security-sessions').addEventListener('click', async () => {
    try {
      const result = await api('/api/v1/auth/sessions'); const host = $('security-session-list'); host.replaceChildren();
      if (!result.sessions.length) { host.textContent = 'No session details are available for this account context.'; return; }
      for (const session of result.sessions) {
        const row = document.createElement('div'); row.className = 'revision-item';
        const title = document.createElement('strong'); title.textContent = `${session.current ? 'Current session' : 'Session'} · ${new Date(session.createdAt).toLocaleString()}`;
        const meta = document.createElement('p'); meta.textContent = `Last used ${new Date(session.lastSeenAt).toLocaleString()} · expires ${new Date(session.expiresAt).toLocaleString()}${session.revokedAt ? ' · revoked' : ''}`; row.append(title, meta);
        if (!session.revokedAt) { const revoke = document.createElement('button'); revoke.className = 'danger'; revoke.textContent = session.current ? 'Revoke current session' : 'Revoke session'; revoke.addEventListener('click', async () => { try { await api(`/api/v1/auth/sessions/${session.id}`, { method: 'DELETE' }); if (session.current) { $('security-dialog').close(); showLogin('The current session was revoked. Sign in again.'); } else { revoke.disabled = true; revoke.textContent = 'Revoked'; } } catch (error) { $('security-status').textContent = error.message; } }); row.append(revoke); }
        host.append(row);
      }
    } catch (error) { $('security-status').textContent = error.message; }
  });
  $('mfa-enroll').addEventListener('click', async () => {
    try { const result = await api('/api/v1/auth/mfa/enroll', { method: 'POST', body: '{}' }); $('mfa-secret').textContent = result.enrollment.secret; $('mfa-otpauth').href = result.enrollment.otpauthUrl; $('mfa-enroll-panel').classList.remove('hidden'); $('security-status').textContent = 'Scan the URI or enter the secret manually, then verify a current code.'; }
    catch (error) { $('security-status').textContent = error.message; }
  });
  $('mfa-confirm').addEventListener('click', async () => {
    try { const result = await api('/api/v1/auth/mfa/confirm', { method: 'POST', body: JSON.stringify({ code: $('mfa-enroll-code').value.trim() }) }); $('mfa-enroll-panel').classList.add('hidden'); $('mfa-recovery-codes').textContent = result.recoveryCodes.join('\n'); $('mfa-recovery-panel').classList.remove('hidden'); $('security-status').textContent = 'MFA enabled. Save the recovery codes now.'; }
    catch (error) { $('security-status').textContent = error.message; }
  });
  $('mfa-disable').addEventListener('click', () => $('mfa-disable-panel').classList.toggle('hidden'));
  $('mfa-disable-confirm').addEventListener('click', async () => {
    try { await api('/api/v1/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password: $('mfa-disable-password').value, code: $('mfa-disable-code').value.trim() }) }); $('security-dialog').close(); sessionStorage.clear(); showLogin('MFA was disabled and all sessions were revoked. Sign in again.'); }
    catch (error) { $('security-status').textContent = error.message; }
  });
  $('site-select').addEventListener('change', async () => { if (state.dirty && !window.confirm('Switch site and discard local unsaved changes?')) { $('site-select').value = state.siteId; return; } state.siteId = $('site-select').value; sessionStorage.setItem('sf-site-id', state.siteId); state.contentId = null; state.document = null; state.dirty = false; await loadPages(); createNewPage(); });
  $('new-page').addEventListener('click', createNewPage); $('page-search').addEventListener('input', renderPageList);
  $('document-title').addEventListener('change', () => { if (!state.document) return; snapshot(); state.document.title = $('document-title').value; if (!state.slugTouched) $('page-slug').value = slugify(state.document.title); markDirty(); renderAll(); });
  $('page-slug').addEventListener('input', () => { state.slugTouched = true; markDirty(); });
  $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo); $('save-button').addEventListener('click', () => void saveDraft());
  $('preview-button').addEventListener('click', () => void preview()); $('workflow-button').addEventListener('click', () => void workflow('submit-review'));
  $('publish-button').addEventListener('click', () => void workflow('publish')); $('approve-button').addEventListener('click', () => void workflow('approve'));
  $('schedule-button').addEventListener('click', () => { const local = window.prompt('Enter publication date and time in ISO format (for example 2027-01-15T10:00:00-06:00):'); if (local) void workflow('schedule', { scheduledAt: local }); });
  $('archive-button').addEventListener('click', () => void workflow('archive')); $('unpublish-button').addEventListener('click', () => void workflow('unpublish'));
  $('more-button').addEventListener('click', () => $('more-menu').classList.toggle('hidden'));
  $('revisions-button').addEventListener('click', () => { $('more-menu').classList.add('hidden'); void openRevisions(); }); $('show-revisions').addEventListener('click', openRevisions);
  $('json-button').addEventListener('click', () => { $('json-editor').value = JSON.stringify(state.document, null, 2); $('json-dialog').showModal(); $('more-menu').classList.add('hidden'); });
  $('download-json').addEventListener('click', downloadJson); $('reload-document').addEventListener('click', () => { if (window.confirm('Discard all local changes?')) { if (state.contentId) void loadPage(state.contentId); else createNewPage(); } });
  $('apply-json').addEventListener('click', async () => {
    try {
      const value = JSON.parse($('json-editor').value); const validation = await api('/api/v1/pages/validate', { method: 'POST', body: JSON.stringify({ document: value }) });
      if (!validation.valid) throw new Error(validation.errors.join('; '));
      snapshot(); state.document = value; state.selectedNodeId = null; state.dirty = true; markDirty(); renderAll(); $('json-dialog').close(); notify('Validated JSON applied to the canvas.');
    } catch (error) { notify(error.message, true); }
  });
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
  for (const button of document.querySelectorAll('.inspector-tabs button')) button.addEventListener('click', () => activateInspector(button.dataset.tab));
  $('responsive-breakpoint').addEventListener('change', () => { state.breakpoint = $('responsive-breakpoint').value; renderAll(); });
  for (const button of document.querySelectorAll('[data-viewport]')) button.addEventListener('click', () => {
    state.breakpoint = button.dataset.viewport; $('responsive-breakpoint').value = state.breakpoint; for (const item of document.querySelectorAll('[data-viewport]')) item.classList.toggle('active', item === button);
    $('canvas-frame').classList.remove('desktop','tablet','mobile'); $('canvas-frame').classList.add(state.breakpoint); renderAll();
  });
  $('duplicate-node').addEventListener('click', () => duplicateNode(state.selectedNodeId)); $('move-up').addEventListener('click', () => shiftNode(state.selectedNodeId, -1)); $('move-down').addEventListener('click', () => shiftNode(state.selectedNodeId, 1)); $('remove-node').addEventListener('click', () => { if (window.confirm('Remove this component and all its nested children?')) removeNode(state.selectedNodeId); });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveDraft(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  });
  window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
  handlePalette();
  $('canvas-root').addEventListener('dragover', onRootDragOver); $('canvas-root').addEventListener('drop', onRootDrop);
  loadAuth();
})();
