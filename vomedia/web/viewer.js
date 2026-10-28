'use strict';
// VO Media — Просмотрщик: полный экран, листание, видео, раскадровка, таймлайн, предпросмотр над шкалой.
// Обычные скрипты грузятся по порядку core → grid → viewer → ui: общие const/let видны между файлами.

// Настройки просмотрщика проверяются здесь, независимо от версии остальных модулей.
const V_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
for (const k of ['autoplay', 'next', 'loop', 'rateUI']) if (typeof S[k] !== 'boolean') S[k] = false;
if (!Number.isInteger(S.slide) || S.slide < 0 || S.slide > 3) S.slide = 0;
if (typeof S.slideSec !== 'number' || !Number.isFinite(S.slideSec)) S.slideSec = 3;
S.slideSec = clamp(Math.round(S.slideSec * 2) / 2, 0.5, 5);
if (typeof S.rate !== 'number' || !V_RATES.includes(S.rate)) S.rate = 1;

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
document.addEventListener('fullscreenchange', () => {
  const was = fsOn;
  fsOn = !!document.fullscreenElement;
  if (was && !fsOn && V.open && S.slide) vSetSlide(0);
  fsChanged();
});
function fsChanged() {
  if (V.open) barShow();
}

/* ───── просмотрщик ───── */

const V = {open: false, list: [], i: -1, seq: 0, sess: 0, hop: false, cache: new Map(), vsrc: false, raf: 0, drag: false, barOff: false,
  idleT: 0, spinT: 0, hudT: 0, wt: 0, clickT: 0, file: null, slideT: 0, loadT: 0, moveRaf: 0,
  failed: new Set(), prefetched: new Set(), neighbors: new Set(), preAbort: null,
  watched: 0, watchAt: 0, saveAt: 0, playing: false, resumed: false, removed: false, bad: false};
let $v, $vi, $vv, $vseek, $vfill, $vknob, $vtime, $vvol, $vmute, $vplay, $vspin, $vmsg;
let $vtl, $vtlc, $vtlcx, $vtlm, $vtlt, $vtlb, $vpv, $vpvc, $vpvx, $vpvt;
let $vauto, $vnextEnd, $vloop, $vrate, $vslide, $vslideSec, $vslideVal, $vfallback, $vrestart;
const vVideo = f => !!f && f.kind === 'video' && !isGif(f);
const vPhoto = () => V.open && V.file && V.file.kind === 'photo' && !isGif(V.file);
const vMode = () => typeof curMode === 'function' ? curMode() : 'dir';
const vRel = f => normRel(f && f.rel != null ? f.rel : curRel);

function vControls() {
  if (!V.open) return;
  for (const [b, k, name] of [[$vauto, 'autoplay', 'Autoplay'], [$vnextEnd, 'next', 'Next video on end'], [$vloop, 'loop', 'Loop video']]) {
    b.classList.toggle('on', S[k]);
    b.setAttribute('aria-pressed', String(S[k]));
    b.title = name + ': ' + (S[k] ? 'on' : 'off') + (k === 'loop' && S.slide ? ' (suspended during slideshow)' : '');
    b.setAttribute('aria-label', b.title);
  }
  const names = ['Off', 'To end of folder', 'Repeat folder', 'Next folders'];
  $vslide.textContent = ['▣', '▶|', '↻', '▶→'][S.slide];
  $vslide.title = 'Slideshow: ' + names[S.slide] + ' (click to change mode)';
  $vslide.setAttribute('aria-label', $vslide.title);
  $vslide.setAttribute('aria-pressed', String(!!S.slide));
  $vslide.classList.toggle('on', !!S.slide);
  $vslideSec.value = 5.5 - S.slideSec;
  $vslideVal.textContent = S.slideSec + ' s';
  $vrate.textContent = S.rate + '×';
  $vrate.hidden = !S.rateUI || !vVideo(V.file) || V.bad;
  $vv.loop = !!S.loop && !S.slide;
  if ($vv.playbackRate !== S.rate) $vv.playbackRate = S.rate;
}

