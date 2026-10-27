'use strict';

/* ───── утилиты ───── */

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const TOK = encodeURIComponent(BOOT.token || '');
const q = p => p + (p.indexOf('?') < 0 ? '?' : '&') + 't=' + TOK;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fUrl = id => q('/f/' + id);
const tUrl = f => q('/t/' + f.id + '?v=' + Math.round(f.mtime || 0));
const tUrlId = id => q('/t/' + id);
const dirUrl = (rel, fresh) => q('/api/dir?rel=' + encodeURIComponent(rel) + (fresh ? '&fresh=1' : ''));
const JPEG_RE = /\.jpe?g$/i;
const coll = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
const rootName = BOOT.rootName || BOOT.root || 'Library';

const fmtNum = n => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, x = n;
  while (x >= 1024 && i < 4) { x /= 1024; i++; }
  return (i === 0 ? String(x) : x >= 100 ? x.toFixed(0) : x.toFixed(1)) + ' ' + u[i];
}
function fmtDur(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? h + ':' + p(m) + ':' + p(x) : m + ':' + p(x);
}
const fmtDate = t => t ? new Date(t * 1000).toLocaleDateString('en-CA') : '';
const plural = (n, one, many) => fmtNum(n) + ' ' + (n === 1 ? one : many);
const normRel = r => String(r || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const parentOf = rel => rel.indexOf('/') < 0 ? '' : rel.slice(0, rel.lastIndexOf('/'));
const baseName = p => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p);

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'on' + (bad ? ' bad' : '');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.className = ''; }, bad ? 7000 : 2600);
}

async function getJson(url, signal, opt) {
  const r = await fetch(url, Object.assign({signal: signal}, opt));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'error ' + r.status);
  return j;
}
const post = (path, body) => getJson(q(path), undefined, {
  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});

/* ───── настройки папки (хранит сервер) ───── */

const DEF = {sort: 'name', desc: false, filter: 'all', view: 'tiles', tile: 220, tree: true, treeW: 280, last: '', volume: 0.8, muted: false};
const S = Object.assign({}, DEF, BOOT.settings || {});
if (['name', 'date', 'size', 'duration'].indexOf(S.sort) < 0) S.sort = 'name';
if (['all', 'photo', 'video'].indexOf(S.filter) < 0) S.filter = 'all';
if (S.view !== 'list') S.view = 'tiles';
S.tile = clamp(+S.tile || 220, 120, 480);
S.treeW = clamp(+S.treeW || 280, 160, 600);
S.volume = clamp(+S.volume, 0, 1);
if (isNaN(S.volume)) S.volume = 0.8;
S.last = normRel(S.last);

let saveTimer = 0, frozen = false;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (frozen) return Promise.resolve();
  // _root: сервер не запишет настройки, если открыта уже другая папка (запрос пришёл во время смены)
  const body = JSON.stringify(Object.assign({}, S, {_root: BOOT.root}));
  return fetch(q('/api/settings'), {method: 'POST', headers: {'Content-Type': 'application/json'}, body, keepalive: true}).catch(() => {});
}
function setS(k, v) {
  S[k] = v;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}
const flushS = () => saveTimer ? saveNow() : Promise.resolve();

/* ───── состояние ───── */

let $scroll = null, $sizer = null, $cells = null;
let D = null;                       // данные текущей папки (ответ /api/dir)
let curRel = '';
let navSeq = 0, applyN = 0, dirAbort = null;
let reading = false;                // идёт чтение папки с диска
let dirs = [], files = [], list = [], nd = 0, nf = 0, filesSize = 0;
const keyIdx = new Map();           // ключ плитки → номер в list
const byId = new Map();             // id файла → файл текущего списка
let selKey = '', selI = -1;
let pendingApply = null;            // данные, пришедшие, пока открыт просмотрщик
const objUrl = new Map();           // id → blob-адрес только что созданной миниатюры
const thumbErr = new Set();         // сервер не отдал миниатюру в этом сеансе
const mounted = new Map();          // номер плитки → элемент в DOM

const GAP = 12, PAD = 14, CAPH = 58, LROW = 34, SECG = 10, THUMB = 320, GEN_MAX = 2;
const G = {avail: 300, cols: 1, cw: 200, ch: 200, rowH: 212, listMode: false, dcols: 1, drowH: 212, ftop: 0, total: 0, top: 0};
let lastW = 0;

const ICO_PHOTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4 4"/></svg>';
const ICO_VID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/></svg>';
const ICO_DIR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6.5A2.5 2.5 0 015.5 4H9l2 2.5h7.5A2.5 2.5 0 0121 9v8.5a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 17.5z"/></svg>';
const ICO_PLAY = '<svg viewBox="0 0 24 24" fill="#fff"><path d="M8 5.5v13l11-6.5z"/></svg>';

/* ───── сортировка (один раз при смене ключа или данных) ───── */

function mkCmp(keyFn, desc) {
  return (a, b) => {
    const x = keyFn(a), y = keyFn(b);
    if (x == null || y == null) {                 // неизвестное — всегда в конец
      if (x != null) return -1;
      if (y != null) return 1;
      return coll.compare(a.name, b.name);
    }
    if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
    return coll.compare(a.name, b.name);
  };
}
function fileCmp() {
  const desc = !!S.desc;
  switch (S.sort) {
    case 'date': return mkCmp(f => f.mtime || 0, desc);
    case 'size': return mkCmp(f => f.size || 0, desc);
    case 'duration': return mkCmp(f => f.kind === 'photo' ? 0 : (f.duration == null ? null : f.duration), desc);
    default: return desc ? (a, b) => coll.compare(b.name, a.name) : (a, b) => coll.compare(a.name, b.name);
  }
}
function dirCmp() {
  const desc = !!S.desc;
  switch (S.sort) {
    case 'date': return mkCmp(d => d.mtime || 0, desc);
    case 'size': return mkCmp(d => d.size || 0, desc);
    default: return desc ? (a, b) => coll.compare(b.name, a.name) : (a, b) => coll.compare(a.name, b.name);
  }
}

function buildLists() {
  const dd = D ? (D.dirs || []) : [];
  const ff = D ? (D.files || []) : [];
  const fl = S.filter === 'all' ? ff.slice() : ff.filter(f => f.kind === S.filter);
  const dl = dd.slice();
  dl.sort(dirCmp());
  fl.sort(fileCmp());
  dirs = dl; files = fl; nd = dl.length; nf = fl.length;
  list = dl.concat(fl);
  keyIdx.clear();
  byId.clear();
  let sz = 0;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    it._i = i;
    if (i < nd) {
      it._k = 'd:' + it.rel;
    } else {
      it._k = 'f:' + it.id;
      byId.set(it.id, it);
      sz += it.size || 0;
    }
    keyIdx.set(it._k, i);
  }
  filesSize = sz;
  selI = keyIdx.has(selKey) ? keyIdx.get(selKey) : -1;
  if (selI < 0) {
    selI = list.length ? 0 : -1;
    selKey = selI >= 0 ? list[0]._k : '';
  }
}

/* ───── раскладка и виртуальная прокрутка ───── */

