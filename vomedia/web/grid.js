'use strict';
// VO Media — Сетка: раскладка, виртуальная прокрутка, выбор плитки, миниатюры, открытие папки, дерево.
// Обычные скрипты грузятся по порядку core → grid → viewer → ui: общие const/let видны между файлами.

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
  if (MODE === 'flat' && M.items.length < M.total && $scroll.scrollTop + $scroll.clientHeight > G.top + G.total - G.rowH * 6) loadMore();
}

function unmount(i, el) {
  if (GS.hover && GS.hover.el === el) gridStoryStop();
  for (const im of el.querySelectorAll('img')) im.removeAttribute('src');
  el.remove();
  mounted.delete(i);
  if (i >= nd && list[i]) gen.pending.delete(list[i].id);
}
function clearMounted() {
  gridStoryStop();
  for (const [i, el] of mounted) unmount(i, el);
  mounted.clear();
  $cells.textContent = '';
  gen.pending.clear();
}

function mountAll(ids) {
  gridStoryInit();
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
  else if (!thumbErr.has(f.id) && f.thumb === 1) src = tUrl(f);
  else f._w = true;                  // миниатюры нет — сразу в очередь генерации
  const vid = f.kind === 'video';
  const scrub = vid && !isGif(f) ? '<canvas class="sb-frame" width="1" height="1" aria-hidden="true"></canvas>' +
    '<span class="sb-pos" aria-hidden="true"><i></i></span><span class="sb-spin" title="Loading storyboard…" aria-hidden="true"></span>' : '';
  let sub = fmtSize(f.size);
  if (f.w && f.h) sub += ' · ' + f.w + '×' + f.h;
  // в режимах «из многих папок» вместо даты — папка файла
  const multi = MODE !== 'dir' && f.rel != null;
  const sub2 = multi ? '<div class="sub path" title="' + esc(f.rel || rootName) + '">' + esc(shortRel(f.rel)) + '</div>'
    : '<div class="sub">' + esc(fmtDate(f.mtime)) + '</div>';
  return '<div class="cell file' + sel + '" data-i="' + i + '" style="' + st + '"><div class="th"><div class="ph">' + (vid ? ICO_VID : ICO_PHOTO) +
    '</div><img alt="" decoding="async" loading="lazy"' + (src ? ' src="' + esc(src) + '"' : '') + '>' +
    (vid ? '<span class="pl">' + ICO_PLAY + '</span>' + (f.duration != null ? '<span class="dur">' + fmtDur(f.duration) + '</span>' : '') : '') + wbHtml(f) + scrub +
    '</div><div class="cap"><div class="nm" title="' + esc(f.name) + '">' + esc(f.name) + '</div><div class="sub">' + esc(sub) +
    '</div>' + sub2 + '</div></div>';
}
// последние два сегмента пути папки
function shortRel(rel) {
  if (!rel) return rootName;
  const a = rel.split('/');
  return a.length > 2 ? '…/' + a.slice(-2).join('/') : rel;
}
// полоска «досмотрено» внизу плитки видео (GIF не считается)
function wbHtml(f) {
  if (f.kind !== 'video' || isGif(f) || typeof f.pos !== 'number' || !(f.duration > 0)) return '';
  const k = clamp(f.pos / f.duration, 0, 1);
  return '<span class="wb' + (k >= 1 ? ' done' : '') + '"><i style="width:' + (k * 100).toFixed(1) + '%"></i></span>';
}
function refreshWatched() {
  for (const [i, el] of mounted) {
    if (i < nd || !list[i]) continue;
    const th = el.querySelector('.th');
    if (!th) continue;
    const old = th.querySelector('.wb');
    if (old) old.remove();
    const h = wbHtml(list[i]);
    if (h) th.insertAdjacentHTML('beforeend', h);
  }
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
  if (MODE === 'search' || MODE === 'new') { exitMulti(); return; }
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

// PgUp/PgDn: соседняя папка со своими файлами (порядок как у перехода между папками в просмотрщике)
let crossBusy = false;
async function gridCross(step) {
  if (crossBusy || MODE === 'search' || MODE === 'new') return;
  crossBusy = true;
  try {
    const nb = await getJson(q('/api/neighbor?rel=' + encodeURIComponent(curRel) + '&step=' + step));
    if (nb.rel == null) toast(step > 0 ? 'Last folder' : 'First folder');
    else await openDir(nb.rel);
  } catch (e) { toast('Cannot open the folder: ' + e.message, true); }
  finally { crossBusy = false; }
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
    case 'PageUp': case 'PageDown': gridCross(k === 'PageUp' ? -1 : 1); return true;
    case 'Home': if (n) setSel(0, true); return true;
    case 'End': if (n) setSel(n - 1, true); return true;
    case 'Enter': case ' ': if (n) openItem(i); return true;
    case 'Backspace': upLevel(); return true;
    case '[': siblingDir(-1); return true;
    case ']': siblingDir(1); return true;
    case 'Escape': if (MODE === 'search' || MODE === 'new') { exitMulti(); return true; } return false;
    case 'F5':
      if (MODE === 'search') { if (M.q) runSearch(M.q); } else if (MODE === 'new') openNew(M.since);
      else openDir(curRel, {mode: 'fresh'});
      return true;
    default: return false;
  }
}