function vPlay() {
  if (!V.open || !V.vsrc || V.bad) return;
  const p = $vv.play();
  if (p && p.catch) p.catch(() => {});
}
function vRate(dir, cycle) {
  if (!V.open || !vVideo(V.file) || V.bad) return;
  const i = V_RATES.indexOf(S.rate);
  setS('rate', V_RATES[cycle ? (i + 1) % V_RATES.length : clamp(i + dir, 0, V_RATES.length - 1)]);
  vControls();
  hud('Speed ' + S.rate + '×');
}

/* ───── слайдшоу и окончание видео ───── */

function vSetSlide(mode) {
  setS('slide', mode);
  clearTimeout(V.slideT);
  if (!V.open) return;
  vControls();
  if (mode) vSlideArm();
}
function vSlideArm() {
  clearTimeout(V.slideT);
  if (!V.open || !S.slide || !V.file) return;
  if (vVideo(V.file) && !V.bad) {
    if ($vv.ended) vSlideLater(0); else vPlay();
  } else {
    vSlideLater(V.bad ? 0 : Math.max(S.slideSec, isGif(V.file) ? (+V.file.duration || 0) : 0) * 1000);
  }
}
function vSlideLater(ms) {
  clearTimeout(V.slideT);
  const seq = V.seq;
  V.slideT = setTimeout(() => { if (V.open && S.slide && V.seq === seq) vSlideAdvance(); }, ms);
}
function vSlideAdvance() {
  if (!V.open || !S.slide || V.hop) return;
  const rel = vRel(V.file), mode = S.slide;
  let i = V.i + 1;
  if (mode !== 3) {
    while (i < V.list.length && vRel(V.list[i]) !== rel) i++;
    if (i === V.list.length && mode === 2) i = V.list.findIndex(f => vRel(f) === rel);
  }
  // Папка из одних неподдерживаемых видео не должна зациклить пропуск.
  for (let n = 0; i >= 0 && i < V.list.length && V.failed.has(V.list[i].id); n++) {
    i++;
    if (mode !== 3) {
      while (i < V.list.length && vRel(V.list[i]) !== rel) i++;
      if (i === V.list.length && mode === 2) i = V.list.findIndex(f => vRel(f) === rel);
    }
    if (n >= V.list.length) { vSetSlide(0); return; }
  }
  if (i >= 0 && i < V.list.length) vShow(i);
  else if (mode === 3 && vMode() === 'dir') vCross(1, true);
  else { vSetSlide(0); hud(vMode() === 'dir' ? 'End of folder' : 'Last file'); }
}
function vEnded() {
  if (!V.open || !V.vsrc || V.bad) return;
  vWatch();
  vProgress(false);
  $vplay.classList.remove('playing');
  vUi();
  if (S.slide) { vSlideLater(0); return; }
  if (!S.next || S.loop) return;
  const rel = vRel(V.file);
  for (let i = V.i + 1; i < V.list.length; i++) {
    const f = V.list[i];
    if (vRel(f) === rel && f.kind === 'video') { vShow(i, true); return; }
  }
}

/* ───── продолжение и тихие запросы ───── */

function vWatch() {
  const now = performance.now();
  if (V.watchAt && V.playing && !$vv.paused && !$vv.seeking && $vv.readyState >= 3) {
    V.watched += Math.max(0, Math.min(1, (now - V.watchAt) / 1000));
  }
  V.watchAt = now;
}
function vProgress(leaving) {
  const f = V.file, dur = vDur(), pos = $vv.currentTime;
  if (!V.vsrc || !vVideo(f) || V.removed || V.watched <= 10 || !Number.isFinite(dur) || dur <= 0 || !Number.isFinite(pos)) return;
  const now = performance.now();
  if (!leaving && now - V.saveAt < 10000) return;
  V.saveAt = now;
  f.pos = pos >= dur - 5 ? dur : pos;
  // Отложенный fresh не должен вернуть старую позицию при закрытии просмотрщика.
  for (const d of [D, pendingApply && pendingApply[0]]) {
    if (!d) continue;
    const same = (d.files || []).find(x => x.id === f.id);
    if (same) same.pos = f.pos;
  }
  fetch(q('/api/progress'), {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({id: f.id, pos: pos, dur: dur}), keepalive: leaving}).catch(() => {});
}
function vMetadata() {
  if (!V.open || !V.vsrc || V.bad) return;
  const f = V.file, dur = vDur();
  if (!V.resumed && f) {
    V.resumed = true;
    if (typeof f.pos === 'number' && f.pos > 10 && f.pos < dur - 10) {
      vSeekTo(f.pos);
      hud('Resumed at ' + fmtDur(f.pos));
      $vrestart.hidden = false;
      clearTimeout(V.hudT);
      V.hudT = setTimeout(() => { $vmsg.hidden = $vrestart.hidden = true; }, 5000);
    }
  }
  vUi();
}
function vCannotPlay() {
  if (!V.open || !V.vsrc || V.bad) return;
  V.bad = true;
  V.failed.add(V.file.id);
  clearTimeout(V.loadT);
  clearTimeout(V.spinT);
  $vspin.hidden = true;
  $vv.pause();
  cancelAnimationFrame(V.raf);
  storyStop(); pvStop();
  $vseek.hidden = $vtl.hidden = $('#vctl').hidden = true;
  $vfallback.hidden = false;
  $vrestart.hidden = true;
  $vmsg.hidden = true;
  vControls();
  if (S.slide) vSlideLater(0);
}

