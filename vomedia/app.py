"""Запуск VO Media: параметры, журнал, настройки, смена папки, окно (pywebview) или браузер.

Класс App — это ctx для сервера: библиотека, токен, настройки, список недавних, смена папки, диалог выбора папки.
"""
import argparse
import contextlib
import json
import re
import shutil
import sqlite3
import logging
import os
import secrets
import sys
import threading
import time
import webbrowser

from . import APP, VERSION
from .index import Library, app_dir, cache_dir
from .server import make_server, root_name

log = logging.getLogger(__name__)

HAS_CONSOLE = [True]   # False при запуске без консоли (pythonw): вывод идёт в журнал, ошибки — окном сообщения
RECENT_MAX = 10
CACHE_LIMIT_GB = 20      # лимит места миниатюр и раскадровок на библиотеку по умолчанию
CACHE_DAYS = 90          # кеш библиотеки, которую не открывали столько дней, удаляется при запуске
SLOCK = threading.Lock()   # файл settings.json


# ───────────────────────── журнал и сообщения об ошибках ─────────────────────────

def setup_log():
    """Журнал в <app_dir>/vomedia.log (+ консоль, если она есть)."""
    fmt = logging.Formatter('%(asctime)s %(levelname)s %(name)s: %(message)s')
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    path = os.path.join(app_dir(), 'vomedia.log')
    try:
        if os.path.exists(path) and os.path.getsize(path) > 1000000:
            os.remove(path)
    except OSError:
        pass
    if sys.stdout is None or sys.stderr is None:  # pythonw: консоли нет, sys.stdout пуст
        HAS_CONSOLE[0] = False
        try:
            sys.stdout = sys.stderr = open(path, 'a', encoding='utf-8', buffering=1)
        except OSError:
            sys.stdout = sys.stderr = open(os.devnull, 'w')
        h = logging.StreamHandler(sys.stderr)
        h.setFormatter(fmt)
        root.addHandler(h)
    else:
        h = logging.StreamHandler(sys.stderr)
        h.setFormatter(fmt)
        root.addHandler(h)
        try:
            fh = logging.FileHandler(path, encoding='utf-8')
            fh.setFormatter(fmt)
            root.addHandler(fh)
        except OSError:
            pass
    log.info('=== start %s %s ===', APP, VERSION)


def die(msg):
    """Сообщить об ошибке и выйти. Без консоли текст показывается окном сообщения: иначе его никто не увидит."""
    log.error('%s', msg)
    if os.name == 'nt' and not HAS_CONSOLE[0]:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, str(msg), APP, 0x10)
        except Exception:  # noqa: BLE001
            pass
    sys.exit(1)


# ───────────────────────── настройки ─────────────────────────

# настройки, общие для всех библиотек (не по папке): сортировка сетки и дерева
SHARED_KEYS = ('sort', 'desc', 'tsort', 'tdesc')


def settings_file():
    return os.path.join(app_dir(), 'settings.json')


def read_all():
    try:
        with open(settings_file(), encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def write_all(d):
    """Запись через .part и os.replace: обрыв посреди записи не портит файл."""
    os.makedirs(app_dir(), exist_ok=True)
    tmp = settings_file() + '.part'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, settings_file())


def root_key(root):
    return os.path.normcase(os.path.abspath(root))


def read_cache_info(d):
    """Корень, место и время последнего открытия кеша библиотеки (без открытия Library)."""
    info = {'root': '', 'bytes': 0, 'opened': None}
    db = os.path.join(d, 'library.sqlite')
    try:
        c = sqlite3.connect('file:%s?mode=ro' % db.replace('\\', '/'), uri=True, timeout=2)
        try:
            kv = dict(c.execute("SELECT k, v FROM meta_kv WHERE k IN ('root', 'bytes', 'opened')").fetchall())
        finally:
            c.close()
        info['root'] = kv.get('root', '')
        info['bytes'] = int(float(kv.get('bytes') or 0))
        info['opened'] = float(kv['opened']) if kv.get('opened') else None
    except (sqlite3.Error, ValueError):
        pass
    if not info['opened']:
        try:
            info['opened'] = os.path.getmtime(db)
        except OSError:
            pass
    if not info['bytes']:
        try:
            info['bytes'] = os.path.getsize(db)
        except OSError:
            pass
    return info


def cleanup_old_caches(current):
    """Удалить кеши библиотек, которые не открывали CACHE_DAYS дней (фоном при запуске)."""
    base = os.path.join(app_dir(), 'cache')
    cur = os.path.normcase(cache_dir(current))
    edge = time.time() - CACHE_DAYS * 86400
    try:
        names = os.listdir(base)
    except OSError:
        return
    for name in names:
        d = os.path.join(base, name)
        if os.path.normcase(d) == cur or not re.fullmatch(r'[0-9a-f]{16}', name):
            continue
        info = read_cache_info(d)
        if info['opened'] and info['opened'] < edge:
            shutil.rmtree(d, ignore_errors=True)
            log.info('Old cache removed (not opened for %d days): %s', CACHE_DAYS, info['root'] or name)


