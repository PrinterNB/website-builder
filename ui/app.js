'use strict';

/* ==========================================================================
   Website Builder editor UI — app.js
   Endpoints this UI calls (the server is written to the same contract):
     GET  /api/project                (load)
     POST /api/project                (autosave; JSON body = whole model)
     GET  /preview/<key>.html?v=<v>   (iframe src, cache-busted)
     POST /api/upload?name=<file>     (raw File bytes as fetch body, NO multipart)
     POST /api/export                 (export button)
     <a href="/api/export/zip">       (browser download link)
     <a href="/export-view">          (browser link to the file listing)

   Layout (this revision): the preview fills the window; everything else lives in
   one collapsible left sidebar with accordion groups in Wix order:
     Add Elements · Add Sections · Pages & Menu · Site Design · My Designs ·
     Page Structure · (Export & Reset pinned at the bottom of the panel)

   Sections:
     1 helpers + icons · 2 model + autosave · 3 block cards (fields/build/render/reorder)
     4 add elements chips + add sections presets · 5 pages rail + menu panels + page ops
     6 site design (theme knobs + presets + header/footer text) · 7 my designs
     8 sidebar chrome (groups, collapse, device widths) · 9 preview
     10 upload · 11 export + reset · 12 boot
   ========================================================================== */

/* ---------- 1. helpers ---------- */

var statusBar = document.querySelector('#status-bar');

const SIDEBAR = document.querySelector('#sidebar');
const SIDE_BODY = document.querySelector('#side-body');
const FRAME = document.querySelector('#preview-frame');
const FRAME_WRAP = document.querySelector('#frame-wrap');
const ASSET_DATALIST = document.querySelector('#asset-options');
const PAGE_DATALIST = document.querySelector('#page-options');
const ADD_BODY = document.querySelector('#b-add');
const SEC_BODY = document.querySelector('#b-sections');
const PAGE_BODY = document.querySelector('#b-pages');
const MENU_BODY = document.querySelector('#b-menu');
const DESIGN_BODY = document.querySelector('#b-design');
const DESIGN_BODY2 = document.querySelector('#b-designs');
const CARD_AREA = document.querySelector('#b-structure');
const EXPORT_PANEL = document.querySelector('#b-export');
const CANVAS_BAR = document.querySelector('#canvas-bar');
const DEVICE_READ = document.querySelector('#device-read');

var uidSeq = 0;
function nextId(base) { uidSeq += 1; return base + '-u' + uidSeq; }

function mkEl(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function setAttr(node, name, v) { node.setAttribute(name, v); return node; }
function setAttrGet(node, name) { return node.getAttribute(name); }
function deepCopy(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; } }

function val(node) {
  if (!node) return '';
  var t = node.tagName;
  if (t === 'DIV') {
    var s = node.innerText || '';
    s = s.replace(/ /g, ' ');
    s = s.replace(/[ \t]+\n/g, '\n');
    return s.replace(/^[\n]+|[\n]+$/g, '');
  }
  if (t === 'SELECT') {
    var i = node.selectedIndex;
    if (i == null || i < 0) i = 0;
    var o = node.options[i];
    return (o && o.value !== '') ? o.value : (o ? (o.textContent || '') : '');
  }
  return node.value == null ? '' : String(node.value);
}

function setStatus(prefix, msg) {
  if (!statusBar) return;
  statusBar.innerHTML = '';
  if (prefix) {
    var b = mkEl('b');
    b.textContent = prefix;
    statusBar.appendChild(b);
  }
  if (msg) {
    var s = mkEl('span');
    s.textContent = ' ' + msg;
    statusBar.appendChild(s);
  }
}

var SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
function slugProblem(slug) {
  if (!SLUG_RE.test(slug)) {
    if (!/^[a-z]/.test(slug)) return 'key must start with a-z';
    if (!/^[a-z0-9-]+$/.test(slug)) return 'key may only contain a-z 0-9 and hyphens';
    if (slug.length > 32) return 'key must be at most 32 chars';
    return 'invalid key: ' + slug;
  }
  return null;
}
function isHexColor(v) { return typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v); }
function blockName(b) { return (b && typeof b === 'object' && typeof b.type === 'string') ? b.type : 'unknown'; }
function typeNameLabel(t) { return TYPE_LABELS[t] || t; }

/* inline SVG icons (no icon font, nothing external) */
var ICONS = {
  heading: '<text x="4" y="15" font-size="13" fill="currentColor" stroke="none">H</text>',
  paragraph: '<text x="5" y="15" font-size="14" fill="currentColor" stroke="none">¶</text>',
  image: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7" cy="8" r="1.6" fill="currentColor" stroke="none"/><path d="M5 14l4-4 3 3 2-2 3 3"/>',
  button: '<rect x="3" y="7" width="14" height="7" rx="3.5"/>',
  image_button: '<rect x="3" y="3" width="14" height="8" rx="1"/><rect x="5" y="13" width="10" height="5" rx="2.5"/>',
  strip: '<rect x="2" y="7" width="16" height="6" rx="2"/><path d="M5 10h10"/>',
  divider: '<path d="M3 10h14" stroke-dasharray="3 2"/>',
  quote: '<path d="M6 5v8M13 5v8"/>',
  box: '<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M7 8h6M7 11h4"/>',
  gallery: '<rect x="2" y="4" width="7" height="7" rx="1"/><rect x="11" y="4" width="7" height="7" rx="1"/><rect x="2" y="13" width="7" height="4" rx="1"/><rect x="11" y="13" width="7" height="4" rx="1"/>',
  video: '<rect x="3" y="5" width="14" height="10" rx="1.5"/><path d="M9 8L13 10L9 12Z" fill="currentColor" stroke="none"/>',
  list: '<path d="M8 6h8M8 11h8M8 16h8"/><circle cx="4.6" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.6" cy="11" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.6" cy="16" r="1.2" fill="currentColor" stroke="none"/>',
  anchor: '<circle cx="10" cy="5" r="2"/><path d="M10 7v8"/><path d="M5 14q5 4 10 0"/>',
  custom_html: '<path d="M7 6L3 10L7 14"/><path d="M13 6L17 10L13 14"/><path d="M11 6L9 14"/>',
  social_links: '<circle cx="5" cy="10" r="1.8" fill="currentColor" stroke="none"/><circle cx="14" cy="5" r="1.8" fill="currentColor" stroke="none"/><circle cx="14" cy="15" r="1.8" fill="currentColor" stroke="none"/><path d="M7 9l5-3M7 11l5 3"/>',
  contact_card: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M6 8h8M6 11h6"/>',
  design: '<rect x="3" y="6" width="14" height="10" rx="1.5"/><path d="M5 4h6v2"/>',
  welcome: '<rect x="3" y="4" width="14" height="5" rx="1"/><path d="M5 12h9M6 15h7"/><rect x="4" y="16" width="9" height="3" rx="1.5"/>',
  about: '<circle cx="6" cy="6" r="2.4"/><path d="M4 12h8M4 15h6"/><rect x="12" y="9" width="6" height="6" rx="1"/>',
  features: '<path d="M4 5h11M7 9h8M7 13h8"/><rect x="12" y="15" width="6" height="4" rx="1"/>',
  pricing: '<path d="M4 5h11"/><circle cx="5.5" cy="9" r="1.1" fill="currentColor" stroke="none"/><circle cx="5.5" cy="13" r="1.1" fill="currentColor" stroke="none"/><path d="M8 9h7M8 13h7"/><rect x="6" y="16" width="8" height="3" rx="1.5"/>',
  promo: '<rect x="2" y="5" width="16" height="5" rx="1.5"/><path d="M4 13h9"/><rect x="5" y="16" width="7" height="3" rx="1.5"/>',
  contact: '<rect x="3" y="4" width="9" height="10" rx="1.5"/><path d="M5 7h5M5 10h4"/><circle cx="15" cy="14" r="1.8" fill="currentColor" stroke="none"/><path d="M12 15h6"/>'
};
function iconNode(name) {
  var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.6');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICONS[name] || '';
  return s;
}

var TYPE_LABELS = {
  heading: 'Heading', paragraph: 'Paragraph', image: 'Image', button: 'Button',
  image_button: 'Photo button', strip: 'Strip', divider: 'Divider', quote: 'Quote',
  box: 'Box', gallery: 'Gallery', video: 'Video', list: 'List', anchor: 'Anchor',
  custom_html: 'Custom HTML', social_links: 'Social links', contact_card: 'Contact card'
};

/* ---------- 2. model + autosave ---------- */

var model = null;
var currentKey = null;
var saveV = 0;
var dirty = false;
var saveTimer = null;
var SAVE_DEBOUNCE_MS = 400;

var liveCards = [];
var selectedIdx = null;
var dragFrom = null;
var dragHover = null;
var panelFields = [];
var PANEL_CFGS = [];
var uploadedNames = {};
var pendingNotes = {};

function currentPage() {
  if (!model) return null;
  var i = indexOfPage(currentKey);
  return i >= 0 ? model.pages[i] : null;
}
function indexOfPage(key) {
  if (!model) return -1;
  for (var i = 0; i < model.pages.length; i++) if (model.pages[i].key === key) return i;
  return -1;
}
function pageKeys() {
  var out = [];
  if (model) for (var i = 0; i < model.pages.length; i++) out.push(String(model.pages[i].key));
  return out;
}
function firstAsset() {
  if (!model || !model.assets) return '';
  for (var k in model.assets) return k;
  return '';
}
function firstAssetNames(n) {
  var out = [];
  if (!model || !model.assets) return out;
  for (var k in model.assets) { out.push(k); if (out.length >= n) break; }
  return out;
}
function isButtonShape(o) {
  return o && typeof o === 'object' && typeof o.label === 'string'
    && ((typeof o.to === 'string') || (typeof o.url === 'string'));
}
function setToFields(obj, patch) {
  if (patch.to != null) {
    obj.label = patch.label; obj.to = patch.to;
    if ('url' in obj) delete obj.url;
    if ('newtab' in obj) delete obj.newtab;
  } else {
    obj.label = patch.label; obj.url = patch.url; obj.newtab = !!patch.newtab;
    if ('to' in obj) delete obj.to;
  }
}

function markDirty() { dirty = true; scheduleSave(); }
function scheduleSave() {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(performSave, SAVE_DEBOUNCE_MS);
}
function cancelSaveTimer() {
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
}

function syncFields() {
  for (var ci = 0; ci < liveCards.length; ci++) {
    var c = liveCards[ci];
    var i;
    for (i = 0; i < c.uiFields.length; i++) { try { c.uiFields[i](); } catch (e) {} }
    for (i = 0; i < c.rowCommits.length; i++) { try { c.rowCommits[i](); } catch (e) {} }
  }
  for (var pi = 0; pi < panelFields.length; pi++) { try { panelFields[pi](); } catch (e) {} }
  for (var pc = 0; pc < PANEL_CFGS.length; pc++) {
    var cfg = PANEL_CFGS[pc];
    if (!cfg.rowCommits) continue;
    for (var r = 0; r < cfg.rowCommits.length; r++) { try { cfg.rowCommits[r](); } catch (e) {} }
  }
}

async function performSave() {
  saveTimer = null;
  if (!dirty || !model) return;
  syncFields();
  setStatus('Saving', 'posting changed model to POST /api/project');
  try {
    var r = await fetch('/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(model)
    });
    if (r.status === 200) {
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('application/json') === -1) throw new Error('save answered non-JSON: ' + ct);
      var j = await r.json();
      if (!j || j.ok !== true) throw new Error('save answered ok !== true');
      dirty = false;
      saveV += 1;
      setStatus('Autosaved', 'preview refreshed to v' + saveV);
      refreshPreview();
    } else if (r.status === 400) {
      var bad = null;
      try {
        var ct4 = (r.headers.get('content-type') || '').toLowerCase();
        if (ct4.indexOf('application/json') !== -1) bad = await r.json();
      } catch (e2) {}
      var errs = (bad && Array.isArray(bad.errors)) ? bad.errors.map(String) : ['server rejected the model'];
      setStatus('Save rejected — errors below; edit something to retry', errs.join('  ·  '));
    } else {
      setStatus('Save error', 'HTTP ' + r.status + ' on POST /api/project');
    }
  } catch (err) {
    setStatus('Save error', String(err) + ' — will retry on next edit');
  }
}

