'use strict';

/* ==========================================================================
   Website Builder editor UI — app.js
   Endpoints this UI calls (server is written to the same contract):
     GET  /api/project                (load)
     POST /api/project                (autosave; JSON body = whole model)
     GET  /preview/<key>.html?v=<v>   (iframe src)
     POST /api/upload?name=<file>     (raw File bytes as fetch body, NO multipart)
     POST /api/export                 (export button)
     <a href="/api/export/zip">       (browser download link)
     <a href="/export-view">          (browser link to the file listing)
   Sections:
     1 helpers · 2 model + autosave · 3 block cards (render/fields/reorder)
     4 toolbar · 5 page rail + reusable header/footer panels + site settings
     6 preview · 7 upload · 8 export + reset
   ========================================================================== */

/* ---------- 1. helpers ---------- */

var statusBar = null;
const CARD_AREA = document.querySelector('#card-area');
const RAIL = document.querySelector('#rail');
const PAGES_SECTION = document.querySelector('#pages-section');
const PAGE_OPS = document.querySelector('#page-ops');
const SETTINGS_SECTION = document.querySelector('#settings-section');
const EXPORT_PANEL = document.querySelector('#export-panel');
const FRAME = document.querySelector('#preview-frame');
const ASSET_DATALIST = document.querySelector('#asset-options');
const PAGE_DATALIST = document.querySelector('#page-options');
const TOP_STRIP = document.querySelector('.topstrip');

var uidSeq = 0;
function nextId(base) { uidSeq += 1; return base + '-u' + uidSeq; }

function mkEl(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function setAttr(node, name, v) { node.setAttribute(name, v); return node; }
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
  if (!/^[a-z]/.test(slug)) return 'key must start with a-z';
  if (!/^[a-z0-9-]+$/.test(slug)) return 'key may only contain a-z 0-9 and hyphens';
  if (slug.length > 32) return 'key must be at most 32 chars';
  return null;
}
function isHexColor(v) { return typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v); }

/* ---------- 2. model + autosave ---------- */

var model = null;
var currentKey = null;
var saveV = 0;
var dirty = false;
var saveTimer = null;
var SAVE_DEBOUNCE_MS = 400;

var liveCards = [];          /* current card UI objects (current page) */
var selectedIdx = null;      /* index in current page's blocks[] */
var dragFrom = null;
var dragHover = null;
var panelFields = [];        /* flush fns for theme controls (rebuilt in renderRail) */
var PANEL_CFGS = [];         /* live header/footer panel configs */
var panelButtons = [];       /* structural panel buttons (add/use-default/edit-override) */
var uploadedNames = {};      /* filename -> true (for the asset datalist) */
var pendingNotes = {};       /* card idx -> note text (survives card rebuilds) */

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
      /* dirty stays true; no new timer: only a fresh user edit retries the save */
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
                   'divider', 'quote', 'contact_card', 'social_links', 'custom_html'];

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
  /* extra safety for browsers that skip 'input' on contenteditable:
     any typing keystroke marks dirty; the save flush reads the DOM anyway */
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
  var commit = function () {
    var v = val(inp);
    if (datalistId === 'asset-options') {
      /* datalist is a suggestion only: any non-empty string is a valid asset name */
      obj[key] = v;
    } else {
      obj[key] = v;
    }
  };
  card.uiFields.push(commit);
  watch(inp, commit);
  return [lab, inp];
}
function makeUploadBox(card, idx) {
  var lab = mkEl('span', 'field-label');
  lab.textContent = 'or drag a new file here (uploads straight away)';
  var inp = mkEl('input', 'field upload-box');
  setAttr(inp, 'type', 'file');
  setAttr(inp, 'data-card', String(idx));
  setAttr(inp, 'data-idx', String(idx));
  card.uploadBox = inp;
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
function setAttrGet(node, name) { return node.getAttribute(name); }
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

/* target fields shared by button + image_button blocks */
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
  };
  card.uiFields.push(commit);
  watch(modeSel, commit);
  watch(toIn, commit);
  watch(urlIn, commit);
  watch(nt, commit);
  return [labMode, modeSel, toIn, urlIn, ntLab, nt];
}

/* target fields shared by header/footer button rows */
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

