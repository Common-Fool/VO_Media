"""HTTP-сервер VO Media: страница, статика, API кеша, отдача файлов (Range) и миниатюр.

Только 127.0.0.1; в каждом запросе (включая /f/, /t/ и статику) нужен токен ?t= и верный заголовок Host.
Сервер сам ничего не знает о Library: всё берёт у ctx (объект App из app.py).
"""
import json
import logging
import os
import re
import secrets
import socket
import socketserver
import sys
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import APP, VERSION

log = logging.getLogger(__name__)

MAX_BODY = 4 * 1024 * 1024   # тело POST (миниатюра ≤ 512 КБ, настройки — мелочь)
CHUNK = 1024 * 1024          # размер куска при отдаче файла

# тип содержимого по расширению файла библиотеки
CTYPES = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v',
}

# статика страницы: только эти файлы (белый список), ничего другого из web/ не отдаётся
STATIC = {
    'app.js': 'application/javascript; charset=utf-8',
    'app.css': 'text/css; charset=utf-8',
}


class Fail(Exception):
    """Ошибка запроса с кодом HTTP и текстом для страницы."""

    def __init__(self, msg, code=400):
        Exception.__init__(self, msg)
        self.code = code


class BadRange(Exception):
    """Заголовок Range неверный или не попадает в файл (ответ 416)."""


def web_dir():
    """Папка web: рядом с этим модулем; в PyInstaller — sys._MEIPASS/vomedia/web."""
    base = getattr(sys, '_MEIPASS', None)
    if base:
        d = os.path.join(base, 'vomedia', 'web')
        if os.path.isdir(d):
            return d
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')


def read_web(name):
    """Прочитать файл из web/ (имя уже проверено вызывающим)."""
    try:
        with open(os.path.join(web_dir(), name), 'rb') as f:
            return f.read()
    except OSError:
        raise Fail('page file is missing: ' + name, 404)


def clean_rel(rel):
    """Относительная папка с клиента: слэши в '/', без '..', без абсолютных путей и дисков. Иначе Fail."""
    rel = (rel or '').replace('\\', '/')
    if '\0' in rel or rel.startswith('/'):
        raise Fail('bad folder path')
    parts = [x for x in rel.split('/') if x not in ('', '.')]
    for x in parts:
        if x == '..' or (os.name == 'nt' and ':' in x):  # в Windows двоеточие — диск или поток NTFS
            raise Fail('bad folder path')
    return '/'.join(parts)


def file_id(s):
    if not (s.isascii() and s.isdigit()) or len(s) > 18:
        raise Fail('not found', 404)
    return int(s)


def parse_range(header, size):
    """Разбор Range для файла в size байт.

    None — Range нет (или единица не bytes, или несколько диапазонов): отдаём файл целиком, 200.
    (a, b) — включительно, 206. BadRange — 416.
    """
    if not header:
        return None
    header = header.strip()
    if not header.lower().startswith('bytes='):
        return None
    spec = header[6:].strip()
    if ',' in spec:
        return None  # несколько диапазонов не поддерживаем: законно ответить целым файлом
    m = re.fullmatch(r'(\d*)\s*-\s*(\d*)', spec)
    if not m or (not m.group(1) and not m.group(2)):
        raise BadRange()
    if size <= 0:
        raise BadRange()
    if not m.group(1):  # bytes=-n: последние n байт
        n = int(m.group(2))
        if n <= 0:
            raise BadRange()
        return max(0, size - n), size - 1
    a = int(m.group(1))
    b = int(m.group(2)) if m.group(2) else size - 1
    if a >= size or b < a:
        raise BadRange()
    return a, min(b, size - 1)


