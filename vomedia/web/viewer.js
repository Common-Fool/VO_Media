'use strict';
// VO Media — Просмотрщик: полный экран, листание, видео, раскадровка, таймлайн, предпросмотр над шкалой.
// Обычные скрипты грузятся по порядку core → grid → viewer → ui: общие const/let видны между файлами.

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

const V = {open: false, list: [], i: -1, seq: 0, sess: 0, hop: false, cache: new Map(), vsrc: false, raf: 0, drag: false, barOff: false,
  idleT: 0, spinT: 0, hudT: 0, wt: 0, clickT: 0};
let $v, $vi, $vv, $vseek, $vfill, $vknob, $vtime, $vvol, $vmute, $vplay, $vspin, $vmsg;
let $vtl, $vtlc, $vtlcx, $vtlm, $vtlt, $vtlb, $vpv, $vpvc, $vpvx, $vpvt;

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
  V.sess++;
  V.hop = false;
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
  clearTimeout(V.clickT);
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
  storyStop();
  pvStop();
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
  clearTimeout(V.clickT);
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
  tlApply(false);
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
  if (V.hop) return;
  i = clamp(i, 0, V.list.length - 1);
  if (i !== V.i) vShow(i);
}

// шаг на файл; за краем списка — в соседнюю папку
function vStep(dir) {
  if (V.hop) return;
  const i = V.i + dir;
  if (i >= 0 && i < V.list.length) vShow(i); else vCross(dir);
}

/* переход между папками: первый файл следующей / последний файл предыдущей */

// открыть папку «как обычно» (кеш, потом fresh) и применить сразу, несмотря на открытый просмотрщик;
// ответ — данные папки, как только они появились (кеш или fresh), null — открыть не удалось
function hopLoad(rel, first) {
  return new Promise(res => {
    let got = false;
    const fin = d => { if (!got) { got = true; res(d); } };
    openDir(rel, {hop: true, first: first, onData: fin}).then(() => fin(null), () => fin(null));
  });
}

async function vCross(step) {
  if (V.hop) return;
  V.hop = true;
  const sess = V.sess;
  const alive = () => V.open && V.sess === sess;
  clearTimeout(V.spinT);
  V.spinT = setTimeout(() => { if (alive()) $vspin.hidden = false; }, 250);
  try {
    let rel = curRel;
    for (let n = 0; n < 50; n++) {
      const nb = await getJson(q('/api/neighbor?rel=' + encodeURIComponent(rel) + '&step=' + step));
      if (!alive()) return;
      if (nb.rel == null) { hud(step > 0 ? 'Last folder' : 'First folder'); return; }
      rel = normRel(nb.rel);
      // дешёвая проверка по кешу: пустые после фильтра папки пропускаем, не трогая сетку
      const j = await getJson(dirUrl(rel, false));
      if (!alive()) return;
      if (!j.missing && !(j.files || []).some(f => S.filter === 'all' || f.kind === S.filter)) continue;
      const d = await hopLoad(rel, j.missing ? null : j);
      if (!alive()) return;
      if (!d) { hud('Cannot open the folder', true); return; }
      if (!files.length) continue;
      V.list = files;
      vShow(step > 0 ? 0 : files.length - 1);
      hud(d.rel ? d.name : rootName);
      return;
    }
    hud('No files in the nearby folders');
  } catch (e) {
    if (alive()) toast('Cannot open the folder: ' + e.message, true);
  } finally {
    if (V.sess === sess) {
      V.hop = false;
      clearTimeout(V.spinT);
      $vspin.hidden = true;
    }
  }
}