function buildCard(pg, block, idx) {
  var type = (typeof block.type === 'string') ? block.type : 'unknown';
  var root = mkEl('div', 'card' + (type === 'custom_html' ? ' custom-html' : ''));
  setAttr(root, 'data-block', type);
  setAttr(root, 'draggable', 'true');

  var top = mkEl('header', 'card-top');
  var chip = mkEl('strong', 'type-chip');
  chip.textContent = (KNOWN_TYPES.indexOf(type) >= 0) ? type : '(unsupported block)';
  top.appendChild(chip);
  if (type === 'custom_html') {
    var raw = mkEl('span', 'raw-tag');
    raw.textContent = 'RAW — pasted HTML is not escaped';
    top.appendChild(raw);
  }
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

  var card = { root: root, uiFields: [], rowCommits: [], idx: idx, block: block, note: note, uploadBox: null };

  if (type === 'heading') {
    var h = makeTextField(card, block, 'text', 'text:', null);
    root.appendChild(h[0]); root.appendChild(h[1]);
    var lv = makeSelectField(card, block, 'level', [['1', '1 (H1)'], ['2', '2 (H2)'], ['3', '3 (H3)']], 'level:', true);
    root.appendChild(lv[0]); root.appendChild(lv[1]);
  } else if (type === 'paragraph') {
    var p = makeTextField(card, block, 'text', 'text:',
      '**bold** *italic* [label](to:key) [label](https://url)');
    root.appendChild(p[0]); root.appendChild(p[1]);
  } else if (type === 'image') {
    var a = makeTextFieldInput(card, block, 'asset', 'asset:', 'asset-options');
    root.appendChild(a[0]); root.appendChild(a[1]);
    var alt = makeTextField(card, block, 'alt', 'alt text:', null);
    root.appendChild(alt[0]); root.appendChild(alt[1]);
    var w = makeSelectField(card, block, 'width', [['small', 'small'], ['medium', 'medium'], ['wide', 'wide'], ['full', 'full']], 'width:', false);
    root.appendChild(w[0]); root.appendChild(w[1]);
    var al = makeSelectField(card, block, 'align', [['left', 'left'], ['center', 'center'], ['right', 'right']], 'align:', false);
    root.appendChild(al[0]); root.appendChild(al[1]);
    var cp = makeTextField(card, block, 'caption', 'caption:', null);
    root.appendChild(cp[0]); root.appendChild(cp[1]);
    var ub = makeUploadBox(card, idx);
    root.appendChild(ub[0]); root.appendChild(ub[1]);
  } else if (type === 'button') {
    var lb = makeTextField(card, block, 'label', 'label:', null);
    root.appendChild(lb[0]); root.appendChild(lb[1]);
    var st = makeSelectField(card, block, 'style', [['pill', 'pill'], ['box', 'box']], 'style:', false);
    root.appendChild(st[0]); root.appendChild(st[1]);
    appendGroup(root, addTargetFields(card, block, lb[1]));
  } else if (type === 'image_button') {
    var ib = makeTextFieldInput(card, block, 'asset', 'asset:', 'asset-options');
    root.appendChild(ib[0]); root.appendChild(ib[1]);
    var ia = makeTextField(card, block, 'alt', 'alt text:', null);
    root.appendChild(ia[0]); root.appendChild(ia[1]);
    var il = makeTextField(card, block, 'label', 'label:', null);
    root.appendChild(il[0]); root.appendChild(il[1]);
    var iw = makeSelectField(card, block, 'width', [['small', 'small'], ['medium', 'medium'], ['wide', 'wide']], 'width:', false);
    root.appendChild(iw[0]); root.appendChild(iw[1]);
    var ish = makeSelectField(card, block, 'shape', [['square', 'square'], ['rounded', 'rounded']], 'shape:', false);
    root.appendChild(ish[0]); root.appendChild(ish[1]);
    appendGroup(root, addTargetFields(card, block, il[1]));
    var iub = makeUploadBox(card, idx);
    root.appendChild(iub[0]); root.appendChild(iub[1]);
  } else if (type === 'divider') {
    var dnote = mkEl('div', 'card-note');
    dnote.textContent = 'no fields — just a rule';
    root.appendChild(dnote);
  } else if (type === 'quote') {
    var q = makeTextField(card, block, 'text', 'quote text:', null);
    root.appendChild(q[0]); root.appendChild(q[1]);
    var at = makeTextField(card, block, 'attribution', 'attribution:', null);
    root.appendChild(at[0]); root.appendChild(at[1]);
  } else if (type === 'contact_card') {
    var rc = makeRows(card, block, 'lines', ['label', 'value', 'url'], { label: '', value: '', url: '' }, 'line');
    root.appendChild(rc[0]); root.appendChild(rc[1]);
  } else if (type === 'social_links') {
    var rs = makeRows(card, block, 'items', ['network', 'url', 'label'], { network: '', url: '', label: '' }, 'item');
    root.appendChild(rs[0]); root.appendChild(rs[1]);
  } else if (type === 'custom_html') {
    var hh = makeTextarea(card, block, 'html', 'html (RAW):');
    root.appendChild(hh[0]); root.appendChild(hh[1]);
    var cc = makeTextarea(card, block, 'css', 'css (RAW):');
    root.appendChild(cc[0]); root.appendChild(cc[1]);
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

  /* card controls */
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
function appendGroup(container, nodes) {
  for (var i = 0; i < nodes.length; i++) if (nodes[i]) container.appendChild(nodes[i]);
}

/* drop the vestigial push in makeUploadBox path: it never pushed; keep filter above harmless */

function renderCards() {
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

/* keyboard reorder: click a card to select it, then ArrowUp/ArrowDown
   (ignored while a contenteditable holds the caret, i.e. while typing) */
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

/* HTML5 drag reorder: drag a card, drop it on another card.
   dragover records the hovered card; dragend commits moveBlock. */
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

/* ---------- 4. toolbar ---------- */

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
  return { type: type };
}

function initToolbar() {
  if (!TOP_STRIP) return;
  var toolbar = TOP_STRIP.querySelector('#toolbar');
  if (!toolbar) return;
  var btns = toolbar.querySelectorAll('.tool-btn');
  for (var i = 0; i < btns.length; i++) bindToolClick(btns[i]);
}
function bindToolClick(btnNode) {
  btnNode.addEventListener('click', function (ev) {
    appendBlock(btnNode.getAttribute('data-block'));
  });
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

/* ---------- 5. page rail + reusable panels + site settings ---------- */

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

/* --- reusable header/footer panel (site-level AND per-page override) --- */

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

  /* button rows */
  var blab = mkEl('span', 'field-label');
  blab.textContent = 'buttons:';
  container.appendChild(blab);
  if (!Array.isArray(obj.buttons)) obj.buttons = [];
  var rowsWrap = mkEl('div', 'brows');
  container.appendChild(rowsWrap);

  var anchor = cfg.rowCommits.length;

  function redrawRows() {
    rowsWrap.innerHTML = '';
    cfg.rowCommits.length = anchor; /* drop this panel's stale row fns from a previous redraw */
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

function createPanel(container, cfg) {
  cfg.rowCommits = [];
  PANEL_CFGS.push(cfg);
  container.className = 'panel';
  redrawPanel(cfg);
}

/* --- render: pages section --- */

function bindPageClick(btnNode) {
  btnNode.addEventListener('click', function (ev) {
    switchPage(btnNode.getAttribute('data-key'));
  });
}

function renderPagesSection() {
  PAGES_SECTION.innerHTML = '';
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
  PAGES_SECTION.appendChild(cur);

  var list = mkEl('div', 'pg-list');
  for (var i = 0; i < model.pages.length; i++) {
    var p = model.pages[i];
    var b = mkEl('button', 'pg-item' + (p.key === currentKey ? ' pg-current-btn' : ''));
    setAttr(b, 'data-key', String(p.key));
    b.textContent = String(p.title);
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
  PAGES_SECTION.appendChild(list);
}

function switchPage(key) {
  if (!model || indexOfPage(key) < 0) return;
  currentKey = key;
  selectedIdx = null;
  renderRail();
  renderCards();
  refreshPreview();
  setStatus('Switched', 'preview + cards now show page "' + key + '"');
}

/* --- render: page ops (current page) --- */

function renderPageOps() {
  PAGE_OPS.innerHTML = '';
  var pg = currentPage();
  if (!pg) return;

  /* Add page */
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
    renderRail(); renderCards(); refreshPreview();
    setStatus('Added page', k + ' (' + (t === '' ? k : t) + ') is now the current page');
  });
  addF.appendChild(keyIn); addF.appendChild(titleIn); addF.appendChild(apBtn);
  PAGE_OPS.appendChild(addF);

  /* Rename (title only) */
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
    renderRail();
    setStatus('Renamed page', String(pg.key) + ' title → "' + v + '"');
  });
  rn.appendChild(rnNew); rn.appendChild(rnApply);
  PAGE_OPS.appendChild(rn);

  /* Change URL key */
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
    ckLive.appendChild(mkEl('span')).textContent = 'valid key — buttons, block links and (to:…) links will be swept over.';
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
  PAGE_OPS.appendChild(ck);

  /* Delete page (with confirm box) */
  var delWrap = mkEl('div', 'del-form');
  var delBtn = mkEl('button', 'del-page');
  delBtn.textContent = 'Delete this page…';
  delBtn.addEventListener('click', function () { openConfirm(PAGE_OPS,
    'Delete page "' + String(pg.key) + '" (' + String(pg.title) + ') now? All buttons, block links and paragraph links pointing at it are dropped. This cannot be undone.',
    function () {
      var res = deletePage(String(pg.key));
      if (!res.ok) setStatus('Delete page refused', res.error);
    });
  });
  delWrap.appendChild(delBtn);
  PAGE_OPS.appendChild(delWrap);

  /* per-page header + footer override panels (reuses the site panel) */
  var hp = mkEl('div', 'ovr-header');
  PAGE_OPS.appendChild(hp);
  createPanel(hp, {
    container: hp, kind: 'header', field: 'header_override', page: true, pageObj: pg,
    label: 'Header override',
    getObj: function () { return pg.header_override; }
  });
  var fp = mkEl('div', 'ovr-footer');
  PAGE_OPS.appendChild(fp);
  createPanel(fp, {
    container: fp, kind: 'text', field: 'footer_override', page: true, pageObj: pg,
    label: 'Footer override',
    getObj: function () { return pg.footer_override; }
  });
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
  renderRail();
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
  renderRail();
  renderCards();
  refreshPreview();
  refreshPageOptions();
  setStatus('Page deleted', '"' + oldKey + '" removed — ' + dropped + ' references dropped');
  return { ok: true, dropped: dropped };
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

/* --- render: site settings --- */

var THEME_SWATCHES = [['#4f8b7e', 'pine (default)'], ['#5b8dbd', 'blue'], ['#b0566e', 'rose'],
                     ['#c19a55', 'amber'], ['#556b4f', 'moss'], ['#7a6f8f', 'violet']];

function bindSwatchClick(swNode) {
  swNode.addEventListener('click', function (ev) {
    syncFields();
    model.theme.accent = swNode.getAttribute('data-color');
    dirty = true;
    markDirty();
    renderRail();
  });
}

function renderSettings() {
  SETTINGS_SECTION.innerHTML = '';
  if (!model) return;

  var theme = mkEl('div', 'theme');

  var aLab = mkEl('span', 'field-label');
  aLab.textContent = 'accent — pick a swatch, or set a custom hex:';
  theme.appendChild(aLab);
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
  hexIn.addEventListener('change', function () {
    var v = val(hexIn).trim();
    if (!isHexColor(v)) { setStatus('Hex refused', 'use #abc or #aabbcc (3–8 hex digits)'); return; }
    syncFields();
    model.theme.accent = v;
    dirty = true; markDirty();
    renderRail();
  });
  theme.appendChild(hexIn);

  var bgLab = mkEl('span', 'field-label');
  bgLab.textContent = 'background hex:';
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

  SETTINGS_SECTION.appendChild(theme);

  var hp = mkEl('div', 'panel-site-header');
  SETTINGS_SECTION.appendChild(hp);
  createPanel(hp, {
    container: hp, kind: 'header', field: 'header', site: true,
    label: 'Site header',
    getObj: function () { return model.header; }
  });
  var fp = mkEl('div', 'panel-site-footer');
  SETTINGS_SECTION.appendChild(fp);
  createPanel(fp, {
    container: fp, kind: 'text', field: 'footer', site: true,
    label: 'Site footer',
    getObj: function () { return model.footer; }
  });
}

function renderRail() {
  panelFields = [];
  PANEL_CFGS = [];
  pendingNotes = {};
  renderPagesSection();
  renderPageOps();
  renderSettings();
  refreshPageOptions();
  refreshAssetOptions();
}

/* --- export controls + reset live in the export panel --- */

function renderExportPanel() {
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
  renderRail();
  renderCards();
  refreshPreview();
  setStatus('Reset', 'pages replaced by one blank home page (assets kept)');
}

/* ---------- 6. preview ---------- */

function refreshPreview() {
  if (!FRAME || !model || currentKey == null) return;
  var url = '/preview/' + encodeURIComponent(String(currentKey)) + '.html?v=' + String(saveV);
  setAttr(FRAME, 'src', url);
}

/* ---------- 7. upload ---------- */

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
      body: f /* raw File bytes as the body — no multipart wrapper */
    });
    if (r.status === 200) {
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('application/json') === -1) throw new Error('upload answered non-JSON');
      var j = await r.json();
      if (!j || j.ok !== true) throw new Error('upload answered ok !== true');
      var asset = (j.asset && String(j.asset)) || f.name;
      /* mirror the server's asset bookkeeping: the autosave POSTs our in-memory
         model, and without this key the POST would drop it from model.assets,
         breaking the /preview/assets/<name> membership guard */
      if (model && model.assets && typeof model.assets === 'object') {
        model.assets[asset] = { uploaded: new Date().toISOString(), bytes: f.size };
      }
      syncFields();
      card.block.asset = asset;
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

/* ---------- 8. export ---------- */

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

    EXPORT_PANEL.innerHTML='';
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
    setStatus('Exported', count + ' files at ' + absPath);
  } catch (err) {
    setStatus('Export failed', String(err));
  }
}

/* ---------- boot ---------- */

initToolbar();

async function boot() {
  statusBar = document.querySelector('#status-bar');
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
  renderRail();
  renderCards();
  refreshPreview();
  setStatus('Loaded', 'starter/theme applied · autosave posts changed model 400ms after each edit (v ' + saveV + ')');
}
boot();