def root_name(root):
    return os.path.basename(root.rstrip('\\/')) or root


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'  # keep-alive: у каждого ответа обязателен Content-Length

    def log_message(self, *args):
        pass

    def reply(self, code, body, ctype='application/json; charset=utf-8', cache='no-store', extra=None):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def jbody(raw):
        try:
            v = json.loads(raw.decode('utf-8') or '{}')
        except ValueError:
            raise Fail('could not parse the request')
        if not isinstance(v, dict):
            raise Fail('could not parse the request')
        return v

    def do_GET(self):
        self.dispatch(False)

    def do_POST(self):
        self.dispatch(True)

    def dispatch(self, post):
        self.started = False  # True — заголовки файла уже отправлены, ответ об ошибке дать нельзя
        raw = b''
        if post:  # тело читаем всегда: иначе при keep-alive оно «слипнется» со следующим запросом
            try:
                n = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                n = 0
            if n > MAX_BODY:
                self.close_connection = True
                return self.reply(413, {'error': 'request too large'})
            raw = self.rfile.read(n) if n > 0 else b''
        ctx = self.server.ctx
        u = urlparse(self.path)
        q = parse_qs(u.query)
        t = q.get('t', [''])[0]
        port = self.server.server_address[1]
        host = (self.headers.get('Host') or '').lower()
        # принимаем только запросы с ключом из адреса и только на локальный адрес
        if host not in ('127.0.0.1:%d' % port, 'localhost:%d' % port) or \
                not secrets.compare_digest(t.encode('utf-8', 'replace'), ctx.token.encode()):
            return self.reply(403, {'error': 'access denied'})
        p = u.path.strip('/').split('/')
        try:
            if post:
                self.route_post(p, raw)
            else:
                self.route_get(p, q)
        except (ConnectionError, socket.timeout):  # браузер оборвал запрос (перемотка видео, уход со страницы)
            self.close_connection = True
        except Fail as e:
            self.safe_reply(e.code, {'error': str(e)})
        except BadRange:
            self.close_connection = True
        except (FileNotFoundError, NotADirectoryError):
            self.safe_reply(404, {'error': 'file not found'})
        except Exception as e:  # noqa: BLE001 — любой сбой даёт 500, а не оборванное соединение
            if not isinstance(e, OSError):
                log.exception('request failed: %s', self.path.split('?')[0])
            else:
                log.warning('request failed: %s: %s', self.path.split('?')[0], e)
            self.close_connection = True
            self.safe_reply(500, {'error': '%s' % e})

    def safe_reply(self, code, body):
        """Ответ об ошибке; если файл уже наполовину отправлен — только закрыть соединение."""
        if self.started:
            self.close_connection = True
            return
        try:
            self.reply(code, body)
        except (ConnectionError, socket.timeout):
            self.close_connection = True

    # ───── GET ─────

    def route_get(self, p, q):
        ctx = self.server.ctx

        def qv(name):
            return q.get(name, [''])[0]

        if p == ['']:
            return self.page()
        if len(p) == 2 and p[0] == 'web':
            if p[1] not in STATIC:
                raise Fail('not found', 404)
            return self.reply(200, read_web(p[1]), STATIC[p[1]], cache='no-cache')
        if p == ['api', 'dir']:
            rel = clean_rel(qv('rel'))
            fresh = qv('fresh') in ('1', 'true')
            with ctx.use() as lib:
                lib.touch()
                changed = False
                if fresh:
                    lib.prioritize(rel)
                    changed = bool(lib.refresh_dir(rel))
                d = lib.list_dir(rel)
            if d is None:
                d = {'rel': rel, 'missing': True}
            if fresh:
                d['changed'] = changed
            return self.reply(200, d)
        if p == ['api', 'tree']:
            rel = clean_rel(qv('rel'))
            with ctx.use() as lib:
                dirs = lib.subdirs(rel)
            return self.reply(200, {'rel': rel, 'dirs': dirs or []})
        if p == ['api', 'index']:
            with ctx.use() as lib:
                return self.reply(200, lib.index_status())
        if len(p) == 2 and p[0] == 'f':
            return self.send_file(file_id(p[1]))
        if len(p) == 2 and p[0] == 't':
            fid = file_id(p[1])
            with ctx.use() as lib:
                lib.touch()
                data = lib.get_thumb(fid)
            if not data:
                raise Fail('no thumbnail', 404)
            return self.reply(200, data, 'image/jpeg', cache='private, max-age=31536000')
        raise Fail('not found', 404)

    def page(self):
        """index.html с подставленным объектом BOOT."""
        ctx = self.server.ctx
        with ctx.use() as lib:  # на время сборки смена папки подождёт: корень и настройки согласованы
            root = lib.root
            boot = {'token': ctx.token, 'app': APP, 'version': VERSION, 'root': root, 'rootName': root_name(root),
                    'settings': ctx.load_settings(), 'recent': ctx.recent()}
        # '<' экранируем, чтобы имя папки не закрыло <script>
        data = json.dumps(boot).replace('<', '\\u003c')
        html = read_web('index.html').decode('utf-8').replace('/*BOOT*/{}', data, 1)
        self.reply(200, html.encode('utf-8'), 'text/html; charset=utf-8')

    def send_file(self, fid):
        """Файл библиотеки с поддержкой Range (<video> перематывает именно так)."""
        ctx = self.server.ctx
        with ctx.use() as lib:
            lib.touch()
            row = lib.file_row(fid)
        if not row:
            raise Fail('file not found', 404)
        path = row['path']
        ctype = CTYPES.get(os.path.splitext(path)[1].lower(), 'application/octet-stream')
        with open(path, 'rb', buffering=0) as f:
            st = os.fstat(f.fileno())
            size = st.st_size
            try:
                rng = parse_range(self.headers.get('Range'), size)
            except BadRange:
                return self.reply(416, {'error': 'range not satisfiable'}, extra={'Content-Range': 'bytes */%d' % size})
            if rng is None:
                code, a, b = 200, 0, size - 1
            else:
                code, (a, b) = 206, rng
            n = max(0, b - a + 1)
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(n))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Last-Modified', formatdate(st.st_mtime, usegmt=True))
            self.send_header('Cache-Control', 'private, max-age=300')
            self.send_header('X-Content-Type-Options', 'nosniff')
            if code == 206:
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (a, b, size))
            self.end_headers()
            self.started = True
            if n and a:
                f.seek(a)
            left = n
            while left > 0:
                chunk = f.read(min(CHUNK, left))
                if not chunk:  # файл стал короче, чем обещано: Content-Length уже не выполнить
                    self.close_connection = True
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    # ───── POST ─────

    def route_post(self, p, raw):
        ctx = self.server.ctx
        if len(p) == 3 and p[:2] == ['api', 'thumb']:
            fid = file_id(p[2])
            with ctx.use() as lib:
                ok = lib.put_thumb(fid, raw)
            if not ok:
                raise Fail('thumbnail rejected')
            return self.reply(200, {'ok': True})
        if p == ['api', 'index', 'start']:
            full = bool(self.jbody(raw).get('full'))
            with ctx.use() as lib:
                lib.start_index(full)
                return self.reply(200, lib.index_status())
        if p == ['api', 'index', 'stop']:
            with ctx.use() as lib:
                lib.stop_index()
                return self.reply(200, lib.index_status())
        if p == ['api', 'settings']:
            ctx.save_settings(self.jbody(raw))
            return self.reply(200, {'ok': True})
        if p == ['api', 'root', 'pick']:
            try:
                folder = ctx.pick_folder()
                if not folder:
                    return self.reply(200, {'cancelled': True})
                ctx.switch_root(folder)
            except ValueError as e:
                raise Fail(str(e), 409)
            return self.reply(200, {'ok': True})
        if p == ['api', 'root', 'recent']:
            folder = self.jbody(raw).get('folder')
            # путь с клиента принимается только из списка недавних
            if not isinstance(folder, str) or folder not in ctx.recent():
                raise Fail('this folder is not in the recent list')
            try:
                ctx.switch_root(folder)
            except ValueError as e:
                raise Fail(str(e), 409)
            return self.reply(200, {'ok': True})
        raise Fail('not found', 404)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64
    ctx = None
    # В Windows SO_REUSEADDR разрешает занять порт, который уже слушает другая программа (в том числе второй
    # экземпляр этой же): запросы окна попадали на чужой сервер с другим ключом и получали «access denied».
    # Поэтому в Windows порт занимается монопольно.
    allow_reuse_address = os.name != 'nt'

    def server_bind(self):
        if os.name == 'nt' and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        # без HTTPServer.server_bind: он зовёт getfqdn(), а обратный поиск имени для 127.0.0.1 бывает медленным
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (ConnectionError, socket.timeout)):
            log.error('connection handler failed', exc_info=True)


def make_server(port, ctx):
    """Сервер на 127.0.0.1:port (0 — свободный порт). Порт занят — берём свободный."""
    try:
        srv = Server(('127.0.0.1', port), Handler)
    except OSError:
        if not port:
            raise
        log.warning('Port %d is busy, using a free one.', port)
        srv = Server(('127.0.0.1', 0), Handler)
    srv.ctx = ctx
    return srv