function layout() {
  const lm = S.view === 'list';
  $('#lhead').hidden = !(lm && nd);
  const avail = Math.max(120, $scroll.clientWidth - 2 * PAD);
  const cols = Math.max(1, Math.floor((avail + GAP) / (S.tile + GAP)));
  const cw = (avail - GAP * (cols - 1)) / cols;
  const ch = Math.round(cw * 0.75) + CAPH;
  G.avail = avail; G.cols = cols; G.cw = cw; G.ch = ch; G.rowH = ch + GAP; G.listMode = lm;
  G.dcols = lm ? 1 : cols;
  G.drowH = lm ? LROW : G.rowH;
  G.ftop = Math.ceil(nd / G.dcols) * G.drowH + (nd && nf ? SECG : 0);
  G.total = G.ftop + Math.ceil(nf / cols) * G.rowH;
  $sizer.style.height = G.total + 'px';
  G.top = $sizer.offsetTop;
  lastW = $scroll.clientWidth;
}

function pos(i) {
  if (i < nd) {
    const r = Math.floor(i / G.dcols), c = i % G.dcols;
    if (G.listMode) return {x: 0, y: r * G.drowH, w: G.avail, h: LROW - 2};
    return {x: c * (G.cw + GAP), y: r * G.drowH, w: G.cw, h: G.ch};
  }
  const j = i - nd, r = Math.floor(j / G.cols), c = j % G.cols;
  return {x: c * (G.cw + GAP), y: G.ftop + r * G.rowH, w: G.cw, h: G.ch};
}

// диапазоны номеров плиток, попадающих в полосу [ya, yb] (координаты внутри sizer)
function rangesFor(ya, yb) {
  const out = [];
  if (nd) {
    const rows = Math.ceil(nd / G.dcols);
    const r0 = Math.max(0, Math.floor(ya / G.drowH)), r1 = Math.min(rows - 1, Math.floor(yb / G.drowH));
    if (r0 <= r1) out.push([r0 * G.dcols, Math.min(nd, (r1 + 1) * G.dcols)]);
  }
  if (nf) {
    const rows = Math.ceil(nf / G.cols);
    const r0 = Math.max(0, Math.floor((ya - G.ftop) / G.rowH)), r1 = Math.min(rows - 1, Math.floor((yb - G.ftop) / G.rowH));
    if (r0 <= r1) out.push([nd + r0 * G.cols, nd + Math.min(nf, (r1 + 1) * G.cols)]);
  }
  return out;
}
function inRanges(i, rr) {
  for (let k = 0; k < rr.length; k++) if (i >= rr[k][0] && i < rr[k][1]) return true;
  return false;
}
function isVisIdx(i) {
  if (i < 0 || i >= list.length) return false;
  const p = pos(i), y = G.top + p.y;
  return y + p.h > $scroll.scrollTop && y < $scroll.scrollTop + $scroll.clientHeight;
}

let updRaf = 0;
function updateSoon() {
  if (!updRaf) updRaf = requestAnimationFrame(update);
}
function update() {
  updRaf = 0;
  if (!$scroll) return;
  const st = $scroll.scrollTop - G.top, vh = $scroll.clientHeight;
  const pad = G.rowH * 2;
  const rr = rangesFor(st - pad, st + vh + pad);
  for (const [i, el] of mounted) if (!inRanges(i, rr)) unmount(i, el);
  const add = [];
  for (const r of rr) for (let i = r[0]; i < r[1]; i++) if (!mounted.has(i)) add.push(i);
  if (add.length) mountAll(add);
  pump();
}

function unmount(i, el) {
  for (const im of el.querySelectorAll('img')) im.removeAttribute('src');
  el.remove();
  mounted.delete(i);
  if (i >= nd && list[i]) gen.pending.delete(list[i].id);
}
function clearMounted() {
  for (const [i, el] of mounted) unmount(i, el);
  mounted.clear();
  $cells.textContent = '';
  gen.pending.clear();
}

function mountAll(ids) {
  const tmp = document.createElement('div');
  tmp.innerHTML = ids.map(cellHtml).join('');
  const els = Array.from(tmp.children);
  const frag = document.createDocumentFragment();
  for (let k = 0; k < ids.length; k++) {
    mounted.set(ids[k], els[k]);
    frag.append(els[k]);
  }
  $cells.append(frag);
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k], el = els[k];
    for (const im of el.querySelectorAll('img')) {       // события могли пройти, пока элемент не был в документе
      if (!im.complete || !im.getAttribute('src')) continue;
      if (im.naturalWidth) im.parentNode.classList.add('ld'); else thumbBad(im);
    }
    if (i >= nd && list[i]._w) genWant(list[i]);
  }
}

function dirCounts(d) {
  const a = [];
  if (d.n_photo) a.push(plural(d.n_photo, 'photo', 'photos'));
  if (d.n_video) a.push(plural(d.n_video, 'video', 'videos'));
  if (a.length) return a.join(' · ');
  if (d.listed == null && !d.n_dirs) return 'Not read yet';
  return d.n_dirs ? 'Only subfolders' : 'Empty';
}

function cellHtml(i) {
  const it = list[i], p = pos(i), sel = i === selI ? ' sel' : '';
  const st = 'left:' + p.x.toFixed(1) + 'px;top:' + p.y + 'px;width:' + p.w.toFixed(1) + 'px;height:' + p.h + 'px';
  if (i < nd) return G.listMode ? dirRowHtml(it, i, st, sel) : dirTileHtml(it, i, st, sel);
  return fileHtml(it, i, st, sel);
}
function dirTileHtml(d, i, st, sel) {
  const th = d.thumbs || [];
  let mos;
  if (th.length) {
    const n = Math.min(4, th.length);
    // thumbs — пары [id, mtime]: mtime в адресе, чтобы браузер не показал старую миниатюру из кеша
    mos = '<div class="th mos m' + n + '">' + th.slice(0, n).map(x =>
      '<img alt="" decoding="async" loading="lazy" src="' +
      esc(Array.isArray(x) ? tUrl({id: x[0], mtime: x[1]}) : tUrlId(x)) + '">').join('') + '</div>';
  } else {
    mos = '<div class="th"><div class="ph">' + ICO_DIR + '</div></div>';
  }
  const s2 = (d.size ? fmtSize(d.size) : '') + (d.n_dirs ? (d.size ? ' · ' : '') + plural(d.n_dirs, 'folder', 'folders') : '');
  return '<div class="cell dir' + sel + '" data-i="' + i + '" style="' + st + '">' + mos +
    '<div class="cap"><div class="nm" title="' + esc(d.name) + '">' + esc(d.name) + '</div><div class="sub">' + esc(dirCounts(d)) +
    '</div><div class="sub">' + esc(s2) + '</div></div></div>';
}
function dirRowHtml(d, i, st, sel) {
  return '<div class="cell dir drow' + sel + '" data-i="' + i + '" style="' + st + '"><span class="c1">' + ICO_DIR +
    '<span class="nm" title="' + esc(d.name) + '">' + esc(d.name) + '</span></span><span class="num">' + fmtNum(d.n_photo) +
    '</span><span class="num">' + fmtNum(d.n_video) + '</span><span class="num">' + esc(fmtSize(d.size)) + '</span><span class="num">' +
    esc(fmtDate(d.mtime)) + '</span></div>';
}
function fileHtml(f, i, st, sel) {
  let src = '';
  const ou = objUrl.get(f.id);
  f._w = false;
  if (ou) src = ou;
  else if (!thumbErr.has(f.id) && (f.thumb === 1 || (f.kind === 'photo' && JPEG_RE.test(f.name)))) src = tUrl(f);   // у JPEG сервер попробует EXIF
  else f._w = true;
  const vid = f.kind === 'video';
  let sub = fmtSize(f.size);
  if (f.w && f.h) sub += ' · ' + f.w + '×' + f.h;
  return '<div class="cell file' + sel + '" data-i="' + i + '" style="' + st + '"><div class="th"><div class="ph">' + (vid ? ICO_VID : ICO_PHOTO) +
    '</div><img alt="" decoding="async" loading="lazy"' + (src ? ' src="' + esc(src) + '"' : '') + '>' +
    (vid ? '<span class="pl">' + ICO_PLAY + '</span>' + (f.duration != null ? '<span class="dur">' + fmtDur(f.duration) + '</span>' : '') : '') +
    '</div><div class="cap"><div class="nm" title="' + esc(f.name) + '">' + esc(f.name) + '</div><div class="sub">' + esc(sub) +
    '</div><div class="sub">' + esc(fmtDate(f.mtime)) + '</div></div></div>';
}

