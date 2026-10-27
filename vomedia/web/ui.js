'use strict';
// VO Media — Окна, меню, кеш, статус индексации, управление, запуск (init — в конце, файл грузится последним).
// Обычные скрипты грузятся по порядку core → grid → viewer → ui: общие const/let видны между файлами.

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

/* ───── окно Cache ───── */

let cacheT = 0, cacheBusy = false;
const CACHE_GB = [5, 10, 20, 50, 100, 0];

function cacheHtml(c) {
  const cur = c.current || {}, rdy = !!cur.ready;
  const sz = n => rdy ? esc(fmtSize(n || 0)) : '<span class="dim">counting…</span>';
  const cnt = n => rdy ? ' · ' + plural(n || 0, 'file', 'files') : '';
  const gbs = CACHE_GB.slice();
  if (gbs.indexOf(+c.limit_gb) < 0) gbs.push(+c.limit_gb || 0);
  const opts = gbs.map(g => '<option value="' + g + '"' + (g === (+c.limit_gb || 0) ? ' selected' : '') + '>' + (g ? g + ' GB' : 'Unlimited') + '</option>').join('');
  let h = '<h3>This folder</h3><div class="dim cpath" title="' + esc(cur.root || '') + '">' + esc(cur.root || '') + '</div><div class="cgrid">' +
    '<span>Thumbnails</span><span>' + sz(cur.thumbs) + esc(cnt(cur.n_thumbs)) + '</span>' +
    '<span>Storyboards</span><span>' + sz(cur.story) + esc(cnt(cur.n_story)) + '</span>' +
    '<span>Index (database)</span><span>' + sz(cur.db) + '</span>' +
    '<span>Cache limit</span><span><select id="climit" aria-label="Cache limit">' + opts + '</select></span></div>' +
    '<div class="cbtns"><button data-act="clear">Clear thumbnails</button><button data-act="reset" class="warn">Reset library cache</button></div>' +
    '<p class="dim cnote">Thumbnails of the least recently opened folders are removed automatically when the limit is exceeded. ' +
    'Caches of folders not opened for 90 days are removed at startup.</p><h3>Other folders</h3>';
  const oth = c.others || [];
  if (!oth.length) h += '<div class="dim">No other folders</div>';
  for (const o of oth) {
    h += '<div class="crow"><div class="cinfo"><div class="cpath" title="' + esc(o.root || '') + '">' + esc(o.root || o.key) + '</div><div class="dim">' +
      esc(fmtSize(o.bytes || 0)) + ' · ' + (o.opened ? 'last opened ' + esc(fmtDate(o.opened)) : 'never opened') +
      '</div></div><button data-act="remove" data-key="' + esc(o.key) + '">Remove</button></div>';
  }
  return h;
}
function cacheShow(c) {
  clearTimeout(cacheT);
  const box = $('#cachec');
  const keep = box.scrollTop;
  box.innerHTML = cacheHtml(c);
  box.scrollTop = keep;
  if (c.current && !c.current.ready) cacheT = setTimeout(cachePoll, 1500);     // размер ещё считается
}
async function cachePoll() {
  if ($('#ov').hidden || $('#cachep').hidden) return;
  try { cacheShow(await getJson(q('/api/cache'))); } catch (e) { cacheT = setTimeout(cachePoll, 3000); }
}
async function cacheOpen() {
  sheet('cachep');
  $('#cachec').textContent = 'Loading…';
  try { cacheShow(await getJson(q('/api/cache'))); } catch (e) { $('#cachec').textContent = ''; toast(e.message, true); }
}
// POST и перерисовка из ответа; ошибка — toast
async function cacheCall(path, body) {
  if (cacheBusy) return null;
  cacheBusy = true;
  $('#cachec').classList.add('busy');
  try {
    const c = await post(path, body);
    cacheShow(c);
    return c;
  } catch (e) {
    toast(e.message, true);
    cachePoll();
    return null;
  } finally {
    cacheBusy = false;
    $('#cachec').classList.remove('busy');
  }
}
// после очистки миниатюр: плитки видимой папки создают их заново
function thumbsCleared() {
  revokeObjs();
  gen.failed.clear();
  thumbErr.clear();
  const wipe = d => {
    if (!d) return;
    for (const f of (d.files || [])) f.thumb = 0;
    for (const x of (d.dirs || [])) x.thumbs = [];
  };
  wipe(D);
  if (pendingApply) wipe(pendingApply[0]);
  if (!$scroll) return;
  clearMounted();
  update();
}
async function cacheClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'clear') {
    if (!await ask('Delete all thumbnails and storyboards of this library? They are created again when needed.', 'Clear')) return;
    if (await cacheCall('/api/cache/clear', {})) thumbsCleared();
  } else if (act === 'reset') {
    if (!await ask('Delete the whole cache of this library, including the index of all folders and files, and start a full rescan? On a big library on a network drive the rescan can take a long time. Nothing on your disk is deleted.', 'Reset')) return;
    try {
      await flushS();                 // до сброса: отложенная запись настроек
      frozen = true;
      await post('/api/cache/reset', {});
      location.reload();
    } catch (err) {
      frozen = false;
      toast('Cannot reset the cache: ' + err.message, true);
    }
  } else if (act === 'remove') {
    const row = b.closest('.crow'), name = row ? row.querySelector('.cpath').textContent : '';
    if (!await ask('Delete the cache of ' + name + '? It will be built again the next time that folder is opened.', 'Remove')) return;
    await cacheCall('/api/cache/remove', {key: b.dataset.key});
  }
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
  $('#mcache').onclick = cacheOpen;
  $('#cclose').onclick = closeSheet;
  $('#cachec').addEventListener('click', cacheClick);
  $('#cachec').addEventListener('change', e => {
    if (e.target.id === 'climit') cacheCall('/api/cache/limit', {gb: +e.target.value});
  });
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