function blankPage(key, title) {
  return { key: key, title: title, header_override: null, footer_override: null, blocks: [] };
}
function normalizeModel(m) {
  if (!m || typeof m !== 'object') m = {};
  if (!m.meta || typeof m.meta !== 'object') m.meta = {};
  if (!m.meta.name) m.meta.name = 'My Site';
  if (!m.meta.language) m.meta.language = 'en';
  if (!m.theme || typeof m.theme !== 'object') m.theme = {};
  if (!m.theme.accent) m.theme.accent = '#4f8b7e';
  if (m.theme.background == null) m.theme.background = '#f9f9f7';
  if (m.theme.text == null) m.theme.text = '#1b1e20';
  if (!m.theme.font) m.theme.font = 'sans';
  if (typeof m.theme.content_width !== 'number') m.theme.content_width = 760;
  if (!m.header || typeof m.header !== 'object') m.header = {};
  if (m.header.title == null) m.header.title = String(m.meta.name);
  if (m.header.subtitle == null) m.header.subtitle = '';
  if (!('logo_asset' in m.header)) m.header.logo_asset = null;
  if (!Array.isArray(m.header.buttons)) m.header.buttons = [];
  if (!m.footer || typeof m.footer !== 'object') m.footer = {};
  if (m.footer.text == null) m.footer.text = '';
  if (!Array.isArray(m.footer.buttons)) m.footer.buttons = [];
  if (!Array.isArray(m.pages)) m.pages = [];
  if (!Array.isArray(m.designs)) m.designs = [];
  var cleanDesigns = [];
  for (var di = 0; di < m.designs.length; di++) {
    var d = m.designs[di];
    if (!d || typeof d !== 'object' || !Array.isArray(d.blocks)) continue;
    if (d.name == null) d.name = String('design ' + (di + 1));
    cleanDesigns.push({ name: String(d.name), blocks: d.blocks });
  }
  m.designs = cleanDesigns;
  var seen = {};
  for (var i = 0; i < m.pages.length; i++) {
    var p = m.pages[i];
    if (!p || typeof p !== 'object') p = blankPage('page-' + i, 'Page ' + i);
    m.pages[i] = p;
    if (!p.key || typeof p.key !== 'string') p.key = 'page-' + i;
    if (seen[p.key]) p.key = p.key + '-x' + i;
    seen[p.key] = true;
    if (p.title == null) p.title = String(p.key);
    if (!p.header_override && 'header_override' in p) p.header_override = null;
    if (!p.footer_override && 'footer_override' in p) p.footer_override = null;
    if (!Array.isArray(p.blocks)) p.blocks = [];
  }
  if (m.pages.length === 0) m.pages.push(blankPage('home', 'Home'));
  if (!m.assets || typeof m.assets !== 'object') m.assets = {};
  return m;
}

/* ---------- 3. block cards ---------- */

var KNOWN_TYPES = ['heading', 'paragraph', 'image', 'button', 'image_button',
                   'divider', 'quote', 'contact_card', 'social_links', 'custom_html',
                   'strip', 'gallery', 'box', 'list', 'video', 'anchor'];

function watch(node, fn) {
  var run = function () { try { fn(); } catch (e) { setStatus('UI error', String(e)); } markDirty(); };
  node.addEventListener('input', run);
  node.addEventListener('change', run);
}
function ceDiv() {
  var d = mkEl('div', 'field');
  setAttr(d, 'contenteditable', 'true');
  return d;
}
function makeSelect(cls, opts) {
  var s = mkEl('select', 'field ' + cls);
  for (var i = 0; i < opts.length; i++) {
    var o = mkEl('option');
    setAttr(o, 'value', String(opts[i][0]));
    o.textContent = String(opts[i][1]);
    s.appendChild(o);
  }
  return s;
}
function makeTextField(card, obj, key, labelText, hint) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = labelText + (hint ? ' ' + hint : '');
  var f = ceDiv();
  f.innerText = String(obj[key] == null ? '' : obj[key]);
  var commit = function () { obj[key] = val(f); };
  card.uiFields.push(commit);
  watch(f, commit);
  f.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === undefined || k === null) return;
    if (k.length === 1 || k === 'Backspace' || k === 'Delete' || k === 'Enter') { commit(); markDirty(); }
  });
  return [lab, f];
}
function makeTextarea(card, obj, key, labelText) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = labelText;
  var ta = mkEl('textarea', 'field ta-' + key);
  ta.value = String(obj[key] == null ? '' : obj[key]);
  var commit = function () { obj[key] = ta.value; };
  card.uiFields.push(commit);
  watch(ta, commit);
  return [lab, ta];
}
function makeSelectField(card, obj, key, opts, labelText, numeric) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = labelText;
  var s = makeSelect('', opts);
  var cur = String(obj[key] == null ? opts[0][0] : obj[key]);
  var found = false;
  for (var i = 0; i < s.options.length; i++) {
    if (s.options[i].value === cur) { s.selectedIndex = i; found = true; }
  }
  if (!found) s.selectedIndex = 0;
  var commit = function () {
    var v = val(s);
    obj[key] = numeric ? Number(v) : v;
  };
  card.uiFields.push(commit);
  watch(s, commit);
  return [lab, s];
}
function makeTextFieldInput(card, obj, key, labelText, datalistId) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = labelText;
  var inp = mkEl('input', 'field ta-' + key);
  setAttr(inp, 'type', 'text');
  if (datalistId) setAttr(inp, 'list', datalistId);
  inp.value = String(obj[key] == null ? '' : obj[key]);
  var commit = function () { obj[key] = val(inp); };
  card.uiFields.push(commit);
  watch(inp, commit);
  return [lab, inp];
}
function makeBoolField(card, obj, key, labelText) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = labelText;
  var cb = mkEl('input', 'field ta-' + key);
  setAttr(cb, 'type', 'checkbox');
  cb.checked = !!obj[key];
  var commit = function () { obj[key] = !!cb.checked; };
  card.uiFields.push(commit);
  watch(cb, commit);
  return [lab, cb];
}
function makeHexField(card, obj, key, labelText) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = labelText;
  var inp = mkEl('input', 'field ta-hex');
  setAttr(inp, 'type', 'text');
  inp.value = String(obj[key] == null ? '' : obj[key]);
  var commit = function () {
    var v = val(inp).trim();
    if (!isHexColor(v)) {
      if (v !== '') {
        card.note.textContent = 'Hex refused: use #abc or #aabbcc — the last good value (' + String(obj[key]) + ') is kept.';
        pendingNotes[card.idx] = card.note.textContent;
      }
      return;
    }
    obj[key] = v;
  };
  card.uiFields.push(commit);
  watch(inp, commit);
  return [lab, inp];
}
function makeSlugField(card, obj, key, labelText, allowEmpty) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = labelText;
  var inp = mkEl('input', 'field ta-' + key);
  setAttr(inp, 'type', 'text');
  inp.value = String(obj[key] == null ? '' : obj[key]);
  var commit = function () {
    var v = val(inp).trim();
    if (v === '') {
      if (allowEmpty) { if (key in obj) delete obj[key]; return; }
      card.note.textContent = 'Anchor name must not be empty — kept the previous name.';
      pendingNotes[card.idx] = card.note.textContent;
      return;
    }
    var prob = slugProblem(v);
    if (prob) {
      card.note.textContent = 'Anchor name refused: ' + prob;
      pendingNotes[card.idx] = card.note.textContent;
      setStatus('Anchor name refused', prob);
      return;
    }
    obj[key] = v;
  };
  card.uiFields.push(commit);
  watch(inp, commit);
  return [lab, inp];
}
function makeUploadBox(card, idx, target) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = target === 'assets'
    ? 'or drag a new file here (uploads and joins this gallery)'
    : 'or drag a new file here (uploads straight away)';
  var inp = mkEl('input', 'field upload-box');
  setAttr(inp, 'type', 'file');
  setAttr(inp, 'data-card', String(idx));
  setAttr(inp, 'data-idx', String(idx));
  card.uploadBox = inp;
  card.uploadTarget = target || 'block';
  inp.addEventListener('change', function () { uploadFromFile(card); });
  return [lab, inp];
}

function makeRows(card, obj, key, spec, addDefault, rowWord) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = key + ' (repeatable)';
  var wrap = mkEl('div', 'rows-wrap ' + key);
  card.rowCommits = [];

  function redraw() {
    wrap.innerHTML = '';
    card.rowCommits = [];
    if (!Array.isArray(obj[key])) obj[key] = [];
    var arr = obj[key];
    for (var i = 0; i < arr.length; i++) {
      if (!arr[i] || typeof arr[i] !== 'object') arr[i] = {};
      var rw = mkEl('div', 'row');
      setAttr(rw, 'data-rowidx', String(i));
      var felMap = [];
      for (var si = 0; si < spec.length; si++) {
        var fk = spec[si];
        var rl = mkEl('span', 'row-label');
        rl.textContent = fk + ':';
        var fel = mkEl('div', 'row-field');
        setAttr(fel, 'contenteditable', 'true');
        setAttr(fel, 'data-rfk', fk);
        fel.innerText = String(arr[i][fk] == null ? '' : arr[i][fk]);
        rw.appendChild(rl);
        rw.appendChild(fel);
        felMap.push(fel);
      }
      var commit = function () { rowCommit(rw, obj, key, spec); };
      card.rowCommits.push(commit);
      for (var mi = 0; mi < felMap.length; mi++) watch(felMap[mi], commit);
      var rm = mkEl('button', 'row-remove');
      rm.textContent = 'remove';
      rm.addEventListener('click', function () {
        syncFields();
        var a2 = obj[key];
        var at = Number(setAttrGet(rw, 'data-rowidx'));
        if (!isNaN(at) && at >= 0 && at < a2.length) {
          a2.splice(at, 1);
          dirty = true; markDirty();
        }
        redraw();
      });
      rw.appendChild(rm);
      wrap.appendChild(rw);
    }
    var add = mkEl('button', 'rows-add ' + key);
    add.textContent = '+ add ' + rowWord;
    add.addEventListener('click', function () {
      syncFields();
      obj[key].push(deepCopy(addDefault));
      dirty = true; markDirty();
      redraw();
    });
    wrap.appendChild(add);
  }
  redraw();
  return [lab, wrap];
}
function rowCommit(rw, obj, key, spec) {
  if (!Array.isArray(obj[key])) return;
  var i = Number(setAttrGet(rw, 'data-rowidx'));
  if (isNaN(i) || i < 0 || i >= obj[key].length) return;
  var o = obj[key][i];
  for (var si = 0; si < spec.length; si++) {
    var fk = spec[si];
    var fel = rw.querySelector('[data-rfk="' + fk + '"]');
    if (!fel) continue;
    var v = val(fel);
    var cur = o[fk];
    if ((cur == null && v === '') || cur === v) continue;
    o[fk] = v;
  }
}

/* string arrays (box lines, list items) */
function stringRowCommit(fel, arr, i) {
  if (i < 0 || i >= arr.length) return;
  arr[i] = val(fel);
}
function makeStringRows(card, obj, key, blankText, rowWord) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = key + ' (repeatable)';
  var wrap = mkEl('div', 'rows-wrap ' + key);

  function redraw() {
    wrap.innerHTML = '';
    card.rowCommits = [];
    if (!Array.isArray(obj[key])) obj[key] = [];
    var arr = obj[key];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] == null || typeof arr[i] !== 'string') arr[i] = String(arr[i] == null ? '' : arr[i]);
      var rw = mkEl('div', 'row');
      setAttr(rw, 'data-rowidx', String(i));
      var rl = mkEl('span', 'row-label');
      rl.textContent = rowWord + ':';
      var fel = mkEl('div', 'row-field');
      setAttr(fel, 'contenteditable', 'true');
      setAttr(fel, 'data-rowidx', String(i));
      fel.innerText = String(arr[i]);
      rw.appendChild(rl);
      rw.appendChild(fel);
      var commit = function () { stringRowCommit(fel, arr, i); };
      card.rowCommits.push(commit);
      watch(fel, commit);
      var rm = mkEl('button', 'row-remove');
      rm.textContent = 'remove';
      rm.addEventListener('click', function () {
        syncFields();
        var at = Number(setAttrGet(rw, 'data-rowidx'));
        if (!isNaN(at) && at >= 0 && at < arr.length) {
          arr.splice(at, 1);
          dirty = true; markDirty();
        }
        redraw();
      });
      rw.appendChild(rm);
      wrap.appendChild(rw);
    }
    var add = mkEl('button', 'rows-add ' + key);
    add.textContent = '+ add ' + rowWord;
    add.addEventListener('click', function () {
      syncFields();
      obj[key].push(blankText);
      dirty = true; markDirty();
      redraw();
    });
    wrap.appendChild(add);
  }
  redraw();
  return [lab, wrap];
}

/* gallery assets: name rows fed by the asset datalist + the upload flow */
var assetRowSeq = 0;
function makeAssetRows(card, obj, key) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = 'assets (names from the asset list, repeatable)';
  var wrap = mkEl('div', 'rows-wrap ' + key);
  var liveInputs = [];
  assetRowSeq += 1;
  var rowBase = 'g' + assetRowSeq;

  function commitAssets() {
    if (!Array.isArray(obj[key])) obj[key] = [];
    var out = [];
    for (var q = 0; q < liveInputs.length; q++) {
      var v = val(liveInputs[q]).trim();
      if (v !== '') out.push(v);
    }
    obj[key] = out;
  }

  function redraw() {
    wrap.innerHTML = '';
    liveInputs = [];
    if (!Array.isArray(obj[key])) obj[key] = [];
    var arr = obj[key];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] == null || typeof arr[i] !== 'string') arr[i] = String(arr[i] == null ? '' : arr[i]);
      var rw = mkEl('div', 'row');
      setAttr(rw, 'data-rowidx', String(i));
      var rl = mkEl('span', 'row-label');
      rl.textContent = 'asset:';
      var inp = mkEl('input', 'row-field ta-asset');
      setAttr(inp, 'type', 'text');
      setAttr(inp, 'list', 'asset-options');
      inp.value = String(arr[i]);
      rw.appendChild(rl);
      rw.appendChild(inp);
      watch(inp, commitAssets);
      var rm = mkEl('button', 'row-remove');
      rm.textContent = 'remove';
      rm.addEventListener('click', function () {
        syncFields();
        var at = Number(setAttrGet(rw, 'data-rowidx'));
        if (!isNaN(at) && at >= 0 && at < arr.length) {
          arr.splice(at, 1);
          dirty = true; markDirty();
        }
        redraw();
      });
      rw.appendChild(rm);
      wrap.appendChild(rw);
      liveInputs.push(inp);
    }
    var add = mkEl('button', 'rows-add ' + key);
    add.textContent = '+ add asset';
    add.addEventListener('click', function () {
      syncFields();
      obj[key].push('');
      dirty = true; markDirty();
      redraw();
    });
    wrap.appendChild(add);
  }
  redraw();
  return [lab, wrap];
}