function setTileImg(el, url) {
  const im = el.querySelector('img');
  if (im) im.src = url;
}

// миниатюра не загрузилась: файл — в очередь генерации, папка — просто скрыть
function thumbBad(im) {
  im.removeAttribute('src');
  const el = im.closest('.cell');
  if (!el) return;
  const i = +el.dataset.i, it = list[i];
  if (!it || i < nd) return;
  if (!thumbErr.has(it.id)) {
    thumbErr.add(it.id);
    genWant(it);
    pump();
  }
}

/* ───── выбор плитки ───── */

function setSel(i, show) {
  if (i < 0 || i >= list.length) return;
  const old = mounted.get(selI);
  if (old) old.classList.remove('sel');
  selI = i;
  selKey = list[i]._k;
  const el = mounted.get(i);
  if (el) el.classList.add('sel');
  if (show) ensureVisible(i);
}
function ensureVisible(i) {
  const p = pos(i), y = G.top + p.y, sc = $scroll;
  if (y - 6 < sc.scrollTop) sc.scrollTop = Math.max(0, y - 10);
  else if (y + p.h + 6 > sc.scrollTop + sc.clientHeight) sc.scrollTop = y + p.h - sc.clientHeight + 10;
  update();
}
function centerOn(i) {
  const p = pos(i);
  $scroll.scrollTop = Math.max(0, G.top + p.y + p.h / 2 - $scroll.clientHeight / 2);
  update();
}

function moveVert(i, dir) {
  if (i < nd) {
    const c = G.dcols, col = i % c;
    if (dir < 0) return i - c >= 0 ? i - c : i;
    if (i + c < nd) return i + c;
    if (Math.floor(i / c) < Math.floor((nd - 1) / c)) return nd - 1;
    if (nf) return nd + Math.min(col, nf - 1);
    return i;
  }
  const j = i - nd, c = G.cols, col = j % c;
  if (dir > 0) {
    if (j + c < nf) return i + c;
    if (Math.floor(j / c) < Math.floor((nf - 1) / c)) return list.length - 1;
    return i;
  }
  if (j - c >= 0) return i - c;
  if (nd) {
    const c2 = G.dcols, lastRow = Math.floor((nd - 1) / c2);
    return Math.min(lastRow * c2 + Math.min(col, c2 - 1), nd - 1);
  }
  return i;
}

function openItem(i) {
  const it = list[i];
  if (!it) return;
  if (i < nd) openDir(it.rel); else openViewer(it);
}
function upLevel() {
  if (!curRel) return;
  openDir(parentOf(curRel), {select: 'd:' + curRel});
}
async function siblingDir(delta) {
  if (!curRel) return;
  const pr = parentOf(curRel);
  try {
    const n = tnode(pr, null);
    if (n.kids === null) await loadKids(n);
    const kids = n.kids || [];
    const t = kids[kids.indexOf(curRel) + delta];
    if (t !== undefined && kids.indexOf(curRel) >= 0) openDir(t);
  } catch (e) { toast(e.message, true); }
}

function gridKey(e) {
  const k = e.key, n = list.length;
  if (e.altKey && k === 'ArrowUp') { upLevel(); return true; }
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const i = selI < 0 ? 0 : selI;
  switch (k) {
    case 'ArrowLeft': if (n) setSel(Math.max(0, i - 1), true); return true;
    case 'ArrowRight': if (n) setSel(Math.min(n - 1, i + 1), true); return true;
    case 'ArrowUp': if (n) setSel(moveVert(i, -1), true); return true;
    case 'ArrowDown': if (n) setSel(moveVert(i, 1), true); return true;
    case 'PageUp': case 'PageDown': {
      if (!n) return true;
      const rows = Math.max(1, Math.floor($scroll.clientHeight / G.rowH) - 1), d = k === 'PageUp' ? -1 : 1;
      let j = i;
      for (let r = 0; r < rows; r++) { const t = moveVert(j, d); if (t === j) break; j = t; }
      setSel(j, true);
      return true;
    }
    case 'Home': if (n) setSel(0, true); return true;
    case 'End': if (n) setSel(n - 1, true); return true;
    case 'Enter': case ' ': if (n) openItem(i); return true;
    case 'Backspace': upLevel(); return true;
    case '[': siblingDir(-1); return true;
    case ']': siblingDir(1); return true;
    case 'F5': openDir(curRel, {mode: 'fresh'}); return true;
    default: return false;
  }
}

/* ───── очередь миниатюр: только видимые плитки, 2 задачи одновременно ───── */

const gen = {pending: new Map(), run: new Map(), failed: new Set()};

function genWant(f) {
  if (gen.failed.has(f.id) || objUrl.has(f.id)) return;
  gen.pending.set(f.id, f);
}

function pump() {
  if (V.open) {                      // пока открыт просмотрщик, он один занимает соединения
    for (const t of gen.run.values()) t.cancel();
    return;
  }
  for (const [id, t] of gen.run) {
    const c = byId.get(id);
    if (!c || !isVisIdx(c._i)) t.cancel();
  }
  if (gen.run.size >= GEN_MAX || !gen.pending.size) return;
  const cand = [];
  for (const f of gen.pending.values()) {
    const c = byId.get(f.id);
    if (c && !gen.run.has(f.id) && isVisIdx(c._i)) cand.push(c);
  }
  cand.sort((a, b) => a._i - b._i);
  for (const f of cand) {
    if (gen.run.size >= GEN_MAX) break;
    runTask(f);
  }
}

function canvasBlob(src, w, h) {
  const k = Math.min(1, THUMB / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, cw, ch);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob')), 'image/jpeg', 0.82));
}

async function makePhotoThumb(f, t) {
  const im = new Image();
  t.clean = () => { im.src = ''; };
  im.decoding = 'async';
  im.src = fUrl(f.id);
  const dp = im.decode();
  dp.catch(() => {});
  await Promise.race([dp, t.abortP]);
  if (!im.naturalWidth) throw new Error('empty image');
  return canvasBlob(im, im.naturalWidth, im.naturalHeight);
}