/* ───── фото: масштаб относительно вписанного размера ───── */

const VP = {z: 1, rot: 0, x: 0, y: 0, w: 0, h: 0, fit: 1, drag: null, raf: 0, moved: false};
function vPhotoReset() {
  if (VP.drag && $vi.hasPointerCapture(VP.drag.id)) $vi.releasePointerCapture(VP.drag.id);
  cancelAnimationFrame(VP.raf);
  Object.assign(VP, {z: 1, rot: 0, x: 0, y: 0, w: 0, h: 0, fit: 1, drag: null, raf: 0, moved: false});
  $vi.removeAttribute('style');
  $v.classList.remove('zoomed', 'panning');
}
function vPhotoDraw() {
  VP.raf = 0;
  if (!vPhoto() || !$vi.naturalWidth) return;
  const r = $('#vstage').getBoundingClientRect(), odd = VP.rot % 180 !== 0;
  const nw = $vi.naturalWidth, nh = $vi.naturalHeight;
  VP.fit = Math.min(r.width / (odd ? nh : nw), r.height / (odd ? nw : nh));
  VP.w = nw * VP.fit; VP.h = nh * VP.fit;
  const bw = (odd ? VP.h : VP.w) * VP.z, bh = (odd ? VP.w : VP.h) * VP.z;
  VP.x = clamp(VP.x, -Math.max(0, (bw - r.width) / 2), Math.max(0, (bw - r.width) / 2));
  VP.y = clamp(VP.y, -Math.max(0, (bh - r.height) / 2), Math.max(0, (bh - r.height) / 2));
  $vi.style.width = VP.w + 'px'; $vi.style.height = VP.h + 'px';
  $vi.style.transform = 'translate(-50%,-50%) translate(' + VP.x + 'px,' + VP.y + 'px) rotate(' + VP.rot + 'deg) scale(' + VP.z + ')';
  $v.classList.toggle('zoomed', VP.z > 1);
}
function vPhotoSoon() { if (V.open && !VP.raf) VP.raf = requestAnimationFrame(vPhotoDraw); }
function vZoom(z, x, y) {
  if (!vPhoto() || !$vi.naturalWidth) return;
  const r = $('#vstage').getBoundingClientRect(), old = VP.z;
  VP.z = clamp(z, 1, 8);
  const ratio = VP.z / old;
  const cx = x == null ? 0 : x - r.left - r.width / 2, cy = y == null ? 0 : y - r.top - r.height / 2;
  VP.x = cx - (cx - VP.x) * ratio; VP.y = cy - (cy - VP.y) * ratio;
  vPhotoDraw();
}
function vPhotoKey(rotate) {
  if (!vPhoto()) return;
  if (rotate) { VP.rot = (VP.rot + 90) % 360; VP.x = VP.y = 0; vPhotoDraw(); }
  else { vPhotoDraw(); vZoom(VP.z > 1 ? 1 : 1 / VP.fit); }
}