/* ───── общая раскадровка: без зависимости от просмотрщика и очереди миниатюр ───── */

const SBN = 30, SBC = 6, SBR = 5, SBW = 320;
const storyCache = new Map(), storyMissing = new Set();
const storyKey = f => f.id + ':' + (f.mtime || 0);

function storyPeek(f) {
  const key = storyKey(f), s = storyCache.get(key);
  if (s) { storyCache.delete(key); storyCache.set(key, s); }
  return s;
}

// Promise -> {src: Image|canvas, fw, fh, got, state}; cancel() отменяет запрос и скрытое видео.
// onProgress получает тот же набор полей после каждого готового кадра, включая неполный спрайт.
function storyGet(f, onProgress) {
  const cached = storyPeek(f);
  if (cached) {
    const p = Promise.resolve(cached);
    p.cancel = () => {};
    return p;
  }
  const t = {f: f, key: storyKey(f), state: 'load', src: null, fw: 0, fh: 0, got: 0,
    dead: false, done: false, vid: null, im: null, rej: null, ac: new AbortController()};
  let abort;
  const aborted = new Promise((_, reject) => { abort = reject; });
  const work = (async () => {
    try {
      const loaded = await storyLoad(t);
      if (t.dead) throw new DOMException('Aborted', 'AbortError');
      if (!loaded) await storyGen(t, onProgress);
      if (t.dead) throw new DOMException('Aborted', 'AbortError');
      t.state = 'ready';
      const s = {src: t.src, fw: t.fw, fh: t.fh, got: SBN, state: 'ready'};
      storyCache.delete(t.key);
      storyCache.set(t.key, s);
      while (storyCache.size > 20) storyCache.delete(storyCache.keys().next().value);
      return s;
    } finally {
      t.done = true;
      storyRelease(t);
    }
  })();
  work.catch(() => {});              // после отмены ошибку work никто не ждёт — без «Uncaught (in promise)»
  aborted.catch(() => {});
  const p = Promise.race([work, aborted]);
  p.cancel = () => {
    if (t.dead || t.done) return;
    t.dead = true;
    t.ac.abort();
    if (t.rej) t.rej();
    if (t.im) t.im.removeAttribute('src');
    storyRelease(t);
    abort(new DOMException('Aborted', 'AbortError'));
  };
  return p;
}

async function storyLoad(t) {
  if (storyMissing.has(t.key)) return false;
  const r = await fetch(q('/s/' + t.f.id + '?v=' + encodeURIComponent(t.f.mtime || 0)), {signal: t.ac.signal});
  if (r.status === 404) { storyMissing.add(t.key); return false; }
  if (!r.ok) throw new Error('storyboard ' + r.status);
  const blob = await r.blob();
  if (t.dead) throw new DOMException('Aborted', 'AbortError');
  const url = URL.createObjectURL(blob), im = t.im = new Image();
  try {
    im.src = url;
    await im.decode();
    if (t.dead) throw new DOMException('Aborted', 'AbortError');
    const fw = im.naturalWidth / SBC, fh = im.naturalHeight / SBR;
    if (fw < 8 || fh < 8) throw new Error('invalid storyboard');
    t.src = im; t.fw = fw; t.fh = fh; t.got = SBN;
    return true;
  } finally {
    t.im = null;
    URL.revokeObjectURL(url);
  }
}