async function makeVideoThumb(f, t) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'metadata';
  v.playsInline = true;
  let tm = 0;
  const clean = () => {
    clearTimeout(tm);
    v.onloadedmetadata = v.onseeked = v.onerror = null;
    try { v.pause(); } catch (_) { /* нечего освобождать */ }
    v.removeAttribute('src');
    v.load();
  };
  t.clean = clean;
  try {
    const frame = new Promise((resolve, reject) => {
      tm = setTimeout(() => reject(new Error('timeout')), 15000);
      v.onerror = () => reject(new Error('video error'));
      v.onseeked = () => resolve();
      v.onloadedmetadata = () => {
        const d = v.duration;
        v.currentTime = isFinite(d) && d > 0 ? Math.max(0.05, Math.min(d * 0.1, 60)) : 0.05;
      };
      v.src = fUrl(f.id);
    });
    frame.catch(() => {});
    await Promise.race([frame, t.abortP]);
    if (!v.videoWidth) throw new Error('no frame');
    return await canvasBlob(v, v.videoWidth, v.videoHeight);
  } finally {
    clean();
  }
}

async function runTask(f) {
  const t = {id: f.id, aborted: false, timedOut: false, clean: null, rej: null, abortP: null};
  t.abortP = new Promise((_, rej) => { t.rej = rej; });
  t.abortP.catch(() => {});
  t.cancel = () => {
    if (t.aborted) return;
    t.aborted = true;
    if (t.clean) t.clean();
    t.rej(new Error('aborted'));
  };
  gen.run.set(f.id, t);
  const to = setTimeout(() => { t.timedOut = true; t.cancel(); }, f.kind === 'video' ? 20000 : 60000);
  try {
    const blob = await (f.kind === 'video' ? makeVideoThumb(f, t) : makePhotoThumb(f, t));
    if (t.aborted) return;
    const r = await fetch(q('/api/thumb/' + f.id), {method: 'POST', headers: {'Content-Type': 'image/jpeg'}, body: blob});
    if (!r.ok) throw new Error('upload ' + r.status);
    const url = URL.createObjectURL(blob);
    objUrl.set(f.id, url);
    gen.pending.delete(f.id);
    const c = byId.get(f.id);
    if (c) {
      c.thumb = 1;
      const el = mounted.get(c._i);
      if (el) setTileImg(el, url);
    }
  } catch (e) {
    if (!t.aborted || t.timedOut) {       // отмена из-за ухода из вида — не неудача
      gen.failed.add(f.id);
      gen.pending.delete(f.id);
    }
  } finally {
    clearTimeout(to);
    gen.run.delete(f.id);
    if (t.clean) t.clean();               // освободить соединение
    pump();
  }
}

function revokeObjs() {
  for (const u of objUrl.values()) URL.revokeObjectURL(u);
  objUrl.clear();
}

/* ───── открытие папки ───── */

function skeleton(rel) {
  const parents = [];
  if (rel) {
    const segs = rel.split('/');
    let acc = '';
    parents.push({rel: '', name: rootName});
    for (let k = 0; k < segs.length - 1; k++) {
      acc = acc ? acc + '/' + segs[k] : segs[k];
      parents.push({rel: acc, name: segs[k]});
    }
  }
  return {rel: rel, name: rel ? rel.slice(rel.lastIndexOf('/') + 1) : rootName, listed: null, mtime: null, parents: parents, dirs: [], files: [], _skel: true};
}

function showBusy(on) { $('#busy').hidden = !on; }

async function openDir(rel, o) {
  o = o || {};
  rel = normRel(rel);
  const mode = o.mode || 'both';
  const seq = ++navSeq;
  if (dirAbort) dirAbort.abort();
  const ac = dirAbort = new AbortController();
  const keep = !!D && D.rel === rel;
  reading = true;
  if (!keep) {
    curRel = rel;
    setS('last', rel);
    document.title = (rel ? rel.slice(rel.lastIndexOf('/') + 1) : rootName) + ' – VO Media';
  }
  let first = null;
  if (mode !== 'fresh') {
    try {
      first = await getJson(dirUrl(rel, false), ac.signal);
    } catch (e) {
      if (seq !== navSeq || e.name === 'AbortError') return;
      toast('Cannot read the library cache: ' + e.message, true);
    }
    if (seq !== navSeq) return;
    if (first && !first.missing) applyDir(first, {keep: keep, select: o.select});
    else if (!keep) applyDir(skeleton(rel), {keep: false, select: o.select});
  }
  showBusy(true);
  try {
    const fr = await getJson(dirUrl(rel, true), ac.signal);
    if (seq !== navSeq) return;
    showBusy(false);
    reading = false;
    if (fr.missing) {
      if (rel === '') {
        setMsg('Folder not found');
      } else {
        toast('Folder not found: ' + rel, true);
        openDir(parentOf(rel));
      }
      return;
    }
    const haveCache = !!first && !first.missing;
    if (fr.changed || !haveCache || mode === 'fresh') {
      applyDir(fr, haveCache || mode === 'fresh' ? {keep: true} : {keep: false, select: o.select});
    } else {
      if (D) D.listed = fr.listed;
      updateMsg();
    }
  } catch (e) {
    if (seq !== navSeq || e.name === 'AbortError') return;
    showBusy(false);
    reading = false;
    updateMsg();
    toast('Cannot read the folder: ' + e.message, true);
  }
}

// тихо обновить цифры из кеша (после конца индексации)
async function reloadCached() {
  if (!D) return;
  const seq = navSeq, n = applyN, rel = curRel;
  try {
    const j = await getJson(dirUrl(rel, false));
    if (seq !== navSeq || n !== applyN || j.missing) return;
    applyDir(j, {keep: true});
  } catch (e) { /* не страшно */ }
}

function applyDir(d, o) {
  o = o || {};
  if (V.open) { pendingApply = [d, o]; return; }
  pendingApply = null;
  applyN++;
  const st = $scroll.scrollTop;
  D = d;
  if (!o.keep) {
    selKey = o.select || '';
    revokeObjs();
  }
  buildLists();
  clearMounted();
  layout();
  if (o.keep) $scroll.scrollTop = st; else $scroll.scrollTop = 0;
  update();
  if (!o.keep && o.select && selI >= 0) centerOn(selI);
  renderCrumbs();
  updCounts();
  updateMsg();
  if (!d._skel) syncTree(d);
  if (!o.keep) revealTree(d.rel, navSeq);
}

function renderCrumbs() {
  const el = $('#crumbs');
  const frag = document.createDocumentFragment();
  const add = (rel, name, last) => {
    if (frag.childNodes.length) {
      const s = document.createElement('span');
      s.className = 'sep';
      s.textContent = '›';
      frag.append(s);
    }
    const b = document.createElement(last ? 'span' : 'button');
    b.className = last ? 'cur' : 'cr';
    b.textContent = name;
    if (!last) b.dataset.rel = rel;
    frag.append(b);
  };
  for (const p of (D.parents || [])) add(p.rel, p.rel === '' ? rootName : p.name, false);
  add(D.rel, D.rel === '' ? rootName : D.name, true);
  el.replaceChildren(frag);
  el.scrollLeft = el.scrollWidth;
}

