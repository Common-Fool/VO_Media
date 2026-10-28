"""Действия с файлами: проводник, внешний плеер, переименование, удаление в корзину, буфер обмена.

Маршруты /api/explorer, /api/player*, /api/play, /api/file/* сервер отдаёт сюда целиком (route()).
Выбор плеера и запуск перенесены из VSPO (pairview.py: list_players, play, send_to_mpc, show_in_explorer).
Путь с клиента не принимается: файлы — только по id из кеша, папки — по rel внутри корня, плеер — из найденного списка.
"""
import ctypes
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time

log = logging.getLogger(__name__)

PREFIXES = frozenset({'explorer', 'player', 'play', 'file'})
IS_WIN = sys.platform == 'win32'

MPC_DEFAULT = r'C:\Program Files (x86)\K-Lite Codec Pack\MPC-HC64\mpc-hc64.exe'
MPC_SUBDIRS = (r'K-Lite Codec Pack\MPC-HC64\mpc-hc64.exe', r'K-Lite Codec Pack\MPC-HC\mpc-hc.exe',
               r'MPC-HC\mpc-hc64.exe', r'MPC-HC\mpc-hc.exe', r'MPC-HC x64\mpc-hc64.exe',
               r'MPC-BE\mpc-be64.exe', r'MPC-BE\mpc-be.exe', r'MPC-BE x64\mpc-be64.exe')
# имя плеера по имени файла: (часть имени, как показывать)
PLAYER_NAMES = (('mpc-hc', 'MPC-HC'), ('mpc-be', 'MPC-BE'), ('mpc-qt', 'MPC-QT'), ('vlc', 'VLC'), ('mpv', 'mpv'),
                ('potplayer', 'PotPlayer'), ('iina', 'IINA'), ('celluloid', 'Celluloid'), ('smplayer', 'SMPlayer'),
                ('haruna', 'Haruna'))
BAD_CHARS = set('<>:"/\\|?*') | set(chr(i) for i in range(32))
PLOCK = threading.Lock()                # один диалог выбора программы за раз


# ───────────────────────── маршруты ─────────────────────────

def handles(p):
    """Маршрут ли это файловых действий (p — путь, разбитый по '/')."""
    return len(p) >= 2 and p[0] == 'api' and p[1] in PREFIXES


def route(ctx, post, p, q, raw):
    """Обработать запрос. Вернуть (код HTTP, объект JSON). ValueError — ошибка для пользователя (сервер ответит 409)."""
    b = {}
    if post:
        try:
            b = json.loads(raw.decode('utf-8') or '{}')
        except ValueError:
            raise ValueError('could not parse the request')
        if not isinstance(b, dict):
            raise ValueError('could not parse the request')
    key = '/'.join(p[1:])
    if key == 'player' and not post:
        return 200, players_menu()
    if not post:
        return 404, {'error': 'not found'}
    if key == 'player/set':
        return 200, choose_player(b.get('id'))
    if key == 'player/pick':
        return 200, pick_player(ctx)
    if key == 'play':
        return 200, play(paths_of(ctx, b.get('ids')))
    if key == 'explorer':
        if b.get('id') is not None:
            return 200, show_in_explorer(paths_of(ctx, [b.get('id')])[0], select=True)
        return 200, show_in_explorer(folder_of(ctx, b.get('rel')), select=False)
    if key == 'file/rename':
        return 200, rename(ctx, b.get('root'), b.get('id'), b.get('old'), b.get('name'))
    if key == 'file/delete':
        return 200, delete(ctx, b.get('root'), b.get('ids'), b.get('names'))
    if key == 'file/copy':
        what = b.get('what') or 'files'
        if what == 'path':
            paths = paths_of(ctx, b.get('ids')) if b.get('ids') else [folder_of(ctx, b.get('rel'))]
            clip_text('\r\n'.join(plain(x) for x in paths))
        elif what == 'files':
            clip_files([plain(x) for x in paths_of(ctx, b.get('ids'))])
        else:
            raise ValueError('unknown copy mode')
        return 200, {'ok': True}
    return 404, {'error': 'not found'}


# ───────────────────────── пути ─────────────────────────

def plain(path):
    """Путь без префикса \\\\?\\ — для проводника, плееров и буфера обмена (они его не понимают)."""
    if path.startswith('\\\\?\\UNC\\'):
        return '\\\\' + path[8:]
    if path.startswith('\\\\?\\'):
        return path[4:]
    return path