/* target fields shared by button + image_button blocks (optional page anchor) */
function addTargetFields(card, block, labelEl) {
  var labMode = mkEl('span', 'field-label');
  labMode.textContent = 'link target — choose one: page key (datalist lists pages), or URL:';
  var modeSel = makeSelect('', [['page', 'to page key'], ['url', 'external URL']]);
  var toIn = mkEl('input', 'field ta-to');
  setAttr(toIn, 'type', 'text');
  setAttr(toIn, 'list', 'page-options');
  toIn.value = (typeof block.to === 'string') ? block.to : '';
  var urlIn = mkEl('input', 'field ta-url');
  setAttr(urlIn, 'type', 'text');
  urlIn.value = (typeof block.url === 'string') ? block.url : '';
  var ntLab = mkEl('span', 'field-label');
  ntLab.textContent = 'new tab (url mode only)';
  var nt = mkEl('input', 'field ta-newtab');
  setAttr(nt, 'type', 'checkbox');
  nt.checked = !!block.newtab;
  var anLab = mkEl('span', 'field-label');
  anLab.textContent = 'jump to anchor on the page (optional, slug):';
  var anIn = mkEl('input', 'field ta-anchor');
  setAttr(anIn, 'type', 'text');
  anIn.value = (typeof block.anchor === 'string') ? block.anchor : '';

  var commit = function () {
    var mode = val(modeSel);
    var label = (labelEl != null) ? val(labelEl) : String(block.label == null ? '' : block.label);
    if (mode === 'page') {
      var key = val(toIn).trim();
      if (pageKeys().indexOf(key) >= 0) setToFields(block, { label: label, to: key });
    } else if (mode === 'url') {
      var u = val(urlIn).trim();
      if (u !== '') setToFields(block, { label: label, url: u, newtab: nt.checked });
    }
    var av = val(anIn).trim();
    if (av !== '' && !slugProblem(av)) block.anchor = av;
    else if (av === '' && 'anchor' in block) delete block.anchor;
  };
  card.uiFields.push(commit);
  watch(modeSel, commit);
  watch(toIn, commit);
  watch(urlIn, commit);
  watch(nt, commit);
  watch(anIn, commit);
  return [labMode, modeSel, toIn, urlIn, ntLab, nt, anLab, anIn];
}

function appendGroup(container, nodes) {
  for (var i = 0; i < nodes.length; i++) if (nodes[i]) container.appendChild(nodes[i]);
}

function buildCard(pg, block, idx) {
  var type = (typeof block.type === 'string') ? block.type : 'unknown';
  var root = mkEl('div', 'card' + (type === 'custom_html' ? ' custom-html' : ''));
  setAttr(root, 'data-block', type);
  setAttr(root, 'draggable', 'true');

  var top = mkEl('header', 'card-top');
  var chip = mkEl('strong', 'type-chip');
  chip.appendChild(iconNode((KNOWN_TYPES.indexOf(type) >= 0) ? type : 'design'));
  chip.appendChild(document.createTextNode((KNOWN_TYPES.indexOf(type) >= 0) ? type : '(unsupported block)'));
  top.appendChild(chip);
  if (type === 'custom_html') {
    var raw = mkEl('span', 'raw-tag');
    raw.textContent = 'RAW — pasted HTML is not escaped';
    top.appendChild(raw);
  }
  var idxTag = mkEl('span', 'card-idx');
  idxTag.textContent = '#' + (idx + 1);
  top.appendChild(idxTag);
  var group = mkEl('div', 'card-ctrl-group');
  var delBtn = mkEl('button', 'card-ctrl delete-btn');
  delBtn.textContent = 'Delete';
  var dupBtn = mkEl('button', 'card-ctrl duplicate-btn');
  dupBtn.textContent = 'Duplicate';
  var upBtn = mkEl('button', 'card-ctrl move-btn up-btn');
  upBtn.textContent = 'up';
  var dnBtn = mkEl('button', 'card-ctrl move-btn down-btn');
  dnBtn.textContent = 'down';
  group.appendChild(delBtn);
  group.appendChild(dupBtn);
  group.appendChild(upBtn);
  group.appendChild(dnBtn);
  top.appendChild(group);
  root.appendChild(top);

  var note = mkEl('div', 'card-note');
  note.textContent = pendingNotes[idx] || '';
  root.appendChild(note);

  var card = { root: root, uiFields: [], rowCommits: [], idx: idx, block: block,
               note: note, uploadBox: null, uploadTarget: 'block' };

  if (type === 'heading') {
    var h = makeTextField(card, block, 'text', 'text:', null);
    appendGroup(root, h);
    var lv = makeSelectField(card, block, 'level', [['1', '1 (H1)'], ['2', '2 (H2)'], ['3', '3 (H3)']], 'level:', true);
    appendGroup(root, lv);
  } else if (type === 'paragraph') {
    var p = makeTextField(card, block, 'text', 'text:',
      '**bold** *italic* [label](to:key) [label](https://url)');
    appendGroup(root, p);
  } else if (type === 'image') {
    var a = makeTextFieldInput(card, block, 'asset', 'asset:', 'asset-options');
    appendGroup(root, a);
    var alt = makeTextField(card, block, 'alt', 'alt text:', null);
    appendGroup(root, alt);
    var w = makeSelectField(card, block, 'width', [['small', 'small'], ['medium', 'medium'], ['wide', 'wide'], ['full', 'full']], 'width:', false);
    appendGroup(root, w);
    var al = makeSelectField(card, block, 'align', [['left', 'left'], ['center', 'center'], ['right', 'right']], 'align:', false);
    appendGroup(root, al);
    var cp = makeTextField(card, block, 'caption', 'caption:', null);
    appendGroup(root, cp);
    var ub = makeUploadBox(card, idx, 'block');
    appendGroup(root, ub);
  } else if (type === 'button') {
    var lb = makeTextField(card, block, 'label', 'label:', null);
    appendGroup(root, lb);
    var st = makeSelectField(card, block, 'style', [['pill', 'pill'], ['box', 'box']], 'style:', false);
    appendGroup(root, st);
    appendGroup(root, addTargetFields(card, block, lb[1]));
  } else if (type === 'image_button') {
    var ib = makeTextFieldInput(card, block, 'asset', 'asset:', 'asset-options');
    appendGroup(root, ib);
    var ia = makeTextField(card, block, 'alt', 'alt text:', null);
    appendGroup(root, ia);
    var il = makeTextField(card, block, 'label', 'label:', null);
    appendGroup(root, il);
    var iw = makeSelectField(card, block, 'width', [['small', 'small'], ['medium', 'medium'], ['wide', 'wide']], 'width:', false);
    appendGroup(root, iw);
    var ish = makeSelectField(card, block, 'shape', [['square', 'square'], ['rounded', 'rounded']], 'shape:', false);
    appendGroup(root, ish);
    appendGroup(root, addTargetFields(card, block, il[1]));
    var iub = makeUploadBox(card, idx, 'block');
    appendGroup(root, iub);
  } else if (type === 'strip') {
    var sx = makeTextField(card, block, 'text', 'banner text:', '**bold** *italic* [label](to:key)');
    appendGroup(root, sx);
    var sbg = makeHexField(card, block, 'bg', 'banner background hex:');
    appendGroup(root, sbg);
    var sa = makeSelectField(card, block, 'align', [['left', 'left'], ['center', 'center'], ['right', 'right']], 'align:', false);
    appendGroup(root, sa);
    var sh = makeSelectField(card, block, 'height', [['low', 'low'], ['medium', 'medium'], ['tall', 'tall']], 'height:', false);
    appendGroup(root, sh);
  } else if (type === 'gallery') {
    var ga = makeAssetRows(card, block, 'assets');
    appendGroup(root, ga);
    var gc = makeSelectField(card, block, 'columns', [['2', '2'], ['3', '3'], ['4', '4']], 'columns:', true);
    appendGroup(root, gc);
    var gc2 = makeTextField(card, block, 'caption', 'caption:', null);
    appendGroup(root, gc2);
    var gub = makeUploadBox(card, idx, 'assets');
    appendGroup(root, gub);
  } else if (type === 'box') {
    var bv = makeSelectField(card, block, 'variant', [['outline', 'outline'], ['filled', 'filled'], ['soft', 'soft']], 'variant:', false);
    appendGroup(root, bv);
    var bt = makeTextField(card, block, 'title', 'title:', null);
    appendGroup(root, bt);
    var bl = makeStringRows(card, block, 'lines', '', 'line');
    appendGroup(root, bl);
  } else if (type === 'list') {
    var lo = makeBoolField(card, block, 'ordered', 'ordered? (numbered list)');
    appendGroup(root, lo);
    var li2 = makeStringRows(card, block, 'items', '', 'item');
    appendGroup(root, li2);
  } else if (type === 'video') {
    var vu = makeTextField(card, block, 'url', 'url (YouTube / Vimeo / any link):', null);
    appendGroup(root, vu);
    var vt = makeTextField(card, block, 'title', 'title:', null);
    appendGroup(root, vt);
  } else if (type === 'anchor') {
    var an = makeSlugField(card, block, 'name', 'anchor name (buttons jump here):', false);
    appendGroup(root, an);
    var anNote = mkEl('div', 'card-note');
    anNote.textContent = 'Anchored point on this page — a button with anchor "' + String(block.name == null ? '' : block.name) + '" jumps here.';
    root.appendChild(anNote);
  } else if (type === 'divider') {
    var dnote = mkEl('div', 'card-note');
    dnote.textContent = 'no fields — just a rule';
    root.appendChild(dnote);
  } else if (type === 'quote') {
    var q = makeTextField(card, block, 'text', 'quote text:', null);
    appendGroup(root, q);
    var at = makeTextField(card, block, 'attribution', 'attribution:', null);
    appendGroup(root, at);
  } else if (type === 'contact_card') {
    var rc = makeRows(card, block, 'lines', ['label', 'value', 'url'], { label: '', value: '', url: '' }, 'line');
    appendGroup(root, rc);
  } else if (type === 'social_links') {
    var rs = makeRows(card, block, 'items', ['network', 'url', 'label'], { network: '', url: '', label: '' }, 'item');
    appendGroup(root, rs);
  } else if (type === 'custom_html') {
    var hh = makeTextarea(card, block, 'html', 'html (RAW):');
    appendGroup(root, hh);
    var cc = makeTextarea(card, block, 'css', 'css (RAW):');
    appendGroup(root, cc);
  } else {
    var un = mkEl('div', 'card-note err');
    un.textContent = 'Unknown block type — edit the raw JSON below; the save keeps it verbatim unless you change it.';
    root.appendChild(un);
    var ta = mkEl('textarea', 'field ta-raw');
    ta.value = JSON.stringify(block, null, 2);
    var commitRaw = function () {
      try {
        var parsed = JSON.parse(ta.value);
        if (!parsed || typeof parsed !== 'object') throw new Error('raw JSON must be an object');
        var keys = [];
        for (var k in block) keys.push(k);
        for (var ki = 0; ki < keys.length; ki++) delete block[keys[ki]];
        for (var pk in parsed) block[pk] = parsed[pk];
      } catch (e) {
        card.note.textContent = 'Raw JSON edit kept: parse error — not applied. (' + String(e) + ')';
        pendingNotes[idx] = card.note.textContent;
      }
    };
    card.uiFields.push(commitRaw);
    watch(ta, commitRaw);
    var lab = mkEl('span', 'field-label');
    lab.textContent = 'raw JSON:';
    root.appendChild(lab);
    root.appendChild(ta);
  }

  delBtn.addEventListener('click', function () {
    syncFields();
    var arr = pg.blocks;
    if (idx >= 0 && idx < arr.length) arr.splice(idx, 1);
    if (selectedIdx === idx) selectedIdx = null;
    dirty = true; markDirty();
    renderCards();
  });
  dupBtn.addEventListener('click', function () {
    syncFields();
    var arr2 = pg.blocks;
    if (idx >= 0 && idx < arr2.length) {
      arr2.splice(idx + 1, 0, deepCopy(arr2[idx]));
      selectedIdx = idx + 1;
      dirty = true; markDirty();
      renderCards();
    }
  });
  function addMoveHandler(btn, dir) {
    btn.addEventListener('click', function () { moveBlock(idx, idx + dir); });
  }
  addMoveHandler(upBtn, -1);
  addMoveHandler(dnBtn, 1);

  root.addEventListener('click', function () {
    selectedIdx = idx;
    for (var li = 0; li < liveCards.length; li++) {
      var c2 = liveCards[li];
      if (c2.idx === selectedIdx) c2.root.classList.add('selected');
      else c2.root.classList.remove('selected');
    }
  });
  return card;
}