function updCounts() {
  const parts = [];
  if (nd) parts.push(plural(nd, 'folder', 'folders'));
  if (nf) parts.push(plural(nf, 'file', 'files') + ' · ' + fmtSize(filesSize));
  $('#cnt').textContent = parts.join(' · ');
}

function setMsg(t) {
  const m = $('#msg');
  m.textContent = t;
  m.hidden = !t;
}
function updateMsg() {
  let t = '';
  if (!list.length) {
    if (!D || (reading && (D._skel || D.listed == null))) t = 'Reading folder…';
    else if (D.files.length || D.dirs.length) t = 'Nothing matches the filter';
    else t = 'This folder is empty';
  }
  setMsg(t);
}

function resort() {
  buildLists();
  clearMounted();
  layout();
  update();
  if (selI >= 0) ensureVisible(selI);
  updCounts();
  updateMsg();
}

function firstVisibleIdx() {
  const st = $scroll.scrollTop - G.top;
  const rr = rangesFor(st, st + 1);
  return rr.length ? rr[0][0] : -1;
}
// пересчёт раскладки (размер плиток, окно, режим); anchor — оставить на месте первую видимую плитку
function relayout(anchor) {
  if (!$scroll) return;
  const ai = anchor ? firstVisibleIdx() : -1;
  clearMounted();
  layout();
  if (ai >= 0 && ai < list.length) $scroll.scrollTop = G.top + pos(ai).y;
  update();
}

/* ───── дерево папок ───── */

const T = new Map();                // rel → узел
let treeSel = '', curRow = null;

function tnode(rel, info) {
  let n = T.get(rel);
  if (!n) {
    n = {rel: rel, name: '', np: null, nv: null, size: null, nd: null, kids: null, open: false, el: null, row: null, box: null, boxKey: null, loading: null};
    T.set(rel, n);
  }
  if (info) {
    n.name = info.name;
    n.np = info.n_photo; n.nv = info.n_video; n.size = info.size; n.nd = info.n_dirs;
  } else if (!n.name) {
    n.name = rel ? rel.slice(rel.lastIndexOf('/') + 1) : rootName;
  }
  return n;
}
function nodeHasKids(n) { return n.kids ? n.kids.length > 0 : n.nd !== 0; }
function nodeCount(n) {
  if (n.np == null) return '';
  return fmtNum(n.np + n.nv) + (n.size ? ' · ' + fmtSize(n.size) : '');
}
function updRow(n) {
  if (!n.row) return;
  n.row.querySelector('.tcn').textContent = nodeCount(n);
  n.row.querySelector('.ta').classList.toggle('no', !nodeHasKids(n));
}
function buildDom(n) {
  const el = document.createElement('div');
  el.className = 'tn' + (n.open ? ' open' : '');
  const row = document.createElement('div');
  row.className = 'tr';
  row.dataset.rel = n.rel;
  row.style.paddingLeft = (6 + (n.rel ? n.rel.split('/').length : 0) * 14) + 'px';
  row.title = n.name;
  row.innerHTML = '<span class="ta"></span><span class="tnm">' + esc(n.name) + '</span><span class="tcn"></span>';
  const box = document.createElement('div');
  box.className = 'tk';
  box.hidden = !n.open;
  n.el = el; n.row = row; n.box = box; n.boxKey = null;
  updRow(n);
  if (n.rel === treeSel) { row.classList.add('on'); curRow = row; }
  el.append(row, box);
  if (n.open && n.kids) fillBox(n);
  return el;
}
function fillBox(n) {
  const frag = document.createDocumentFragment();
  for (const r of n.kids) frag.append(buildDom(T.get(r)));
  n.box.replaceChildren(frag);
  n.boxKey = n.kids.join('\n');
}
function setKids(n, arr) {
  const infos = arr.slice().sort((a, b) => coll.compare(a.name, b.name));
  const rels = infos.map(d => d.rel);
  for (const d of infos) tnode(d.rel, d);
  n.kids = rels;
  n.nd = rels.length;
  if (n.box && n.open) {
    if (n.boxKey !== rels.join('\n')) fillBox(n);
    else for (const r of rels) updRow(T.get(r));
  }
  updRow(n);
}
function loadKids(n) {
  if (n.loading) return n.loading;
  n.loading = (async () => {
    try {
      const j = await getJson(q('/api/tree?rel=' + encodeURIComponent(n.rel)));
      setKids(n, j.dirs || []);
    } finally {
      n.loading = null;
    }
  })();
  return n.loading;
}
async function openNode(n) {
  if (n.kids === null) await loadKids(n);
  n.open = true;
  if (!n.box) return;
  if (n.boxKey !== (n.kids || []).join('\n')) fillBox(n);
  n.box.hidden = false;
  n.el.classList.add('open');
}
function closeNode(n) {
  n.open = false;
  if (n.box) n.box.hidden = true;
  if (n.el) n.el.classList.remove('open');
}
function markCurrent(rel) {
  if (curRow) curRow.classList.remove('on');
  treeSel = rel;
  const n = T.get(rel);
  curRow = n && n.row ? n.row : null;
  if (curRow) {
    curRow.classList.add('on');
    curRow.scrollIntoView({block: 'nearest'});
  }
}
// раскрыть цепочку предков текущей папки и подсветить её
async function revealTree(rel, seq) {
  markCurrent(rel);
  try {
    const segs = rel ? rel.split('/') : [];
    let acc = '';
    await openNode(tnode('', null));
    for (let k = 0; k < segs.length - 1; k++) {
      if (seq !== navSeq) return;
      acc = acc ? acc + '/' + segs[k] : segs[k];
      await openNode(tnode(acc, null));
    }
    if (seq === navSeq) markCurrent(rel);
  } catch (e) { /* дерево не критично */ }
}
// данные открытой папки обновляют её узел в дереве
function syncTree(d) {
  const n = tnode(d.rel, null);
  let np = 0, nv = 0, sz = 0;
  for (const f of (d.files || [])) { if (f.kind === 'photo') np++; else nv++; sz += f.size || 0; }
  for (const x of (d.dirs || [])) { np += x.n_photo; nv += x.n_video; sz += x.size; }
  n.np = np; n.nv = nv; n.size = sz;
  setKids(n, d.dirs || []);
}

/* ───── полный экран ───── */