def ids_list(ids):
    if not isinstance(ids, list) or not ids or len(ids) > 10000:
        raise ValueError('no files given')
    out = []
    for x in ids:
        if not isinstance(x, int) or isinstance(x, bool):
            raise ValueError('bad file id')
        out.append(x)
    return list(dict.fromkeys(out))


def rows_of(ctx, ids):
    """Строки файлов из кеша по id (только существующие в кеше)."""
    with ctx.use() as lib:
        rows = [lib.file_row(i) for i in ids_list(ids)]
    rows = [r for r in rows if r]
    if not rows:
        raise ValueError('these files are no longer in the library')
    return rows


def checked_rows(lib, root, ids, names):
    """Строки для удаления/переименования с проверкой, что страница видит ту же библиотеку и те же файлы:
    устаревшая вкладка (другая открытая папка) или id, занятый новым файлом, не должны задеть чужой файл."""
    if not isinstance(root, str) or os.path.normcase(os.path.abspath(root)) != os.path.normcase(lib.root):
        raise ValueError('another folder is open now — reload the page')
    if not isinstance(ids, list) or not isinstance(names, list) or not ids or len(ids) != len(names) or len(ids) > 10000:
        raise ValueError('no files given')
    rows, seen = [], set()
    for fid, name in zip(ids, names):
        if not isinstance(fid, int) or isinstance(fid, bool) or fid in seen:
            continue
        seen.add(fid)
        r = lib.file_row(fid)
        if not r or r['name'] != name:
            raise ValueError('the file list is out of date — refresh the folder (F5)')
        rows.append(r)
    return rows


def paths_of(ctx, ids):
    return [r['path'] for r in rows_of(ctx, ids)]


def folder_of(ctx, rel):
    """Абсолютный путь папки внутри корня по rel с клиента (выход за корень запрещён)."""
    parts = [x for x in str(rel or '').replace('\\', '/').split('/') if x not in ('', '.')]
    if '..' in parts or any(':' in x for x in parts if IS_WIN):
        raise ValueError('invalid folder')
    with ctx.use() as lib:
        root = lib.root
    path = os.path.normpath(os.path.join(root, *parts))
    if os.path.commonpath([os.path.normcase(root), os.path.normcase(path)]) != os.path.normcase(root):
        raise ValueError('invalid folder')
    return path


# ───────────────────────── проводник ─────────────────────────

def open_file(path):
    """Открыть файл или папку программой по умолчанию."""
    if IS_WIN:
        os.startfile(path)
    elif sys.platform == 'darwin':
        subprocess.Popen(['open', path])
    else:
        subprocess.Popen(['xdg-open', path])


def show_in_explorer(path, select):
    """Показать файл в проводнике (выделенным) или открыть папку."""
    path = plain(path)
    if not os.path.exists(path):
        raise ValueError('not found on disk: ' + path)
    if IS_WIN and select:
        subprocess.Popen(['explorer.exe', '/select,', path])  # explorer всегда отвечает кодом 1 — это нормально
    elif sys.platform == 'darwin' and select:
        subprocess.Popen(['open', '-R', path])               # Finder с выделенным файлом
    else:                                                    # Linux: выделить файл стандартного способа нет
        open_file(os.path.dirname(path) if select else path)
    return {'ok': True}


# ───────────────────────── внешний плеер (из VSPO) ─────────────────────────

def program_dirs():
    bases = [os.environ.get(k) for k in ('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432')]
    bases += [r'C:\Program Files', r'C:\Program Files (x86)']
    return list(dict.fromkeys(x for x in bases if x))


def player_name(path):
    if not path:
        return 'default app'
    base = os.path.basename(path.rstrip('\\/'))
    low = base.lower()
    return next((n for k, n in PLAYER_NAMES if k in low), os.path.splitext(base)[0] or base)


def player_kind(path):
    """'mpc' — MPC-HC/MPC-BE (плейлист передаётся списком файлов); '' — любой другой плеер."""
    low = os.path.basename(path or '').lower()
    return 'mpc' if IS_WIN and ('mpc-hc' in low or 'mpc-be' in low) else ''