function renderCards() {
  if (!CARD_AREA) return;
  CARD_AREA.innerHTML = '';
  liveCards = [];
  dragFrom = null;
  dragHover = null;
  var pg = currentPage();
  if (!pg) return;
  for (var i = 0; i < pg.blocks.length; i++) {
    var block = pg.blocks[i];
    if (!block || typeof block !== 'object') block = { type: 'unknown', note: 'missing block' };
    pg.blocks[i] = block;
    var card = buildCard(pg, block, i);
    liveCards.push(card);
    CARD_AREA.appendChild(card.root);
  }
  for (var li = 0; li < liveCards.length; li++) {
    var c = liveCards[li];
    c.note.textContent = pendingNotes[c.idx] || '';
    if (selectedIdx === c.idx) c.root.classList.add('selected');
  }
}

function findCardUI(node) {
  if (!node) return null;
  for (var i = 0; i < liveCards.length; i++) {
    var c = liveCards[i];
    if (c.root === node || c.root.contains(node)) return c;
  }
  return null;
}

function moveBlock(from, to) {
  var pg = currentPage();
  if (!pg) return;
  var arr = pg.blocks;
  if (from < 0 || to < 0 || from >= arr.length || to >= arr.length || from === to) return;
  syncFields();
  var moved = arr.splice(from, 1)[0];
  arr.splice(to, 0, moved);
  selectedIdx = to;
  dirty = true; markDirty();
  renderCards();
}

document.addEventListener('keydown', function (e) {
  if (selectedIdx == null || !model) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  var ae = document.activeElement;
  if (ae && ae.isContentEditable) return;
  var pg = currentPage();
  if (!pg) return;
  var target = selectedIdx + (e.key === 'ArrowDown' ? 1 : -1);
  if (target < 0 || target >= pg.blocks.length) return;
  e.preventDefault();
  moveBlock(selectedIdx, target);
});

document.addEventListener('dragstart', function (e) {
  var c = findCardUI(e.target);
  if (c) { dragFrom = c.idx; dragHover = null; }
});
document.addEventListener('dragover', function (e) {
  if (dragFrom == null) return;
  var c = findCardUI(e.target);
  if (c) dragHover = c.idx;
});
document.addEventListener('dragend', function (e) {
  if (dragFrom != null && dragHover != null && dragHover !== dragFrom) moveBlock(dragFrom, dragHover);
  dragFrom = null;
  dragHover = null;
});

/* ---------- 4. add elements (chips) + add sections (presets) ---------- */

var ELEMENT_ROWS = [
  ['Text', [['heading', 'Heading'], ['paragraph', 'Paragraph']]],
  ['Image', [['image', 'Image']]],
  ['Button', [['button', 'Button'], ['image_button', 'Photo button']]],
  ['Strip', [['strip', 'Strip']]],
  ['Decorative', [['divider', 'Divider'], ['quote', 'Quote'], ['box', 'Box']]],
  ['Gallery', [['gallery', 'Gallery']]],
  ['Video & Music', [['video', 'Video']]],
  ['Interactive', [['list', 'List'], ['anchor', 'Anchor']]],
  ['Embed Code', [['custom_html', 'Custom HTML/CSS']]],
  ['Social', [['social_links', 'Social links']]],
  ['Contact & Forms', [['contact_card', 'Contact card']]]
];

function renderChips() {
  if (!ADD_BODY) return;
  ADD_BODY.innerHTML = '';
  for (var r = 0; r < ELEMENT_ROWS.length; r++) {
    var rowDef = ELEMENT_ROWS[r];
    var row = mkEl('div', 'chip-row');
    var lab = mkEl('span', 'chip-row-label');
    lab.textContent = rowDef[0];
    row.appendChild(lab);
    var chips = rowDef[1];
    for (var ci = 0; ci < chips.length; ci++) {
      var type = chips[ci][0];
      var btn = mkEl('button', 'chip' + (type === 'custom_html' ? ' raw' : ''));
      setAttr(btn, 'data-block', type);
      btn.appendChild(iconNode(type));
      var tl = mkEl('span', 'tl');
      tl.textContent = chips[ci][1];
      btn.appendChild(tl);
      if (type === 'custom_html') {
        var rawTag = mkEl('span', 'tl');
        rawTag.textContent = 'raw';
        btn.appendChild(rawTag);
      }
      bindChipClick(btn);
      row.appendChild(btn);
    }
    ADD_BODY.appendChild(row);
  }
}
function bindChipClick(btnNode) {
  btnNode.addEventListener('click', function (ev) {
    appendBlock(btnNode.getAttribute('data-block'));
  });
}

function makeDefaultBlock(type) {
  var firstKey = pageKeys().length ? pageKeys()[0] : (currentKey || 'home');
  if (type === 'heading') return { type: 'heading', text: 'New heading', level: 1 };
  if (type === 'paragraph') return { type: 'paragraph', text: 'New paragraph. Supports **bold**, *italic*, [a link](to:' + firstKey + ') and [ext](https://example.com).' };
  if (type === 'image') return { type: 'image', asset: firstAsset(), alt: '', width: 'medium', align: 'center', caption: '' };
  if (type === 'button') return { type: 'button', label: 'Open', style: 'pill', to: firstKey };
  if (type === 'image_button') return { type: 'image_button', asset: firstAsset(), alt: '', label: 'Open', width: 'medium', shape: 'rounded', to: firstKey };
  if (type === 'divider') return { type: 'divider' };
  if (type === 'quote') return { type: 'quote', text: 'A thought worth quoting.', attribution: 'Someone' };
  if (type === 'contact_card') return { type: 'contact_card', lines: [{ label: 'Email', value: 'me@example.com', url: '' }] };
  if (type === 'social_links') return { type: 'social_links', items: [{ network: 'Mastodon', url: 'https://', label: 'Mastodon' }] };
  if (type === 'custom_html') return { type: 'custom_html', html: '<div class="custom-note">\n  <p>Replace this with your own markup.</p>\n</div>', css: '.custom-note {\n  padding: 12px;\n}' };
  if (type === 'strip') return { type: 'strip', bg: '#e9ede9', text: 'New strip — click here', align: 'center', height: 'medium' };
  if (type === 'gallery') return { type: 'gallery', assets: firstAssetNames(3), columns: 3, caption: '' };
  if (type === 'box') return { type: 'box', variant: 'outline', title: 'Note', lines: ['First line', 'Second line'] };
  if (type === 'list') return { type: 'list', ordered: false, items: ['First', 'Second', 'Third'] };
  if (type === 'video') return { type: 'video', url: 'https://www.youtube.com/watch?v=REPLACE_ME', title: 'Video' };
  if (type === 'anchor') return { type: 'anchor', name: 'section' };
  return { type: type };
}

function insertBlocks(blocksArr, label, at) {
  var pg = currentPage();
  if (!pg) return 0;
  syncFields();
  if (!Array.isArray(pg.blocks)) pg.blocks = [];
  var made = deepCopy(blocksArr);
  if (!made || !made.length) return 0;
  var pos = at;
  if (pos == null) {
    pos = (selectedIdx != null && selectedIdx >= 0 && selectedIdx < pg.blocks.length)
      ? selectedIdx + 1 : pg.blocks.length;
  }
  for (var i = 0; i < made.length; i++) pg.blocks.splice(pos + i, 0, made[i]);
  selectedIdx = pos + made.length - 1;
  dirty = true; markDirty();
  renderCards();
  var where = (pos === 0) ? 'at the top of page "' + currentKey + '"'
    : 'after "' + blockName(pg.blocks[pos - 1]) + '" on page "' + currentKey + '"';
  setStatus(label, made.length + ' block(s) inserted ' + where);
  return made.length;
}

function appendBlock(type) {
  var pg = currentPage();
  if (!pg) return;
  syncFields();
  pg.blocks.push(makeDefaultBlock(type));
  selectedIdx = pg.blocks.length - 1;
  dirty = true; markDirty();
  renderCards();
  setStatus('Added', type + ' block at the end of page "' + currentKey + '"');
}

function fillPresetAssets(blocksArr) {
  if (!blocksArr) return;
  for (var i = 0; i < blocksArr.length; i++) {
    var b = blocksArr[i];
    if (!b || typeof b !== 'object') continue;
    if ((b.type === 'image' || b.type === 'image_button') && (b.asset == null || b.asset === '')) {
      b.asset = firstAsset();
    }
    if (b.type === 'gallery' && (!Array.isArray(b.assets) || b.assets.length === 0)) {
      b.assets = firstAssetNames(3);
    }
  }
}

var PRESETS = [
  { name: 'Welcome', icon: 'welcome', blurb: 'heading + intro + button',
    blocks: [{ type: 'heading', text: 'Welcome', level: 1 },
             { type: 'paragraph', text: 'A short intro paragraph. Supports **bold** and *italic*.' },
             { type: 'button', label: 'Get started', style: 'pill', to: 'home' }] },
  { name: 'About Me', icon: 'about', blurb: 'heading + paragraph + image',
    blocks: [{ type: 'heading', text: 'About me', level: 2 },
             { type: 'paragraph', text: 'Who I am and what I make.' },
             { type: 'image', asset: firstAssetNameLazy(), alt: 'Portrait', width: 'medium', align: 'left', caption: '' }] },
  { name: 'Features', icon: 'features', blurb: 'heading + list + box',
    blocks: [{ type: 'heading', text: 'Features', level: 2 },
             { type: 'list', ordered: false, items: ['Fast', 'Simple', 'Ownable'] },
             { type: 'box', variant: 'soft', title: 'Note', lines: ['Everything lives in one file.'] }] },
  { name: 'Pricing', icon: 'pricing', blurb: 'heading + list + button',
    blocks: [{ type: 'heading', text: 'Pricing', level: 2 },
             { type: 'list', ordered: false, items: ['Starter — free', 'Pro — paid'] },
             { type: 'button', label: 'Choose a plan', style: 'pill', to: 'home' }] },
  { name: 'Promo strip', icon: 'promo', blurb: 'strip + heading + button',
    blocks: [{ type: 'strip', bg: '#e2e8e4', text: 'New drop out this week — **limited**', align: 'center', height: 'medium' },
             { type: 'heading', text: 'New drop', level: 2 },
             { type: 'button', label: 'See it', style: 'pill', to: 'home' }] },
  { name: 'Photo gallery', icon: 'gallery', blurb: 'heading + gallery',
    blocks: [{ type: 'heading', text: 'Gallery', level: 2 },
             { type: 'gallery', assets: [], columns: 3, caption: '' }] },
  { name: 'Contact', icon: 'contact', blurb: 'contact card + social links',
    blocks: [{ type: 'contact_card', lines: [{ label: 'Email', value: 'me@example.com', url: '' }] },
             { type: 'social_links', items: [{ network: 'Mastodon', url: 'https://', label: 'Mastodon' }] }] }
];
/* the About Me preset needs a lazy asset: evaluated when the preset is rendered */
function firstAssetNameLazy() { return firstAsset(); }

function renderPresets() {
  if (!SEC_BODY) return;
  SEC_BODY.innerHTML = '';
  for (var i = 0; i < PRESETS.length; i++) {
    var p = PRESETS[i];
    var row = mkEl('div', 'preset-row');
    setAttr(row, 'data-preset', String(i));
    row.appendChild(iconNode(p.icon));
    row.appendChild(mkEl('span', 'preset-name', p.name));
    row.appendChild(mkEl('span', 'preset-meta', p.blurb));
    row.appendChild(mkEl('span', 'preset-blocks', p.blocks.length + ' blocks'));
    bindPresetClick(row);
    SEC_BODY.appendChild(row);
  }
}
function bindPresetClick(rowNode) {
  rowNode.addEventListener('click', function (ev) {
    var i = Number(setAttrGet(rowNode, 'data-preset'));
    if (isNaN(i) || i < 0 || i >= PRESETS.length) return;
    var made = deepCopy(PRESETS[i].blocks);
    if (!made) return;
    fillPresetAssets(made);
    var n = insertBlocks(made, 'Section added', null);
    if (n === 0) setStatus('Add section refused', 'no page selected');
  });
}

/* ---------- 5. pages rail + page ops + menu panels ---------- */

function refreshPageOptions() {
  PAGE_DATALIST.innerHTML = '';
  var keys = pageKeys();
  for (var i = 0; i < keys.length; i++) {
    var o = mkEl('option');
    setAttr(o, 'value', keys[i]);
    PAGE_DATALIST.appendChild(o);
  }
}
function refreshAssetOptions() {
  ASSET_DATALIST.innerHTML = '';
  var names = [];
  if (model && model.assets) for (var k in model.assets) names.push(k);
  for (var u in uploadedNames) names.push(u);
  names.sort();
  for (var i = 0; i < names.length; i++) {
    var o = mkEl('option');
    setAttr(o, 'value', names[i]);
    ASSET_DATALIST.appendChild(o);
  }
}