let fsOn = false;
const winApi = () => (window.pywebview && window.pywebview.api && window.pywebview.api.set_fullscreen) ? window.pywebview.api : null;
function enterFs() {
  if (winApi()) {
    fsOn = true;
    try { winApi().set_fullscreen(true); } catch (e) { /* окно не ответило */ }
    fsChanged();
    return;
  }
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) {
    const p = el.requestFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
}
function leaveFs() {
  if (winApi()) {
    fsOn = false;
    try { winApi().set_fullscreen(false); } catch (e) { /* окно не ответило */ }
    fsChanged();
    return;
  }
  if (document.fullscreenElement && document.exitFullscreen) {
    const p = document.exitFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
}
const toggleFs = () => { if (fsOn) leaveFs(); else enterFs(); };
// Esc в HTML-полноэкранном режиме перехватывает браузер: следим за событием
document.addEventListener('fullscreenchange', () => { fsOn = !!document.fullscreenElement; fsChanged(); });
function fsChanged() {
  if (V.open) barShow();
}

/* ───── просмотрщик ───── */

const V = {open: false, list: [], i: -1, seq: 0, cache: new Map(), vsrc: false, raf: 0, drag: false, barOff: false, idleT: 0, spinT: 0, hudT: 0, wt: 0};
let $v, $vi, $vv, $vseek, $vfill, $vknob, $vtime, $vvol, $vmute, $vplay, $vspin, $vmsg;

function hud(text, sticky) {
  clearTimeout(V.hudT);
  $vmsg.textContent = text;
  $vmsg.className = sticky ? 'err' : '';
  $vmsg.hidden = false;
  if (!sticky) V.hudT = setTimeout(() => { $vmsg.hidden = true; }, 1200);
}

function openViewer(f) {
  const i = files.indexOf(f);
  if (i < 0) return;
  V.list = files;
  V.open = true;
  V.barOff = false;
  $v.classList.remove('idle', 'nobar');
  $v.hidden = false;
  document.body.classList.add('viewing');
  applyVol();
  vShow(i);
  barShow();
}

function closeViewer() {
  if (!V.open) return;
  const f = V.list[V.i];
  vLeaveVideo();
  $vi.removeAttribute('src');
  clearTimeout(V.spinT);
  clearTimeout(V.idleT);
  for (const im of V.cache.values()) im.src = '';
  V.cache.clear();
  V.open = false;
  V.seq++;
  $v.hidden = true;
  document.body.classList.remove('viewing');
  if (fsOn) leaveFs();
  if (f) { selKey = f._k; }
  if (pendingApply) {
    const pa = pendingApply;
    pendingApply = null;
    applyDir(pa[0], Object.assign({}, pa[1], {keep: true}));
    if (selI >= 0) ensureVisible(selI);
  } else if (f && keyIdx.has(f._k)) {
    setSel(keyIdx.get(f._k), true);
  }
}

function vLeaveVideo() {
  cancelAnimationFrame(V.raf);
  if (V.vsrc) {
    $vv.pause();
    $vv.removeAttribute('src');
    $vv.load();                    // освободить соединение
    V.vsrc = false;
  }
  $vv.removeAttribute('poster');
  $vplay.classList.remove('playing');
}

function vShow(i) {
  if (i < 0 || i >= V.list.length) return;
  const f = V.list[i];
  const seq = ++V.seq;
  V.i = i;
  vLeaveVideo();
  $vmsg.hidden = true;
  clearTimeout(V.spinT);
  $vspin.hidden = true;
  $('#vname').textContent = f.name;
  $('#vpos').textContent = (i + 1) + ' / ' + V.list.length;
  $('#vsize').textContent = fmtSize(f.size) + (f.mtime ? ' · ' + fmtDate(f.mtime) : '');
  $('#vres').textContent = f.w && f.h ? f.w + '×' + f.h : '';
  const vid = f.kind === 'video';
  $('#vctl').hidden = !vid;
  $vseek.hidden = !vid;
  if (vid) {
    $vi.removeAttribute('src');
    $vi.hidden = true;
    $vv.hidden = false;
    const ps = objUrl.get(f.id) || (f.thumb === 1 && !thumbErr.has(f.id) ? tUrl(f) : '');
    if (ps) $vv.poster = ps;       // видео не запускается само: показываем миниатюру
    // src сразу, но только метаданные: виден первый кадр, а Space запускает без ожидания открытия файла
    V.vsrc = true;
    $vv.preload = 'metadata';
    $vv.src = fUrl(f.id);
    vUi();
  } else {
    $vv.hidden = true;
    $vi.hidden = false;
    $vi.src = fUrl(f.id);
    V.spinT = setTimeout(() => { if (seq === V.seq) $vspin.hidden = false; }, 150);
    $vi.decode().then(() => {
      if (seq !== V.seq) return;
      clearTimeout(V.spinT);
      $vspin.hidden = true;
    }).catch(() => {
      if (seq !== V.seq) return;
      clearTimeout(V.spinT);
      $vspin.hidden = true;
      hud('Cannot display this file', true);
    });
  }
  vPreload(i);
}

// предзагрузка ±2 соседних фото; у видео ничего не грузим
function vPreload(i) {
  const cur = V.list[i];
  const want = new Set();
  if (cur.kind === 'photo') want.add(cur.id);
  for (const d of [1, -1, 2, -2]) {
    const f = V.list[i + d];
    if (f && f.kind === 'photo') want.add(f.id);
  }
  for (const [id, im] of V.cache) {
    if (!want.has(id)) { im.src = ''; V.cache.delete(id); }
  }
  for (const id of want) {
    if (V.cache.has(id) || id === cur.id) continue;
    const im = new Image();
    im.decoding = 'async';
    im.src = fUrl(id);
    im.decode().catch(() => {});
    V.cache.set(id, im);
  }
}

function vGo(i) {
  i = clamp(i, 0, V.list.length - 1);
  if (i !== V.i) vShow(i);
}

const vDur = () => (isFinite($vv.duration) && $vv.duration > 0) ? $vv.duration : ((V.list[V.i] && V.list[V.i].duration) || 0);
function vUi() {
  const d = vDur(), t = V.vsrc ? $vv.currentTime : 0;
  const p = d ? clamp(t / d, 0, 1) * 100 : 0;
  $vfill.style.width = p + '%';
  $vknob.style.left = p + '%';
  $vtime.textContent = fmtDur(t) + ' / ' + fmtDur(d);
}
function vTick() {
  vUi();
  if (!$vv.paused && !$vv.ended) V.raf = requestAnimationFrame(vTick);
}
function vLoadSrc() {
  const f = V.list[V.i];
  if (V.vsrc || !f || f.kind !== 'video') return;
  V.vsrc = true;
  $vv.preload = 'metadata';
  $vv.src = fUrl(f.id);
}
function vToggle() {
  const f = V.list[V.i];
  if (!f || f.kind !== 'video') return;
  vLoadSrc();
  if ($vv.paused) { const p = $vv.play(); if (p && p.catch) p.catch(() => {}); } else $vv.pause();
}
function vSeekTo(t) {
  const f = V.list[V.i];
  if (!f || f.kind !== 'video') return;
  vLoadSrc();
  $vv.currentTime = clamp(t, 0, vDur() || t);
  vUi();
}
const vSeekBy = dt => vSeekTo(($vv.currentTime || 0) + dt);

function applyVol() {
  $vv.volume = S.volume;
  $vv.muted = !!S.muted;
  $vvol.value = S.muted ? 0 : S.volume;
  $vmute.classList.toggle('off', !!S.muted || S.volume === 0);
}
function vVol(d) {
  setS('volume', clamp(Math.round((S.volume + d) * 100) / 100, 0, 1));
  if (d > 0) setS('muted', false);
  applyVol();
  hud('Volume ' + Math.round(S.volume * 100) + '%');
}
function vMute() {
  setS('muted', !S.muted);
  applyVol();
  hud(S.muted ? 'Muted' : 'Volume ' + Math.round(S.volume * 100) + '%');
}

// панель: прячется через 2 с без движения мыши (в полноэкранном режиме)
function barShow() {
  $v.classList.remove('idle');
  clearTimeout(V.idleT);
  if (!fsOn) return;
  const arm = () => {
    V.idleT = setTimeout(() => {
      if ($('#vbar').matches(':hover')) arm(); else $v.classList.add('idle');
    }, 2000);
  };
  arm();
}

function viewerKey(e) {
  const k = e.key;
  if (k === 'Escape') { if (fsOn) leaveFs(); else closeViewer(); return true; }
  if (e.altKey || e.metaKey) return false;
  const f = V.list[V.i];
  const vid = f && f.kind === 'video';
  switch (k) {
    case 'ArrowLeft': case 'ArrowRight': {
      const dir = k === 'ArrowLeft' ? -1 : 1;
      if (e.ctrlKey) { if (vid) vSeekBy(dir * (e.shiftKey ? 30 : 5)); } else vGo(V.i + dir);
      return true;
    }
    case 'Home': vGo(0); return true;
    case 'End': vGo(V.list.length - 1); return true;
    case ' ': case 'Spacebar': vToggle(); return true;
    case 'Enter': toggleFs(); return true;
    case 'ArrowUp': vVol(0.05); return true;
    case 'ArrowDown': vVol(-0.05); return true;
    case 'm': case 'M': vMute(); return true;
    case 'i': case 'I':
      V.barOff = !V.barOff;
      $v.classList.toggle('nobar', V.barOff);
      return true;
    default: return false;
  }
}

function initViewer() {
  $v = $('#v'); $vi = $('#vi'); $vv = $('#vv'); $vseek = $('#vseek'); $vfill = $('#vfill'); $vknob = $('#vknob');
  $vtime = $('#vtime'); $vvol = $('#vvol'); $vmute = $('#vmute'); $vplay = $('#vplay'); $vspin = $('#vspin'); $vmsg = $('#vmsg');
  $vi.addEventListener('error', () => {
    if (V.open && $vi.getAttribute('src')) { clearTimeout(V.spinT); $vspin.hidden = true; hud('Cannot display this file', true); }
  });
  $vv.addEventListener('play', () => { $vplay.classList.add('playing'); cancelAnimationFrame(V.raf); V.raf = requestAnimationFrame(vTick); });
  $vv.addEventListener('pause', () => { $vplay.classList.remove('playing'); vUi(); });
  $vv.addEventListener('ended', () => { $vplay.classList.remove('playing'); vUi(); });
  $vv.addEventListener('timeupdate', vUi);
  $vv.addEventListener('loadedmetadata', vUi);
  $vv.addEventListener('error', () => { if (V.vsrc) hud('Cannot play this video', true); });
  $('#vplay').onclick = vToggle;
  $('#vmute').onclick = vMute;
  $vvol.addEventListener('input', () => {
    setS('volume', +$vvol.value);
    setS('muted', +$vvol.value === 0);
    applyVol();
  });
  $('#vprev').onclick = () => vGo(V.i - 1);
  $('#vnext').onclick = () => vGo(V.i + 1);
  $('#vclose').onclick = closeViewer;
  $v.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });   // кнопки не берут фокус
  $v.addEventListener('mousemove', barShow);
  $('#vstage').addEventListener('click', e => { if (e.target === $vv) vToggle(); });
  $('#vstage').addEventListener('dblclick', e => { if (!e.target.closest('button')) toggleFs(); });
  $('#vstage').addEventListener('wheel', e => {
    e.preventDefault();
    const now = Date.now();
    if (now - V.wt < 120 || !e.deltaY) return;
    V.wt = now;
    vGo(V.i + (e.deltaY > 0 ? 1 : -1));
  }, {passive: false});
  const seekAt = e => {
    const r = $vseek.getBoundingClientRect();
    vSeekTo(clamp((e.clientX - r.left) / r.width, 0, 1) * vDur());
  };
  $vseek.addEventListener('pointerdown', e => { $vseek.setPointerCapture(e.pointerId); V.drag = true; seekAt(e); });
  $vseek.addEventListener('pointermove', e => { if (V.drag) seekAt(e); });
  const endDrag = () => { V.drag = false; };
  $vseek.addEventListener('pointerup', endDrag);
  $vseek.addEventListener('pointercancel', endDrag);
}