# ───────────────────────── диалог выбора папки ─────────────────────────

def pick_folder(initial=''):
    """Диалог выбора папки через tkinter (входит в состав Python). Пусто — недоступен или отменён."""
    try:
        import tkinter
        from tkinter import filedialog
        root = tkinter.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        try:
            return filedialog.askdirectory(title='Folder with photos and videos', initialdir=initial or None,
                                           mustexist=True) or ''
        finally:
            root.destroy()
    except Exception:  # noqa: BLE001 — нет tkinter или дисплея
        return ''


def ask_folder(window, initial=''):
    """Диалог выбора папки: в своём окне — диалог самого окна, иначе tkinter. Пусто — отменён."""
    if window is not None:
        try:
            import webview
            kind = getattr(getattr(webview, 'FileDialog', None), 'FOLDER', None)
            if kind is None:
                kind = webview.FOLDER_DIALOG
            r = window.create_file_dialog(kind, directory=initial or '')
            if isinstance(r, (list, tuple)):
                r = r[0] if r else ''
            return r or ''
        except Exception as e:  # noqa: BLE001 — не вышло диалогом окна: пробуем tkinter
            log.warning('The window dialog did not open (%s: %s), using the standard one.', type(e).__name__, e)
    return pick_folder(initial)


# ───────────────────────── App: контекст сервера ─────────────────────────