// Ожидание события прерывается вместе с задачей, обработчики и таймер всегда снимаются.
function waitVid(t, v, ev, ms) {
  return new Promise((res, rej) => {
    let tm = 0;
    const fin = err => {
      clearTimeout(tm);
      v.removeEventListener(ev, ok);
      v.removeEventListener('error', bad);
      if (t.rej === abort) t.rej = null;
      if (err) rej(err); else res();
    };
    const ok = () => fin(null);
    const bad = () => fin(new Error('video error'));
    const abort = () => fin(new DOMException('Aborted', 'AbortError'));
    tm = setTimeout(() => fin(new Error('timeout')), ms);
    t.rej = abort;
    v.addEventListener(ev, ok, {once: true});
    v.addEventListener('error', bad, {once: true});
  });
}

function storyRelease(t) {
  const v = t.vid;
  if (!v) return;
  t.vid = null;
  v.removeAttribute('src');
  try { v.load(); } catch (_) { /* нечего освобождать */ }
}

async function storyGen(t, onProgress) {
  const v = t.vid = document.createElement('video');
  v.muted = true; v.preload = 'metadata'; v.playsInline = true;
  t.state = 'gen';
  const meta = waitVid(t, v, 'loadedmetadata', 15000);
  v.src = fUrl(t.f.id);
  await meta;
  const dur = v.duration, vw = v.videoWidth, vh = v.videoHeight;
  if (!isFinite(dur) || dur <= 0 || !vw || !vh) throw new Error('no video');
  let fh = Math.max(2, Math.round(SBW * vh / vw));
  fh += fh & 1;
  const c = document.createElement('canvas');
  c.width = SBW * SBC; c.height = fh * SBR;
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  t.src = c; t.fw = SBW; t.fh = fh;
  for (let i = 0; i < SBN; i++) {
    if (t.dead) throw new DOMException('Aborted', 'AbortError');
    const seek = waitVid(t, v, 'seeked', 10000);
    v.currentTime = dur * (i + 0.5) / SBN;
    await seek;
    if (t.dead) throw new DOMException('Aborted', 'AbortError');
    x.drawImage(v, (i % SBC) * SBW, Math.floor(i / SBC) * fh, SBW, fh);
    t.got = i + 1;
    if (onProgress) onProgress(t);
  }
  storyRelease(t);
  // toDataURL, а не toBlob: синхронное кодирование без ожидания простоя Chromium.
  const blob = dataBlob(c.toDataURL('image/jpeg', 0.8));
  fetch(q('/api/story/' + t.f.id), {method: 'POST', headers: {'Content-Type': 'image/jpeg'},
    body: blob, signal: t.ac.signal}).then(r => {
    if (r.ok) storyMissing.delete(t.key);       // после сохранения сервер снова может отдать спрайт
  }).catch(() => {});
}

/* ───── кадры при наведении на картинку плитки ───── */