// Вызывается сеткой после удаления; работает и если её массив уже изменён.
function vFileRemoved(id) {
  if (!V.open) return;
  const current = V.file, old = V.i;
  V.list = V.list.filter(f => f.id !== id);
  if (current && current.id === id) {
    V.removed = true;
    if (V.list.length) vShow(Math.min(old, V.list.length - 1)); else closeViewer();
  } else {
    V.i = V.list.indexOf(current);
    $('#vpos').textContent = (V.i + 1) + ' / ' + V.list.length;
  }
}

function hud(text, sticky) {
  clearTimeout(V.hudT);
  $vrestart.hidden = true;
  V.hudText.textContent = text;
  $vmsg.className = sticky ? 'err' : '';
  $vmsg.hidden = false;
  if (!sticky) V.hudT = setTimeout(() => { $vmsg.hidden = true; }, 1200);
}

function openViewer(f) {
  const i = files.indexOf(f);
  if (i < 0) return;
  V.list = files.slice();
  V.open = true;
  V.sess++;
  V.hop = false;
  V.failed.clear();
  V.prefetched.clear();
  V.neighbors.clear();
  V.preAbort = new AbortController();
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
  if (S.slide) setS('slide', 0);
  if (V.preAbort) { V.preAbort.abort(); V.preAbort = null; }
  clearTimeout(V.hudT);
  cancelAnimationFrame(V.moveRaf);
  V.moveRaf = 0;
  vPhotoReset();
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
  vWatch();
  vProgress(true);
  V.playing = false;
  clearTimeout(V.slideT);
  clearTimeout(V.loadT);
  clearTimeout(V.hudT);
  cancelAnimationFrame(TLH.raf);
  TLH.raf = 0; TLH.on = false;
  V.drag = false;
  cancelAnimationFrame(V.raf);
  storyStop();
  pvStop();
  if (V.vsrc) {
    V.vsrc = false;
    $vv.pause();
    $vv.removeAttribute('src');
    $vv.load();                    // освободить соединение
    V.vsrc = false;
  }
  $vv.removeAttribute('poster');
  $vplay.classList.remove('playing');
}

function vShow(i, play) {
  if (!V.open || i < 0 || i >= V.list.length) return;
  const f = V.list[i];
  const seq = ++V.seq;
  clearTimeout(V.clickT);
  vLeaveVideo();
  V.i = i;
  V.file = f;
  V.bad = V.resumed = V.removed = false;
  V.watched = 0; V.watchAt = 0; V.saveAt = performance.now();
  vPhotoReset();
  $v.classList.toggle('photo', !!vPhoto());
  $vfallback.hidden = $vrestart.hidden = true;
  $vmsg.hidden = true;
  clearTimeout(V.spinT);
  $vspin.hidden = true;
  $('#vname').textContent = f.name;
  $('#vpos').textContent = (i + 1) + ' / ' + V.list.length;
  $('#vsize').textContent = fmtSize(f.size) + (f.mtime ? ' · ' + fmtDate(f.mtime) : '');
  $('#vres').textContent = f.w && f.h ? f.w + '×' + f.h : '';
  const vid = vVideo(f);
  $('#vctl').hidden = !vid;
  $vseek.hidden = !vid;
  if (vid) {
    $vi.removeAttribute('src');
    $vi.hidden = true;
    $vv.hidden = false;
    const ps = objUrl.get(f.id) || (f.thumb === 1 && !thumbErr.has(f.id) ? tUrl(f) : '');
    if (ps) $vv.poster = ps;
    // src сразу, но только метаданные: виден первый кадр, а Space запускает без ожидания открытия файла
    V.vsrc = true;
    // loadeddata нужен и при выключенном autoplay: проверяем возможность показать первый кадр.
    $vv.preload = 'auto';
    $vv.src = fUrl(f.id);
    V.loadT = setTimeout(() => { if (V.open && V.seq === seq && $vv.readyState < 2) vCannotPlay(); }, 8000);
    vUi();
    vControls();
    if (play || S.autoplay || S.slide) vPlay();
  } else {
    $vv.hidden = true;
    $vi.hidden = false;
    $vi.src = fUrl(f.id);
    V.spinT = setTimeout(() => { if (seq === V.seq) $vspin.hidden = false; }, 150);
    $vi.decode().then(() => {
      if (seq !== V.seq) return;
      clearTimeout(V.spinT);
      $vspin.hidden = true;
      if (!isGif(f)) vPhotoDraw();
      vSlideArm();
    }).catch(() => {
      if (seq !== V.seq) return;
      clearTimeout(V.spinT);
      $vspin.hidden = true;
      hud('Cannot display this file', true);
      if (S.slide) vSlideLater(S.slideSec * 1000);
    });
  }
  tlApply(false);
  vControls();
  vPreload(i);
}