function bindPageClick(btnNode) {
  btnNode.addEventListener('click', function (ev) {
    switchPage(btnNode.getAttribute('data-key'));
  });
}

function renderPagesSection() {
  if (!PAGE_BODY) return;
  PAGE_BODY.innerHTML = '';
  if (!model) return;

  var cur = mkEl('div', 'pg-current');
  var pg = currentPage();
  if (pg) {
    cur.appendChild(mkEl('b')).textContent = 'Current page: ' + String(pg.title);
    var kc = mkEl('code', 'pg-code');
    kc.textContent = ' (' + String(pg.key) + ')';
    if (pg.key === 'home') {
      var ih = mkEl('span', 'pg-index-hint');
      ih.textContent = ' (index.html)';
      cur.appendChild(ih);
    }
    cur.appendChild(kc);
  }
  PAGE_BODY.appendChild(cur);

  var list = mkEl('div', 'pg-list');
  for (var i = 0; i < model.pages.length; i++) {
    var p = model.pages[i];
    var b = mkEl('button', 'pg-item' + (p.key === currentKey ? ' pg-current-btn' : ''));
    setAttr(b, 'data-key', String(p.key));
    b.appendChild(mkEl('span')).textContent = String(p.title);
    var code = mkEl('code', 'pg-code');
    code.textContent = ' ' + String(p.key);
    b.appendChild(code);
    if (p.key === 'home') {
      var hint = mkEl('span', 'pg-index-hint');
      hint.textContent = ' (index.html)';
      b.appendChild(hint);
    }
    bindPageClick(b);
    list.appendChild(b);
  }
  PAGE_BODY.appendChild(list);
}

function switchPage(key) {
  if (!model || indexOfPage(key) < 0) return;
  currentKey = key;
  selectedIdx = null;
  renderSidebar();
  renderCards();
  refreshPreview();
  setStatus('Switched', 'preview + cards now show page "' + key + '"');
}

function renderPageOps() {
  if (!PAGE_BODY) return;
  var pg = currentPage();
  if (!pg) return;

  var addF = mkEl('div', 'pg-add-form');
  addF.appendChild(mkEl('div', 'pg-rule')).textContent = 'key: ';
  var ruleCode = mkEl('code');
  ruleCode.textContent = '^[a-z][a-z0-9-]{0,31}$';
  addF.appendChild(ruleCode);
  addF.appendChild(mkEl('span')).textContent = ' (unique, max 32) · title:';
  var keyIn = mkEl('input', 'ap-key');
  setAttr(keyIn, 'type', 'text');
  var titleIn = mkEl('input', 'ap-title');
  setAttr(titleIn, 'type', 'text');
  var apBtn = mkEl('button', 'ap-apply');
  apBtn.textContent = 'Add page';
  apBtn.addEventListener('click', function () {
    var k = val(keyIn).trim();
    var t = val(titleIn).trim();
    var prob = slugProblem(k);
    if (!prob && pageKeys().indexOf(k) >= 0) prob = 'key already used by another page';
    if (prob) { setStatus('Add page refused', prob + ' — fix the form and click again'); return; }
    syncFields();
    model.pages.push(blankPage(k, t === '' ? k : t));
    currentKey = k;
    selectedIdx = null;
    dirty = true; markDirty();
    renderSidebar(); renderCards(); refreshPreview();
    setStatus('Added page', k + ' (' + (t === '' ? k : t) + ') is now the current page');
  });
  addF.appendChild(keyIn); addF.appendChild(titleIn); addF.appendChild(apBtn);
  PAGE_BODY.appendChild(addF);

  var rn = mkEl('div', 'rn-form');
  rn.appendChild(mkEl('div')).textContent = 'Rename "' + String(pg.key) + '" — display title only; URL key stays "' + String(pg.key) + '".';
  var rnNew = mkEl('input', 'rn-new');
  setAttr(rnNew, 'type', 'text');
  rnNew.value = String(pg.title);
  var rnApply = mkEl('button', 'rn-apply');
  rnApply.textContent = 'Apply';
  rnApply.addEventListener('click', function () {
    var v = val(rnNew).trim();
    if (v === '') { setStatus('Rename refused', 'title must not be empty'); return; }
    syncFields();
    pg.title = v;
    dirty = true; markDirty();
    renderSidebar();
    setStatus('Renamed page', String(pg.key) + ' title → "' + v + '"');
  });
  rn.appendChild(rnNew); rn.appendChild(rnApply);
  PAGE_BODY.appendChild(rn);

  var ck = mkEl('div', 'ck-form');
  ck.appendChild(mkEl('div')).textContent = 'Change URL key from "' + String(pg.key) + '" to:';
  var ckNew = mkEl('input', 'ck-new');
  setAttr(ckNew, 'type', 'text');
  var ckApply = mkEl('button', 'ck-apply');
  ckApply.textContent = 'Rename key';
  var ckLive = mkEl('div', 'ck-key-ok');
  function refreshCkLive() {
    ckLive.innerHTML = '';
    var v = val(ckNew).trim();
    if (v === pg.key) { ckLive.appendChild(mkEl('span')).textContent = 'same as current key — nothing to do.'; return; }
    var prob = slugProblem(v);
    if (prob) { ckLive.appendChild(mkEl('span', 'err')).textContent = 'invalid: ' + prob; return; }
    if (pageKeys().indexOf(v) >= 0) { ckLive.appendChild(mkEl('span', 'err')).textContent = 'already used by another page.'; return; }
    ckLive.appendChild(mkEl('span', 'ok')).textContent = 'valid key — buttons, block links and (to:…) links will be swept over.';
  }
  refreshCkLive();
  ckApply.addEventListener('click', function () {
    var v = val(ckNew).trim();
    if (v === pg.key) return;
    var prob = slugProblem(v);
    if (prob) { setStatus('Change URL key refused', prob); return; }
    if (pageKeys().indexOf(v) >= 0) { setStatus('Change URL key refused', 'key "' + v + '" already used by another page'); return; }
    var res = renamePageKey(String(pg.key), v);
    if (!res.ok) { setStatus('Change URL key refused', res.error); return; }
    setStatus('Page key renamed', res.swept + ' references swept to "' + v + '"');
  });
  ck.appendChild(ckNew); ck.appendChild(ckApply); ck.appendChild(ckLive);
  PAGE_BODY.appendChild(ck);

  var mv = mkEl('div', 'pg-move-form');
  var upP = mkEl('button', 'pg-move-up');
  upP.textContent = 'page up';
  upP.addEventListener('click', function () { movePage(-1); });
  var dnP = mkEl('button', 'pg-move-down');
  dnP.textContent = 'page down';
  dnP.addEventListener('click', function () { movePage(1); });
  mv.appendChild(upP); mv.appendChild(dnP);
  PAGE_BODY.appendChild(mv);

  var delWrap = mkEl('div', 'del-form');
  var delBtn = mkEl('button', 'del-page');
  delBtn.textContent = 'Delete this page…';
  delBtn.addEventListener('click', function () {
    openConfirm(PAGE_BODY,
      'Delete page "' + String(pg.key) + '" (' + String(pg.title) + ') now? All buttons, block links and paragraph links pointing at it are dropped. This cannot be undone.',
      function () {
        var res = deletePage(String(pg.key));
        if (!res.ok) setStatus('Delete page refused', res.error);
      });
  });
  delWrap.appendChild(delBtn);
  PAGE_BODY.appendChild(delWrap);

  var hp = mkEl('div', 'ovr-header');
  PAGE_BODY.appendChild(hp);
  createPanel(hp, {
    container: hp, kind: 'header', field: 'header_override', page: true, pageObj: pg,
    label: 'Header override',
    getObj: function () { return pg.header_override; }
  });
  var fp = mkEl('div', 'ovr-footer');
  PAGE_BODY.appendChild(fp);
  createPanel(fp, {
    container: fp, kind: 'text', field: 'footer_override', page: true, pageObj: pg,
    label: 'Footer override',
    getObj: function () { return pg.footer_override; }
  });
}

function movePage(dir) {
  if (!model || currentKey == null) return;
  var i = indexOfPage(currentKey);
  if (i < 0) return;
  var j = i + dir;
  if (j < 0 || j >= model.pages.length) {
    setStatus('Move page refused', '"' + currentKey + '" is already at the ' + (dir > 0 ? 'bottom' : 'top') + ' of the menu order');
    return;
  }
  syncFields();
  var sp = model.pages.splice(i, 1)[0];
  model.pages.splice(j, 0, sp);
  dirty = true; markDirty();
  renderSidebar();
  refreshPreview();
  setStatus('Page reordered', '"' + currentKey + '" moved to position ' + (j + 1) + ' of ' + model.pages.length);
}

function openConfirm(container, message, onYes) {
  var box = mkEl('div', 'confirm-box');
  box.appendChild(mkEl('div')).textContent = message;
  var yesBtn = mkEl('button', 'yes-btn');
  yesBtn.textContent = 'Yes, confirm';
  var noBtn = mkEl('button', 'no-btn');
  noBtn.textContent = 'Cancel';
  yesBtn.addEventListener('click', function () { box.remove(); onYes(); });
  noBtn.addEventListener('click', function () { box.remove(); });
  box.appendChild(yesBtn);
  box.appendChild(noBtn);
  container.appendChild(box);
}

function renamePageKey(oldKey, newKey) {
  syncFields();
  var pg = currentPage();
  if (!pg || pg.key !== oldKey) return { ok: false, error: 'the page being renamed is no longer selected' };
  var prob = slugProblem(newKey);
  if (prob) return { ok: false, error: prob };
  if (pageKeys().indexOf(newKey) >= 0) return { ok: false, error: 'key "' + newKey + '" already used by another page' };

  var swept = 0;

  function sweepButtons(arr, apply) {
    if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      if (b && typeof b === 'object' && b.to === oldKey) { apply(b); swept += 1; }
    }
  }
  sweepButtons(model.header.buttons, function (b) { b.to = newKey; });
  sweepButtons(model.footer.buttons, function (b) { b.to = newKey; });
  for (var i = 0; i < model.pages.length; i++) {
    var p = model.pages[i];
    if (p.header_override) sweepButtons(p.header_override.buttons, function (b) { b.to = newKey; });
    if (p.footer_override) sweepButtons(p.footer_override.buttons, function (b) { b.to = newKey; });
    if (!Array.isArray(p.blocks)) continue;
    for (var bi = 0; bi < p.blocks.length; bi++) {
      var blk = p.blocks[bi];
      if (!blk || typeof blk !== 'object') continue;
      if (typeof blk.to === 'string' && blk.to === oldKey) { blk.to = newKey; swept += 1; }
      if (blk.type === 'paragraph' && typeof blk.text === 'string' && blk.text.indexOf('(to:' + oldKey + ')') >= 0) {
        blk.text = blk.text.split('(to:' + oldKey + ')').join('(to:' + newKey + ')');
        swept += 1;
      }
    }
  }

  pg.key = newKey;
  dirty = true; markDirty();
  renderSidebar();
  renderCards();
  refreshPreview();
  refreshPageOptions();
  return { ok: true, swept: swept };
}

function deletePage(oldKey) {
  syncFields();
  if (model.pages.length <= 1) return { ok: false, error: 'refusing to delete the last remaining page' };
  var idx = indexOfPage(oldKey);
  if (idx < 0) return { ok: false, error: 'page not found' };
  var pg = model.pages[idx];
  if (pg.key !== currentKey) return { ok: false, error: 'only the current page can be deleted' };

  var dropped = 0;
  var linkRe = new RegExp('\\[([^\\]]*)\\]\\(to:' + oldKey + '\\)', 'g');

  function keepOnly(arr) {
    if (!Array.isArray(arr)) return;
    var kept = [];
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      if (b && typeof b === 'object' && b.to === oldKey) { dropped += 1; continue; }
      kept.push(b);
    }
    arr.length = kept.length;
    for (var k = 0; k < kept.length; k++) arr[k] = kept[k];
  }
  keepOnly(model.header.buttons);
  keepOnly(model.footer.buttons);
  for (var i = 0; i < model.pages.length; i++) {
    var p = model.pages[i];
    if (p.header_override) keepOnly(p.header_override.buttons);
    if (p.footer_override) keepOnly(p.footer_override.buttons);
    if (!Array.isArray(p.blocks)) continue;
    var keptBlocks = [];
    for (var bi = 0; bi < p.blocks.length; bi++) {
      var blk = p.blocks[bi];
      if (blk && typeof blk === 'object' && typeof blk.to === 'string' && blk.to === oldKey) { dropped += 1; continue; }
      if (blk && blk.type === 'paragraph' && typeof blk.text === 'string' && blk.text.indexOf('(to:' + oldKey + ')') >= 0) {
        blk.text = blk.text.replace(linkRe, '$1');
        dropped += 1;
      }
      keptBlocks.push(blk);
    }
    p.blocks = keptBlocks;
  }

  model.pages.splice(idx, 1);
  currentKey = model.pages[0].key;
  selectedIdx = null;
  dirty = true; markDirty();
  renderSidebar();
  renderCards();
  refreshPreview();
  refreshPageOptions();
  setStatus('Page deleted', '"' + oldKey + '" removed — ' + dropped + ' references dropped');
  return { ok: true, dropped: dropped };
}