class App:
    """ctx для сервера. Хранит открытую Library и меняет её без перезапуска.

    Запросы берут библиотеку через use(): пока идёт смена папки, они ждут, а смена ждёт, пока завершатся
    запросы со старой библиотекой.
    """

    def __init__(self, folder):
        self.token = secrets.token_urlsafe(16)
        self.window = None
        self._cv = threading.Condition()
        self._switching = False     # идёт замена библиотеки
        self._active = 0            # запросов внутри use()
        self._swlock = threading.Lock()   # одна смена папки за раз
        self._plock = threading.Lock()    # один диалог выбора папки за раз
        path = os.path.abspath(folder)
        self._lib = self._open(path)
        self._root = path
        self._remember(path)
        self._lib.start_index(False)      # пустую БД Library сама обходит полностью; окно обхода не ждёт

    # ───── библиотека ─────

    @property
    def lib(self):
        """Текущая Library (ждёт, пока идёт смена папки). Для нескольких вызовов подряд лучше use()."""
        with self._cv:
            while self._switching:
                self._cv.wait()
            return self._lib

    @contextlib.contextmanager
    def use(self):
        """Библиотека на время блока: смена папки не начнётся, пока блок не завершён. Вложенно не вызывать."""
        with self._cv:
            while self._switching:
                self._cv.wait()
            self._active += 1
            lib = self._lib
        try:
            yield lib
        finally:
            with self._cv:
                self._active -= 1
                self._cv.notify_all()

    def close(self):
        try:
            self._lib.close()
        except Exception:  # noqa: BLE001
            log.exception('closing the library failed')

    def _open(self, path):
        lib = Library(path)
        lib.cache_limit = self.cache_limit()
        return lib

    # ───── кеш ─────

    def cache_limit(self):
        """Лимит места миниатюр и раскадровок в байтах (0 — без лимита)."""
        v = read_all().get('cache_limit_gb', CACHE_LIMIT_GB)
        try:
            return max(0, int(float(v) * 1024 ** 3))
        except (TypeError, ValueError):
            return CACHE_LIMIT_GB * 1024 ** 3

    def set_cache_limit(self, gb):
        gb = float(gb)
        if gb < 0 or gb > 100000:
            raise ValueError('Bad cache limit')
        with SLOCK:
            d = read_all()
            d['cache_limit_gb'] = gb
            try:
                write_all(d)
            except OSError as e:
                log.warning('Could not save settings: %s', e)
        with self.use() as lib:
            lib.cache_limit = self.cache_limit()
            lib.check_limit()

    def caches(self):
        """Кеши всех библиотек: текущая (подробно) и остальные (корень, место, когда открывали)."""
        with self.use() as lib:
            cur = lib.cache_stats()
            cur_dir = os.path.normcase(lib.cache)
        others = []
        base = os.path.join(app_dir(), 'cache')
        try:
            names = os.listdir(base)
        except OSError:
            names = []
        for name in names:
            d = os.path.join(base, name)
            if os.path.normcase(d) == cur_dir or not re.fullmatch(r'[0-9a-f]{16}', name):
                continue
            info = read_cache_info(d)
            info['key'] = name
            others.append(info)
        others.sort(key=lambda x: -(x.get('opened') or 0))
        return {'current': cur, 'others': others, 'limit_gb': self.cache_limit() / 1024 ** 3}

    def remove_cache(self, key):
        """Удалить кеш другой (не открытой) библиотеки."""
        if not isinstance(key, str) or not re.fullmatch(r'[0-9a-f]{16}', key):
            raise ValueError('Bad cache id')
        d = os.path.join(app_dir(), 'cache', key)
        with self.use() as lib:
            if os.path.normcase(d) == os.path.normcase(lib.cache):
                raise ValueError('This is the cache of the open folder')
        shutil.rmtree(d, ignore_errors=True)
        log.info('Cache removed: %s', key)

    def clear_thumbs(self):
        with self.use() as lib:
            lib.clear_thumbs()

    def reset_cache(self):
        """Удалить весь кеш открытой папки (индекс, миниатюры) и начать полный обход заново."""
        if not self._swlock.acquire(False):
            raise ValueError('Another folder is being opened')
        try:
            with self._cv:
                self._switching = True
                ok = self._cv.wait_for(lambda: self._active == 0, timeout=60)
                if not ok:
                    self._switching = False
                    self._cv.notify_all()
            if not ok:
                raise ValueError('The folder is busy, try again in a moment')
            try:
                old = self._lib
                old.close()
                shutil.rmtree(old.cache, ignore_errors=True)
                self._lib = self._open(self._root)
            finally:
                with self._cv:
                    self._switching = False
                    self._cv.notify_all()
        finally:
            self._swlock.release()
        log.info('Library cache reset: %s', self._root)
        self._lib.start_index(True)

    # ───── настройки ─────

    def load_settings(self):
        """Настройки интерфейса открытой папки (объект как есть)."""
        a = read_all()
        d = (a.get('roots') or {}).get(root_key(self._root))
        d = dict(d) if isinstance(d, dict) else {}
        g = a.get('shared')
        if isinstance(g, dict):
            d.update((k, g[k]) for k in SHARED_KEYS if k in g)
        return d

    def save_settings(self, new):
        if not isinstance(new, dict):
            raise ValueError('settings must be an object')
        # страница присылает свой корень: запрос от старой страницы во время смены папки не должен
        # записать её настройки в ключ новой
        root = new.pop('_root', None)
        if isinstance(root, str) and root_key(root) != root_key(self._root):
            log.info('Settings for another folder ignored: %s', root)
            return
        if len(json.dumps(new)) > 200000:
            log.warning('Settings are too large, not saved.')
            return
        with SLOCK:
            d = read_all()
            roots = d.get('roots')
            if not isinstance(roots, dict):
                roots = d['roots'] = {}
            g = {k: new.pop(k) for k in SHARED_KEYS if k in new}
            if g:
                d['shared'] = g
            roots[root_key(self._root)] = new
            try:
                write_all(d)
            except OSError as e:
                log.warning('Could not save settings: %s', e)

    def _recent_all(self):
        r = read_all().get('recent')
        return [x for x in r if isinstance(x, str) and x] if isinstance(r, list) else []

    def recent(self):
        """Недавние папки без открытой. Доступность не проверяется: NAS может отвечать долго."""
        cur = root_key(self._root)
        return [x for x in self._recent_all() if root_key(x) != cur]

    def _remember(self, path):
        """С этой папки начнётся следующий запуск; она встаёт первой в список недавних."""
        with SLOCK:
            d = read_all()
            r = d.get('recent')
            rest = [x for x in r if isinstance(x, str) and x and root_key(x) != root_key(path)] \
                if isinstance(r, list) else []
            d['recent'] = ([path] + rest)[:RECENT_MAX]
            d['last_folder'] = path
            try:
                write_all(d)
            except OSError as e:
                log.warning('Could not save settings: %s', e)

    # ───── смена папки и диалог ─────

    def pick_folder(self):
        """Диалог выбора папки. Пусто — отмена. ValueError — диалог уже открыт."""
        if not self._plock.acquire(False):
            raise ValueError('The folder picker is already open')
        try:
            return ask_folder(self.window, self._root)
        finally:
            self._plock.release()

    def switch_root(self, folder):
        """Открыть другую папку. ValueError с текстом для пользователя, если не вышло."""
        path = os.path.abspath(folder)
        if not os.path.isdir(path):
            raise ValueError('Folder not available: %s' % path)
        if root_key(path) == root_key(self._root):
            return
        if not self._swlock.acquire(False):
            raise ValueError('Another folder is being opened')
        try:
            try:
                new = self._open(path)  # открываем до замены: не вышло — старая остаётся как есть
            except Exception as e:  # noqa: BLE001
                log.exception('could not open the library for %s', path)
                raise ValueError('Could not open %s: %s' % (path, e))
            with self._cv:
                self._switching = True
                ok = self._cv.wait_for(lambda: self._active == 0, timeout=60)
                if not ok:
                    self._switching = False
                    self._cv.notify_all()
            if not ok:
                new.close()
                raise ValueError('The current folder is busy, try again in a moment')
            old = self._lib
            try:
                old.close()  # снаружи блокировки: остановка нитей может занять время
            except Exception:  # noqa: BLE001
                log.exception('closing the old library failed')
            with self._cv:
                self._lib = new
                self._root = path
                self._switching = False
                self._cv.notify_all()
        finally:
            self._swlock.release()
        self._remember(path)
        w = self.window
        if w is not None:
            try:
                w.set_title(APP + ' — ' + root_name(path))
            except Exception:  # noqa: BLE001
                pass
        log.info('Opened folder: %s', path)
        new.start_index(False)