def list_players():
    """Установленные плееры, которые нашлись в стандартных местах: [(путь, имя)], без повторов по имени."""
    cands = []
    if IS_WIN:
        cands.append(MPC_DEFAULT)
        for b in program_dirs():
            cands += [os.path.join(b, s) for s in MPC_SUBDIRS]
            cands += [os.path.join(b, s) for s in (r'VideoLAN\VLC\vlc.exe', r'DAUM\PotPlayer\PotPlayerMini64.exe',
                                                   r'DAUM\PotPlayer\PotPlayerMini.exe', r'mpv\mpv.exe')]
        cands += [shutil.which(n) for n in ('mpc-hc64', 'mpc-be64', 'vlc', 'mpv')]
    elif sys.platform == 'darwin':
        for d in ('/Applications', os.path.expanduser('~/Applications')):
            cands += [os.path.join(d, n) for n in ('IINA.app', 'VLC.app', 'mpv.app')]
        cands.append(shutil.which('mpv'))
    else:
        cands += [shutil.which(n) for n in ('mpv', 'vlc', 'celluloid', 'smplayer', 'haruna', 'mpc-qt')]
    out, seen = [], set()
    for c in cands:
        if c and os.path.exists(c):
            name = player_name(c)
            if name not in seen:
                seen.add(name)
                out.append((c, name))
    return out


def _settings():
    from . import app            # лениво: app импортирует server, server — этот модуль
    return app


def current_player():
    """Выбранный плеер: из settings.json (общий), не выбирали — MPC, иначе первый найденный, иначе программа системы."""
    v = _settings().read_all().get('player')
    if isinstance(v, str):
        return v
    found = list_players()
    mpc = [p for p, _n in found if player_kind(p) == 'mpc']
    return (mpc or [p for p, _n in found] or [''])[0]


def save_player(path):
    a = _settings()
    with a.SLOCK:
        d = a.read_all()
        d['player'] = path
        try:
            a.write_all(d)
        except OSError as e:
            log.warning('Could not save settings: %s', e)


def players_menu():
    """Для окна «Video player»: найденные плееры и текущий."""
    cur = current_player()
    found = list_players()
    if cur and all(os.path.normcase(p) != os.path.normcase(cur) for p, _n in found):
        found.append((cur, player_name(cur)))
    items = [{'id': p, 'name': n, 'path': p, 'rec': player_kind(p) == 'mpc',
              'current': os.path.normcase(p) == os.path.normcase(cur)} for p, n in found]
    items.append({'id': '', 'name': 'Default app of the system', 'path': '', 'rec': False, 'current': cur == ''})
    return {'players': items, 'current': {'name': player_name(cur), 'path': cur}}


def choose_player(pid):
    """Выбрать плеер из найденных — путь с клиента принимается только из этого списка."""
    pid = pid if isinstance(pid, str) else ''
    if pid and pid != current_player() and all(p != pid for p, _n in list_players()):
        raise ValueError('unknown player')
    save_player(pid)
    return dict(players_menu(), ok=True)


def ask_file(window):
    """Диалог выбора программы: в своём окне — диалог окна, иначе tkinter. Пусто — отменён."""
    start = r'C:\Program Files' if IS_WIN else ('/Applications' if sys.platform == 'darwin' else '/usr/bin')
    if window is not None:
        try:
            import webview
            kind = getattr(getattr(webview, 'FileDialog', None), 'OPEN', None)
            if kind is None:
                kind = webview.OPEN_DIALOG
            types = ('Programs (*.exe)', 'All files (*.*)') if IS_WIN else ()
            r = window.create_file_dialog(kind, directory=start, file_types=types)
            if isinstance(r, (list, tuple)):
                r = r[0] if r else ''
            return r or ''
        except Exception as e:  # noqa: BLE001 — не вышло диалогом окна: пробуем tkinter
            log.warning('The window dialog did not open (%s: %s), using the standard one.', type(e).__name__, e)
    try:
        import tkinter
        from tkinter import filedialog
        root = tkinter.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        try:
            types = [('Programs', '*.exe'), ('All files', '*.*')] if IS_WIN else [('All files', '*')]
            return filedialog.askopenfilename(title='Video player', initialdir=start, filetypes=types) or ''
        finally:
            root.destroy()
    except Exception:  # noqa: BLE001 — нет tkinter или дисплея
        return ''


def pick_player(ctx):
    """Указать плеер вручную: диалог выбора файла на стороне сервера."""
    if not PLOCK.acquire(False):
        raise ValueError('the dialog is already open')
    try:
        path = ask_file(getattr(ctx, 'window', None))
    finally:
        PLOCK.release()
    if not path:
        return {'cancelled': True}
    if not os.path.exists(path):
        raise ValueError('file not found: ' + path)
    save_player(path)
    return dict(players_menu(), ok=True)


def launch(prog, args):
    """Запустить программу отдельно от нас (macOS: приложение .app — через open -a)."""
    if sys.platform == 'darwin' and prog.lower().rstrip('/').endswith('.app'):
        cmd = ['open', '-a', prog] + args
    else:
        cmd = [prog] + args
    kw = {'start_new_session': True} if os.name != 'nt' else {}
    subprocess.Popen(cmd, close_fds=True, **kw)