/* ---------- menu: site header/footer links + header/footer text ---------- */

function redrawPanel(cfg) {
  var c = cfg.container;
  c.innerHTML = '';
  cfg.rowCommits = [];
  var obj = cfg.getObj();

  var head = mkEl('div', 'panel-head');
  var title = mkEl('span', 'panel-title');
  title.textContent = cfg.label;
  head.appendChild(title);

  if (cfg.page) {
    if (obj === null) {
      var ebtn = mkEl('button', 'panel-btn edit-btn');
      ebtn.textContent = 'Edit override (copies site)';
      ebtn.addEventListener('click', function () {
        syncFields();
        var src = (cfg.field === 'header') ? model.header : model.footer;
        cfg.pageObj[cfg.field] = deepCopy(src);
        dirty = true; markDirty();
        redrawPanel(cfg);
      });
      head.appendChild(ebtn);
    } else {
      var ubtn = mkEl('button', 'panel-btn use-default-btn');
      ubtn.textContent = 'Use site default';
      ubtn.addEventListener('click', function () {
        syncFields();
        cfg.pageObj[cfg.field] = null;
        dirty = true; markDirty();
        redrawPanel(cfg);
      });
      head.appendChild(ubtn);
    }
  } else if (cfg.site) {
    var abtn = mkEl('button', 'panel-btn add-btn');
    abtn.textContent = '+ button';
    abtn.addEventListener('click', function () {
      syncFields();
      var o = cfg.getObj();
      if (!o) return;
      if (!Array.isArray(o.buttons)) o.buttons = [];
      var firstKey = pageKeys().length ? pageKeys()[0] : (currentKey || 'home');
      o.buttons.push({ label: 'Open', to: firstKey });
      dirty = true; markDirty();
      redrawPanel(cfg);
    });
    head.appendChild(abtn);
  }
  c.appendChild(head);

  if (obj === null) {
    var note = mkEl('div', 'panel-note');
    note.textContent = 'Currently uses the site-level ' + cfg.field + '. Click "Edit override" to start from a copy of it, then tweak per page.';
    c.appendChild(note);
    return;
  }

  buildPanelBody(c, cfg, obj);
}

function buildPanelBody(container, cfg, obj) {
  if (cfg.kind === 'header') {
    var tLab = mkEl('span', 'field-label');
    tLab.textContent = 'title:';
    var tF = ceDiv();
    tF.innerText = String(obj.title == null ? '' : obj.title);
    var cT = function () { obj.title = val(tF); };
    cfg.rowCommits.push(cT);
    watch(tF, cT);
    container.appendChild(tLab); container.appendChild(tF);

    var sLab = mkEl('span', 'field-label');
    sLab.textContent = 'subtitle:';
    var sF = ceDiv();
    sF.innerText = String(obj.subtitle == null ? '' : obj.subtitle);
    var cS = function () { obj.subtitle = val(sF); };
    cfg.rowCommits.push(cS);
    watch(sF, cS);
    container.appendChild(sLab); container.appendChild(sF);

    var lLab = mkEl('span', 'field-label');
    lLab.textContent = 'logo asset (empty = none):';
    var lIn = mkEl('input', 'panel-field logo');
    setAttr(lIn, 'type', 'text');
    setAttr(lIn, 'list', 'asset-options');
    lIn.value = (obj.logo_asset == null) ? '' : String(obj.logo_asset);
    var cL = function () {
      var v = val(lIn).trim();
      obj.logo_asset = (v === '') ? null : v;
    };
    cfg.rowCommits.push(cL);
    watch(lIn, cL);
    container.appendChild(lLab); container.appendChild(lIn);
  } else {
    var xLab = mkEl('span', 'field-label');
    xLab.textContent = 'footer text:';
    var xF = ceDiv();
    xF.innerText = String(obj.text == null ? '' : obj.text);
    var cX = function () { obj.text = val(xF); };
    cfg.rowCommits.push(cX);
    watch(xF, cX);
    container.appendChild(xLab); container.appendChild(xF);
  }

  var blab = mkEl('span', 'field-label');
  blab.textContent = 'buttons:';
  container.appendChild(blab);
  if (!Array.isArray(obj.buttons)) obj.buttons = [];
  var rowsWrap = mkEl('div', 'brows');
  container.appendChild(rowsWrap);

  var anchor = cfg.rowCommits.length;

  function redrawRows() {
    rowsWrap.innerHTML = '';
    cfg.rowCommits.length = anchor;
    var btns = obj.buttons;
    for (var i = 0; i < btns.length; i++) {
      if (!btns[i] || typeof btns[i] !== 'object') btns[i] = { label: 'Link', to: pageKeys()[0] || currentKey || 'home' };
      var rw = mkEl('div', 'brow');
      setAttr(rw, 'data-rowidx', String(i));

      var lab = ceDiv();
      setAttr(lab, 'data-f', 'label');
      lab.className = 'field blabel';
      lab.innerText = String(btns[i].label == null ? '' : btns[i].label);

      var sel = mkEl('select', 'bmode');
      var oP = mkEl('option'); setAttr(oP, 'value', 'page'); oP.textContent = 'to page';
      var oU = mkEl('option'); setAttr(oU, 'value', 'url'); oU.textContent = 'to URL';
      sel.appendChild(oP); sel.appendChild(oU);
      setAttr(sel, 'data-f', 'mode');
      if (typeof btns[i].url === 'string') sel.selectedIndex = 1;

      var toIn = mkEl('input', 'bto');
      setAttr(toIn, 'type', 'text');
      setAttr(toIn, 'list', 'page-options');
      setAttr(toIn, 'data-f', 'to');
      toIn.value = (typeof btns[i].to === 'string') ? btns[i].to : '';

      var urlIn = mkEl('input', 'burl');
      setAttr(urlIn, 'type', 'text');
      setAttr(urlIn, 'data-f', 'url');
      urlIn.value = (typeof btns[i].url === 'string') ? btns[i].url : '';

      var nt = mkEl('input', 'bnt');
      setAttr(nt, 'type', 'checkbox');
      setAttr(nt, 'data-f', 'newtab');
      nt.checked = !!btns[i].newtab;

      var rm = mkEl('button', 'bremove');
      rm.textContent = 'remove';
      rm.addEventListener('click', function () {
        syncFields();
        var at = Number(setAttrGet(rw, 'data-rowidx'));
        if (!isNaN(at) && at >= 0 && at < obj.buttons.length) {
          obj.buttons.splice(at, 1);
          dirty = true; markDirty();
        }
        redrawRows();
      });

      rw.appendChild(lab); rw.appendChild(sel); rw.appendChild(toIn);
      rw.appendChild(urlIn); rw.appendChild(nt); rw.appendChild(rm);
      rowsWrap.appendChild(rw);

      var commit = function () { commitRowButton(rw, obj); };
      cfg.rowCommits.push(commit);
      watch(lab, commit);
      watch(sel, commit);
      watch(toIn, commit);
      watch(urlIn, commit);
      watch(nt, commit);
    }
  }
  redrawRows();
}

function commitRowButton(rw, obj) {
  if (!Array.isArray(obj.buttons)) return;
  var i = Number(setAttrGet(rw, 'data-rowidx'));
  if (isNaN(i) || i < 0 || i >= obj.buttons.length) return;
  var b = obj.buttons[i];
  if (!b || typeof b !== 'object') return;
  var label = val(rw.querySelector('[data-f="label"]'));
  var mode = val(rw.querySelector('[data-f="mode"]'));
  if (mode === 'page') {
    var key = val(rw.querySelector('[data-f="to"]')).trim();
    if (pageKeys().indexOf(key) < 0) return;
    if (isButtonShape(b) && b.to === key && String(b.label) === label) return;
    setToFields(b, { label: label, to: key });
  } else if (mode === 'url') {
    var url = val(rw.querySelector('[data-f="url"]')).trim();
    if (url === '') return;
    var nt = rw.querySelector('[data-f="newtab"]');
    if (isButtonShape(b) && b.url === url && String(b.label) === label && !!b.newtab === (nt ? nt.checked : false)) return;
    setToFields(b, { label: label, url: url, newtab: nt ? nt.checked : false });
  }
}

function createPanel(container, cfg) {
  cfg.rowCommits = [];
  PANEL_CFGS.push(cfg);
  container.className = 'panel';
  redrawPanel(cfg);
}

/* links-only panels: the site menu + footer links (one view per array, so
   the menu rows and the override panels never fight over the same list) */
function redrawLinksPanel(cfg) {
  var c = cfg.container;
  c.innerHTML = '';
  cfg.rowCommits = [];
  var obj = cfg.getObj();

  var head = mkEl('div', 'panel-head');
  var title = mkEl('span', 'panel-title');
  title.textContent = cfg.label;
  head.appendChild(title);

  var addBtn = mkEl('button', 'panel-btn add-btn');
  addBtn.textContent = '+ add link';
  addBtn.addEventListener('click', function () {
    syncFields();
    var o = cfg.getObj();
    if (!o) return;
    if (!Array.isArray(o.buttons)) o.buttons = [];
    var firstKey = pageKeys().length ? pageKeys()[0] : (currentKey || 'home');
    o.buttons.push({ label: 'Link', to: firstKey });
    dirty = true; markDirty();
    redrawLinksPanel(cfg);
  });
  head.appendChild(addBtn);

  if (cfg.automatic) {
    var autoBtn = mkEl('button', 'panel-btn auto-btn');
    autoBtn.textContent = 'Auto menu from pages';
    autoBtn.addEventListener('click', function () {
      syncFields();
      var o = cfg.getObj();
      if (!o) return;
      var out = [];
      for (var i = 0; i < model.pages.length; i++) {
        var p = model.pages[i];
        out.push({ label: String(p.title == null ? p.key : p.title), to: String(p.key) });
      }
      o.buttons = out;
      dirty = true; markDirty();
      redrawLinksPanel(cfg);
      setStatus('Menu rebuilt', out.length + ' header links generated from the current page order');
    });
    head.appendChild(autoBtn);
  }
  c.appendChild(head);

  var note = mkEl('div', 'panel-note');
  note.textContent = cfg.note || '';
  c.appendChild(note);

  if (!Array.isArray(obj.buttons)) obj.buttons = [];
  var rowsWrap = mkEl('div', 'brows');
  c.appendChild(rowsWrap);

  function redrawRows() {
    rowsWrap.innerHTML = '';
    cfg.rowCommits.length = 0;
    var btns = obj.buttons;
    for (var i = 0; i < btns.length; i++) {
      if (!btns[i] || typeof btns[i] !== 'object') btns[i] = { label: 'Link', to: pageKeys()[0] || currentKey || 'home' };
      var rw = mkEl('div', 'brow');
      setAttr(rw, 'data-rowidx', String(i));

      var lab = ceDiv();
      setAttr(lab, 'data-f', 'label');
      lab.className = 'field blabel';
      lab.innerText = String(btns[i].label == null ? '' : btns[i].label);

      var sel = mkEl('select', 'bmode');
      var oP = mkEl('option'); setAttr(oP, 'value', 'page'); oP.textContent = 'to page';
      var oU = mkEl('option'); setAttr(oU, 'value', 'url'); oU.textContent = 'to URL';
      sel.appendChild(oP); sel.appendChild(oU);
      setAttr(sel, 'data-f', 'mode');
      if (typeof btns[i].url === 'string') sel.selectedIndex = 1;

      var toIn = mkEl('input', 'bto');
      setAttr(toIn, 'type', 'text');
      setAttr(toIn, 'list', 'page-options');
      setAttr(toIn, 'data-f', 'to');
      toIn.value = (typeof btns[i].to === 'string') ? btns[i].to : '';

      var urlIn = mkEl('input', 'burl');
      setAttr(urlIn, 'type', 'text');
      setAttr(urlIn, 'data-f', 'url');
      urlIn.value = (typeof btns[i].url === 'string') ? btns[i].url : '';

      var nt = mkEl('input', 'bnt');
      setAttr(nt, 'type', 'checkbox');
      setAttr(nt, 'data-f', 'newtab');
      nt.checked = !!btns[i].newtab;

      var anIn = mkEl('input', 'ban');
      setAttr(anIn, 'type', 'text');
      setAttr(anIn, 'data-f', 'anchor');
      anIn.value = (typeof btns[i].anchor === 'string') ? btns[i].anchor : '';

      var rm = mkEl('button', 'bremove');
      rm.textContent = 'remove';
      rm.addEventListener('click', function () {
        syncFields();
        var at = Number(setAttrGet(rw, 'data-rowidx'));
        if (!isNaN(at) && at >= 0 && obj.buttons.length) {
          obj.buttons.splice(at, 1);
          dirty = true; markDirty();
        }
        redrawRows();
      });

      rw.appendChild(lab); rw.appendChild(sel); rw.appendChild(toIn);
      rw.appendChild(urlIn); rw.appendChild(nt); rw.appendChild(anIn); rw.appendChild(rm);
      rowsWrap.appendChild(rw);

      var commit = function () { commitRowButton(rw, obj); };
      cfg.rowCommits.push(commit);
      watch(lab, commit);
      watch(sel, commit);
      watch(toIn, commit);
      watch(urlIn, commit);
      watch(nt, commit);

      var commitAnchor = function () {
        if (!Array.isArray(obj.buttons)) return;
        var at = Number(setAttrGet(rw, 'data-rowidx'));
        if (isNaN(at) || at < 0 || at >= obj.buttons.length) return;
        var b = obj.buttons[at];
        if (!b || typeof b !== 'object') return;
        var v = val(anIn).trim();
        if (v !== '' && !slugProblem(v)) { b.anchor = v; return; }
        if (v === '' && 'anchor' in b) delete b.anchor;
      };
      cfg.rowCommits.push(commitAnchor);
      watch(anIn, commitAnchor);
    }
  }
  redrawRows();
}