const vDur = () => (isFinite($vv.duration) && $vv.duration > 0) ? $vv.duration : ((V.list[V.i] && V.list[V.i].duration) || 0);
function vUi() {
  const d = vDur(), t = V.vsrc ? $vv.currentTime : 0;
  const p = d ? clamp(t / d, 0, 1) * 100 : 0;
  $vfill.style.width = p + '%';
  $vknob.style.left = p + '%';
  if (!$vtl.hidden) $vtlm.style.left = p + '%';
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

/* ───── раскадровка видео: 30 кадров, спрайт 6×5 ───── */

const SBN = 30, SBC = 6, SBR = 5, SBW = 320;
let ST = null;                      // раскадровка текущего видео: {f, state, src, fw, fh, got, vid, rej, dead, tm, im}

// нужна ли раскадровка: создаётся один раз на видео (после неудачи не повторяем)
function storyNeed(delay) {
  const f = V.list[V.i];
  if (!V.open || !f || f.kind !== 'video' || ST) return;
  const st = ST = {f: f, state: 'load', src: null, fw: 0, fh: 0, got: 0, vid: null, rej: null, dead: false, tm: 0, im: null};
  st.tm = setTimeout(() => storyLoad(st), delay || 0);
}

function storyLoad(st) {
  if (st.dead) return;
  const im = st.im = new Image();
  im.onload = () => {
    if (st.dead) return;
    st.im = null;
    const fw = im.naturalWidth / SBC, fh = im.naturalHeight / SBR;
    if (fw < 8 || fh < 8) { storyGen(st); return; }
    st.src = im; st.fw = fw; st.fh = fh; st.got = SBN; st.state = 'ready';
    tlDraw();
  };
  im.onerror = () => { if (!st.dead) { st.im = null; storyGen(st); } };     // на сервере нет — делаем сами
  im.src = q('/s/' + st.f.id + '?v=' + Math.round(st.f.mtime || 0));
}

// ждать событие скрытого <video>; st.rej позволяет оборвать ожидание при отмене
function waitVid(st, v, ev, ms) {
  return new Promise((res, rej) => {
    let tm = 0;
    const fin = err => {
      clearTimeout(tm);
      v.removeEventListener(ev, ok);
      v.removeEventListener('error', bad);
      if (st.rej === abort) st.rej = null;
      if (err) rej(err); else res();
    };
    const ok = () => fin(null);
    const bad = () => fin(new Error('video error'));
    const abort = () => fin(new Error('aborted'));
    tm = setTimeout(() => fin(new Error('timeout')), ms);
    st.rej = abort;
    v.addEventListener(ev, ok, {once: true});
    v.addEventListener('error', bad, {once: true});
  });
}

function storyRelease(st) {
  const v = st.vid;
  if (!v) return;
  st.vid = null;
  v.removeAttribute('src');
  try { v.load(); } catch (_) { /* нечего освобождать */ }
}

async function storyGen(st) {
  if (st.dead) return;
  st.state = 'gen';
  const f = st.f;
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'metadata';
  v.playsInline = true;
  st.vid = v;
  try {
    const meta = waitVid(st, v, 'loadedmetadata', 15000);
    v.src = fUrl(f.id);
    await meta;
    const dur = v.duration, vw = v.videoWidth, vh = v.videoHeight;
    if (!isFinite(dur) || dur <= 0 || !vw || !vh) throw new Error('no video');
    let fh = Math.round(SBW * vh / vw);
    fh += fh & 1;                                       // высота кадра чётная
    const c = document.createElement('canvas');
    c.width = SBW * SBC; c.height = fh * SBR;
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    st.src = c; st.fw = SBW; st.fh = fh; st.got = 0;
    for (let i = 0; i < SBN; i++) {
      if (st.dead) return;
      const w = waitVid(st, v, 'seeked', 10000);
      v.currentTime = dur * (i + 0.5) / SBN;
      await w;
      if (st.dead) return;
      x.drawImage(v, (i % SBC) * SBW, Math.floor(i / SBC) * fh, SBW, fh);
      st.got = i + 1;
      tlFrame(st, i);
    }
    st.state = 'ready';
    storyRelease(st);
    // toDataURL, а не toBlob (см. canvasBlob)
    const blob = dataBlob(c.toDataURL('image/jpeg', 0.8));
    fetch(q('/api/story/' + f.id), {method: 'POST', headers: {'Content-Type': 'image/jpeg'}, body: blob}).catch(() => {});
  } catch (e) {
    if (!st.dead) st.state = 'fail';                    // тихо: что успели — остаётся
  } finally {
    storyRelease(st);
  }
}

function storyStop() {
  const st = ST;
  if (!st) return;
  ST = null;
  st.dead = true;
  clearTimeout(st.tm);
  if (st.rej) st.rej();
  if (st.im) { st.im.onload = st.im.onerror = null; st.im.src = ''; st.im = null; }
  storyRelease(st);
}

/* ───── таймлайн: полоса из 30 кадров над панелью ───── */

function tlApply(now) {
  const f = V.list[V.i];
  const on = !!S.timeline && !!f && f.kind === 'video';
  $vtlb.classList.toggle('on', !!S.timeline);
  $vtl.hidden = !on;
  $vtlt.hidden = true;
  TLH.on = false;
  if (on) {
    tlSize();
    vUi();
    storyNeed(now ? 0 : 250);       // при быстром листании не дёргаем сервер сразу
  }
}
function tlToggle() {
  setS('timeline', !S.timeline);
  tlApply(true);
  const f = V.list[V.i];
  if (!f || f.kind !== 'video') hud('Timeline ' + (S.timeline ? 'on' : 'off'));
}
function tlSize() {
  const c = $vtlc, dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round($vtl.clientWidth * dpr), h = Math.round($vtl.clientHeight * dpr);
  if (!w || !h) return;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  TL.dpr = dpr;
  tlDraw();
}
// раскладка: сколько кадров целиком (в их пропорциях) помещается в полосу и какие из 30 взять
const TL = {key: '', m: 1, idx: [14], cw: 0, gap: 2, dpr: 1};
function tlLayout() {
  const W = $vtlc.width, Hh = $vtlc.height, ar = clamp(pvAspect(), 0.3, 4);
  const key = W + 'x' + Hh + '@' + ar.toFixed(3);
  if (key === TL.key) return false;
  TL.key = key;
  const gap = Math.round(2 * TL.dpr);
  const m = clamp(Math.floor((W + gap) / (Hh * ar + gap)), 1, SBN);
  TL.m = m; TL.gap = gap; TL.cw = (W - gap * (m - 1)) / m;
  TL.idx = [];
  for (let k = 0; k < m; k++) TL.idx.push(clamp(Math.round((k + 0.5) * SBN / m - 0.5), 0, SBN - 1));
  return true;
}
function tlDraw() {
  const c = $vtlc;
  $vtlcx.clearRect(0, 0, c.width, c.height);
  tlLayout();
  if (!ST) return;
  for (let k = 0; k < TL.m; k++) tlCell(ST, k);
}
function tlCell(st, k) {
  const i = TL.idx[k];
  if (!st.src || i >= st.got) return;
  const Hh = $vtlc.height, x0 = Math.round(k * (TL.cw + TL.gap)), dw = Math.round(TL.cw);
  const ar = dw / Hh;
  let sw = st.fw, sh = st.fh;                        // пропорции почти совпадают; лишнее срезается
  if (sw / sh > ar) sw = sh * ar; else sh = sw / ar;
  $vtlcx.drawImage(st.src, (i % SBC) * st.fw + (st.fw - sw) / 2, Math.floor(i / SBC) * st.fh + (st.fh - sh) / 2, sw, sh, x0, 0, dw, Hh);
}
// готов кадр i раскадровки — дорисовать его ячейки
function tlFrame(st, i) {
  if (st !== ST || !st.src || $vtl.hidden || !$vtlc.width) return;
  if (tlLayout()) { tlDraw(); return; }              // пропорции уточнились — раскладка другая
  for (let k = 0; k < TL.m; k++) if (TL.idx[k] === i) tlCell(st, k);
}
// момент t_i кадра под курсором (ячейка → кадр раскадровки)
function tlTime(x, d) {
  const r = $vtl.getBoundingClientRect();
  const k = r.width ? clamp(Math.floor((x - r.left) / r.width * TL.m), 0, TL.m - 1) : 0;
  return d * (TL.idx[k] + 0.5) / SBN;
}
const TLH = {on: false, x: 0, raf: 0};
function tlHover() {
  TLH.raf = 0;
  const d = vDur();
  if (!TLH.on || $vtl.hidden || !d) return;
  const r = $vtl.getBoundingClientRect();
  $vtlt.textContent = fmtDur(tlTime(TLH.x, d));
  $vtlt.style.left = clamp(TLH.x - r.left, 28, Math.max(28, r.width - 28)) + 'px';
  $vtlt.hidden = false;
}

/* ───── предпросмотр над шкалой: время + кадр ───── */

const H = {on: false, x: 0, t: 0, idx: -1, raf: 0, tm: 0, w: 0, h: 0, key: ''};
let PV = null;                      // второй скрытый <video> для точных кадров: {v, ready, busy, want, t, tm, dead, ar}

function pvAspect() {
  const f = V.list[V.i];
  if (PV && PV.ar) return PV.ar;
  if (ST && ST.fw && ST.fh) return ST.fw / ST.fh;
  return f && f.w && f.h ? f.w / f.h : 16 / 9;
}
// размер окна и холста под пропорции видео (меняется редко)
function pvSize() {
  const a = clamp(pvAspect(), 0.3, 4);
  const w = Math.round(a >= 240 / 170 ? 240 : 170 * a), h = Math.max(1, Math.round(w / a));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const key = w + 'x' + h + '@' + dpr;
  if (key === H.key) return;
  H.key = key; H.w = w; H.h = h; H.idx = -1;
  $vpvc.width = Math.round(w * dpr); $vpvc.height = Math.round(h * dpr);
  $vpvc.style.width = w + 'px'; $vpvc.style.height = h + 'px';
}
function pvMove(e) {
  H.on = true;
  H.x = e.clientX;
  if (!H.raf) H.raf = requestAnimationFrame(pvFrame);
}
function pvFrame() {
  H.raf = 0;
  const f = V.list[V.i];
  if (!H.on || !V.open || !f || f.kind !== 'video') return;
  const d = vDur();
  if (!d) return;
  const r = $vseek.getBoundingClientRect();        // единственное чтение раскладки за кадр
  const t = H.t = clamp((H.x - r.left) / r.width, 0, 1) * d;
  pvSize();
  const x = clamp(H.x - H.w / 2, 8, Math.max(8, window.innerWidth - H.w - 8));
  $vpv.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(r.top - H.h - 12) + 'px)';
  $vpv.hidden = false;
  $vpvt.textContent = fmtDur(t);
  const idx = Math.min(SBN - 1, Math.floor(t / d * SBN));
  if (idx !== H.idx) {                              // сразу: ближайший кадр раскадровки
    H.idx = idx;
    const s = ST;
    if (s && s.src && idx < s.got) {
      $vpvx.drawImage(s.src, (idx % SBC) * s.fw, Math.floor(idx / SBC) * s.fh, s.fw, s.fh, 0, 0, $vpvc.width, $vpvc.height);
    }
  }
  clearTimeout(H.tm);
  H.tm = setTimeout(pvExact, 150);                  // точный кадр — когда мышь замерла
}
function pvExact() {
  H.tm = 0;
  const f = V.list[V.i];
  if (!H.on || !V.open || !f || f.kind !== 'video') return;
  if (!PV) pvCreate(f);
  if (PV.dead) return;
  PV.want = H.t;
  pvRun();
}
function pvCreate(f) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'metadata';
  v.playsInline = true;
  const p = PV = {v: v, ready: false, busy: false, want: null, t: 0, tm: 0, dead: false, ar: 0};
  v.addEventListener('loadedmetadata', () => {
    if (p.dead) return;
    p.ready = true;
    if (v.videoWidth && v.videoHeight) p.ar = v.videoWidth / v.videoHeight;
    pvRun();
  });
  v.addEventListener('seeked', () => {
    if (p.dead || !p.busy) return;
    p.busy = false;
    clearTimeout(p.tm);
    // рисуем, только если цель не ушла дальше (иначе кадр устарел)
    if (H.on && p.want == null && Math.abs(p.t - H.t) < 0.05) {
      pvSize();
      $vpvx.drawImage(v, 0, 0, $vpvc.width, $vpvc.height);
    }
    pvRun();
  });
  v.addEventListener('error', () => pvFail(p));
  v.src = fUrl(f.id);
}
// одна перемотка за раз; пока идёт, новая цель только запоминается (p.want)
function pvRun() {
  const p = PV;
  if (!p || p.dead || !p.ready || p.busy || p.want == null) return;
  p.t = p.want;
  p.want = null;
  p.busy = true;
  clearTimeout(p.tm);
  p.tm = setTimeout(() => pvFail(p), 10000);
  p.v.currentTime = p.t;
}
function pvFail(p) {                                // тихо: остаётся кадр раскадровки
  if (p.dead) return;
  p.dead = true;
  clearTimeout(p.tm);
  p.v.removeAttribute('src');
  try { p.v.load(); } catch (_) { /* нечего освобождать */ }
}
function pvHide() {
  H.on = false;
  clearTimeout(H.tm);
  if (PV) PV.want = null;
  $vpv.hidden = true;
}
function pvStop() {
  pvHide();
  cancelAnimationFrame(H.raf);
  H.raf = 0;
  if (PV) { pvFail(PV); PV = null; }
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
      if (e.ctrlKey || e.shiftKey) {                  // перемотка: Shift 5 с, Ctrl 30 с, Ctrl+Shift 120 с
        if (vid) vSeekBy(dir * (e.ctrlKey ? (e.shiftKey ? 120 : 30) : 5));
      } else vStep(dir);
      return true;
    }
    case 'Home': vGo(0); return true;
    case 'End': vGo(V.list.length - 1); return true;
    case ' ': case 'Spacebar': vToggle(); return true;
    case 'Enter': toggleFs(); return true;
    case 'ArrowUp': vVol(0.05); return true;
    case 'ArrowDown': vVol(-0.05); return true;
    case 'm': case 'M': vMute(); return true;
    case 't': case 'T': tlToggle(); return true;
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
  $vtl = $('#vtl'); $vtlc = $('#vtlc'); $vtlm = $('#vtlm'); $vtlt = $('#vtlt'); $vtlb = $('#vtlb');
  $vpv = $('#vpv'); $vpvc = $('#vpvc'); $vpvt = $('#vpvt');
  $vtlcx = $vtlc.getContext('2d');
  $vpvx = $vpvc.getContext('2d');
  $vpvx.imageSmoothingQuality = 'high';
  S.timeline = !!S.timeline;
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
  $vtlb.onclick = tlToggle;
  $vvol.addEventListener('input', () => {
    setS('volume', +$vvol.value);
    setS('muted', +$vvol.value === 0);
    applyVol();
  });
  $('#vprev').onclick = () => vStep(-1);
  $('#vnext').onclick = () => vStep(1);
  $('#vclose').onclick = closeViewer;
  $v.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });   // кнопки не берут фокус
  $v.addEventListener('mousemove', barShow);

  // клик по картинке: закрыть (ждём 250 мс — вдруг двойной); в полном экране видео — play/pause, фото — ничего
  const stage = $('#vstage');
  stage.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    clearTimeout(V.clickT);
    if (fsOn) {
      const f = V.list[V.i];
      if (f && f.kind === 'video') vToggle();
      return;
    }
    if (e.detail > 1) return;                     // вторая половина двойного клика
    V.clickT = setTimeout(closeViewer, 250);
  });
  stage.addEventListener('dblclick', e => {
    if (e.target.closest('button')) return;
    clearTimeout(V.clickT);
    toggleFs();
  });
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const now = Date.now();
    if (now - V.wt < 120 || !e.deltaY) return;
    V.wt = now;
    vStep(e.deltaY > 0 ? 1 : -1);
  }, {passive: false});

  // шкала: перемотка и предпросмотр (работает и при перетаскивании)
  const seekAt = e => {
    const r = $vseek.getBoundingClientRect();
    vSeekTo(clamp((e.clientX - r.left) / r.width, 0, 1) * vDur());
  };
  $vseek.addEventListener('pointerenter', e => { storyNeed(0); pvMove(e); });
  $vseek.addEventListener('pointerdown', e => { $vseek.setPointerCapture(e.pointerId); V.drag = true; seekAt(e); pvMove(e); });
  $vseek.addEventListener('pointermove', e => { if (V.drag) seekAt(e); pvMove(e); });
  $vseek.addEventListener('pointerleave', () => { if (!V.drag) pvHide(); });
  const endDrag = () => {
    V.drag = false;
    if (!$vseek.matches(':hover')) pvHide();
  };
  $vseek.addEventListener('pointerup', endDrag);
  $vseek.addEventListener('pointercancel', endDrag);

  // таймлайн: клик по кадру — перемотка к его t_i
  $vtl.addEventListener('click', e => {
    const d = vDur();
    if (d) vSeekTo(tlTime(e.clientX, d));
  });
  $vtl.addEventListener('pointermove', e => {
    TLH.on = true;
    TLH.x = e.clientX;
    if (!TLH.raf) TLH.raf = requestAnimationFrame(tlHover);
  });
  $vtl.addEventListener('pointerleave', () => { TLH.on = false; $vtlt.hidden = true; });
  let rzRaf = 0;
  addEventListener('resize', () => {
    if (!V.open || $vtl.hidden || rzRaf) return;
    rzRaf = requestAnimationFrame(() => { rzRaf = 0; if (V.open && !$vtl.hidden) tlSize(); });
  });
}
