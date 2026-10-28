"""Кеш библиотеки в SQLite: обход NAS, агрегаты по папкам, фоновые нити, миниатюры.

Страница обслуживается только из кеша; NAS читают лишь refresh_dir (одна папка)
и фоновые нити, которые уступают пользователю (touch()).
"""
import contextlib
import hashlib
import logging
import os
import re
import shutil
import sqlite3
import sys
import threading
import time
from collections import deque

from . import meta

log = logging.getLogger('vomedia')

IS_WIN = sys.platform == 'win32'
REPARSE = 0x400                 # FILE_ATTRIBUTE_REPARSE_POINT (junction, symlink)
SCHEMA = '1'
YIELD = 1.5                     # на сколько секунд фоновые нити уступают после touch()
META_BATCH = 200                # файлов за выборку для нити метаданных
META_FLUSH = 25                 # сколько результатов копить до записи
MAX_THUMB = 512 * 1024
MAX_STORY = 4 * 1024 * 1024        # раскадровка видео (спрайт 6×5 кадров)
THUMB_PX = '800'                # размер миниатюр; сменился — старые сбрасываются
JANITOR_EVERY = 600             # как часто (с) проверять лимит места кеша
MAX_ERRORS = 30                 # подряд ошибок папок — считаем, что NAS недоступна
SKIP_NAMES = frozenset({'system volume information', '_to_delete', '_на_удаление'})
KIND_PHOTO, KIND_VIDEO = 1, 2
MAX_PROGRESS = 20000            # строк в progress (лишние — самые старые по ts)
PROGRESS_MIN = 10               # позиция меньше — «не смотрели», строка удаляется
PROGRESS_END = 5                # до конца меньше — «досмотрено», pos = dur


def _exts_key(photo, video):
    return 'photo:%s;video:%s' % (','.join(sorted(photo)), ','.join(sorted(video)))


def _key_exts(key):
    """Множество расширений из строки _exts_key."""
    out = set()
    for part in (key or '').split(';'):
        out.update(x for x in part.partition(':')[2].split(',') if x)
    return out


EXTS = _exts_key(meta.PHOTO_EXT, meta.VIDEO_EXT)    # набор расширений; сменился — первый обход полный
EXTS_V01 = _exts_key({'.jpg', '.jpeg', '.png', '.webp', '.gif'}, {'.mp4', '.m4v'})  # кеш без meta_kv.exts

DDL = """
CREATE TABLE IF NOT EXISTS meta_kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS dirs(
  id INTEGER PRIMARY KEY, parent INTEGER,
  rel TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL, mtime REAL,
  listed REAL,
  own_photo INTEGER DEFAULT 0, own_video INTEGER DEFAULT 0, own_size INTEGER DEFAULT 0,
  n_photo INTEGER DEFAULT 0, n_video INTEGER DEFAULT 0, size INTEGER DEFAULT 0,
  n_dirs INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS dirs_parent ON dirs(parent);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY, dir INTEGER NOT NULL, name TEXT NOT NULL,
  kind INTEGER NOT NULL,
  size INTEGER, mtime REAL,
  w INTEGER, h INTEGER, duration REAL, rot INTEGER,
  meta INTEGER DEFAULT 0,
  thumb INTEGER DEFAULT 0,
  UNIQUE(dir, name));
CREATE INDEX IF NOT EXISTS files_meta ON files(meta) WHERE meta = 0;
CREATE INDEX IF NOT EXISTS files_thumb ON files(dir) WHERE thumb = 1;
CREATE TABLE IF NOT EXISTS progress(id INTEGER PRIMARY KEY, pos REAL, dur REAL, ts REAL);
CREATE INDEX IF NOT EXISTS progress_ts ON progress(ts);
"""

# колонки files, которые добавлены после v0.1 (ALTER TABLE), и индексы по ним
FILES_V02 = """
CREATE INDEX IF NOT EXISTS files_lname ON files(lname);
CREATE INDEX IF NOT EXISTS files_first_seen ON files(first_seen) WHERE first_seen > 0;
"""
# столбцы файла для страницы (f — files, p — progress через LEFT JOIN), порядок — как в _file_obj
FCOLS = 'f.id, f.name, f.kind, f.size, f.mtime, f.w, f.h, f.duration, f.thumb, p.pos'


# ─── где лежит кеш ───

def app_dir():
    """Папка данных программы (создаётся при первом обращении)."""
    p = os.environ.get('VOMEDIA_HOME')
    if not p:
        if IS_WIN:
            p = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), 'VO Media')
        elif sys.platform == 'darwin':
            p = os.path.expanduser('~/Library/Application Support/VO Media')
        else:
            base = os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
            p = os.path.join(base, 'vo-media')
    os.makedirs(p, exist_ok=True)
    return p


def cache_dir(root):
    """Папка кеша для данной библиотеки: <app_dir>/cache/<sha1 пути>."""
    key = os.path.normcase(os.path.abspath(root))
    h = hashlib.sha1(key.encode('utf-8', 'replace')).hexdigest()[:16]
    return os.path.join(app_dir(), 'cache', h)


# ─── разбор папки ───

def skip_dir(name):
    """Папки, которые обход не трогает (служебные, корзины)."""
    return name[:1] in ('.', '@', '#', '$') or name.lower() in SKIP_NAMES


def _is_reparse(entry):
    """Junction/точка повторной обработки в Windows (symlink отсекает is_dir(follow_symlinks=False))."""
    if not IS_WIN:
        return False
    try:
        return bool(entry.stat(follow_symlinks=False).st_file_attributes & REPARSE)
    except (OSError, AttributeError):
        return False


def _encodable(name):
    try:
        name.encode('utf-8')
        return True
    except UnicodeEncodeError:
        return False


def list_folder(path):
    """Прочитать одну папку: (имена подпапок, {имя: (kind, size, mtime)}). На Windows stat файлов берётся из списка."""
    subs = []
    files = {}
    with os.scandir(path) as it:
        for e in it:
            name = e.name
            try:
                if e.is_dir(follow_symlinks=False):
                    if not skip_dir(name) and _encodable(name) and not _is_reparse(e):
                        subs.append(name)
                    continue
                if name[:1] == '.':
                    continue
                k = meta.kind_of(name)
                if k is None or not _encodable(name) or not e.is_file():
                    continue
                st = e.stat()
                files[name] = (KIND_PHOTO if k == 'photo' else KIND_VIDEO, st.st_size, st.st_mtime)
            except OSError:
                continue
    return subs, files


def long_path(p):
    """Windows: путь длиннее MAX_PATH — с префиксом \\\\?\\ (иначе FileNotFoundError, хотя файл есть)."""
    if not IS_WIN or len(p) < 240 or p.startswith('\\\\?\\'):
        return p
    p = os.path.normpath(p)             # префикс \\?\ не понимает '/' и '..'
    if p.startswith('\\\\'):
        return '\\\\?\\UNC\\' + p[2:]
    return '\\\\?\\' + p