/* ───── окна и диалоги ───── */

function ask(text, okLabel) {
  return new Promise(res => {
    const d = $('#dlg');
    $('#dtxt').textContent = text;
    $('#dok').textContent = okLabel || 'Continue';
    d.hidden = false;
    $('#dok').focus();
    const done = v => { d.hidden = true; ask.cancel = null; res(v); };
    $('#dok').onclick = () => done(true);
    $('#dno').onclick = () => done(false);
    ask.cancel = () => done(false);
  });
}

function sheet(id) {
  closePanels();
  $('#ov').hidden = false;
  document.querySelectorAll('.sheet').forEach(x => { x.hidden = x.id !== id; });
  const b = $('#' + id + ' .go');
  if (b) b.focus();
}
function closeSheet() { $('#ov').hidden = true; }

function closePanels() {
  $('#menup').hidden = true;
  $('#rootp').hidden = true;
}
function togglePanel(id) {
  const el = $('#' + id), was = el.hidden;
  closePanels();
  el.hidden = !was;
  if (!el.hidden) el.style.top = ($('#hd').offsetHeight + 6) + 'px';
}

function fillRecent() {
  const box = $('#rootl');
  box.textContent = '';
  const cur = String(BOOT.root || '').toLowerCase();
  for (const p of (BOOT.recent || [])) {
    const b = document.createElement('button');
    if (String(p).toLowerCase() === cur) b.className = 'cur';
    b.innerHTML = '<b>' + esc(baseName(p)) + '</b><span class="dim">' + esc(p) + '</span>';
    b.onclick = () => switchRoot('/api/root/recent', {folder: p});
    box.append(b);
  }
  if (!box.childNodes.length) box.innerHTML = '<span class="dim">No recent folders</span>';
}

async function switchRoot(path, body) {
  closePanels();
  try {
    await flushS();                 // до смены: иначе отложенная запись ушла бы в настройки новой папки
    frozen = true;                  // пока открыт диалог и идёт смена, настройки не пишем
    const r = await post(path, body);
    if (r.cancelled) { frozen = false; return; }
    location.reload();
  } catch (e) {
    frozen = false;
    toast('Cannot open the folder: ' + e.message, true);
  }
}

/* ───── статус индексации ───── */

