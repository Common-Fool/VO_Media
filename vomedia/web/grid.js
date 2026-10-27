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
  else if (!thumbErr.has(f.id) && f.thumb === 1) src = tUrl(f);
  else f._w = true;                  // миниатюры нет — сразу в очередь генерации
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