function createLinksPanel(container, cfg) {
  cfg.rowCommits = [];
  PANEL_CFGS.push(cfg);
  container.className = 'panel';
  redrawLinksPanel(cfg);
}

function renderMenuPanels() {
  if (!MENU_BODY) return;
  MENU_BODY.innerHTML = '';
  if (!model) return;

  /* header display text (title / subtitle / logo) — separate from the link rows */
  var hp = mkEl('div', 'panel');
  MENU_BODY.appendChild(hp);
  var hHead = mkEl('div', 'panel-head');
  var hTitle = mkEl('span', 'panel-title');
  hTitle.textContent = 'Site header text';
  hHead.appendChild(hTitle);
  hp.appendChild(hHead);

  var tLab = mkEl('span', 'field-label');
  tLab.textContent = 'site title:';
  var tF = ceDiv();
  tF.innerText = String(model.header.title == null ? '' : model.header.title);
  var cT = function () { model.header.title = val(tF); };
  panelFields.push(cT);
  watch(tF, cT);
  hp.appendChild(tLab); hp.appendChild(tF);

  var sLab = mkEl('span', 'field-label');
  sLab.textContent = 'subtitle:';
  var sF = ceDiv();
  sF.innerText = String(model.header.subtitle == null ? '' : model.header.subtitle);
  var cS = function () { model.header.subtitle = val(sF); };
  panelFields.push(cS);
  watch(sF, cS);
  hp.appendChild(sLab); hp.appendChild(sF);

  var lLab = mkEl('span', 'field-label');
  lLab.textContent = 'logo asset (empty = none):';
  var lIn = mkEl('input', 'panel-field logo');
  setAttr(lIn, 'type', 'text');
  setAttr(lIn, 'list', 'asset-options');
  lIn.value = (model.header.logo_asset == null) ? '' : String(model.header.logo_asset);
  var cL = function () {
    var v = val(lIn).trim();
    model.header.logo_asset = (v === '') ? null : v;
  };
  panelFields.push(cL);
  watch(lIn, cL);
  hp.appendChild(lLab); hp.appendChild(lIn);

  /* header links = the site menu */
  var menuWrap = mkEl('div', 'menu-header');
  MENU_BODY.appendChild(menuWrap);
  createLinksPanel(menuWrap, {
    container: menuWrap, kind: 'links', field: 'header', site: true, automatic: true,
    label: 'Site menu (header links)',
    note: 'The menu shown at the top of every page. "Auto menu from pages" rebuilds it from the current page order; links can also be added or edited one by one.',
    getObj: function () { return model.header; }
  });

  /* footer links */
  var footWrap = mkEl('div', 'menu-footer');
  MENU_BODY.appendChild(footWrap);
  createLinksPanel(footWrap, {
    container: footWrap, kind: 'links', field: 'footer', site: true,
    label: 'Footer links',
    note: 'Links shown at the bottom of every page.',
    getObj: function () { return model.footer; }
  });

  /* footer text */
  var ftWrap = mkEl('div', 'panel');
  MENU_BODY.appendChild(ftWrap);
  var ftHead = mkEl('div', 'panel-head');
  var ftTitle = mkEl('span', 'panel-title');
  ftTitle.textContent = 'Footer text';
  ftHead.appendChild(ftTitle);
  ftWrap.appendChild(ftHead);
  var xLab = mkEl('span', 'field-label');
  xLab.textContent = 'footer text:';
  var xF = ceDiv();
  xF.innerText = String(model.footer.text == null ? '' : model.footer.text);
  var cX = function () { model.footer.text = val(xF); };
  panelFields.push(cX);
  watch(xF, cX);
  ftWrap.appendChild(xLab); ftWrap.appendChild(xF);
}

/* ---------- 6. site design: theme knobs + named presets ---------- */

var THEME_SWATCHES = [['#4f8b7e', 'pine (default)'], ['#5b8dbd', 'blue'], ['#b0566e', 'rose'],
                     ['#c19a55', 'amber'], ['#556b4f', 'moss'], ['#7a6f8f', 'violet']];

var THEME_PRESETS = [
  ['Paper', { accent: '#4f8b7e', background: '#f9f9f7', text: '#1b1e20', font: 'sans', content_width: 760 }],
  ['Ink', { accent: '#3b5a8c', background: '#fbfbfa', text: '#14161a', font: 'serif', content_width: 700 }],
  ['Terracotta', { accent: '#b4543b', background: '#f7f1e8', text: '#2a211c', font: 'serif', content_width: 720 }],
  ['Forest', { accent: '#3f6f4e', background: '#f2f4ef', text: '#18241c', font: 'sans', content_width: 800 }],
  ['Slate', { accent: '#6b7f92', background: '#23262b', text: '#eceef1', font: 'sans', content_width: 820 }]
];

function bindSwatchClick(swNode) {
  swNode.addEventListener('click', function (ev) {
    syncFields();
    model.theme.accent = swNode.getAttribute('data-color');
    dirty = true;
    markDirty();
    renderSidebar();
  });
}

function renderSettings() {
  if (!DESIGN_BODY) return;
  DESIGN_BODY.innerHTML = '';
  if (!model) return;

  var theme = mkEl('div', 'theme');

  var swLab = mkEl('span', 'field-label');
  swLab.textContent = 'accent — pick a swatch, or type a custom hex:';
  theme.appendChild(swLab);
  var swWrap = mkEl('div', 'swatches');
  for (var i = 0; i < THEME_SWATCHES.length; i++) {
    var s = mkEl('button', 'swatch');
    setAttr(s, 'data-color', THEME_SWATCHES[i][0]);
    s.style.background = THEME_SWATCHES[i][0];
    var swTitle = mkEl('span');
    swTitle.textContent = THEME_SWATCHES[i][1];
    s.appendChild(swTitle);
    if (model.theme.accent === THEME_SWATCHES[i][0]) setAttr(s, 'data-active', '1');
    bindSwatchClick(s);
    swWrap.appendChild(s);
  }
  theme.appendChild(swWrap);

  var hexIn = mkEl('input', 'ta-hex');
  setAttr(hexIn, 'type', 'text');
  hexIn.value = String(model.theme.accent);
  var cAccent = function () {
    var v = val(hexIn).trim();
    if (!isHexColor(v)) {
      if (v !== '') setStatus('Hex refused', 'use #abc or #aabbcc (3–8 hex digits)');
      return;
    }
    model.theme.accent = v;
  };
  panelFields.push(cAccent);
  watch(hexIn, cAccent);
  theme.appendChild(hexIn);

  var bgLab = mkEl('span', 'field-label');
  bgLab.textContent = 'page background hex:';
  var bgIn = mkEl('input', 'ta-bg');
  setAttr(bgIn, 'type', 'text');
  bgIn.value = String(model.theme.background);
  var bgCommit = function () {
    var v = val(bgIn).trim();
    if (isHexColor(v)) model.theme.background = v;
  };
  panelFields.push(bgCommit);
  watch(bgIn, bgCommit);
  theme.appendChild(bgLab); theme.appendChild(bgIn);

  var txLab = mkEl('span', 'field-label');
  txLab.textContent = 'body text hex:';
  var txIn = mkEl('input', 'ta-text');
  setAttr(txIn, 'type', 'text');
  txIn.value = String(model.theme.text);
  var txCommit = function () {
    var v = val(txIn).trim();
    if (isHexColor(v)) model.theme.text = v;
  };
  panelFields.push(txCommit);
  watch(txIn, txCommit);
  theme.appendChild(txLab); theme.appendChild(txIn);

  var fLab = mkEl('span', 'field-label');
  fLab.textContent = 'font:';
  var fSel = makeSelect('', [['sans', 'sans'], ['serif', 'serif'], ['mono', 'mono']]);
  var fCommit = function () { model.theme.font = val(fSel); };
  panelFields.push(fCommit);
  watch(fSel, fCommit);
  theme.appendChild(fLab); theme.appendChild(fSel);

  var wLab = mkEl('span', 'field-label');
  wLab.textContent = 'content width (480–1100):';
  var wRange = mkEl('input', 'ta-width');
  setAttr(wRange, 'type', 'range');
  setAttr(wRange, 'min', '480');
  setAttr(wRange, 'max', '1100');
  setAttr(wRange, 'value', String(Math.max(480, Math.min(1100, Number(model.theme.content_width) || 760))));
  var wCommit = function () {
    var n = Number(wRange.value);
    if (isFinite(n)) model.theme.content_width = Math.max(480, Math.min(1100, Math.round(n)));
  };
  panelFields.push(wCommit);
  watch(wRange, wCommit);
  theme.appendChild(wLab); theme.appendChild(wRange);

  DESIGN_BODY.appendChild(theme);

  /* named theme presets: one click applies a knob bundle */
  var preWrap = mkEl('div', 'theme-preset-row');
  for (var pi = 0; pi < THEME_PRESETS.length; pi++) {
    var bundle = THEME_PRESETS[pi][1];
    var pbtn = mkEl('button', 'theme-preset');
    setAttr(pbtn, 'data-preset', String(pi));
    pbtn.appendChild(mkEl('span', 'tp-chip')).style.background = bundle.accent;
    pbtn.appendChild(mkEl('span', 'tp-chip')).style.background = bundle.background;
    pbtn.appendChild(mkEl('span', 'tp-chip')).style.background = bundle.text;
    var nm = mkEl('span');
    nm.textContent = THEME_PRESETS[pi][0];
    pbtn.appendChild(nm);
    bindThemePreset(pbtn);
    preWrap.appendChild(pbtn);
  }
  DESIGN_BODY.appendChild(preWrap);
}
function bindThemePreset(pbtn) {
  pbtn.addEventListener('click', function (ev) {
    var i = Number(setAttrGet(pbtn, 'data-preset'));
    if (isNaN(i) || i < 0 || i >= THEME_PRESETS.length) return;
    syncFields();
    var bundle = THEME_PRESETS[i][1];
    model.theme.accent = bundle.accent;
    model.theme.background = bundle.background;
    model.theme.text = bundle.text;
    model.theme.font = bundle.font;
    model.theme.content_width = bundle.content_width;
    dirty = true; markDirty();
    renderSidebar();
    setStatus('Theme applied', THEME_PRESETS[i][0] + ' — accent · background · text · font · width');
  });
}

/* ---------- 7. my designs: save selected blocks, re-add them later ---------- */