const GS = {hover: null, raf: 0, x: 0, target: null, wired: false};
function gridStoryBlocked() {
  return V.open || frozen || document.hidden || !!$('#dlg:not([hidden]),#ov:not([hidden]),#menup:not([hidden]),#rootp:not([hidden]),#newp:not([hidden]),#ctxm:not([hidden])');
}
function gridStoryStop() {
  cancelAnimationFrame(GS.raf); GS.raf = 0; GS.target = null;
  const h = GS.hover;
  GS.hover = null;
  if (!h) return;
  clearTimeout(h.tm);
  if (h.task) h.task.cancel();
  h.th.classList.remove('sb-show', 'sb-busy');
  h.canvas.getContext('2d').clearRect(0, 0, h.canvas.width, h.canvas.height);
}
function gridStoryAlive(h) {
  return GS.hover === h && h.el.isConnected && mounted.get(h.i) === h.el &&
    list[h.i] === h.f && storyKey(h.f) === h.key && !gridStoryBlocked();
}
function gridStoryPaint(h) {
  if (!gridStoryAlive(h)) { gridStoryStop(); return; }
  if (!h.sprite) return;
  const r = h.th.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const k = clamp((GS.x - r.left) / r.width, 0, 1), idx = Math.min(SBN - 1, Math.floor(k * SBN));
  const c = h.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(r.width * dpr), ht = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== ht) { c.width = w; c.height = ht; h.idx = -1; }
  if (h.idx !== idx) {
    const s = h.sprite, ar = w / ht;
    let sw = s.fw, sh = s.fh;
    if (sw / sh > ar) sw = sh * ar; else sh = sw / ar;
    c.getContext('2d').drawImage(s.src, (idx % SBC) * s.fw + (s.fw - sw) / 2,
      Math.floor(idx / SBC) * s.fh + (s.fh - sh) / 2, sw, sh, 0, 0, w, ht);
    h.idx = idx;
  }
  h.bar.style.width = (k * 100) + '%';
  h.th.classList.add('sb-show');
}
function gridStorySoon() {
  if (!GS.raf) GS.raf = requestAnimationFrame(() => {
    GS.raf = 0;
    if (GS.hover) gridStoryPaint(GS.hover);
  });
}
async function gridStoryLoad(h) {
  h.tm = 0;
  if (!gridStoryAlive(h)) { if (GS.hover === h) gridStoryStop(); return; }
  h.th.classList.add('sb-busy');
  try {
    h.task = storyGet(h.f);
    const s = await h.task;
    if (!gridStoryAlive(h)) return;
    h.sprite = s;
    gridStorySoon();
  } catch (_) { /* нет декодера или ошибка сети — остаётся миниатюра */ }
  finally { h.th.classList.remove('sb-busy'); }
}
function gridStoryPoint() {
  GS.raf = 0;
  const th = GS.target && GS.target.closest('.file .th');
  if (!th || gridStoryBlocked()) { gridStoryStop(); return; }
  if (GS.hover && GS.hover.th === th) { gridStoryPaint(GS.hover); return; }
  const el = th.closest('.cell'), i = +el.dataset.i, f = list[i];
  gridStoryStop();
  if (!f || i < nd || f.kind !== 'video' || isGif(f)) return;
  const h = GS.hover = {el: el, th: th, i: i, f: f, key: storyKey(f), tm: 0, task: null,
    canvas: th.querySelector('.sb-frame'), bar: th.querySelector('.sb-pos i'), sprite: storyPeek(f), idx: -1};
  if (h.sprite) gridStoryPaint(h);
  else h.tm = setTimeout(() => gridStoryLoad(h), 700);
}
function gridStoryInit() {
  if (GS.wired) return;
  GS.wired = true;
  const move = e => {
    GS.x = e.clientX; GS.target = e.target;
    if (!GS.raf) GS.raf = requestAnimationFrame(gridStoryPoint);
  };
  $cells.addEventListener('mouseover', move);
  $cells.addEventListener('mousemove', move);
  $cells.addEventListener('mouseout', e => {
    const th = e.target.closest('.file .th');
    if (th && (!e.relatedTarget || !th.contains(e.relatedTarget))) gridStoryStop();
  });
  // Прокрутка и смена раскладки не должны оставлять кадр под неподвижной мышью.
  addEventListener('scroll', gridStoryStop, true);
  addEventListener('resize', gridStoryStop);
  addEventListener('blur', gridStoryStop);
  addEventListener('pagehide', gridStoryStop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) gridStoryStop(); });
  const ob = new MutationObserver(() => { if (gridStoryBlocked()) gridStoryStop(); });
  for (const id of ['dlg', 'ov', 'menup', 'rootp', 'newp', 'ctxm']) {
    const el = $('#' + id);
    if (el) ob.observe(el, {attributes: true, attributeFilter: ['hidden']});
  }
  ob.observe(document.body, {attributes: true, attributeFilter: ['class']});
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

// dataURL (JPEG) → Blob
function dataBlob(url) {
  const s = atob(url.split(',')[1]);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return new Blob([a], {type: 'image/jpeg'});
}