// Предзагрузка ±2 фото, одного следующего видео и первых трёх миниатюр соседней папки.
function vPreload(i) {
  if (!V.open) return;
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
  const next = V.list[i + 1];
  if (vVideo(next) && !V.prefetched.has(next.id)) {
    V.prefetched.add(next.id);
    fetch(q('/api/prefetch'), {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id: next.id}), signal: V.preAbort && V.preAbort.signal}).catch(() => {});
  }
  if (vMode() !== 'dir' || i < V.list.length - 2 || V.neighbors.has(curRel)) return;
  const rel = curRel, sess = V.sess, signal = V.preAbort && V.preAbort.signal;
  V.neighbors.add(rel);
  const alive = () => V.open && V.sess === sess && curRel === rel && vMode() === 'dir';
  (async () => {
    try {
      const nb = await getJson(q('/api/neighbor?rel=' + encodeURIComponent(rel) + '&step=1'), signal);
      if (!alive() || nb.rel == null) return;
      const d = await getJson(dirUrl(normRel(nb.rel), false), signal);
      if (!alive() || d.missing || typeof thumbPrefetch !== 'function') return;
      const ff = (d.files || []).filter(f => S.filter === 'all' || f.kind === S.filter).sort(fileCmp());
      thumbPrefetch(ff.slice(0, 3));
    } catch (_) { /* сервер предзагрузки ещё может отсутствовать */ }
  })();
}

function vGo(i) {
  if (!V.open || V.hop) return;
  i = clamp(i, 0, V.list.length - 1);
  if (i !== V.i) vShow(i);
}

// шаг на файл; за краем списка — в соседнюю папку
function vStep(dir) {
  if (!V.open || V.hop) return;
  const i = V.i + dir;
  if (i >= 0 && i < V.list.length) vShow(i);
  else if (vMode() === 'dir') vCross(dir);
  else hud(dir > 0 ? 'Last file' : 'First file');
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

async function vCross(step, slide) {
  if (!V.open || V.hop || vMode() !== 'dir') return;
  clearTimeout(V.slideT);
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
      if (nb.rel == null) { if (slide) vSetSlide(0); hud(step > 0 ? 'Last folder' : 'First folder'); return; }
      rel = normRel(nb.rel);
      // дешёвая проверка по кешу: пустые после фильтра папки пропускаем, не трогая сетку
      const j = await getJson(dirUrl(rel, false));
      if (!alive()) return;
      if (!j.missing && !(j.files || []).some(f => S.filter === 'all' || f.kind === S.filter)) continue;
      const d = await hopLoad(rel, j.missing ? null : j);
      if (!alive()) return;
      if (!d) { if (slide) vSetSlide(0); hud('Cannot open the folder', true); return; }
      if (!files.length) continue;
      V.list = files.slice();
      vShow(step > 0 ? 0 : files.length - 1);
      hud(d.rel ? d.name : rootName);
      return;
    }
    hud('No files in the nearby folders');
    if (slide) vSetSlide(0);
  } catch (e) {
    if (alive()) { if (slide) vSetSlide(0); toast('Cannot open the folder: ' + e.message, true); }
  } finally {
    if (V.sess === sess) {
      V.hop = false;
      clearTimeout(V.spinT);
      $vspin.hidden = true;
    }
  }
}