def write_playlist(files):
    """Список видео для плееров без списка в командной строке: один файл .m3u8."""
    a = _settings()
    path = os.path.join(a.app_dir(), 'playlist.m3u8')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('#EXTM3U\n' + ''.join(x + '\n' for x in files))
    return path


def send_to_mpc(prog, files):
    """MPC: файлы списком; командная строка Windows ограничена 32 767 знаками — длинный список частями с /add."""
    chunks, cur, size = [], [], 0
    for f in files:
        n = len(f) + 3
        if cur and size + n > 24000:
            chunks.append(cur)
            cur, size = [], 0
        cur.append(f)
        size += n
    chunks.append(cur)
    for i, ch in enumerate(chunks):
        subprocess.Popen([prog] + (['/add'] if i > 0 else []) + ch)
        if i + 1 < len(chunks):
            time.sleep(1.5)  # дать первому экземпляру подняться, иначе следующий вызов откроет второе окно


def play(paths):
    """Открыть файлы во внешнем плеере."""
    files = [plain(f) for f in paths if os.path.isfile(f)]
    if not files:
        raise ValueError('the file is not available')
    prog = current_player()
    try:
        if prog and player_kind(prog) == 'mpc':
            send_to_mpc(prog, files)
        else:
            target = files[0] if len(files) == 1 else write_playlist(files)
            if prog:
                launch(prog, [target])
            else:
                open_file(target)
    except OSError as e:
        raise ValueError('could not start %s: %s' % (player_name(prog), getattr(e, 'strerror', None) or e))
    return {'ok': True, 'player': player_name(prog)}


# ───────────────────────── переименование ─────────────────────────

def check_name(name):
    """Новое имя файла: без путей и запрещённых в Windows знаков."""
    if not isinstance(name, str):
        raise ValueError('no name given')
    name = name.strip()
    if not name or name in ('.', '..') or len(name) > 240:
        raise ValueError('bad file name')
    if any(c in BAD_CHARS for c in name) or name.endswith('.') or name.endswith(' '):
        raise ValueError('the name contains characters that are not allowed in file names')
    return name


def rename(ctx, root, fid, old_name, name):
    """Переименовать файл в той же папке; id и миниатюра сохраняются (Library.file_renamed).

    Вся операция — на одной открытой библиотеке; переименование на диске и запись в кеш — под блокировкой записи
    кеша, чтобы между ними не влезло слияние списка этой папки (оно сопоставляет файлы по имени).
    """
    name = check_name(name)
    with ctx.use() as lib:
        row = checked_rows(lib, root, [fid], [old_name])[0]
        old = row['path']
        new = os.path.join(os.path.dirname(old), name)
        if name == row['name']:
            return {'ok': True, 'file': None}
        # смена только регистра в Windows: файл «существует» под новым именем — это он сам
        if os.path.exists(new) and os.path.normcase(new) != os.path.normcase(old):
            raise ValueError('a file with this name already exists')
        with lib.wlock:
            try:
                os.rename(old, new)
            except OSError as e:
                raise ValueError(explain(e))
            f = lib.file_renamed(row['id'], name)
    return {'ok': True, 'file': f} if f else {'ok': True, 'removed': True}


def row_rel(lib, path):
    """rel папки файла относительно корня библиотеки."""
    d = os.path.dirname(plain(path))
    rel = os.path.relpath(d, plain(lib.root))
    return '' if rel == '.' else rel.replace('\\', '/')


def explain(e):
    """Понятный текст ошибки файловой операции."""
    if isinstance(e, PermissionError) or getattr(e, 'winerror', None) in (5, 32, 33):
        return 'the file is in use or access is denied (close the player and try again)'
    if isinstance(e, FileNotFoundError):
        return 'the file is no longer there'
    return getattr(e, 'strerror', None) or str(e)


# ───────────────────────── удаление ─────────────────────────

if IS_WIN:
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [('hwnd', wintypes.HWND), ('wFunc', wintypes.UINT), ('pFrom', wintypes.LPCWSTR),
                    ('pTo', wintypes.LPCWSTR), ('fFlags', ctypes.c_ushort), ('fAnyOperationsAborted', wintypes.BOOL),
                    ('hNameMappings', ctypes.c_void_p), ('lpszProgressTitle', wintypes.LPCWSTR)]

    FO_DELETE = 3
    FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI = 0x4, 0x10, 0x40, 0x400