function canvasBlob(src, w, h) {
  const k = Math.min(1, THUMB / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, cw, ch);
  // toDataURL, а не toBlob: Chromium откладывает toBlob/convertToBlob на простой потока — замерено ~0,9 с
  // на миниатюру против ~20 мс у toDataURL
  return Promise.resolve(dataBlob(c.toDataURL('image/jpeg', 0.8)));
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
  const to = setTimeout(() => { t.timedOut = true; t.cancel(); }, f.kind === 'video' && !isGif(f) ? 20000 : 60000);
  try {
    const blob = await (f.kind === 'video' && !isGif(f) ? makeVideoThumb(f, t) : makePhotoThumb(f, t));
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
  clearTimeout(searchT);
  $('#qs').value = '';
  if (S.flat) return openFlat(rel, o);
  if (MODE !== 'dir') leaveMulti();
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
  let first = null, sent = false;
  // o.hop — переход из просмотрщика: данные применяются сразу (мимо pendingApply), onData получает их один раз
  const give = () => {
    if (o.onData && !sent && D && !D._skel && D.rel === rel) { sent = true; o.onData(D); }
  };
  if (mode !== 'fresh') {
    try {
      first = o.first || await getJson(dirUrl(rel, false), ac.signal);
    } catch (e) {
      if (seq !== navSeq || e.name === 'AbortError') return;
      toast('Cannot read the library cache: ' + e.message, true);
    }
    if (seq !== navSeq) return;
    if (first && !first.missing) { applyDir(first, {keep: keep, select: o.select, force: !!o.hop}); give(); }
    else if (!keep) applyDir(skeleton(rel), {keep: false, select: o.select, force: !!o.hop});
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
      // fresh после уже показанных данных в просмотрщике откладывается как обычно
      applyDir(fr, Object.assign({force: !!o.hop && !sent}, haveCache || mode === 'fresh' ? {keep: true} : {keep: false, select: o.select}));
      give();
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
  if (!D || MODE !== 'dir') return;
  const seq = navSeq, n = applyN, rel = curRel;
  try {
    const j = await getJson(dirUrl(rel, false));
    if (seq !== navSeq || n !== applyN || j.missing) return;
    applyDir(j, {keep: true});
  } catch (e) { /* не страшно */ }
}

function applyDir(d, o) {
  o = o || {};
  if (V.open && !o.force) { pendingApply = [d, o]; return; }
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
  syncModeUi();
  if (!d._skel) syncTree(d);
  if (!o.keep) revealTree(d.rel, navSeq);
  metaWatch();
}

// длительность и размеры кадра читает фоновый поток уже после показа папки: пока в ней есть
// непрочитанные файлы (pending), опрашиваем кеш и дописываем значения в те же объекты
let metaT = 0;
function metaWatch() {
  clearTimeout(metaT);
  if (MODE === 'dir' && D && !D._skel && D.pending > 0) metaT = setTimeout(metaPoll, 1500);
}
async function metaPoll() {
  if (MODE !== 'dir' || !D || D._skel) return;
  const seq = navSeq, n = applyN, rel = D.rel;
  let j;
  try { j = await getJson(dirUrl(rel, false)); } catch (e) { metaWatch(); return; }
  if (seq !== navSeq || n !== applyN || j.missing || !D || D.rel !== rel) return;
  const nf = new Map(j.files.map(f => [f.id, f]));
  if (nf.size !== D.files.length || D.files.some(f => !nf.has(f.id))) { applyDir(j, {keep: true}); return; }
  let changed = false;
  for (const f of D.files) {
    const x = nf.get(f.id);
    if (x.duration !== f.duration || x.w !== f.w || x.h !== f.h) { f.duration = x.duration; f.w = x.w; f.h = x.h; changed = true; }
  }
  D.pending = j.pending;
  if (changed && !V.open) {
    if (S.sort === 'duration') buildLists();
    clearMounted();
    layout();
    update();
  }
  metaWatch();
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
  if (MODE === 'search' || MODE === 'new') {
    add(curRel, '← ' + (curRel ? baseName(curRel) : rootName), false);
    add('', MODE === 'search' ? 'Search: “' + M.q + '”' : M.label, true);
    el.replaceChildren(frag);
    return;
  }
  for (const p of (D.parents || [])) add(p.rel, p.rel === '' ? rootName : p.name, false);
  add(D.rel, D.rel === '' ? rootName : D.name, true);
  el.replaceChildren(frag);
  el.scrollLeft = el.scrollWidth;
}

function updCounts() {
  const parts = [];
  if (MODE !== 'dir') {
    if (nd) parts.push(plural(nd, 'folder', 'folders'));
    if (MODE === 'flat' && nf < M.total) parts.push('Showing ' + fmtNum(nf) + ' of ' + fmtNum(M.total) + ' files');
    else if (nf || !nd) parts.push(plural(nf, 'file', 'files') + (M.truncated ? '+' : '') + (nf ? ' · ' + fmtSize(filesSize) : ''));
    if (MODE === 'new' && M.total > nf) parts.push('of ' + fmtNum(M.total));
    $('#cnt').textContent = parts.join(' · ');
    return;
  }
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
  if (!list.length && MODE !== 'dir') {
    if (M.loading) t = MODE === 'search' ? 'Searching…' : 'Loading…';
    else if (D && D.files.length) t = 'Nothing matches the filter';
    else t = MODE === 'search' ? 'Nothing found' : MODE === 'new' ? 'No new files' : 'No files';
  } else if (!list.length) {
    if (!D || (reading && (D._skel || D.listed == null))) t = 'Reading folder…';
    else if (D.files.length || D.dirs.length) t = 'Nothing matches the filter';
    else t = 'This folder is empty';
  }
  setMsg(t);
}

function resort() {
  if (MODE === 'flat') { openFlat(curRel); return; }   // порядок задаёт сервер
  if (MODE === 'new') M.userSort = true;
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
    n = {rel: rel, name: '', np: null, nv: null, size: null, mtime: null, nd: null, kids: null, open: false, el: null, row: null, box: null, boxKey: null, loading: null};
    T.set(rel, n);
  }
  if (info) {
    n.name = info.name;
    n.np = info.n_photo; n.nv = info.n_video; n.size = info.size; n.mtime = info.mtime; n.nd = info.n_dirs;
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
// порядок веток дерева — своя сортировка (S.tsort/S.tdesc), не та, что у сетки
function treeKey(n) {
  switch (S.tsort) {
    case 'date': return n.mtime || 0;
    case 'size': return n.size || 0;
    case 'count': return (n.np || 0) + (n.nv || 0);
  }
  return null;
}
function sortRels(rels) {
  const k = S.tsort === 'name' ? null : treeKey, sg = S.tdesc ? -1 : 1;
  return rels.sort((a, b) => {
    const x = T.get(a), y = T.get(b);
    const d = k ? k(x) - k(y) : 0;
    return sg * (d || coll.compare(x.name, y.name));
  });
}
function resortTree() {
  for (const n of T.values()) {
    if (!n.kids) continue;
    sortRels(n.kids);
    if (n.box && n.open && n.boxKey !== n.kids.join('\n')) fillBox(n);
  }
  if (curRow) curRow.scrollIntoView({block: 'nearest'});
}
function setKids(n, arr) {
  for (const d of arr) tnode(d.rel, d);
  const rels = sortRels(arr.map(d => d.rel));
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

/* ───── режимы «файлы из многих папок»: поиск, плоский вид, «Новое» ───── */

const curMode = () => MODE;
let searchT = 0;

// данные в форме ответа /api/dir, чтобы buildLists/сетка работали без изменений
function multiData(rel, fl, dl) {
  const d = skeleton(rel);
  d._skel = false;
  d._multi = true;
  d.listed = 1;
  d.files = fl;
  d.dirs = dl || [];
  return d;
}
function applyMulti(d, keep) {
  pendingApply = null;
  applyN++;
  const st = $scroll.scrollTop;
  D = d;
  if (!keep) { selKey = ''; revokeObjs(); }
  buildLists();
  clearMounted();
  layout();
  $scroll.scrollTop = keep ? st : 0;
  update();
  renderCrumbs();
  updCounts();
  updateMsg();
  syncModeUi();
}
// перерисовать текущие данные (после переименования/удаления), прокрутка и выбор сохраняются
function rerender() {
  if (!D) return;
  const st = $scroll.scrollTop;
  buildLists();
  clearMounted();
  layout();
  $scroll.scrollTop = st;
  update();
  updCounts();
  updateMsg();
}
// начать переход в другой режим: отменить прежние запросы, вернуть свежий номер
function multiBegin() {
  const seq = ++navSeq;
  if (dirAbort) dirAbort.abort();
  if (M.abort) M.abort.abort();
  const ac = dirAbort = M.abort = new AbortController();
  reading = false;
  showBusy(false);
  return {seq: seq, ac: ac};
}
function leaveMulti() {
  MODE = 'dir';
  M.q = ''; M.loading = false; M.truncated = false; M.total = 0; M.items = []; M.userSort = false;
  if (M.abort) M.abort.abort();
  D = null;
  syncModeUi();
}
function exitMulti() { openDir(curRel); }

function syncModeUi() {
  const multi = MODE === 'search' || MODE === 'new';
  const fav = S.fav.indexOf(curRel) >= 0;
  $('#flatb').classList.toggle('on', !!S.flat);
  $('#newb').classList.toggle('on', MODE === 'new');
  $('#newx').hidden = MODE !== 'new';
  $('#xplb').hidden = multi;
  $('#favb').hidden = multi || !curRel;
  $('#favb').textContent = fav ? '★' : '☆';
  $('#favb').title = fav ? 'Remove this folder from favourites' : 'Add this folder to favourites';
  $('#more').hidden = !(MODE === 'flat' && M.items.length < M.total);
  $('#mrate').classList.toggle('on', !!S.rateUI);
}

/* поиск */

function searchInput(now) {
  clearTimeout(searchT);
  const v = $('#qs').value.trim();
  if (!v) { if (MODE === 'search') exitMulti(); return; }
  searchT = setTimeout(() => runSearch(v), now ? 0 : 300);
}
async function runSearch(text) {
  const first = MODE !== 'search';
  const b = multiBegin();
  MODE = 'search';
  M.q = text; M.loading = true; M.truncated = false; M.userSort = false;
  if (first) applyMulti(multiData(curRel, [], []));
  else { showBusy(true); renderCrumbs(); }
  try {
    const j = await getJson(q('/api/search?q=' + encodeURIComponent(text) + '&limit=500'), b.ac.signal);
    if (b.seq !== navSeq) return;
    showBusy(false);
    M.loading = false;
    M.truncated = !!j.truncated;
    applyMulti(multiData(curRel, j.files || [], j.dirs || []));
  } catch (e) {
    if (b.seq !== navSeq || e.name === 'AbortError') return;
    showBusy(false);
    toast(errText(e), true);
    exitMulti();
  }
}

/* плоский вид: все файлы папки и подпапок, порциями по 5000 */

const FLAT_PAGE = 5000;
const flatPage = (rel, offset, signal) => getJson(q('/api/flat?rel=' + encodeURIComponent(rel) + '&sort=' + S.sort + '&desc=' + (S.desc ? 1 : 0) +
  '&filter=' + S.filter + '&offset=' + offset + '&limit=' + FLAT_PAGE), signal);

async function openFlat(rel, o) {
  rel = normRel(rel);
  const b = multiBegin();
  MODE = 'flat';
  M.q = ''; M.items = []; M.total = 0; M.truncated = false; M.loading = true; M.busy = true; M.retry = 0;
  curRel = rel;
  setS('last', rel);
  document.title = (rel ? baseName(rel) : rootName) + ' – VO Media';
  applyMulti(multiData(rel, M.items, []));
  revealTree(rel, b.seq);
  try {
    const j = await flatPage(rel, 0, b.ac.signal);
    if (b.seq !== navSeq) return;
    for (const f of (j.files || [])) M.items.push(f);
    M.total = Math.max(+j.total || 0, M.items.length);
  } catch (e) {
    if (b.seq !== navSeq || e.name === 'AbortError') return;
    M.loading = false; M.busy = false;
    toast(errText(e), true);
    setS('flat', false);
    syncControls();
    openDir(rel);
    return;
  }
  M.loading = false; M.busy = false;
  applyMulti(multiData(rel, M.items, []));
}
async function loadMore() {
  if (MODE !== 'flat' || M.busy || V.open || M.items.length >= M.total || Date.now() < M.retry) return;
  const seq = navSeq, signal = M.abort ? M.abort.signal : undefined;
  M.busy = true;
  showBusy(true);
  try {
    const j = await flatPage(curRel, M.items.length, signal);
    if (seq !== navSeq) return;
    const got = j.files || [];
    if (!got.length) M.total = M.items.length;
    for (const f of got) M.items.push(f);
    if (D) D.files = M.items;
    buildLists();
    layout();                      // плитки впереди остаются на месте: порция дописана в конец
    update();
    updCounts();
    updateMsg();
    syncModeUi();
  } catch (e) {
    if (seq !== navSeq || e.name === 'AbortError') return;
    M.retry = Date.now() + 5000;
    toast(errText(e), true);
  } finally {
    if (seq === navSeq) { M.busy = false; showBusy(false); }
  }
}

/* «Новое» */

const NEW_LABELS = {last: 'New since last launch', '7': 'New in the last 7 days', '30': 'New in the last 30 days'};
async function openNew(since) {
  since = NEW_LABELS[since] ? since : 'last';
  const b = multiBegin();
  MODE = 'new';
  M.since = since; M.label = NEW_LABELS[since]; M.q = ''; M.loading = true; M.truncated = false; M.userSort = false; M.total = 0;
  $('#qs').value = '';
  applyMulti(multiData(curRel, [], []));
  try {
    const j = await getJson(q('/api/new?since=' + since + '&limit=5000'), b.ac.signal);
    if (b.seq !== navSeq) return;
    M.loading = false;
    M.total = +j.total || 0;
    applyMulti(multiData(curRel, j.files || [], []));
  } catch (e) {
    if (b.seq !== navSeq || e.name === 'AbortError') return;
    toast(errText(e), true);
    exitMulti();
  }
}

/* ───── общие функции для просмотрщика и меню ───── */

// после закрытия просмотрщика: свежие полоски «досмотрено», отложенная перерисовка
function afterViewer() {
  if (M.dirty) { M.dirty = false; rerender(); } else refreshWatched();
}

// файл переименован (nf2 — объект файла из ответа сервера, тот же id)
function fileChanged(nf2) {
  if (!nf2 || !D) return;
  const cur = byId.get(nf2.id) || (D.files || []).find(x => x.id === nf2.id);
  if (!cur) return;
  Object.assign(cur, nf2);
  if (V.open) {
    M.dirty = true;
    const t = $('#vname');
    if (t && V.list[V.i] && V.list[V.i].id === cur.id) t.textContent = cur.name;
  } else if (MODE === 'flat' && M.total > M.items.length && S.sort === 'name') {
    // плоский вид грузится порциями в порядке сервера: новое имя сдвигает порядок, и следующая порция
    // дала бы повтор и пропуск — загрузить заново
    openFlat(curRel);
  } else {
    rerender();
  }
}
// файл удалён (или перестал быть медиа)
function fileRemoved(id) {
  const cut = d => {
    if (!d || !d.files) return;
    const i = d.files.findIndex(x => x.id === id);
    if (i >= 0) d.files.splice(i, 1);
  };
  cut(D);
  if (pendingApply) cut(pendingApply[0]);
  if (MODE === 'flat') M.total = Math.max(0, M.total - 1);
  gen.pending.delete(id);
  const it = byId.get(id);
  if (it && it._k === selKey) {
    const n = list[it._i + 1] || list[it._i - 1];
    selKey = n ? n._k : '';
  }
  if (V.open && typeof vFileRemoved === 'function') vFileRemoved(id);
  rerender();
  if (MODE === 'dir' && D && !D._skel) syncTree(D);
}

// миниатюры до 3 файлов другой папки; только когда очередь сетки ничего не делает
let preRun = false;
async function thumbPrefetch(fs) {
  if (preRun) return;
  const todo = (fs || []).slice(0, 3).filter(f => f && f.thumb !== 1 && !gen.failed.has(f.id) && !objUrl.has(f.id));
  if (!todo.length) return;
  preRun = true;
  try {
    for (const f of todo) {
      if (gen.run.size) break;
      const t = {aborted: false, clean: null, rej: null, abortP: null};
      t.abortP = new Promise((_, rej) => { t.rej = rej; });
      t.abortP.catch(() => {});
      t.cancel = () => {
        if (t.aborted) return;
        t.aborted = true;
        if (t.clean) t.clean();
        t.rej(new Error('aborted'));
      };
      const to = setTimeout(t.cancel, 20000);
      try {
        const blob = await (f.kind === 'video' && !isGif(f) ? makeVideoThumb(f, t) : makePhotoThumb(f, t));
        const r = await fetch(q('/api/thumb/' + f.id), {method: 'POST', headers: {'Content-Type': 'image/jpeg'}, body: blob});
        if (r.ok) f.thumb = 1;
      } catch (e) { /* не вышло — не страшно, плитка сделает сама */ }
      finally { clearTimeout(to); if (t.clean) t.clean(); }
    }
  } finally {
    preRun = false;
  }
}

/* ───── избранные папки ───── */

function favToggle(rel) {
  rel = normRel(rel);
  if (!rel) return;
  const a = S.fav.slice(), i = a.indexOf(rel);
  if (i >= 0) a.splice(i, 1); else a.push(rel);
  setS('fav', a);
  renderFavs();
  syncModeUi();
}
function renderFavs() {
  const box = $('#favs');
  box.hidden = !S.fav.length;
  box.innerHTML = S.fav.length ? '<div class="ph2">Favourites</div>' + S.fav.map(r =>
    '<div class="tr fv" data-rel="' + esc(r) + '" title="' + esc(r) + '"><span class="fst">★</span><span class="tnm">' + esc(baseName(r)) + '</span></div>').join('') : '';
}