function renderDesigns() {
  if (!DESIGN_BODY2) return;
  DESIGN_BODY2.innerHTML = '';
  if (!model) return;

  var form = mkEl('div', 'design-form');
  form.appendChild(mkEl('div', 'panel-note')).textContent =
    'Name it, tick the blocks to keep on the current page, then save. Saved designs live in model.designs and can be re-added to any page.';
  var nameIn = mkEl('input', 'design-name');
  setAttr(nameIn, 'type', 'text');
  nameIn.value = '';
  form.appendChild(mkEl('span', 'field-label')).textContent = 'design name:';
  form.appendChild(nameIn);

  var pg = currentPage();
  var pickWrap = mkEl('div', 'design-pick');
  if (pg) {
    for (var bi = 0; bi < pg.blocks.length; bi++) {
      var pick = mkEl('button', 'pick');
      setAttr(pick, 'data-idx', String(bi));
      setAttr(pick, 'data-on', '0');
      pick.appendChild(mkEl('span')).textContent = '#' + (bi + 1) + ' ' + blockName(pg.blocks[bi]);
      pickWrap.appendChild(pick);
    }
  }
  form.appendChild(pickWrap);
  form.appendChild(mkEl('div', 'panel-note')).textContent = 'Nothing ticked = save every block on this page.';

  var saveBtn = mkEl('button', 'design-save pg-add');
  saveBtn.textContent = 'Save design';
  saveBtn.addEventListener('click', function () {
    var name = val(nameIn).trim();
    if (name === '') { setStatus('Save design refused', 'give the design a name first'); return; }
    if (name.length > 40) { setStatus('Save design refused', 'design name must be at most 40 characters (server cap)'); return; }
    syncFields();
    var page = currentPage();
    if (!page) { setStatus('Save design refused', 'no page selected'); return; }
    var chosen = [];
    for (var q = 0; q < pickWrap.children.length; q++) {
      var pk = pickWrap.children[q];
      if ((pk.getAttribute('data-on') || '0') === '1') chosen.push(Number(pk.getAttribute('data-idx')));
    }
    chosen.sort();
    var blocksOut = [];
    if (!chosen.length) {
      blocksOut = deepCopy(page.blocks) || [];
    } else {
      for (var ci = 0; ci < chosen.length; ci++) {
        var at = chosen[ci];
        if (at >= 0 && at < page.blocks.length) blocksOut.push(deepCopy(page.blocks[at]));
      }
    }
    model.designs.push({ name: name, blocks: blocksOut });
    dirty = true; markDirty();
    renderSidebar();
    setStatus('Design saved', '"' + name + '" stored with ' + blocksOut.length + ' block(s) at model.designs');
  });
  form.appendChild(saveBtn);
  DESIGN_BODY2.appendChild(form);

  var picks = pickWrap;
  for (var pi2 = 0; pi2 < picks.children.length; pi2++) {
    var pickBtn = picks.children[pi2];
    bindPickToggle(pickBtn, picks);
  }

  var list = model.designs;
  for (var di = 0; di < list.length; di++) {
    var d = list[di];
    if (!d || typeof d !== 'object') continue;
    var card = mkEl('div', 'design-card');
    setAttr(card, 'data-design-idx', String(di));
    var titleEl = mkEl('span', 'design-title');
    titleEl.textContent = String(d.name);
    card.appendChild(titleEl);
    var cnt = mkEl('span', 'design-count');
    cnt.textContent = (Array.isArray(d.blocks) ? d.blocks.length : 0) + ' blocks';
    card.appendChild(cnt);
    var types = mkEl('span', 'design-types');
    var namesArr = [];
    if (Array.isArray(d.blocks)) for (var bi2 = 0; bi2 < d.blocks.length; bi2++) namesArr.push(blockName(d.blocks[bi2]));
    types.textContent = namesArr.join(' · ');
    card.appendChild(types);
    var ctl = mkEl('div', 'design-ctl');
    var addBtn = mkEl('button', 'design-import');
    addBtn.textContent = 're-add to this page';
    bindDesignReAdd(addBtn, card);
    ctl.appendChild(addBtn);
    var delBtn2 = mkEl('button', 'del');
    delBtn2.textContent = 'delete';
    bindDesignDelete(delBtn2, card);
    ctl.appendChild(delBtn2);
    card.appendChild(ctl);
    DESIGN_BODY2.appendChild(card);
  }
}
function bindPickToggle(pickBtn, wrap) {
  pickBtn.addEventListener('click', function (ev) {
    var on = (pickBtn.getAttribute('data-on') || '0') === '1';
    setAttr(pickBtn, 'data-on', on ? '0' : '1');
  });
}
function bindDesignReAdd(btn, card) {
  btn.addEventListener('click', function () {
    if (!model) return;
    var i = Number(setAttrGet(card, 'data-design-idx'));
    if (isNaN(i) || i < 0 || i >= model.designs.length) { setStatus('Re-add refused', 'this design moved — refresh the panel'); return; }
    var d = model.designs[i];
    if (!d || !Array.isArray(d.blocks)) { setStatus('Re-add refused', 'design has no blocks'); return; }
    var made = deepCopy(d.blocks) || [];
    var n = insertBlocks(made, 'Design re-added');
    if (n === 0) setStatus('Re-add refused', 'design has no blocks to insert');
  });
}
function bindDesignDelete(btn, card) {
  btn.addEventListener('click', function () {
    if (!model) return;
    var i = Number(setAttrGet(card, 'data-design-idx'));
    if (isNaN(i) || i < 0 || i >= model.designs.length) return;
    syncFields();
    model.designs.splice(i, 1);
    dirty = true; markDirty();
    renderSidebar();
    setStatus('Design deleted', 'that design was removed — ' + model.designs.length + ' left in model.designs');
  });
}

/* ---------- 8. sidebar chrome: groups, collapse, device widths ---------- */

function renderSidebar() {
  panelFields = [];
  PANEL_CFGS = [];
  pendingNotes = {};
  renderChips();
  renderPresets();
  renderPagesSection();
  renderPageOps();
  renderMenuPanels();
  renderSettings();
  renderDesigns();
  refreshPageOptions();
  refreshAssetOptions();
}

var currentDevice = 'desktop';

function setFrameDevice(dev) {
  var want = (dev === 'tablet' || dev === 'phone') ? dev : 'desktop';
  currentDevice = want;
  if (FRAME_WRAP) setAttr(FRAME_WRAP, 'data-device', want);
  if (DEVICE_READ) {
    DEVICE_READ.textContent = want + ' · ' + (want === 'desktop' ? 'full width' : (want === 'tablet' ? '768 px' : '390 px'));
  }
  var dbs = document.querySelectorAll('.device-btn');
  for (var i = 0; i < dbs.length; i++) {
    if (dbs[i].getAttribute('data-device') === want) setAttr(dbs[i], 'data-active', '1');
    else dbs[i].removeAttribute('data-active');
  }
}

function bindSidebarControls() {
  var cb = document.querySelector('#collapse-btn');
  if (cb) {
    cb.addEventListener('click', function () {
      if (!SIDEBAR) return;
      var open = (SIDEBAR.getAttribute('data-open') || '1') === '1';
      setAttr(SIDEBAR, 'data-open', open ? '0' : '1');
      setAttr(cb, 'aria-expanded', open ? 'false' : 'true');
      setStatus(open ? 'Presentation mode' : 'Panel open',
        open ? 'sidebar collapsed — the preview fills the window (click the chevron tab to bring the panel back)'
             : 'editor panel is back (360 px)');
    });
  }

  var toggles = document.querySelectorAll('.group-toggle');
  for (var i = 0; i < toggles.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var hostId = btn.getAttribute('data-group');
        if (!hostId) return;
        var host = document.getElementById(hostId);
        if (!host) return;
        var open = (host.getAttribute('data-open') || '1') === '1';
        setAttr(host, 'data-open', open ? '0' : '1');
      });
    })(toggles[i]);
  }

  var dbs = document.querySelectorAll('.device-btn');
  for (var d = 0; d < dbs.length; d++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var dev = btn.getAttribute('data-device');
        if (dev === currentDevice) return;
        setFrameDevice(dev);
        setStatus('Preview width', dev + ' (' + (dev === 'tablet' ? '768 px' : dev === 'phone' ? '390 px' : 'full window') + ') — the page reflows, the model did not change');
      });
    })(dbs[d]);
  }
}

/* ---------- 9. preview ---------- */

function refreshPreview() {
  if (!FRAME || !model || currentKey == null) return;
  var url = '/preview/' + encodeURIComponent(String(currentKey)) + '.html?v=' + String(saveV);
  setAttr(FRAME, 'src', url);
}

/* ---------- 10. upload ---------- */

async function uploadFromFile(card) {
  var inp = card.uploadBox;
  if (!inp) return;
  var f = inp.value;
  if (!(f instanceof File)) {
    card.note.textContent = 'Upload failed: the file control did not hand over a file (drag a file onto the dashed box, or browse for one).';
    pendingNotes[card.idx] = card.note.textContent;
    return;
  }
  card.note.textContent = 'Uploading "' + f.name + '" to POST /api/upload …';
  try {
    var r = await fetch('/api/upload?name=' + encodeURIComponent(f.name), {
      method: 'POST',
      body: f
    });
    if (r.status === 200) {
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('application/json') === -1) throw new Error('upload answered non-JSON');
      var j = await r.json();
      if (!j || j.ok !== true) throw new Error('upload answered ok !== true');
      var asset = (j.asset && String(j.asset)) || f.name;
      if (model && model.assets && typeof model.assets === 'object') {
        model.assets[asset] = { uploaded: new Date().toISOString(), bytes: f.size };
      }
      syncFields();
      if (card.uploadTarget === 'assets') {
        if (card.block && typeof card.block === 'object') {
          if (!Array.isArray(card.block.assets)) card.block.assets = [];
          var haveIt = false;
          for (var ai = 0; ai < card.block.assets.length; ai++) {
            if (String(card.block.assets[ai]) === asset) haveIt = true;
          }
          if (!haveIt) card.block.assets.push(asset);
        }
      } else if (card.block) {
        card.block.asset = asset;
      }
      uploadedNames[asset] = true;
      uploadedNames[f.name] = true;
      dirty = true; markDirty();
      var idx = Number(setAttrGet(inp, 'data-idx'));
      pendingNotes[idx] = 'Uploaded → asset "' + asset + '" (now set on this card).';
      selectedIdx = card.idx;
      refreshAssetOptions();
      renderCards();
    } else if (r.status === 400) {
      var bad = null;
      try {
        if ((r.headers.get('content-type') || '').indexOf('application/json') !== -1) bad = await r.json();
      } catch (e2) {}
      var msg = (bad && bad.error) ? String(bad.error) : 'server rejected the upload';
      card.note.innerHTML = '';
      var errSpan = mkEl('span', 'err');
      errSpan.textContent = 'Upload failed: ' + msg;
      card.note.appendChild(errSpan);
      pendingNotes[card.idx] = card.note.textContent;
    } else {
      pendingNotes[card.idx] = 'Upload failed: unexpected HTTP ' + r.status;
      renderCards();
    }
  } catch (err) {
    pendingNotes[card.idx] = 'Upload failed: ' + String(err);
    renderCards();
  }
}

/* ---------- 11. export + reset ---------- */

function renderExportPanel() {
  if (!EXPORT_PANEL) return;
  EXPORT_PANEL.innerHTML = '';
  var ctl = mkEl('div', 'export-ctl');
  var exBtn = mkEl('button', 'export-btn');
  exBtn.textContent = 'Export site';
  exBtn.addEventListener('click', function () { doExport(); });
  var resetBtn = mkEl('button', 'reset-btn');
  resetBtn.textContent = 'Reset to blank project…';
  resetBtn.addEventListener('click', function () {
    openConfirm(EXPORT_PANEL,
      'Reset to blank project? Uploaded assets stay, but ALL pages (and their blocks) are replaced by one empty home page.',
      function () { resetBlank(); });
  });
  ctl.appendChild(exBtn);
  ctl.appendChild(resetBtn);
  EXPORT_PANEL.appendChild(ctl);
}

function resetBlank() {
  syncFields();
  model.pages = [blankPage('home', 'Home')];
  currentKey = 'home';
  selectedIdx = null;
  dirty = true; markDirty();
  renderSidebar();
  renderCards();
  refreshPreview();
  setStatus('Reset', 'pages replaced by one blank home page (assets kept)');
}

async function doExport() {
  setStatus('Exporting', 'POST /api/export');
  try {
    syncFields();
    var r = await fetch('/api/export', { method: 'POST' });
    if (r.status !== 200) {
      setStatus('Export failed', 'HTTP ' + r.status + ' on POST /api/export');
      return;
    }
    var ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('application/json') === -1) { setStatus('Export failed', 'non-JSON answer from POST /api/export'); return; }
    var j = await r.json();
    if (!j || j.ok !== true) { setStatus('Export failed', 'answer did not have ok:true'); return; }
    var count = (j.files && Array.isArray(j.files)) ? j.files.length : 0;
    var absPath = (j && j.path) ? String(j.path) : '(path not reported)';

    if (EXPORT_PANEL) {
      EXPORT_PANEL.innerHTML = '';
      renderExportPanel();
      var res = mkEl('div', 'export-result');
      var cnt = mkEl('span', 'cnt');
      cnt.textContent = 'Files written: ' + count + '  ·  at ';
      res.appendChild(cnt);
      var pathCode = mkEl('code');
      pathCode.textContent = absPath;
      res.appendChild(pathCode);
      var zipA = mkEl('a', 'zip-link');
      setAttr(zipA, 'href', '/api/export/zip');
      setAttr(zipA, 'download', 'site.zip');
      zipA.textContent = 'download site.zip';
      res.appendChild(mkEl('br')); res.appendChild(zipA);
      var viewA = mkEl('a');
      setAttr(viewA, 'href', '/export-view');
      viewA.textContent = 'browse the exported folder (/export-view)';
      res.appendChild(mkEl('br')); res.appendChild(viewA);
      var hint = mkEl('span');
      hint.textContent = 'Serve it right away: ';
      res.appendChild(mkEl('br')); res.appendChild(hint);
      var serveCode = mkEl('code');
      serveCode.textContent = 'python3 -m http.server 9000';
      res.appendChild(serveCode);
      EXPORT_PANEL.appendChild(res);
    }
    setStatus('Exported', count + ' files at ' + absPath);
  } catch (err) {
    setStatus('Export failed', String(err));
  }
}

/* ---------- 12. boot ---------- */

bindSidebarControls();
setFrameDevice('desktop');

async function boot() {
  setStatus('Loading', '/api/project …');
  var m = null;
  try {
    var r = await fetch('/api/project', { cache: 'no-store' });
    if (r.status !== 200) throw new Error('GET /api/project answered HTTP ' + r.status);
    var ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('application/json') === -1) throw new Error('GET /api/project answered non-JSON');
    m = await r.json();
    if (!m || typeof m !== 'object') throw new Error('project answer was not an object');
  } catch (e) {
    setStatus('Project load failed', String(e) + ' — running on a blank starter model; saves will retry while you edit.');
  }
  model = normalizeModel(m);
  currentKey = String(model.pages[0].key);
  renderSidebar();
  renderCards();
  renderExportPanel();
  refreshPreview();
  setStatus('Loaded', 'autosave posts the changed model 400 ms after each edit (v ' + saveV + ')');
}
boot();