def recycle(path):
    """Удалить как Delete в проводнике: локальный диск — в корзину Windows; сетевая папка — удаление
    (на NAS его ловит корзина общей папки, если включена). Не Windows — os.remove."""
    if not IS_WIN:
        os.remove(path)
        return
    p = plain(path)
    if len(p) >= 260:                            # SHFileOperation не умеет длинные пути: удалить навсегда нельзя молча
        raise OSError('the path is too long for the Recycle Bin — delete this file in Explorer')
    ctypes.windll.ole32.CoInitializeEx(None, 2)  # оболочке нужна COM-квартира в этой нити
    op = SHFILEOPSTRUCTW(None, FO_DELETE, p + '\0', None,
                         FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI, False, None, None)
    r = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if r != 0 or op.fAnyOperationsAborted:
        if os.path.exists(p):
            raise OSError('could not delete (code %d)' % r)


def delete(ctx, root, ids, names):
    """Удалить файлы; затем перечитать их папки, чтобы кеш и суммы обновились (всё — на одной библиотеке)."""
    deleted, errors, folders = [], [], set()
    with ctx.use() as lib:
        rows = checked_rows(lib, root, ids, names)
        for r in rows:
            try:
                recycle(r['path'])
                deleted.append(r['id'])
            except OSError as e:
                errors.append({'id': r['id'], 'error': explain(e)})
            folders.add(row_rel(lib, r['path']))
        for rel in folders:
            try:
                lib.refresh_dir(rel)
            except Exception:  # noqa: BLE001 — кеш поправит следующий обход
                log.exception('refresh after delete failed: %s', rel)
    log.info('Deleted %d file(s), %d error(s)', len(deleted), len(errors))
    return {'deleted': deleted, 'errors': errors}


# ───────────────────────── буфер обмена (Windows) ─────────────────────────

CF_UNICODETEXT, CF_HDROP, GMEM_MOVEABLE = 13, 15, 0x2


def _clip_api():
    if not IS_WIN:
        raise ValueError('copying to the clipboard works only on Windows')
    k32, u32 = ctypes.windll.kernel32, ctypes.windll.user32
    k32.GlobalAlloc.restype = ctypes.c_void_p
    k32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    k32.GlobalLock.restype = ctypes.c_void_p
    k32.GlobalLock.argtypes = [ctypes.c_void_p]
    k32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    k32.GlobalFree.argtypes = [ctypes.c_void_p]
    u32.SetClipboardData.restype = ctypes.c_void_p
    u32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    u32.OpenClipboard.argtypes = [ctypes.c_void_p]
    u32.RegisterClipboardFormatW.argtypes = [ctypes.c_wchar_p]
    return k32, u32


def _global(k32, data):
    h = k32.GlobalAlloc(GMEM_MOVEABLE, len(data))
    if not h:
        raise ValueError('out of memory for the clipboard')
    p = k32.GlobalLock(h)
    ctypes.memmove(p, data, len(data))
    k32.GlobalUnlock(h)
    return h


def _set_clipboard(items):
    """Положить в буфер [(формат, байты)]; буфер может быть занят другой программой — несколько попыток."""
    k32, u32 = _clip_api()
    for _ in range(20):
        if u32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise ValueError('the clipboard is busy, try again')
    try:
        u32.EmptyClipboard()
        for fmt, data in items:
            h = _global(k32, data)
            if not u32.SetClipboardData(fmt, h):
                k32.GlobalFree(h)
                raise ValueError('could not put data into the clipboard')
    finally:
        u32.CloseClipboard()


def clip_text(text):
    _set_clipboard([(CF_UNICODETEXT, (text + '\0').encode('utf-16-le'))])


def clip_files(paths):
    """Файлы в буфер как при «Копировать» в проводнике: Ctrl+V в папке вставит их копии."""
    _k32, u32 = _clip_api()
    # DROPFILES: смещение списка (20), точка (0, 0), fNC, fWide=1; затем пути UTF-16 через \0 и ещё один \0 в конце
    head = (20).to_bytes(4, 'little') + bytes(8) + (0).to_bytes(4, 'little') + (1).to_bytes(4, 'little')
    body = ''.join(p + '\0' for p in paths) + '\0'
    effect = u32.RegisterClipboardFormatW('Preferred DropEffect')
    _set_clipboard([(CF_HDROP, head + body.encode('utf-16-le')),
                    (effect, (1).to_bytes(4, 'little'))])    # DROPEFFECT_COPY: вставить копию, а не переместить