# ───────────────────────── своё окно (pywebview) ─────────────────────────

class WindowApi:
    """Методы, которые страница вызывает через window.pywebview.api (имена с подчёркиванием наружу не выдаются)."""

    def __init__(self):
        self._window = None
        self._fs = False

    def set_fullscreen(self, on):
        """Полный экран окна для просмотра: в окне pywebview HTML-полноэкранный режим не годится."""
        on = bool(on)
        if self._window is not None and on != self._fs:
            self._window.toggle_fullscreen()
            self._fs = on
        return self._fs


def run_window(url, title, ctx=None, width=1600, height=1000):
    """Показать страницу в собственном окне. Блокирует, пока окно не закроют.

    True — окно было показано и закрыто; False — открыть не вышло (нет pywebview, нет WebView2, нет дисплея),
    тогда вызывающий откроет браузер.
    """
    try:
        import webview
    except ImportError:
        log.info('The app window needs pywebview (pip install pywebview). Opening in the browser.')
        return False
    api = WindowApi()
    try:
        win = webview.create_window(title, url, js_api=api, width=width, height=height, min_size=(900, 600),
                                    background_color='#111217', text_select=True)
        api._window = win
        if ctx is not None:
            ctx.window = win
        # на Windows принудительно WebView2: запасной движок IE страницу не потянет
        webview.start(gui='edgechromium' if os.name == 'nt' else None)
    except Exception as e:  # noqa: BLE001 — любой сбой окна не должен убивать программу: есть браузер
        log.warning('The window did not open (%s: %s). Opening in the browser.', type(e).__name__, e)
        if ctx is not None:
            ctx.window = None
        return False
    return True


# ───────────────────────── запуск ─────────────────────────

def main():
    setup_log()
    ap = argparse.ArgumentParser(description=APP + ': fast viewer for photos and videos in huge folders (NAS-friendly).')
    ap.add_argument('--version', action='version', version='%s %s' % (APP, VERSION))
    ap.add_argument('folder', nargs='?',
                    help='folder with photos and videos (subfolders are included). '
                         'Without it the folder from the last run opens, otherwise a folder picker')
    ap.add_argument('--port', type=int, default=0,
                    help='local server port (default: any free port, so windows for different folders do not interfere)')
    ap.add_argument('--browser', action='store_true', help='open the viewer in the browser instead of the app window (pywebview)')
    ap.add_argument('--no-browser', action='store_true', help='open nothing (server only)')
    a = ap.parse_args()

    folder = a.folder
    if not folder:
        last = read_all().get('last_folder')
        if isinstance(last, str) and last:
            if os.path.isdir(last):
                folder = last
                log.info('Folder from the last run: %s', last)
            else:
                log.warning('The folder from the last run is not available: %s', last)
    if not folder:
        folder = pick_folder()
    if not folder:
        die('No folder given. Run: vomedia.py "D:\\Photos" — or pick a folder in the dialog.')
    path = os.path.abspath(folder)
    if not os.path.isdir(path):
        die('No such folder: ' + path)

    try:
        app = App(path)
    except Exception as e:  # noqa: BLE001
        log.exception('could not open the library')
        die('Could not open %s: %s' % (path, e))
    try:
        srv = make_server(a.port, app)
    except OSError as e:
        app.close()
        die('Could not start the local server: %s' % e)
    threading.Thread(target=cleanup_old_caches, args=(path,), name='vomedia-cleanup', daemon=True).start()
    url = 'http://127.0.0.1:%d/?t=%s' % (srv.server_address[1], app.token)
    log.info('Viewer: %s', url)
    try:
        if a.no_browser:
            log.info('Press Ctrl+C to quit.')
            srv.serve_forever()
        elif a.browser:
            log.info('Press Ctrl+C to quit.')
            webbrowser.open(url)
            srv.serve_forever()
        else:
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            if run_window(url, APP + ' — ' + root_name(path), app):
                log.info('Window closed.')
            else:
                log.info('Press Ctrl+C to quit.')
                webbrowser.open(url)
                while True:
                    time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        app.close()