const vDur = () => (isFinite($vv.duration) && $vv.duration > 0) ? $vv.duration : ((V.file && V.file.duration) || 0);
function vUi() {
  if (!V.open) return;
  const d = vDur(), t = V.vsrc ? $vv.currentTime : 0;
  const p = d ? clamp(t / d, 0, 1) * 100 : 0;
  $vfill.style.width = p + '%';
  $vknob.style.left = p + '%';
  if (!$vtl.hidden) $vtlm.style.left = p + '%';
  $vtime.textContent = fmtDur(t) + ' / ' + fmtDur(d);
}
function vTick() {
  if (!V.open || !V.vsrc || V.bad) return;
  vWatch();
  vProgress(false);
  vUi();
  if (!$vv.paused && !$vv.ended) V.raf = requestAnimationFrame(vTick);
}
function vLoadSrc() {
  const f = V.list[V.i];
  if (!V.open || V.vsrc || !vVideo(f) || V.bad) return;
  V.vsrc = true;
  $vv.preload = 'metadata';
  $vv.src = fUrl(f.id);
}
function vToggle() {
  const f = V.list[V.i];
  if (!V.open || !vVideo(f) || V.bad) return;
  vLoadSrc();
  if ($vv.paused) { const p = $vv.play(); if (p && p.catch) p.catch(() => {}); } else $vv.pause();
}
function vSeekTo(t) {
  const f = V.list[V.i];
  if (!V.open || !vVideo(f) || V.bad) return;
  vLoadSrc();
  try { $vv.currentTime = clamp(t, 0, vDur() || t); } catch (_) { /* метаданные ещё не готовы */ }
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
  if (!V.open) return;
  vControls();
  $v.classList.remove('idle');
  clearTimeout(V.idleT);
  if (!fsOn) return;
  const arm = () => {
    V.idleT = setTimeout(() => {
      if (!V.open) return;
      if ($('#vbar').matches(':hover') || $('#vslidebox').matches(':hover')) arm(); else $v.classList.add('idle');
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
  if (!V.open || !vVideo(f) || V.bad || ST) return;
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
  const on = V.open && !!S.timeline && vVideo(f) && !V.bad;
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
  if (!vVideo(f)) hud('Timeline ' + (S.timeline ? 'on' : 'off'));
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
  if (!V.open || !TLH.on || $vtl.hidden || !d) return;
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
  if (!V.open || !vVideo(V.file) || V.bad) return;
  H.on = true;
  H.x = e.clientX;
  if (!H.raf) H.raf = requestAnimationFrame(pvFrame);
}
function pvFrame() {
  H.raf = 0;
  const f = V.list[V.i];
  if (!H.on || !V.open || !vVideo(f) || V.bad) return;
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
  if (!H.on || !V.open || !vVideo(f) || V.bad) return;
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
  if (!V.open) return false;
  const k = e.key;
  if (k === 'Escape') { if (S.slide) vSetSlide(0); if (fsOn) leaveFs(); else closeViewer(); return true; }
  if (e.altKey || e.metaKey) return false;
  const f = V.list[V.i];
  const vid = vVideo(f) && !V.bad;
  if (!e.ctrlKey && (e.code === 'Comma' || e.code === 'Period' || [',', '.', '<', '>'].includes(k))) {
    const dir = e.code === 'Comma' || k === ',' || k === '<' ? -1 : 1;
    if (e.shiftKey) vRate(dir, false);
    else if (vid && $vv.paused) vSeekBy(dir / 30);
    return true;
  }
  if (!e.ctrlKey && (k.toLowerCase() === 'z' || k.toLowerCase() === 'r')) {
    vPhotoKey(k.toLowerCase() === 'r');
    return true;
  }
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

  // Новая разметка принадлежит просмотрщику; index.html меняется параллельно.
  const options = document.createElement('span');
  options.id = 'voptions';
  const button = (id, text, title, parent) => {
    const b = document.createElement('button');
    b.id = id; b.type = 'button'; b.tabIndex = -1;
    b.textContent = text; b.title = title; b.setAttribute('aria-label', title);
    parent.append(b);
    return b;
  };
  $vauto = button('vauto', 'A▶', 'Autoplay', options);
  $vnextEnd = button('vnextend', '▶|', 'Next video on end', options);
  $vloop = button('vloop', '↻', 'Loop video', options);
  $('#vrow').append(options);
  $vrate = button('vrate', S.rate + '×', 'Playback speed (Shift+, / Shift+.)', $('#vctl'));
  $vrate.hidden = true;
  const slideBox = document.createElement('div');
  slideBox.id = 'vslidebox';
  $vslide = button('vslide', '▣', 'Slideshow', slideBox);
  const speed = document.createElement('label');
  speed.id = 'vslidespeed';
  $vslideSec = document.createElement('input');
  $vslideSec.type = 'range'; $vslideSec.min = '0.5'; $vslideSec.max = '5'; $vslideSec.step = '0.5';
  $vslideSec.setAttribute('aria-label', 'Slideshow speed (5 to 0.5 seconds)');
  $vslideVal = document.createElement('span');
  speed.append($vslideSec, $vslideVal);
  slideBox.append(speed);
  $v.append(slideBox);
  $vfallback = document.createElement('div');
  $vfallback.id = 'vfallback'; $vfallback.hidden = true;
  const cannot = document.createElement('span');
  cannot.textContent = "Can't play here";
  $vfallback.append(cannot);
  const external = button('vexternal', 'Play in external player', 'Play in external player', $vfallback);
  $('#vstage').append($vfallback);
  $vrestart = button('vrestart', 'Restart', 'Restart from the beginning', $vmsg);
  $vrestart.hidden = true;
  // Текст HUD и кнопка независимы: обычные сообщения не уничтожают Restart.
  const msgText = document.createElement('span');
  $vmsg.prepend(msgText);
  V.hudText = msgText;
  for (const [b, k] of [[$vauto, 'autoplay'], [$vnextEnd, 'next'], [$vloop, 'loop']]) {
    b.onclick = () => { setS(k, !S[k]); vControls(); };
  }
  $vslide.onclick = () => vSetSlide((S.slide + 1) % 4);
  $vslideSec.oninput = () => {
    setS('slideSec', 5.5 - Number($vslideSec.value));
    vControls();
    if (!vVideo(V.file) || V.bad) vSlideArm();
  };
  $vrate.onclick = () => vRate(1, true);
  external.onclick = () => {
    if (V.open && V.file) post('/api/play', {ids: [V.file.id]}).catch(() => {});
  };
  $vrestart.onclick = () => {
    if (!V.open || !V.vsrc || V.bad) return;
    vSeekTo(0);
    V.file.pos = 0;
    $vmsg.hidden = true;
    $vrestart.hidden = true;
  };
  // Меню пишет через setS; наблюдаем rateUI без опроса и без зависимости от ui.js.
  let rateUI = S.rateUI;
  Object.defineProperty(S, 'rateUI', {enumerable: true, configurable: true,
    get: () => rateUI, set: value => { rateUI = value === true; if (V.open) vControls(); }});

  $vi.addEventListener('error', () => {
    if (V.open && $vi.getAttribute('src')) { clearTimeout(V.spinT); $vspin.hidden = true; hud('Cannot display this file', true); }
  });
  $vv.addEventListener('play', () => {
    if (!V.open || !V.vsrc || V.bad || $vv.paused) return;
    $vplay.classList.add('playing');
    V.watchAt = performance.now();
    cancelAnimationFrame(V.raf); V.raf = requestAnimationFrame(vTick);
  });
  $vv.addEventListener('playing', () => { if (V.open && V.vsrc && !V.bad) { V.playing = true; V.watchAt = performance.now(); } });
  $vv.addEventListener('waiting', () => { if (V.open && V.vsrc) { vWatch(); V.playing = false; } });
  $vv.addEventListener('seeking', () => { if (V.open && V.vsrc) vWatch(); });
  $vv.addEventListener('pause', () => {
    if (!V.open || !V.vsrc || !$vv.paused) return;
    vWatch(); V.playing = false;
    $vplay.classList.remove('playing'); vUi();
  });
  $vv.addEventListener('ended', vEnded);
  $vv.addEventListener('timeupdate', () => { if (V.open && V.vsrc && !V.bad) { vWatch(); vProgress(false); vUi(); } });
  $vv.addEventListener('loadedmetadata', vMetadata);
  $vv.addEventListener('loadeddata', () => { if (V.open && V.vsrc && $vv.readyState >= 2) clearTimeout(V.loadT); });
  $vv.addEventListener('error', () => { if ($vv.error) vCannotPlay(); });
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
  $v.addEventListener('mousemove', () => {
    if (V.open && !V.moveRaf) V.moveRaf = requestAnimationFrame(() => { V.moveRaf = 0; barShow(); });
  });
  addEventListener('pagehide', () => { if (V.open) { vWatch(); vProgress(true); } });

  // клик по картинке: закрыть (ждём 250 мс — вдруг двойной); в полном экране видео — play/pause, фото — ничего
  const stage = $('#vstage');
  stage.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    clearTimeout(V.clickT);
    if (e.target.closest('#vfallback')) return;
    if (vPhoto() && (VP.z > 1 || VP.moved)) { VP.moved = false; return; }
    if (fsOn) {
      const f = V.list[V.i];
      if (vVideo(f)) vToggle();
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
    if (!V.open) return;
    if (e.ctrlKey) {
      if (vPhoto() && e.deltaY) vZoom(VP.z * Math.exp(-clamp(e.deltaY, -100, 100) * 0.002), e.clientX, e.clientY);
      return;
    }
    const now = Date.now();
    if (now - V.wt < 120 || !e.deltaY) return;
    V.wt = now;
    vStep(e.deltaY > 0 ? 1 : -1);
  }, {passive: false});

  for (const media of [$vi, $vv]) media.addEventListener('contextmenu', e => {
    if (!V.open || !V.file) return;
    e.preventDefault();
    clearTimeout(V.clickT);
    if (typeof showCtxMenu === 'function') showCtxMenu(e.clientX, e.clientY, {type: 'file', f: V.file});
  });
  $vi.addEventListener('pointerdown', e => {
    if (!vPhoto() || VP.z <= 1 || e.button !== 0) return;
    clearTimeout(V.clickT);
    VP.moved = false;
    VP.drag = {id: e.pointerId, sx: e.clientX, sy: e.clientY, x: VP.x, y: VP.y};
    $vi.setPointerCapture(e.pointerId);
    $v.classList.add('panning');
    e.preventDefault();
  });
  const photoMove = e => {
    const d = VP.drag;
    if (!V.open || !d || e.pointerId !== d.id) return;
    VP.x = d.x + e.clientX - d.sx; VP.y = d.y + e.clientY - d.sy;
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) VP.moved = true;
    vPhotoSoon();
  };
  $vi.addEventListener('pointermove', photoMove);
  const photoEnd = e => {
    if (!VP.drag || e.pointerId !== VP.drag.id) return;
    photoMove(e);
    VP.drag = null;
    $v.classList.remove('panning');
    if ($vi.hasPointerCapture(e.pointerId)) $vi.releasePointerCapture(e.pointerId);
  };
  $vi.addEventListener('pointerup', photoEnd);
  $vi.addEventListener('pointercancel', photoEnd);
  $vi.addEventListener('lostpointercapture', () => { VP.drag = null; $v.classList.remove('panning'); });

  // шкала: перемотка и предпросмотр (работает и при перетаскивании)
  const seekAt = e => {
    const r = $vseek.getBoundingClientRect();
    vSeekTo(clamp((e.clientX - r.left) / r.width, 0, 1) * vDur());
  };
  $vseek.addEventListener('pointerenter', e => { storyNeed(0); pvMove(e); });
  $vseek.addEventListener('pointerdown', e => { $vseek.setPointerCapture(e.pointerId); V.drag = true; seekAt(e); pvMove(e); });
  let seekRaf = 0, seekX = 0;
  $vseek.addEventListener('pointermove', e => {
    if (!V.open) return;
    seekX = e.clientX;
    if (V.drag && !seekRaf) seekRaf = requestAnimationFrame(() => { seekRaf = 0; if (V.open && V.drag) seekAt({clientX: seekX}); });
    pvMove(e);
  });
  $vseek.addEventListener('pointerleave', () => { if (!V.drag) pvHide(); });
  const endDrag = e => {
    if (V.open && V.drag && e.type === 'pointerup') seekAt(e);
    cancelAnimationFrame(seekRaf); seekRaf = 0;
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
    if (!V.open) return;
    TLH.on = true;
    TLH.x = e.clientX;
    if (!TLH.raf) TLH.raf = requestAnimationFrame(tlHover);
  });
  $vtl.addEventListener('pointerleave', () => { TLH.on = false; $vtlt.hidden = true; });
  let rzRaf = 0;
  addEventListener('resize', () => {
    if (!V.open || rzRaf) return;
    rzRaf = requestAnimationFrame(() => {
      rzRaf = 0;
      if (!V.open) return;
      if (!$vtl.hidden) tlSize();
      if (vPhoto()) vPhotoDraw();
    });
  });
}
