'use strict';
// VO Media — Общее: утилиты, настройки папки, состояние, сортировка.
// Обычные скрипты грузятся по порядку core → grid → viewer → ui: общие const/let видны между файлами.

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
// GIF считается видео (kind 'video'), но показывается <img> и миниатюра делается как у фото
const isGif = f => !!f && /\.gif$/i.test(f.name);

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

const DEF = {sort: 'name', desc: false, filter: 'all', view: 'tiles', tile: 220, tree: true, treeW: 280, last: '', volume: 0.8, muted: false, timeline: false};
const S =Object.assign({}, DEF, BOOT.settings || {});
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

const GAP = 12, PAD = 14, CAPH = 58, LROW = 34, SECG = 10, THUMB = 800, GEN_MAX = 2;
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