let idxTimer = 0, idxRunning = false;
function showIndex(st) {
  const was = idxRunning;
  idxRunning = !!st.running;
  const box = $('#idx'), t = $('#idxt');
  box.classList.toggle('run', idxRunning);
  box.classList.toggle('err', !idxRunning && !!st.error);
  if (idxRunning) t.textContent = (st.full ? 'Full rescan… ' : 'Indexing… ') + fmtNum(st.dirs) + ' folders · ' + fmtNum(st.files) + ' files';
  else if (st.error) t.textContent = 'Index error: ' + st.error;
  else t.textContent = fmtNum(st.files) + ' files in library';
  t.title = st.error || '';
  $('#idxs').hidden = !idxRunning;
  if (was && !idxRunning) reloadCached();
}
async function pollIndex() {
  clearTimeout(idxTimer);
  let st = null;
  try { st = await getJson(q('/api/index')); } catch (e) { /* сервер занят — повторим */ }
  if (st) showIndex(st);
  idxTimer = setTimeout(pollIndex, st && st.running ? 1000 : 10000);
}
async function indexCmd(path, body, okMsg) {
  try {
    const st = await post(path, body);
    if (okMsg) toast(okMsg);
    showIndex(st);
  } catch (e) {
    toast(e.message, true);
  }
  clearTimeout(idxTimer);
  idxTimer = setTimeout(pollIndex, 1000);
}

/* ───── управление ───── */

function syncControls() {
  $('#srt').value = S.sort;
  $('#sdir').textContent = S.desc ? '↓' : '↑';
  $('#flt').value = S.filter;
  $('#sz').value = S.tile;
  document.querySelectorAll('#vw button').forEach(b => b.classList.toggle('on', b.dataset.v === S.view));
  document.documentElement.style.setProperty('--tw', S.treeW + 'px');
  document.body.classList.toggle('notree', !S.tree);
  $('#rootn').textContent = rootName;
  $('#rootb').title = BOOT.root || '';
  $('#mver').textContent = (BOOT.app || 'VO Media') + ' ' + (BOOT.version || '');
}

function wireControls() {
  const blurAfter = el => el.addEventListener('change', () => el.blur());
  $('#srt').addEventListener('change', e => { setS('sort', e.target.value); resort(); });
  $('#sdir').onclick = () => { setS('desc', !S.desc); syncControls(); resort(); };
  $('#flt').addEventListener('change', e => { setS('filter', e.target.value); resort(); });
  blurAfter($('#srt')); blurAfter($('#flt')); blurAfter($('#sz'));
  let szRaf = 0;
  $('#sz').addEventListener('input', e => {
    setS('tile', +e.target.value);
    if (!szRaf) szRaf = requestAnimationFrame(() => { szRaf = 0; relayout(true); });
  });
  $('#vw').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.dataset.v === S.view) return;
    setS('view', b.dataset.v);
    syncControls();
    relayout(true);
    if (selI >= 0) ensureVisible(selI);
  });
  $('#lhead').addEventListener('click', e => {
    const s = e.target.closest('[data-s]');
    if (!s) return;
    if (S.sort === s.dataset.s) setS('desc', !S.desc); else setS('sort', s.dataset.s);
    syncControls();
    resort();
  });
  $('#tg').onclick = () => { setS('tree', !S.tree); syncControls(); };

  $('#crumbs').addEventListener('click', e => {
    const b = e.target.closest('.cr');
    if (b) openDir(b.dataset.rel);
  });

  // дерево
  $('#dirs').addEventListener('click', async e => {
    const row = e.target.closest('.tr');
    if (!row) return;
    const n = T.get(row.dataset.rel);
    if (!n) return;
    try {
      if (e.target.closest('.ta')) {
        if (n.open) closeNode(n); else await openNode(n);
        return;
      }
      openDir(n.rel);
      if (!n.open && nodeHasKids(n)) await openNode(n);
    } catch (err) { toast(err.message, true); }
  });
  const split = $('#split');
  let sdrag = false;
  split.addEventListener('pointerdown', e => { split.setPointerCapture(e.pointerId); sdrag = true; split.classList.add('drag'); });
  split.addEventListener('pointermove', e => {
    if (!sdrag) return;
    const w = clamp(Math.round(e.clientX), 160, 600);
    S.treeW = w;
    document.documentElement.style.setProperty('--tw', w + 'px');
  });
  const sEnd = () => { if (!sdrag) return; sdrag = false; split.classList.remove('drag'); setS('treeW', S.treeW); };
  split.addEventListener('pointerup', sEnd);
  split.addEventListener('pointercancel', sEnd);

  // сетка
  $cells.addEventListener('click', e => {
    const el = e.target.closest('.cell');
    if (!el) return;
    const i = +el.dataset.i;
    setSel(i, false);
    openItem(i);
  });
  $cells.addEventListener('error', e => { if (e.target instanceof HTMLImageElement) thumbBad(e.target); }, true);
  $cells.addEventListener('load', e => { if (e.target instanceof HTMLImageElement) e.target.parentNode.classList.add('ld'); }, true);
  $scroll.addEventListener('scroll', updateSoon, {passive: true});
  let roRaf = 0;
  new ResizeObserver(() => {
    if (roRaf) return;
    roRaf = requestAnimationFrame(() => {
      roRaf = 0;
      if ($scroll.clientWidth !== lastW) relayout(true); else update();
    });
  }).observe($scroll);

  // меню и папки
  $('#menub').onclick = () => togglePanel('menup');
  $('#rootb').onclick = () => togglePanel('rootp');
  $('#rpick').onclick = () => switchRoot('/api/root/pick', {});
  $('#mupd').onclick = () => { closePanels(); indexCmd('/api/index/start', {full: false}, 'Updating the library…'); };
  $('#mfull').onclick = async () => {
    closePanels();
    if (await ask('A full rescan rereads every folder of the library from the disk. On a big library on a network drive it can take a long time. Start it?', 'Start')) {
      indexCmd('/api/index/start', {full: true}, 'Full rescan started');
    }
  };
  $('#mkeys').onclick = () => sheet('keyp');
  $('#kclose').onclick = closeSheet;
  $('#ov').onclick = e => { if (e.target.id === 'ov') closeSheet(); };
  $('#idxs').onclick = () => indexCmd('/api/index/stop', {}, '');
  document.addEventListener('click', e => {
    if (!e.target.closest('#rootp,#rootb,#menup,#menub')) closePanels();
    const b = e.target.closest('button');
    if (b && !b.closest('#dlg') && !b.closest('#ov')) b.blur();     // чтобы Space/Enter не нажимали кнопку повторно
  });
}

document.addEventListener('keydown', e => {
  const k = e.key;
  if (!$('#dlg').hidden) {
    if (k === 'Escape' && ask.cancel) { e.preventDefault(); ask.cancel(); }
    return;
  }
  if (!$('#ov').hidden) {
    if (k === 'Escape') { e.preventDefault(); closeSheet(); }
    return;
  }
  if (k === 'Escape' && (!$('#menup').hidden || !$('#rootp').hidden)) { e.preventDefault(); closePanels(); return; }
  if (V.open) {
    if (viewerKey(e)) e.preventDefault();
    return;
  }
  const tg = e.target;
  if (tg && (tg.tagName === 'SELECT' || tg.tagName === 'INPUT')) return;
  if (gridKey(e)) e.preventDefault();
});
addEventListener('pagehide', () => { flushS(); });

function init() {
  $scroll = $('#scroll'); $sizer = $('#sizer'); $cells = $('#cells');
  initViewer();
  syncControls();
  fillRecent();
  wireControls();
  applyVol();
  const root = tnode('', null);
  root.name = rootName;
  root.open = true;
  $('#dirs').append(buildDom(root));
  loadKids(root).catch(() => {});
  pollIndex();
  openDir(S.last || '');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