def _nat(s):
    """Ключ естественной сортировки имён: 'img2' < 'img10'."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', s)]


def _root_name(root):
    return os.path.basename(root.rstrip('/\\')) or root


def _lower(s):
    """lower() Python для SQL (кириллица; встроенный lower() SQLite знает только ASCII)."""
    return s.lower() if isinstance(s, str) else s


def _file_obj(r):
    """Объект файла для страницы из строки, начинающейся со столбцов FCOLS."""
    return {'id': r[0], 'name': r[1], 'kind': 'photo' if r[2] == KIND_PHOTO else 'video',
            'size': r[3], 'mtime': r[4], 'w': r[5], 'h': r[6], 'duration': r[7], 'thumb': r[8], 'pos': r[9]}


def _like_word(w):
    """Слово запроса → шаблон LIKE '%слово%' с экранированием % _ и \\."""
    return '%' + w.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'


class Library(object):
    """Кеш одной открытой папки. Потокобезопасен: соединение на нить, запись под wlock."""

    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.root_name = _root_name(self.root)
        self.cache = cache_dir(self.root)
        self.thumbs_dir = os.path.join(self.cache, 'thumbs')
        self.story_dir = os.path.join(self.cache, 'story')
        os.makedirs(self.thumbs_dir, exist_ok=True)
        self.db_path = os.path.join(self.cache, 'library.sqlite')

        self.wlock = threading.RLock()
        self._local = threading.local()
        self._conns = {}                    # ident нити -> соединение (для close() и чистки)
        self._clock = threading.Lock()
        self._closed = False
        self._touched = time.monotonic() - 10 * YIELD
        self._prio = []                     # последние prioritize(): rel
        self._plock = threading.Lock()

        # обход
        self._ixlock = threading.Lock()
        self._ix = None
        self._ix_running = False
        self._stop_ix = threading.Event()
        self._st = {'full': False, 'dirs': 0, 'listed': 0, 'current': '',
                    'started': None, 'finished': None, 'error': ''}
        # метаданные
        self._meta_event = threading.Event()
        self._meta_thread = None
        # first_seen = 0 для новых строк: 'all' — полного обхода ещё не было (иначе при первом запуске
        # всё «новое»); иначе — расширения, добавленные после прошлого полного обхода (уже лежавшие mkv/webm)
        self._fs_zero = frozenset()
        # место кеша: байты миниатюр и раскадровок (считает нить janitor, дальше — на ходу)
        self.cache_limit = 0                # байт; 0 — без лимита (задаёт app.py)
        self._bytes = {'thumbs': 0, 'story': 0, 'n_thumbs': 0, 'n_story': 0, 'ready': False}
        self._blk = threading.Lock()
        self._jan_event = threading.Event()

        self._init_db()
        self._meta_event.set()
        self._meta_thread = threading.Thread(target=self._meta_main, name='vomedia-meta', daemon=True)
        self._meta_thread.start()
        self._jan_thread = threading.Thread(target=self._janitor, name='vomedia-cache', daemon=True)
        self._jan_thread.start()

    # ─── соединения и транзакции ───

    def _connect(self):
        c = sqlite3.connect(self.db_path, timeout=30, check_same_thread=False, isolation_level=None)
        try:
            c.create_function('pylower', 1, _lower, deterministic=True)
        except (TypeError, sqlite3.NotSupportedError):     # старый SQLite без deterministic
            c.create_function('pylower', 1, _lower)
        c.execute('PRAGMA synchronous=NORMAL')
        c.execute('PRAGMA cache_size=-20000')
        return c

    def _db(self):
        """Соединение текущей нити (создаётся при первом обращении)."""
        c = getattr(self._local, 'c', None)
        if c is None:
            if self._closed:
                raise sqlite3.ProgrammingError('library is closed')
            c = self._connect()
            self._local.c = c
            with self._clock:
                self._conns[threading.get_ident()] = c
                if len(self._conns) > 16:       # нити HTTP умирают: закрываем их соединения
                    alive = set(t.ident for t in threading.enumerate())
                    for ident in list(self._conns):
                        if ident not in alive:
                            try:
                                self._conns.pop(ident).close()
                            except Exception:
                                pass
        return c

    @contextlib.contextmanager
    def _tx(self):
        """Короткая транзакция записи под wlock (не вкладывать)."""
        with self.wlock:
            c = self._db()
            c.execute('BEGIN IMMEDIATE')
            try:
                yield c
                c.execute('COMMIT')
            except BaseException:
                try:
                    c.execute('ROLLBACK')
                except sqlite3.Error:
                    pass
                raise

    def _init_db(self):
        with self.wlock:
            c = self._db()
            c.execute('PRAGMA journal_mode=WAL')
            c.execute('CREATE TABLE IF NOT EXISTS meta_kv(k TEXT PRIMARY KEY, v TEXT)')
            r = c.execute("SELECT v FROM meta_kv WHERE k='schema'").fetchone()
            if r and r[0] != SCHEMA:
                log.warning('Cache schema %s != %s, rebuilding', r[0], SCHEMA)
                c.executescript('DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS dirs; DROP TABLE IF EXISTS progress; '
                                'DELETE FROM meta_kv;')
                shutil.rmtree(self.thumbs_dir, ignore_errors=True)
                os.makedirs(self.thumbs_dir, exist_ok=True)
            c.executescript(DDL)
            if 'seen' not in [r[1] for r in c.execute('PRAGMA table_info(dirs)')]:
                c.execute('ALTER TABLE dirs ADD COLUMN seen REAL')     # когда папку последний раз открывали
            gif_fix = self._migrate_v02(c)
            r = c.execute("SELECT v FROM meta_kv WHERE k='opened'").fetchone()
            if r:                                                       # для /api/new?since=last
                c.execute("INSERT OR REPLACE INTO meta_kv(k, v) VALUES('prev_opened', ?)", (r[0],))
            c.execute("INSERT OR REPLACE INTO meta_kv(k, v) VALUES('opened', ?)", (str(time.time()),))
            c.execute("INSERT OR REPLACE INTO meta_kv(k, v) VALUES('schema', ?)", (SCHEMA,))
            c.execute("INSERT OR REPLACE INTO meta_kv(k, v) VALUES('root', ?)", (self.root,))
            c.execute("INSERT OR IGNORE INTO dirs(id, parent, rel, name) VALUES(1, NULL, '', ?)", (self.root_name,))
            c.execute("UPDATE dirs SET name=? WHERE id=1", (self.root_name,))
            r = c.execute("SELECT v FROM meta_kv WHERE k='thumb_px'").fetchone()
            if not r or r[0] != THUMB_PX:       # миниатюры другого размера: сбросить, страница сделает новые
                c.execute('UPDATE files SET thumb=0 WHERE thumb=1')
                shutil.rmtree(self.thumbs_dir, ignore_errors=True)
                shutil.rmtree(self.story_dir, ignore_errors=True)
                os.makedirs(self.thumbs_dir, exist_ok=True)
                c.execute("INSERT OR REPLACE INTO meta_kv(k, v) VALUES('thumb_px', ?)", (THUMB_PX,))
            self._fs_zero = self._zero_exts(c)
        if gif_fix:
            self.recompute_totals()
            with self._tx() as c:
                c.execute("INSERT OR REPLACE INTO meta_kv(k, v) VALUES('gif_video', '1')")

    def _migrate_v02(self, c):
        """Колонки v0.2 (lname, first_seen) и перевод GIF в видео. Вернуть True, если нужен пересчёт итогов."""
        cols = [r[1] for r in c.execute('PRAGMA table_info(files)')]
        if 'lname' not in cols or 'first_seen' not in cols:
            t = time.monotonic()
            n = c.execute('SELECT COUNT(*) FROM files').fetchone()[0]
            c.execute('BEGIN IMMEDIATE')
            try:
                if 'lname' not in cols:
                    c.execute('ALTER TABLE files ADD COLUMN lname TEXT')
                    c.execute('UPDATE files SET lname=pylower(name)')
                if 'first_seen' not in cols:            # прежние строки — не «новые»
                    c.execute('ALTER TABLE files ADD COLUMN first_seen REAL DEFAULT 0')
                c.execute('COMMIT')
            except BaseException:
                c.execute('ROLLBACK')
                raise
            if n:
                log.info('Cache upgraded for v0.2 (%d files) in %.1f s', n, time.monotonic() - t)
        c.executescript(FILES_V02)
        if c.execute("SELECT v FROM meta_kv WHERE k='gif_video'").fetchone():
            return False
        # GIF стал видео: kind=2, метаданные перечитать (длительность); own_* всех папок — заново из files.
        # Флаг gif_video ставится после recompute_totals() (в _init_db): прервались — повторится, это безопасно
        c.execute('BEGIN IMMEDIATE')
        try:
            n = c.execute("UPDATE files SET kind=?, meta=0 WHERE lname LIKE '%.gif' AND kind<>?",
                          (KIND_VIDEO, KIND_VIDEO)).rowcount
            c.execute('UPDATE dirs SET '
                      'own_photo=(SELECT COUNT(*) FROM files f WHERE f.dir=dirs.id AND f.kind=?), '
                      'own_video=(SELECT COUNT(*) FROM files f WHERE f.dir=dirs.id AND f.kind=?), '
                      'own_size=(SELECT IFNULL(SUM(f.size), 0) FROM files f WHERE f.dir=dirs.id)',
                      (KIND_PHOTO, KIND_VIDEO))
            c.execute('COMMIT')
        except BaseException:
            c.execute('ROLLBACK')
            raise
        if n:
            log.info('%d GIF files are now videos', n)
        return True

    def _zero_exts(self, c):
        """Значение для self._fs_zero по состоянию кеша (см. __init__)."""
        if not c.execute("SELECT 1 FROM meta_kv WHERE k='full_done'").fetchone():
            return 'all'
        r = c.execute("SELECT v FROM meta_kv WHERE k='exts'").fetchone()
        return frozenset(_key_exts(EXTS) - _key_exts(r[0] if r else EXTS_V01))

    def _first_seen(self, name, now):
        """first_seen для новой строки файла."""
        z = self._fs_zero
        if z == 'all' or (z and os.path.splitext(name)[1].lower() in z):
            return 0
        return now

    def _kv_get(self, k):
        r = self._db().execute('SELECT v FROM meta_kv WHERE k=?', (k,)).fetchone()
        return r[0] if r else None

    def close(self):
        """Остановить нити и закрыть соединения."""
        if self._closed:
            return
        self._closed = True
        self._stop_ix.set()
        self._meta_event.set()
        self._jan_event.set()
        me = threading.current_thread()
        for t in (self._ix, self._meta_thread, self._jan_thread):
            if t is not None and t is not me and t.is_alive():
                t.join(5)
        with self._clock:
            conns = list(self._conns.values())
            self._conns.clear()
        for c in conns:
            try:
                c.close()
            except Exception:
                pass

    # ─── пути ───

    @staticmethod
    def _norm(rel):
        return (rel or '').strip('/')

    def _abs(self, rel, name=None):
        p = os.path.join(self.root, *rel.split('/')) if rel else self.root
        return long_path(os.path.join(p, name) if name else p)

    def thumb_file(self, fid):
        return os.path.join(self.thumbs_dir, '%02x' % (fid % 256), '%d.jpg' % fid)

    def story_file(self, fid):
        return os.path.join(self.story_dir, '%02x' % (fid % 256), '%d.jpg' % fid)

    def _count(self, kind, d_bytes, d_n):
        with self._blk:
            self._bytes[kind] += d_bytes
            self._bytes['n_' + kind] += d_n

    def _remove(self, kind, path):
        """Удалить файл кеша и поправить счётчик места."""
        try:
            n = os.path.getsize(path)
            os.remove(path)
        except OSError:
            return
        self._count(kind, -n, -1)

    def _unlink_thumbs(self, ids):
        """Удалить миниатюры и раскадровки файлов (изменились или исчезли)."""
        for fid in ids:
            self._remove('thumbs', self.thumb_file(fid))
            self._remove('story', self.story_file(fid))

    # ─── чтение для страницы (только кеш) ───

    def _dir_thumbs(self, c, did, rel, total):
        """До 4 id миниатюр: из самой папки, добор из поддерева (диапазон по rel, без LIKE)."""
        if not total:
            return []
        ids = [[r[0], r[1]] for r in c.execute('SELECT id, mtime FROM files WHERE dir=? AND thumb=1 LIMIT 4', (did,))]
        if len(ids) < 4:
            for r in c.execute('SELECT f.id, f.mtime FROM dirs d CROSS JOIN files f ON f.dir=d.id '
                               'WHERE d.rel>=? AND d.rel<? AND f.thumb=1 LIMIT ?',
                               (rel + '/', rel + '0', 4 - len(ids))):
                ids.append([r[0], r[1]])
        return ids

    DCOLS = 'id, rel, name, n_photo, n_video, size, n_dirs, mtime, listed'

    def _dir_item(self, c, r):
        """Объект папки для страницы из строки DCOLS."""
        sid, rel, name, n_p, n_v, size, n_d, mt, li = r
        return {'rel': rel, 'name': name, 'n_photo': n_p, 'n_video': n_v, 'size': size,
                'n_dirs': n_d, 'mtime': mt, 'listed': li,
                'thumbs': self._dir_thumbs(c, sid, rel, n_p + n_v)}

    def _dir_items(self, c, did):
        rows = c.execute('SELECT ' + self.DCOLS + ' FROM dirs WHERE parent=? ORDER BY name', (did,)).fetchall()
        return [self._dir_item(c, r) for r in rows]

    def list_dir(self, rel):
        rel = self._norm(rel)
        c = self._db()
        r = c.execute('SELECT id, name, mtime, listed FROM dirs WHERE rel=?', (rel,)).fetchone()
        if r is None:
            return None
        did, name, mtime, listed = r
        parts = rel.split('/') if rel else []
        parents = []
        if parts:
            parents.append({'rel': '', 'name': self.root_name})
            for i in range(1, len(parts)):
                parents.append({'rel': '/'.join(parts[:i]), 'name': parts[i - 1]})
        files = [_file_obj(r) for r in c.execute(
            'SELECT ' + FCOLS + ' FROM files f LEFT JOIN progress p ON p.id=f.id WHERE f.dir=? ORDER BY f.name',
            (did,))]
        # pending — файлы, у которых фоновый поток ещё не прочитал размеры/длительность: страница дочитает их опросом
        pending = c.execute('SELECT COUNT(*) FROM files WHERE dir=? AND meta=0', (did,)).fetchone()[0]
        return {'rel': rel, 'name': name, 'listed': listed, 'mtime': mtime, 'parents': parents,
                'dirs': self._dir_items(c, did), 'files': files, 'pending': pending}

    def subdirs(self, rel):
        rel = self._norm(rel)
        c = self._db()
        r = c.execute('SELECT id FROM dirs WHERE rel=?', (rel,)).fetchone()
        if r is None:
            return None
        return self._dir_items(c, r[0])

    def file_path(self, fid):
        r = self._db().execute('SELECT d.rel, f.name FROM files f JOIN dirs d ON d.id=f.dir WHERE f.id=?',
                               (fid,)).fetchone()
        if r is None:
            return None
        return self._abs(r[0], r[1])

    def file_row(self, fid):
        r = self._db().execute('SELECT d.rel, f.name, f.kind, f.size, f.mtime FROM files f '
                               'JOIN dirs d ON d.id=f.dir WHERE f.id=?', (fid,)).fetchone()
        if r is None:
            return None
        return {'id': fid, 'name': r[1], 'kind': 'photo' if r[2] == KIND_PHOTO else 'video',
                'size': r[3], 'mtime': r[4], 'path': self._abs(r[0], r[1])}

    # ─── поиск, плоский вид, новое (только кеш) ───

    def search(self, q, limit=500):
        """Файлы и папки, в имени которых есть все слова q (без учёта регистра, кириллица тоже).

        Файлы — по индексу lname в порядке имени, пока не наберётся limit; папки — перебором имён (их на порядки меньше).
        """
        words = [w for w in _lower(q or '').split() if w]
        if not words:
            return {'q': q, 'files': [], 'dirs': [], 'truncated': False}
        c = self._db()
        where = ' AND '.join(["f.lname LIKE ? ESCAPE '\\'"] * len(words))
        rows = c.execute('SELECT ' + FCOLS + ', d.rel FROM files f CROSS JOIN dirs d ON d.id=f.dir '
                         'LEFT JOIN progress p ON p.id=f.id WHERE ' + where + ' ORDER BY f.lname, f.id LIMIT ?',
                         [_like_word(w) for w in words] + [limit + 1]).fetchall()
        files = []
        for r in rows[:limit]:
            o = _file_obj(r)
            o['rel'] = r[10]
            files.append(o)
        drows = []
        for r in c.execute('SELECT ' + self.DCOLS + ' FROM dirs WHERE id<>1'):
            ln = r[2].lower()
            if all(w in ln for w in words):
                drows.append(r)
        drows.sort(key=lambda r: (r[2].lower(), r[1]))
        dirs = [self._dir_item(c, r) for r in drows[:limit]]
        return {'q': q, 'files': files, 'dirs': dirs, 'truncated': len(rows) > limit or len(drows) > limit}

    FLAT_SORT = {'name': 'f.lname', 'date': 'f.mtime', 'size': 'f.size',
                 'duration': 'CASE WHEN f.kind=%d THEN 0 ELSE f.duration END' % KIND_PHOTO}

    def flat(self, rel, sort='name', desc=False, filt='all', offset=0, limit=5000):
        """Все файлы папки и её подпапок (из кеша) одной страницей offset/limit с сортировкой на сервере.
        None — папки нет в кеше."""
        rel = self._norm(rel)
        c = self._db()
        if c.execute('SELECT 1 FROM dirs WHERE rel=?', (rel,)).fetchone() is None:
            return None
        cond, args = [], []
        if rel:                                         # поддерево — диапазон по rel, как в _drop_subtree
            cond.append('(d.rel=? OR (d.rel>=? AND d.rel<?))')
            args += [rel, rel + '/', rel + '0']
        if filt in ('photo', 'video'):
            cond.append('f.kind=?')
            args.append(KIND_PHOTO if filt == 'photo' else KIND_VIDEO)
        where = (' WHERE ' + ' AND '.join(cond)) if cond else ''
        # в корне — только files (порядок по имени берётся из индекса lname), в поддереве — от dirs по диапазону rel
        src = 'files f' if not rel else 'dirs d CROSS JOIN files f ON f.dir=d.id'
        total = c.execute('SELECT COUNT(*) FROM ' + src + where, args).fetchone()[0]
        key = self.FLAT_SORT.get(sort, 'f.lname')
        order = ' ORDER BY %s%s, f.lname, f.id' % (key, ' DESC' if desc else '')
        if sort == 'duration':                          # неизвестная длительность — в конце при любом направлении
            order = ' ORDER BY %s IS NULL,%s' % (key, order[9:])
        # страница id — без соединения с progress (OFFSET пропускает строки дёшево), потом сами строки
        ids = [r[0] for r in c.execute('SELECT f.id FROM ' + src + where + order + ' LIMIT ? OFFSET ?',
                                       args + [limit, offset])]
        rows = {}
        for i in range(0, len(ids), 500):
            part = ids[i:i + 500]
            for r in c.execute('SELECT ' + FCOLS + ', d.rel FROM files f CROSS JOIN dirs d ON d.id=f.dir '
                               'LEFT JOIN progress p ON p.id=f.id WHERE f.id IN (%s)' % ','.join('?' * len(part)),
                               part):
                rows[r[0]] = r
        files = []
        for fid in ids:
            r = rows.get(fid)
            if r is not None:
                o = _file_obj(r)
                o['rel'] = r[10]
                files.append(o)
        return {'rel': rel, 'total': total, 'offset': offset, 'files': files}

    def new_files(self, since, limit=5000):
        """Файлы, впервые увиденные после since ('last' — прошлое открытие библиотеки, или число дней)."""
        now = time.time()
        if since == 'last':
            try:
                ts = float(self._kv_get('prev_opened') or 0)
            except ValueError:
                ts = 0
            if ts <= 0:
                ts = now - 7 * 86400
        else:
            ts = now - float(since) * 86400
        c = self._db()
        # first_seen > 0 в условии — чтобы SQLite взял частичный индекс files_first_seen
        where = ' WHERE f.first_seen > 0 AND f.first_seen > ?'
        total = c.execute('SELECT COUNT(*) FROM files f' + where, (ts,)).fetchone()[0]
        rows = c.execute('SELECT ' + FCOLS + ', d.rel FROM files f CROSS JOIN dirs d ON d.id=f.dir '
                         'LEFT JOIN progress p ON p.id=f.id' + where + ' ORDER BY f.first_seen DESC, f.id DESC LIMIT ?',
                         (ts, limit)).fetchall()
        files = []
        for r in rows:
            o = _file_obj(r)
            o['rel'] = r[10]
            files.append(o)
        return {'since': ts, 'total': total, 'files': files}

    # ─── позиция просмотра видео ───

    def save_progress(self, fid, pos, dur):
        """Запомнить позицию: pos < 10 — удалить (не смотрели), почти до конца — pos = dur. False — файла нет."""
        with self._tx() as c:
            r = c.execute('SELECT duration FROM files WHERE id=?', (fid,)).fetchone()
            if r is None:
                return False
            if not dur or dur <= 0:
                dur = r[0]
            if pos < PROGRESS_MIN:
                c.execute('DELETE FROM progress WHERE id=?', (fid,))
                return True
            if dur and pos >= dur - PROGRESS_END:
                pos = dur
            c.execute('INSERT OR REPLACE INTO progress(id, pos, dur, ts) VALUES(?, ?, ?, ?)',
                      (fid, pos, dur, time.time()))
            extra = c.execute('SELECT COUNT(*) FROM progress').fetchone()[0] - MAX_PROGRESS
            if extra > 0:
                c.execute('DELETE FROM progress WHERE id IN (SELECT id FROM progress ORDER BY ts LIMIT ?)', (extra,))
        return True

    # ─── переименование (файл уже переименован files.py) ───

    def file_renamed(self, fid, new_name):
        """Поправить кеш после os.rename файла в той же папке: id, миниатюра и позиция сохраняются.

        Новое имя не медиа (или его пропустил бы обход) — строка удаляется, итоги папки поправляются, вернуть None.
        Иначе — объект файла, как в list_dir. None и если id нет в кеше.
        """
        k = meta.kind_of(new_name)
        keep = k is not None and new_name[:1] != '.' and _encodable(new_name) and '/' not in new_name \
            and '\\' not in new_name
        kind = KIND_PHOTO if k == 'photo' else KIND_VIDEO
        unlink = []
        with self._tx() as c:
            r = c.execute('SELECT dir, name, kind, size FROM files WHERE id=?', (fid,)).fetchone()
            if r is None:
                return None
            did, old_name, o_kind, size = r
            size = size or 0
            # строка с таким именем уже есть (файл заменён переименованием) — её больше нет на диске
            gone = [(x[0], x[1], x[2] or 0) for x in c.execute(
                'SELECT id, kind, size FROM files WHERE dir=? AND name=? AND id<>?', (did, new_name, fid))]
            if not keep:
                gone.append((fid, o_kind, size))
            d_p = d_v = d_s = 0
            for gid, gk, gs in gone:
                c.execute('DELETE FROM files WHERE id=?', (gid,))
                c.execute('DELETE FROM progress WHERE id=?', (gid,))
                unlink.append(gid)
                if gk == KIND_PHOTO:
                    d_p -= 1
                else:
                    d_v -= 1
                d_s -= gs
            if keep:
                ext_changed = os.path.splitext(old_name)[1].lower() != os.path.splitext(new_name)[1].lower()
                # другое расширение — другой разборщик заголовка: метаданные перечитать (миниатюра та же)
                c.execute('UPDATE files SET name=?, lname=?, kind=?, meta=CASE WHEN ? THEN 0 ELSE meta END '
                          'WHERE id=?', (new_name, new_name.lower(), kind, ext_changed, fid))
                if kind != o_kind:
                    d_p += 1 if kind == KIND_PHOTO else -1
                    d_v += 1 if kind == KIND_VIDEO else -1
            if d_p or d_v or d_s:
                c.execute('UPDATE dirs SET own_photo=own_photo+?, own_video=own_video+?, own_size=own_size+? '
                          'WHERE id=?', (d_p, d_v, d_s, did))
                self._bump(c, did, d_p, d_v, d_s)
            row = None
            if keep:
                row = c.execute('SELECT ' + FCOLS + ' FROM files f LEFT JOIN progress p ON p.id=f.id WHERE f.id=?',
                                (fid,)).fetchone()
        self._unlink_thumbs(unlink)
        if keep:
            self._meta_event.set()
            return _file_obj(row)
        return None

    # ─── слияние списка папки с кешем ───

    def _bump(self, c, did, d_p, d_v, d_s):
        """Прибавить разницу итогов к папке и всем её предкам."""
        if not (d_p or d_v or d_s):
            return
        while did is not None:
            c.execute('UPDATE dirs SET n_photo=n_photo+?, n_video=n_video+?, size=size+? WHERE id=?',
                      (d_p, d_v, d_s, did))
            r = c.execute('SELECT parent FROM dirs WHERE id=?', (did,)).fetchone()
            did = r[0] if r else None

    def _drop_subtree(self, c, did, rel):
        """Удалить папку и всё поддерево (rel с префиксом 'rel/' — диапазон по индексу, без LIKE).
        Вернуть id файлов, у которых были миниатюры."""
        args = (rel, rel + '/', rel + '0')
        tids = [r[0] for r in c.execute(
            'SELECT f.id FROM dirs d CROSS JOIN files f ON f.dir=d.id '
            'WHERE f.thumb=1 AND (d.rel=? OR (d.rel>=? AND d.rel<?))', args)]
        c.execute('DELETE FROM progress WHERE id IN (SELECT f.id FROM dirs d CROSS JOIN files f ON f.dir=d.id '
                  'WHERE d.rel=? OR (d.rel>=? AND d.rel<?))', args)
        c.execute('DELETE FROM files WHERE dir IN (SELECT id FROM dirs WHERE rel=? OR (rel>=? AND rel<?))', args)
        c.execute('DELETE FROM dirs WHERE rel=? OR (rel>=? AND rel<?)', args)
        return tids

    def _ensure(self, c, rel):
        """id папки; если её нет в кеше — добавить цепочку предков (listed=NULL). None — путь в пропускаемых."""
        r = c.execute('SELECT id FROM dirs WHERE rel=?', (rel,)).fetchone()
        if r:
            return r[0]
        pid = 1
        cur = ''
        for p in rel.split('/'):
            cur = cur + '/' + p if cur else p
            r = c.execute('SELECT id FROM dirs WHERE rel=?', (cur,)).fetchone()
            if r:
                pid = r[0]
                continue
            if skip_dir(p):
                return None
            pid = self._add_dir(c, pid, cur, p)
        return pid

    def _add_dir(self, c, parent, rel, name):
        cur = c.execute('INSERT INTO dirs(parent, rel, name) VALUES(?, ?, ?)', (parent, rel, name))
        c.execute('UPDATE dirs SET n_dirs=n_dirs+1 WHERE id=?', (parent,))
        return cur.lastrowid

    def _apply(self, c, did, dmtime, subs, files):
        """Слить прочитанный список папки с кешем (внутри транзакции).
        Вернуть (изменилось, id файлов для удаления миниатюр, есть новые/изменённые файлы) или None, если папки уже нет."""
        row = c.execute('SELECT rel, own_photo, own_video, own_size, listed FROM dirs WHERE id=?', (did,)).fetchone()
        if row is None:
            return None
        rel, o_p, o_v, o_s, listed = row
        changed = listed is None
        unlink = []

        # файлы: сопоставление по имени, id сохраняются
        old = {}
        for fid, name, kind, size, mt, th in c.execute(
                'SELECT id, name, kind, size, mtime, thumb FROM files WHERE dir=?', (did,)):
            old[name] = (fid, kind, size, mt, th)
        ins, upd = [], []
        n_p = n_v = total = 0
        now = time.time()
        for name, (kind, size, mt) in files.items():
            if kind == KIND_PHOTO:
                n_p += 1
            else:
                n_v += 1
            total += size
            o = old.pop(name, None)
            if o is None:
                ins.append((did, name, kind, size, mt, name.lower(), self._first_seen(name, now)))
            elif o[1] != kind or o[2] != size or o[3] is None or abs(o[3] - mt) > 0.001:
                upd.append((kind, size, mt, o[0]))
                unlink.append(o[0])
        gone = []
        for o in old.values():
            gone.append((o[0],))
            unlink.append(o[0])
        if ins:
            c.executemany('INSERT INTO files(dir, name, kind, size, mtime, lname, first_seen) '
                          'VALUES(?, ?, ?, ?, ?, ?, ?)', ins)
        if upd:
            c.executemany('UPDATE files SET kind=?, size=?, mtime=?, w=NULL, h=NULL, duration=NULL, rot=NULL, '
                          'meta=0, thumb=0 WHERE id=?', upd)
            c.executemany('DELETE FROM progress WHERE id=?', [(u[3],) for u in upd])
        if gone:
            c.executemany('DELETE FROM files WHERE id=?', gone)
            c.executemany('DELETE FROM progress WHERE id=?', gone)
        if ins or upd or gone:
            changed = True

        # подпапки
        d_p, d_v, d_s = n_p - o_p, n_v - o_v, total - o_s
        olds = {}
        for sid, name, srel, sp, sv, ss in c.execute(
                'SELECT id, name, rel, n_photo, n_video, size FROM dirs WHERE parent=?', (did,)):
            olds[name] = (sid, srel, sp, sv, ss)
        present = set(subs)
        for name, (sid, srel, sp, sv, ss) in olds.items():
            if name not in present:
                unlink.extend(self._drop_subtree(c, sid, srel))
                d_p -= sp
                d_v -= sv
                d_s -= ss
                changed = True
        for name in subs:
            if name not in olds:
                self._add_dir(c, did, rel + '/' + name if rel else name, name)
                changed = True
        # n_dirs задаём явно (после _add_dir, который прибавляет +1 для ensure-цепочек)
        c.execute('UPDATE dirs SET mtime=?, listed=?, own_photo=?, own_video=?, own_size=?, n_dirs=? WHERE id=?',
                  (dmtime, time.time(), n_p, n_v, total, len(subs), did))
        self._bump(c, did, d_p, d_v, d_s)
        return changed, unlink, bool(ins or upd)

    def refresh_dir(self, rel):
        """Перечитать одну папку с диска и слить с кешем. True — что-то изменилось."""
        rel = self._norm(rel)
        if rel and any(skip_dir(p) for p in rel.split('/')):
            return False
        path = self._abs(rel)
        try:
            dmtime = os.stat(path).st_mtime
            subs, files = list_folder(path)
        except (FileNotFoundError, NotADirectoryError):
            return self._vanished(rel)
        except OSError as e:
            log.warning('Cannot read %s: %s', path, e)
            return False
        with self._tx() as c:
            did = self._ensure(c, rel)
            res = self._apply(c, did, dmtime, subs, files) if did else None
            if did:
                c.execute('UPDATE dirs SET seen=? WHERE id=?', (time.time(), did))   # для вытеснения кеша
        if res is None:
            return False
        changed, unlink, new_files = res
        self._unlink_thumbs(unlink)
        if new_files:
            self._meta_event.set()
        return changed

    def _vanished(self, rel):
        """Папки нет на диске: убрать из кеша. Только если корень доступен (NAS не оффлайн)."""
        if not rel or not os.path.isdir(self.root):
            return False
        parts = rel.split('/')
        top = None
        for i in range(1, len(parts) + 1):      # самый верхний пропавший предок
            sub = '/'.join(parts[:i])
            if not os.path.isdir(self._abs(sub)):
                top = sub
                break
        if top is None:
            return False
        with self._tx() as c:
            r = c.execute('SELECT id, parent, n_photo, n_video, size FROM dirs WHERE rel=?', (top,)).fetchone()
            if r is None:
                return False
            unlink = self._drop_subtree(c, r[0], top)
            self._bump(c, r[1], -r[2], -r[3], -r[4])
            c.execute('UPDATE dirs SET n_dirs=MAX(n_dirs-1, 0) WHERE id=?', (r[1],))
        self._unlink_thumbs(unlink)
        log.info('Folder removed from cache: %s', top)
        return True

    def recompute_totals(self):
        """Пересчитать n_photo/n_video/size/n_dirs снизу вверх из own_* (страховка от расхождений)."""
        with self._tx() as c:
            rows = c.execute('SELECT id, parent, rel, own_photo, own_video, own_size, '
                             'n_photo, n_video, size, n_dirs FROM dirs').fetchall()
            tot = {}
            for r in rows:
                tot[r[0]] = [r[3], r[4], r[5], 0]
            rows.sort(key=lambda r: (r[2].count('/') + 1) if r[2] else 0, reverse=True)
            for r in rows:
                par = r[1]
                if par is not None and par in tot:
                    t, pt = tot[r[0]], tot[par]
                    pt[0] += t[0]
                    pt[1] += t[1]
                    pt[2] += t[2]
                    pt[3] += 1
            upd = []
            for r in rows:
                t = tot[r[0]]
                if (t[0], t[1], t[2], t[3]) != (r[6], r[7], r[8], r[9]):
                    upd.append((t[0], t[1], t[2], t[3], r[0]))
            if upd:
                c.executemany('UPDATE dirs SET n_photo=?, n_video=?, size=?, n_dirs=? WHERE id=?', upd)
        if upd:
            log.info('Totals corrected for %d folders', len(upd))

    # ─── уступчивость пользователю ───

    def touch(self):
        self._touched = time.monotonic()

    def _pause(self, stop=None):
        """Спать, пока пользователь активен (touch() был меньше YIELD секунд назад)."""
        while not self._closed and not (stop is not None and stop.is_set()):
            d = self._touched + YIELD - time.monotonic()
            if d <= 0:
                return
            time.sleep(min(d, 0.25))

    def prioritize(self, rel):
        rel = self._norm(rel)
        with self._plock:
            if rel in self._prio:
                self._prio.remove(rel)
            self._prio.append(rel)
            del self._prio[:-3]
        self._meta_event.set()

    # ─── фоновый обход ───

    def start_index(self, full=False):
        t = None
        with self._ixlock:
            if self._closed:
                return
            if self._ix_running:
                # идёт обычный обход, а просят полный, или обход уже останавливается — перезапустить
                if not (self._stop_ix.is_set() or (full and not self._st['full'])):
                    return
                self._stop_ix.set()
                t = self._ix
        if t is not None and t is not threading.current_thread():
            t.join(10)
        with self._ixlock:
            if self._closed or self._ix_running:
                return
            if not self._kv_get('full_done') or self._kv_get('exts') != EXTS:
                full = True                     # первый обход пустой БД или новый набор расширений — полный
            self._stop_ix.clear()
            self._st.update(full=bool(full), dirs=0, listed=0, current='', started=time.time(),
                            finished=None, error='')
            self._ix_running = True
            self._ix = threading.Thread(target=self._index_main, name='vomedia-index', daemon=True)
            self._ix.start()

    def stop_index(self):
        self._stop_ix.set()
        t = self._ix
        if t is not None and t is not threading.current_thread() and t.is_alive():
            t.join(2)

    def index_status(self):
        st = dict(self._st)
        st['running'] = self._ix_running
        try:
            r = self._db().execute('SELECT n_photo + n_video FROM dirs WHERE id=1').fetchone()
            st['files'] = r[0] if r else 0
        except sqlite3.Error:
            st['files'] = 0
        return st

    def _index_main(self):
        done = False
        try:
            if self._st['full']:
                with self._tx() as c:           # повторить файлы с прежними ошибками разбора
                    c.execute('UPDATE files SET meta=0 WHERE meta=2')
                self._meta_event.set()
            done = self._walk()
            if done and self._st['full']:
                self.recompute_totals()
                with self._tx() as c:
                    c.execute("INSERT OR REPLACE INTO meta_kv(k, v) VALUES('full_done', ?)", (str(time.time()),))
                    c.execute("INSERT OR REPLACE INTO meta_kv(k, v) VALUES('exts', ?)", (EXTS,))
                self._fs_zero = frozenset()
        except Exception as e:
            if not self._closed:
                log.exception('Index walk failed')
                self._st['error'] = str(e) or e.__class__.__name__
        finally:
            self._st['finished'] = time.time()
            self._st['current'] = ''
            with self._ixlock:
                self._ix_running = False
            self._meta_event.set()

    def _walk(self):
        """Обход в ширину. True — дошли до конца (не остановили, корень читался)."""
        queue = deque([(1, '')])
        errors = 0
        while queue:
            if self._stop_ix.is_set() or self._closed:
                return False
            self._pause(self._stop_ix)
            if self._stop_ix.is_set() or self._closed:
                return False
            did, rel = queue.popleft()
            self._st['current'] = rel
            try:
                children = self._index_dir(did, rel)
                errors = 0
            except Exception as e:
                if self._closed:
                    return False
                log.warning('Skipping folder %r: %s', rel or '/', e)
                errors += 1
                if did == 1:
                    self._st['error'] = 'Cannot read library root: %s' % e
                    return False
                if errors >= MAX_ERRORS:
                    self._st['error'] = 'Too many unreadable folders in a row (library offline?)'
                    return False
                continue
            queue.extend(children)
        return True

    def _index_dir(self, did, rel):
        """Шаг обхода: при необходимости перечитать папку; вернуть известные подпапки [(id, rel)]."""
        c = self._db()
        r = c.execute('SELECT mtime, listed FROM dirs WHERE id=?', (did,)).fetchone()
        if r is None:                           # убрана параллельным refresh_dir
            return []
        path = self._abs(rel)
        dmtime = os.stat(path).st_mtime
        self._st['dirs'] += 1
        if self._st['full'] or r[1] is None or r[0] is None or dmtime != r[0]:
            subs, files = list_folder(path)
            with self._tx() as w:
                res = self._apply(w, did, dmtime, subs, files)
            if res is None:
                return []
            self._unlink_thumbs(res[1])
            if res[2]:
                self._meta_event.set()
            self._st['listed'] += 1
        return c.execute('SELECT id, rel FROM dirs WHERE parent=?', (did,)).fetchall()

    # ─── нить метаданных ───

    def _meta_batch(self):
        """До META_BATCH файлов с meta=0: сначала из приоритетных папок, потом любые."""
        c = self._db()
        out = []
        with self._plock:
            prio = list(self._prio)
        for rel in reversed(prio):
            if len(out) >= META_BATCH:
                break
            r = c.execute('SELECT id FROM dirs WHERE rel=?', (rel,)).fetchone()
            if r is None:
                continue
            for fid, name, kind, size, mt in c.execute(
                    'SELECT id, name, kind, size, mtime FROM files WHERE dir=? AND meta=0 LIMIT ?',
                    (r[0], META_BATCH - len(out))):
                out.append((fid, rel, name, kind, size, mt))
        if len(out) < META_BATCH:
            seen = set(x[0] for x in out)
            for fid, rel, name, kind, size, mt in c.execute(
                    'SELECT f.id, d.rel, f.name, f.kind, f.size, f.mtime FROM files f '
                    'JOIN dirs d ON d.id=f.dir WHERE f.meta=0 LIMIT ?', (META_BATCH,)):
                if fid in seen:
                    continue
                out.append((fid, rel, name, kind, size, mt))
                if len(out) >= META_BATCH:
                    break
        return out

    def _meta_flush(self, rows):
        # условие по size/mtime: файл мог измениться, пока его читали
        with self._tx() as c:
            c.executemany('UPDATE files SET w=?, h=?, duration=?, rot=?, meta=? '
                          'WHERE id=? AND meta=0 AND mtime IS ? AND size IS ?', rows)

    def _meta_process(self, batch):
        done = []
        for fid, rel, name, kind, size, mt in batch:
            self._pause()
            if self._closed:
                break
            path = self._abs(rel, name)
            try:
                m = meta.read_meta(path, 'photo' if kind == KIND_PHOTO else 'video') or {}
            except Exception:
                m = {}
            w, h, dur = m.get('w'), m.get('h'), m.get('duration')
            ok = w is not None or h is not None or dur is not None
            if not ok and not os.path.isdir(self.root):
                break                           # NAS пропала посреди пачки: не метить файлы ошибкой
            done.append((w, h, dur, m.get('rot') or 1, 1 if ok else 2, fid, mt, size))
            if len(done) >= META_FLUSH:
                self._meta_flush(done)
                done = []
        if done:
            self._meta_flush(done)

    def _meta_main(self):
        while not self._closed:
            try:
                self._pause()
                if self._closed:
                    break
                batch = self._meta_batch()
                if not batch:
                    self._meta_event.clear()
                    batch = self._meta_batch()      # сигнал мог прийти до clear()
                    if not batch:
                        self._meta_event.wait(60)
                        continue
                if not os.path.isdir(self.root):    # NAS недоступна — не метить файлы ошибкой
                    self._meta_event.clear()        # иначе wait() вернётся сразу и нить будет крутиться
                    self._meta_event.wait(30)
                    continue
                self._meta_process(batch)
            except Exception:
                if self._closed:
                    break
                log.exception('Meta thread error')
                time.sleep(2)

    # ─── миниатюры ───

    def _set_thumb(self, fid, value):
        with self._tx() as c:
            c.execute('UPDATE files SET thumb=? WHERE id=?', (value, fid))

    def get_thumb(self, fid):
        """Миниатюра из кеша или None (EXIF-миниатюры ~160 px — для 800 px малы, делает страница)."""
        r = self._db().execute('SELECT thumb FROM files WHERE id=?', (fid,)).fetchone()
        if not r or r[0] != 1:
            return None
        try:
            with open(self.thumb_file(fid), 'rb') as f:
                return f.read()
        except OSError:                         # файл миниатюры потерян
            self._set_thumb(fid, 0)
            return None

    def _put_file(self, kind, path, data):
        """Записать файл кеша через .part + os.replace. False — не вышло."""
        tmp = '%s.%d.part' % (path, threading.get_ident())
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(tmp, 'wb') as f:
                f.write(data)
            try:
                old = os.path.getsize(path)
            except OSError:
                old = -1
            os.replace(tmp, path)
            self._count(kind, len(data) - max(old, 0), 0 if old >= 0 else 1)
            return True
        except OSError as e:
            log.warning('Cannot save %s: %s', path, e)
            try:
                os.remove(tmp)
            except OSError:
                pass
            return False

    def get_story(self, fid):
        """Раскадровка видео из кеша или None."""
        try:
            with open(self.story_file(fid), 'rb') as f:
                return f.read()
        except OSError:
            return None

    def put_story(self, fid, data):
        """Сохранить раскадровку (JPEG ≤ 4 МБ) только для видео, которое есть в кеше."""
        if not data or len(data) > MAX_STORY or bytes(data[:2]) != b'\xff\xd8':
            return False
        r = self._db().execute('SELECT kind FROM files WHERE id=?', (fid,)).fetchone()
        if not r or r[0] != KIND_VIDEO:
            return False
        return self._put_file('story', self.story_file(fid), data)

    # ─── место кеша ───

    def _scan_bytes(self):
        """Посчитать место миниатюр и раскадровок обходом локальной папки кеша."""
        tot = {'thumbs': 0, 'story': 0, 'n_thumbs': 0, 'n_story': 0}
        for kind, base in (('thumbs', self.thumbs_dir), ('story', self.story_dir)):
            try:
                subs = list(os.scandir(base))
            except OSError:
                continue
            for d in subs:
                if self._closed:
                    return
                try:
                    with os.scandir(d.path) as it:
                        for e in it:
                            if e.name.endswith('.jpg'):
                                tot[kind] += e.stat().st_size
                                tot['n_' + kind] += 1
                except OSError:
                    pass
        with self._blk:
            self._bytes.update(tot, ready=True)

    def cache_stats(self):
        """Место кеша этой библиотеки: миниатюры, раскадровки, БД, лимит."""
        with self._blk:
            st = dict(self._bytes)
        db = 0
        for sfx in ('', '-wal', '-shm'):
            try:
                db += os.path.getsize(self.db_path + sfx)
            except OSError:
                pass
        st.update(db=db, limit=self.cache_limit, root=self.root)
        return st

    def _evict(self, target):
        """Удалять миниатюры и раскадровки давно не открытых папок, пока место не станет ≤ target."""
        c = self._db()
        with self._plock:
            keep = set(self._prio)              # недавно открытые папки не трогаем
        rows = c.execute('SELECT d.id, d.rel FROM dirs d WHERE EXISTS(SELECT 1 FROM files f '
                         'WHERE f.dir=d.id AND (f.thumb=1 OR f.kind=?)) '
                         'ORDER BY d.seen IS NOT NULL, d.seen', (KIND_VIDEO,)).fetchall()
        freed = 0
        for did, rel in rows:
            with self._blk:
                used = self._bytes['thumbs'] + self._bytes['story']
            if used <= target or self._closed:
                break
            if rel in keep:
                continue
            ids = [r[0] for r in c.execute('SELECT id FROM files WHERE dir=? AND (thumb=1 OR kind=?)',
                                           (did, KIND_VIDEO))]
            with self._tx() as w:
                w.execute('UPDATE files SET thumb=0 WHERE dir=? AND thumb=1', (did,))
            self._unlink_thumbs(ids)
            freed += 1
        if freed:
            log.info('Cache limit: thumbnails of %d least recently opened folders removed', freed)

    def _janitor(self):
        """Нить места кеша: подсчёт при запуске, потом раз в JANITOR_EVERY — лимит."""
        if self._jan_event.wait(5) and self._closed:
            return
        try:
            self._scan_bytes()
        except Exception:
            log.exception('Cache size scan failed')
        while not self._closed:
            try:
                st = self.cache_stats()
                if self.cache_limit and st['thumbs'] + st['story'] > self.cache_limit:
                    self._evict(int(self.cache_limit * 0.9))
                with self._tx() as c:
                    c.execute("INSERT OR REPLACE INTO meta_kv(k, v) VALUES('bytes', ?)",
                              (str(st['thumbs'] + st['story'] + st['db']),))
            except Exception:
                if self._closed:
                    break
                log.exception('Cache janitor error')
            self._jan_event.wait(JANITOR_EVERY)
            self._jan_event.clear()

    def check_limit(self):
        """Проверить лимит сейчас (после смены лимита)."""
        self._jan_event.set()

    def clear_thumbs(self):
        """Удалить все миниатюры и раскадровки этой библиотеки (индекс остаётся)."""
        with self._tx() as c:
            c.execute('UPDATE files SET thumb=0 WHERE thumb=1')
        for d in (self.thumbs_dir, self.story_dir):
            shutil.rmtree(d, ignore_errors=True)
        os.makedirs(self.thumbs_dir, exist_ok=True)
        with self._blk:
            self._bytes.update(thumbs=0, story=0, n_thumbs=0, n_story=0)
        log.info('Thumbnails cleared: %s', self.root)

    # ─── соседняя папка (переход в просмотрщике) ───

    @staticmethod
    def _node(c, did):
        return c.execute('SELECT id, parent, rel, name, own_photo + own_video FROM dirs WHERE id=?', (did,)).fetchone()

    @staticmethod
    def _kids(c, did):
        rows = c.execute('SELECT id, parent, rel, name, own_photo + own_video FROM dirs WHERE parent=?', (did,)).fetchall()
        rows.sort(key=lambda r: _nat(r[3]))
        return rows

    def _pre_next(self, c, n):
        """Следующая папка в порядке дерева (обход в глубину)."""
        k = self._kids(c, n[0])
        if k:
            return k[0]
        while n is not None and n[1] is not None:
            sib = self._kids(c, n[1])
            i = [x[0] for x in sib].index(n[0])
            if i + 1 < len(sib):
                return sib[i + 1]
            n = self._node(c, n[1])
        return None

    def _pre_prev(self, c, n):
        """Предыдущая папка в порядке дерева."""
        if n[1] is None:
            return None
        sib = self._kids(c, n[1])
        i = [x[0] for x in sib].index(n[0])
        if i == 0:
            return self._node(c, n[1])
        n = sib[i - 1]
        while True:                             # самая последняя папка поддерева предыдущего соседа
            k = self._kids(c, n[0])
            if not k:
                return n
            n = k[-1]

    def neighbor_dir(self, rel, step):
        """rel ближайшей папки со своими файлами после (step > 0) или до (step < 0) данной; None — нет."""
        c = self._db()
        n = c.execute('SELECT id, parent, rel, name, own_photo + own_video FROM dirs WHERE rel=?',
                      (self._norm(rel),)).fetchone()
        while n is not None:
            n = self._pre_next(c, n) if step > 0 else self._pre_prev(c, n)
            if n is not None and n[4] > 0:
                return n[2]
        return None

    def put_thumb(self, fid, data):
        """Сохранить миниатюру (JPEG ≤ 512 КБ) через .part + os.replace, thumb=1."""
        if not data or len(data) > MAX_THUMB or bytes(data[:2]) != b'\xff\xd8':
            return False
        if self._db().execute('SELECT 1 FROM files WHERE id=?', (fid,)).fetchone() is None:
            return False
        if not self._put_file('thumbs', self.thumb_file(fid), data):
            return False
        with self._tx() as c:
            n = c.execute('UPDATE files SET thumb=1 WHERE id=?', (fid,)).rowcount
        if n == 0:                              # файл исчез из кеша, пока писали
            self._unlink_thumbs([fid])
            return False
        return True
