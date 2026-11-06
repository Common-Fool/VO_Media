"""Обновления с GitHub и поддержка проекта — решения VO SP."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser

from . import APP, VERSION, REPO, LINKS, ASSETS


class UpdateError(ValueError):
    """Ошибка обновления с кодом для HTTP."""

    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


def configure(read, write, lock, prepare_restart):
    """Настройки и остановка приложения передаются из app.py без обратного импорта."""
    global read_settings, write_settings, SLOCK, before_restart
    read_settings, write_settings, SLOCK, before_restart = read, write, lock, prepare_restart


def base_dir():
    """Папка программы: рядом с VO_Media.exe, .app, AppImage или vomedia.py.

    В собранном onefile-exe __file__ указывает во временную папку распаковки, поэтому берём путь к самому exe.
    """
    if getattr(sys, 'frozen', False):
        app = mac_bundle()
        if app:  # macOS: сам exe лежит внутри VO_Media.app/Contents/MacOS, «рядом с программой» — это рядом с .app
            return os.path.dirname(app)
        if os.environ.get('APPIMAGE'):  # Linux AppImage: рядом с файлом .AppImage, а не во временной точке монтирования
            return os.path.dirname(os.path.abspath(os.environ['APPIMAGE']))
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def mac_bundle():
    """Путь к VO_Media.app, если программа запущена из собранного приложения macOS; иначе ''."""
    if sys.platform != 'darwin' or not getattr(sys, 'frozen', False):
        return ''
    p = os.path.abspath(sys.executable)
    for _ in range(3):
        p = os.path.dirname(p)
    return p if p.lower().endswith('.app') else ''


def fix_env():
    """Окружение для запуска чужих программ (плеер, браузер).

    macOS: у приложения, запущенного из Finder, в PATH нет Homebrew — mpv из brew иначе не находится.
    Linux, собранная версия: PyInstaller подменяет LD_LIBRARY_PATH на свои библиотеки, и системный плеер или браузер
    подхватывают их и падают. Нам самим это уже не нужно (библиотеки загружены при запуске), детям — вредно.
    """
    if sys.platform == 'darwin':
        path = os.environ.get('PATH', '').split(os.pathsep)
        for d in ('/opt/homebrew/bin', '/usr/local/bin'):
            if d not in path and os.path.isdir(d):
                path.append(d)
        os.environ['PATH'] = os.pathsep.join(x for x in path if x)
    elif os.name != 'nt' and getattr(sys, 'frozen', False):
        orig = os.environ.pop('LD_LIBRARY_PATH_ORIG', None)
        if orig:
            os.environ['LD_LIBRARY_PATH'] = orig
        else:
            os.environ.pop('LD_LIBRARY_PATH', None)


DONATE_DAYS = (7, 30)  # напоминание о донатах: обычно и после «Remind me less often»
UPD = {'checked': 0, 'checking': False, 'error': '', 'latest': '', 'newer': False, 'page': '', 'notes': '',
       'asset': '', 'size': 0, 'digest': '', 'running': False, 'stage': '', 'done': 0, 'total': 0}
ULOCK = threading.Lock()


def vtuple(tag):
    return tuple(int(x) for x in re.findall(r'\d+', tag or ''))


def http_get(url, timeout=20):
    import urllib.request
    req = urllib.request.Request(url, headers={'User-Agent': APP + '/' + VERSION, 'Accept': 'application/vnd.github+json'})
    return urllib.request.urlopen(req, timeout=timeout)


def install_kind():
    """Как установлена программа: exe (Windows), app (macOS), appimage (Linux), source (пакет исходников) или '' — не знаем."""
    if not getattr(sys, 'frozen', False):
        return 'source'
    if os.name == 'nt':
        return 'exe'
    if mac_bundle():
        return 'app'
    return 'appimage' if os.environ.get('APPIMAGE') else ''


def check_update(background=False):
    """Последний релиз на GitHub и файл для этой сборки. Ошибки сети — в UPD['error']."""
    with ULOCK:
        if UPD['checking'] or (background and UPD['checked']):
            return
        UPD['checking'] = True
    if background:
        threading.Thread(target=_check_update, daemon=True).start()
    else:
        _check_update()


def _check_update():
    try:
        with http_get('https://api.github.com/repos/%s/releases/latest' % REPO) as r:
            j = json.loads(r.read().decode('utf-8'))
        want = ASSETS.get(install_kind(), '').lower()
        exe = next((a for a in j.get('assets') or [] if str(a.get('name', '')).lower() == want), {})
        tag = str(j.get('tag_name') or '')
        with ULOCK:
            UPD.update(latest=tag, newer=vtuple(tag) > vtuple(VERSION), page=str(j.get('html_url') or LINKS['releases']),
                       notes=str(j.get('body') or '')[:3000], asset=str(exe.get('browser_download_url') or ''),
                       size=int(exe.get('size') or 0), digest=str(exe.get('digest') or ''), error='')
    except Exception as e:  # noqa: BLE001 — нет сети, лимит GitHub, странный ответ: проверка просто не удалась
        with ULOCK:
            UPD['error'] = 'could not reach GitHub (%s)' % (getattr(e, 'reason', None) or e)
    finally:
        with ULOCK:
            UPD['checking'] = False
            UPD['checked'] = time.time()


def update_status():
    with ULOCK:
        return dict(UPD, version=VERSION, kind=install_kind())


def update_start():
    """Скачать новую сборку, подменить exe, app или AppImage и перезапуститься."""
    with ULOCK:
        if UPD['running']:
            return
        if not UPD['newer']:
            raise UpdateError('no newer version', 409)
        kind = install_kind()
        if kind not in ASSETS:
            raise UpdateError('this build cannot update itself: download the new version from the release page', 409)
        if not UPD['asset']:
            raise UpdateError('the release has no %s yet: try again in a few minutes' % ASSETS[kind], 409)
        UPD.update(running=True, stage='downloading', done=0, total=UPD['size'], error='')
    threading.Thread(target=update_worker, daemon=True).start()


def download(url, total=0):
    import hashlib
    buf = bytearray()
    with http_get(url, timeout=60) as r:
        total = total or int(r.headers.get('Content-Length') or 0)
        with ULOCK:
            UPD['total'] = total
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            buf += chunk
            with ULOCK:
                UPD['done'] = len(buf)
    if total and len(buf) != total:
        raise RuntimeError('download incomplete')
    return bytes(buf), hashlib.sha256(buf).hexdigest()


def check_digest(sha, digest):
    if digest.startswith('sha256:') and digest[7:].lower() != sha:
        raise RuntimeError('checksum mismatch')


def update_worker():
    kind, dst = install_kind(), ''
    try:
        with ULOCK:
            tag, asset, size, digest = UPD['latest'], UPD['asset'], UPD['size'], UPD['digest']
        if kind not in ASSETS:
            raise RuntimeError('this build cannot update itself: download the new version from the release page')
        data, sha = download(asset, size)
        check_digest(sha, digest)
        magic = {'exe': b'MZ', 'app': b'PK', 'appimage': b'\x7fELF'}[kind]
        if not data.startswith(magic):
            raise RuntimeError('the downloaded file is not a %s' % ASSETS[kind])
        dst = mac_bundle() if kind == 'app' else os.path.abspath(os.environ['APPIMAGE'] if kind == 'appimage' else sys.executable)
        with ULOCK:
            UPD['stage'] = 'installing'
        if kind == 'app':
            install_app(dst, data)
        else:
            new = dst + '.new'
            with open(new, 'wb') as f:
                f.write(data)
            if kind == 'appimage':
                os.chmod(new, 0o755)
            if kind == 'exe':
                # запущенный exe в Windows перезаписать нельзя, а переименовать можно: старый уходит в .old
                old = dst + '.old'
                if os.path.exists(old):
                    os.remove(old)
                os.rename(dst, old)
                try:
                    os.rename(new, dst)
                except OSError:
                    os.rename(old, dst)
                    raise
            else:  # AppImage: запущенный файл заменяется переименованием поверх
                os.replace(new, dst)
        with ULOCK:
            UPD['stage'] = 'restarting'
        print('Updated to %s, restarting.' % tag)
        threading.Thread(target=restart, args=(dst,), daemon=True).start()
    except Exception as e:  # noqa: BLE001
        if dst and kind != 'app':
            try:
                os.remove(dst + '.new')
            except OSError:
                pass
        with ULOCK:
            UPD.update(running=False, stage='',
                       error=('no permission to replace ' + dst) if isinstance(e, PermissionError) else str(e))
        print('Update failed:', e)


def install_app(app, data):
    """macOS: распаковать VO_Media.app рядом со старым (ditto сохраняет права и ссылки внутри приложения) и поменять местами.

    Скачанное нами не получает отметку «из интернета», поэтому Gatekeeper новую версию не останавливает.
    """
    parent = os.path.dirname(app)
    tmp = tempfile.mkdtemp(prefix='.vo_media-update-', dir=parent)
    try:
        z = os.path.join(tmp, 'VO_Media.zip')
        with open(z, 'wb') as f:
            f.write(data)
        r = subprocess.run(['ditto', '-x', '-k', z, tmp], capture_output=True, text=True, timeout=300)
        new = os.path.join(tmp, 'VO_Media.app')
        if r.returncode != 0 or not os.path.isdir(new):
            raise RuntimeError('could not unpack the update: ' + (r.stderr.strip().splitlines()[-1] if r.stderr.strip() else 'no VO_Media.app inside'))
        old = app + '.old'
        if os.path.exists(old):
            shutil.rmtree(old, ignore_errors=True)
        os.rename(app, old)
        try:
            os.rename(new, app)
        except OSError:
            os.rename(old, app)
            raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def restart(dst=''):
    """Запустить новую версию с теми же параметрами и выйти. Ответ странице успевает уйти за секунду."""
    time.sleep(1.0)
    args = before_restart()
    env = dict(os.environ)
    kind = install_kind()
    if kind == 'source':
        cmd = [sys.executable, os.path.join(base_dir(), 'vomedia.py')] + args
    else:
        exe = dst or sys.executable
        if kind == 'app':
            exe = os.path.join(dst, 'Contents', 'MacOS', os.path.basename(sys.executable))
        cmd = [exe] + args
        # собранная программа, запущенная из другой собранной, иначе возьмёт её временную папку
        env = {k: v for k, v in env.items() if not k.startswith(('_MEI', '_PYI', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD'))}
        env['PYINSTALLER_RESET_ENVIRONMENT'] = '1'
    if os.name == 'nt':
        kw = {'creationflags': 0x00000008 | 0x00000200}  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw = {'start_new_session': True}
    try:
        subprocess.Popen(cmd, env=env, cwd=base_dir(), close_fds=True, **kw)
    except OSError as e:
        print('Could not restart:', e)
    os._exit(0)


def cleanup_old():
    """После обновления остаётся VO_Media.exe.old (Windows) или VO_Media.app.old (macOS): старый процесс к этому времени вышел."""
    kind = install_kind()
    if kind not in ('exe', 'app'):
        return
    old = (mac_bundle() if kind == 'app' else os.path.abspath(sys.executable)) + '.old'
    for _ in range(10):
        if not os.path.exists(old):
            return
        try:
            if os.path.isdir(old):
                shutil.rmtree(old)
            else:
                os.remove(old)
            return
        except OSError:
            time.sleep(2)


def donate_due():
    """Пора ли напомнить о поддержке. Первый запуск только назначает срок; напомнив, сразу назначаем следующий."""
    with SLOCK:
        d = read_settings()
        s = d.get('donate') if isinstance(d.get('donate'), dict) else {}
        now = time.time()
        nxt = s.get('next') if isinstance(s.get('next'), (int, float)) else 0
        due = bool(nxt) and now >= nxt
        if not nxt or due:
            s['next'] = now + DONATE_DAYS[bool(s.get('rare'))] * 86400
            d['donate'] = s
            try:
                write_settings(d)
            except OSError:
                return False
        return due


def donate_rare():
    """«Remind me less often»: дальше напоминаем реже."""
    with SLOCK:
        d = read_settings()
        d['donate'] = {'rare': True, 'next': time.time() + DONATE_DAYS[1] * 86400}
        try:
            write_settings(d)
        except OSError:
            pass


def open_link(name):
    url = LINKS.get(str(name))
    if not url:
        raise UpdateError('unknown link')
    webbrowser.open(url)
    return {'ok': True}


