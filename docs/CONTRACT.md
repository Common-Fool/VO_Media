# VO Media — договор модулей (v0.1)

Общий договор для всех, кто пишет код. Имена функций, полей, путей API и форматов JSON — **ровно как здесь**.
Если что-то в договоре не сходится или не хватает — не выдумывать молча: сделать самый простой вариант и написать об этом в отчёте.

## Что это

Просмотрщик фото и видео для огромной библиотеки (больше 1 млн файлов, тысячи подпапок) на NAS Synology по SMB.
Окно — pywebview (WebView2) или браузер; внутри локальный HTTP-сервер и страница. Главное — **отзывчивость**:
всё, что можно, берётся из локального кеша (SQLite + миниатюры на локальном диске), NAS читается как можно меньше и мелкими порциями.
Первая версия — **только просмотр**: на диске библиотеки ничего не создаётся, не переносится и не удаляется.

- Python 3.8+, только стандартная библиотека. `pywebview` — необязательный (нет — открываемся в браузере). ffmpeg **не нужен**.
- Основная система — Windows 10/11, работать должно и на macOS/Linux.
- Фото: `.jpg .jpeg .png .webp .gif`. Видео: `.mp4 .m4v` (H.264, играются тегом `<video>` напрямую). Остальное не показывается.
- Интерфейс, сообщения, журнал, `--help` — на английском. Комментарии и докстринги — по-русски, коротко.
- Образец стиля и готовых решений — `..\Steam_View\pairview.py` (VSPO) и его `CLAUDE.md`.

## Файлы

```
vomedia.py                 точка входа: from vomedia.app import main; main()
vomedia/__init__.py        APP = 'VO Media', VERSION = '0.1.0'
vomedia/meta.py            разбор заголовков файлов (без зависимостей от других модулей)
vomedia/index.py           кеш SQLite, обход, фоновые нити, миниатюры (зависит только от meta)
vomedia/server.py          HTTP (зависит от index)
vomedia/app.py             запуск, параметры, настройки, окно (зависит от index, server)
vomedia/web/index.html     страница
vomedia/web/app.css
vomedia/web/app.js         весь интерфейс, ванильный JS, без библиотек и CDN (работа без интернета)
tools/nas_probe.py         разовый скрипт замеров на NAS (самостоятельный)
```

---

## meta.py

Чистые функции, никаких глобальных состояний, никогда не бросают исключений наружу (ошибка → пустой результат).
Файл открывать `open(path, 'rb', buffering=0)` и читать только нужное: по SMB каждое чтение дорогое.

```python
PHOTO_EXT = frozenset({'.jpg', '.jpeg', '.png', '.webp', '.gif'})
VIDEO_EXT = frozenset({'.mp4', '.m4v'})

def kind_of(name: str) -> str | None
    # 'photo' | 'video' | None — по расширению, без учёта регистра

def read_meta(path: str, kind: str) -> dict
    # {'w': int|None, 'h': int|None, 'duration': float|None, 'rot': int}
    # фото: размеры из заголовка; для JPEG с EXIF Orientation 5..8 w и h меняются местами (как увидит пользователь);
    #       'rot' — значение EXIF Orientation (1, если нет). duration = None.
    # видео mp4/m4v: duration из moov/mvhd (timescale, версии 0 и 1), w/h — из tkhd первой видеодорожки
    #       (hdlr == 'vide'; ширина/высота — 16.16 fixed). moov бывает и в начале, и в конце файла:
    #       идём по атомам верхнего уровня, читая только их заголовки (8/16 байт, size==1 → 64-битный размер,
    #       size==0 → до конца файла), потом читаем moov целиком (если moov > 64 МБ — сдаёмся).
    #       rot = 1.
    # Ошибка/неизвестный формат → {'w': None, 'h': None, 'duration': None, 'rot': 1}

def exif_thumb(path: str) -> bytes | None
    # встроенная JPEG-миниатюра из EXIF (APP1, IFD1: JPEGInterchangeFormat/Length), читать не больше первых 128 КБ.
    # Вернуть None, если миниатюры нет, она меньше 120 px по большей стороне, или Orientation основного снимка != 1
    # (повёрнутую миниатюру проще сгенерировать заново на странице). Проверить, что байты начинаются с FFD8.
```

Размеры изображений: JPEG — маркеры SOF0..SOF15 кроме C4/C8/CC; PNG — IHDR; GIF — логический экран;
WebP — `VP8 ` / `VP8L` / `VP8X`.

---

## index.py

### Где лежит кеш

`cache_dir(root) -> str` — `<app_dir>/cache/<sha1(normcase(abspath(root)))[:16]>/`, внутри `library.sqlite` и папка `thumbs/`.
`app_dir()` — в `index.py`: переменная окружения `VOMEDIA_HOME`, иначе Windows `%APPDATA%\VO Media`, macOS `~/Library/Application Support/VO Media`,
Linux `$XDG_CONFIG_HOME/vo-media` (или `~/.config/vo-media`). Создаётся при первом обращении. `app.py` берёт `app_dir()` отсюда.

### Схема БД

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS meta_kv(k TEXT PRIMARY KEY, v TEXT);          -- schema=1, root, full_done=<unix time>
CREATE TABLE IF NOT EXISTS dirs(
  id INTEGER PRIMARY KEY, parent INTEGER,          -- корень: id=1, parent NULL, rel=''
  rel TEXT UNIQUE NOT NULL,                        -- путь от корня через '/', как на диске (регистр сохраняется)
  name TEXT NOT NULL, mtime REAL,                  -- mtime папки на момент последнего чтения списка
  listed REAL,                                     -- когда читали список (unix time), NULL — ни разу
  own_photo INTEGER DEFAULT 0, own_video INTEGER DEFAULT 0, own_size INTEGER DEFAULT 0,  -- только файлы самой папки
  n_photo INTEGER DEFAULT 0, n_video INTEGER DEFAULT 0, size INTEGER DEFAULT 0,          -- рекурсивно, с подпапками
  n_dirs INTEGER DEFAULT 0);                       -- прямых подпапок
CREATE INDEX IF NOT EXISTS dirs_parent ON dirs(parent);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY, dir INTEGER NOT NULL, name TEXT NOT NULL,
  kind INTEGER NOT NULL,                           -- 1 photo, 2 video
  size INTEGER, mtime REAL,
  w INTEGER, h INTEGER, duration REAL, rot INTEGER,
  meta INTEGER DEFAULT 0,                          -- 0 не читали, 1 прочитано, 2 ошибка
  thumb INTEGER DEFAULT 0,                         -- 0 нет, 1 есть в кеше, 2 не удалось
  UNIQUE(dir, name));
CREATE INDEX IF NOT EXISTS files_meta ON files(meta) WHERE meta = 0;
```

`id` файлов и папок стабильны: при перечитывании папки строки сопоставляются по `(dir, name)`; изменился размер или mtime файла →
`meta=0, thumb=0`, файл миниатюры удаляется. Исчезла подпапка → удаляется всё её поддерево (файлы, миниатюры, строки dirs).

### Что пропускается при обходе

Папки с именами на `.`, `@`, `#`, `$` (`@eaDir`, `#recycle`, `$RECYCLE.BIN`), `System Volume Information`, `_to_delete`, `_на_удаление`.
Ссылки на папки (symlink/junction) не обходятся. Файлы — только с `kind_of() != None`, скрытые (на `.`) пропускаются.

### Класс Library

Один объект на открытую папку. Потокобезопасен: у каждой нити своё соединение sqlite (`threading.local`), запись — под `self.wlock`
(одна запись за раз), `timeout=30`. Чтение — без блокировки (WAL).

```python
class Library:
    def __init__(self, root: str)               # открыть/создать БД, проверить schema, создать корень dirs(id=1)
    root: str                                   # абсолютный путь
    def close(self)                             # остановить нити, закрыть соединения

    # --- чтение для страницы (только кеш, NAS не трогает) ---
    def list_dir(self, rel: str) -> dict | None # None — папки нет в кеше
    def subdirs(self, rel: str) -> list | None  # только подпапки (для дерева слева)
    def file_path(self, fid: int) -> str | None # абсолютный путь файла по id
    def file_row(self, fid: int) -> dict | None # {'id','name','kind','size','mtime','path'} — kind строкой

    # --- свежий список одной папки (читает NAS, вызывается из нити HTTP) ---
    def refresh_dir(self, rel: str) -> bool     # os.scandir папки, слияние с кешем, поправка агрегатов вверх по цепочке;
                                                # True — что-то изменилось. Папки нет на диске → удалить из кеша, вернуть True.
                                                # Новые подпапки добавляются строкой dirs (listed=NULL), внутрь не заходим.
    def touch(self)                             # пользователь что-то делает: фоновые нити уступают ~1,5 с
    def prioritize(self, rel: str)              # метаданные файлов этой папки читать в первую очередь

    # --- фоновая индексация ---
    def start_index(self, full: bool = False)   # запустить обход (если уже идёт — full усиливает текущий)
    def stop_index(self)
    def index_status(self) -> dict

    # --- миниатюры ---
    def thumb_file(self, fid: int) -> str       # <cache>/thumbs/<id % 256 в hex, 2 знака>/<id>.jpg
    def get_thumb(self, fid: int) -> bytes | None   # из кеша; нет и это JPEG-фото с thumb=0 → meta.exif_thumb,
                                                # удалось — сохранить (thumb=1) и вернуть; иначе None
    def put_thumb(self, fid: int, data: bytes) -> bool  # проверить FFD8 и размер ≤ 512 КБ, записать через .part + os.replace, thumb=1
```

Формат `list_dir`:

```json
{"rel": "Trips/2024", "name": "2024", "listed": 1730000000.0, "mtime": 1729990000.0,
 "parents": [{"rel": "", "name": "<имя корня>"}, {"rel": "Trips", "name": "Trips"}],
 "dirs": [{"rel": "Trips/2024/Rome", "name": "Rome", "n_photo": 120, "n_video": 4, "size": 3456789012,
           "n_dirs": 2, "mtime": 1729000000.0, "listed": 1730000000.0, "thumbs": [[11, 1728000000.0], [12, 1728000100.0]]}],
 "files": [{"id": 11, "name": "IMG_0001.jpg", "kind": "photo", "size": 3456789, "mtime": 1728000000.0,
            "w": 4032, "h": 3024, "duration": null, "thumb": 1}]}
```

`dirs[].thumbs` — до 4 пар `[id, mtime]` файлов с `thumb=1` из этой папки или (если в ней мало) из её поддерева — одним дешёвым запросом
(например, `files JOIN dirs WHERE dirs.rel LIKE 'rel/%' AND thumb=1 LIMIT 4`), без обхода. Порядок `files` — по имени; сортирует страница.
`subdirs` — тот же формат, что `dirs` в `list_dir`.

### Агрегаты

При `refresh_dir` и в обходе: считаем новые `own_*` папки, разницу (`d_photo, d_video, d_size`) прибавляем к `n_photo/n_video/size`
самой папки и всех предков (цепочка по `parent`, одной транзакцией). Удаление поддерева вычитает его итоги из предков.
После полного обхода — `recompute_totals()` (один проход снизу вверх по глубине) для страховки от расхождений.

### Фоновый обход (нить `indexer`)

- Обход в ширину от корня. Для каждой папки: `os.stat` папки. Если `full=False`, папка уже читалась (`listed` не NULL)
  и `mtime` совпадает — список **не** перечитывается, идём в известные подпапки из кеша. Иначе — как `refresh_dir`.
- Пауза: если `touch()` был меньше 1,5 с назад — спать до истечения. Между папками — без задержек.
- `index_status()`:
  `{"running": bool, "full": bool, "dirs": <пройдено папок>, "listed": <перечитано списков>, "files": <всего файлов в кеше>,
    "current": "<rel>", "started": ts|null, "finished": ts|null, "error": ""|"..."}`
- Ошибка доступа к одной папке — пропустить, записать в журнал (`logging`), идти дальше. Остановка — по флагу, между папками.
- В конце полного обхода (`full=True` или первый обход пустой БД) — `recompute_totals()`, `meta_kv.full_done`.

### Нить метаданных (`meta`)

Берёт файлы с `meta=0` пачками по 200: сначала из папок, переданных `prioritize()` (последние 3), потом любые.
`meta.read_meta` → запись `w,h,duration,rot,meta=1` (ошибка → `meta=2`). Уступает `touch()` так же. Работает всегда, пока есть работа;
нет работы — ждёт `threading.Event` (будит `refresh_dir`/обход, если появились новые файлы).

---

## server.py

По образцу `Handler`/`Server` из `pairview.py`: `ThreadingHTTPServer`, только `127.0.0.1`, токен `?t=` в каждом запросе
(в том числе `/f/`, `/t/`, статика), проверка `Host`, в Windows `SO_EXCLUSIVEADDRUSE` и `allow_reuse_address=False`, тело POST читается всегда,
ошибки — JSON `{"error": "..."}` с кодом. `ConnectionResetError`/`BrokenPipeError`/`ConnectionAbortedError` при отдаче — тихо.

```python
class Server(ThreadingHTTPServer): ...
def make_server(port: int, ctx) -> Server       # ctx — объект App из app.py (см. ниже), сервер берёт из него lib/settings
```

`ctx` даёт: `ctx.lib` (Library), `ctx.token`, `ctx.load_settings() -> dict`, `ctx.save_settings(d)`, `ctx.recent() -> list[str]`,
`ctx.switch_root(folder) -> None` (бросает `ValueError` с текстом для пользователя), `ctx.pick_folder() -> str` (диалог, '' — отмена),
`ctx.window` (pywebview-окно или None).

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/` | `web/index.html`, в нём заменить `/*BOOT*/{}` на JSON `{"token","app","version","root","rootName","settings","recent"}` |
| GET | `/web/app.js`, `/web/app.css` | статика из папки `web` (рядом с модулем; в PyInstaller — `sys._MEIPASS/vomedia/web`) |
| GET | `/api/dir?rel=` | `lib.list_dir(rel)`; нет в кеше → `{"rel": rel, "missing": true}` (страница сразу просит `fresh`) |
| GET | `/api/dir?rel=&fresh=1` | `lib.refresh_dir(rel)`, затем `list_dir`; плюс поле `"changed": bool`; `lib.prioritize(rel)` |
| GET | `/api/tree?rel=` | `{"rel", "dirs": lib.subdirs(rel)}` |
| GET | `/f/<id>` | файл; **Range** (`bytes=a-b`, `bytes=a-`, `bytes=-n`) → 206 + `Content-Range`; без Range → 200; `Accept-Ranges: bytes`; `Content-Type` по расширению; `Last-Modified`; чтение кусками по 1 МБ; нет файла → 404; неверный Range → 416 |
| GET | `/t/<id>` | `lib.get_thumb(id)` → 200 `image/jpeg`, `Cache-Control: private, max-age=31536000` (страница добавляет `&v=<mtime>`); нет → 404 |
| POST | `/api/thumb/<id>` | тело — JPEG (`Content-Type: image/jpeg`), ≤ 512 КБ → `lib.put_thumb` → `{"ok": true}` |
| GET | `/s/<id>` | раскадровка видео (JPEG-спрайт, см. «Раскадровка»), как `/t/`: 200 с долгим кешем (страница добавляет `&v=<mtime>`) или 404 |
| POST | `/api/story/<id>` | тело — JPEG-спрайт ≤ 4 МБ → `lib.put_story` → `{"ok": true}` |
| GET | `/api/neighbor?rel=&step=1\|-1` | `{"rel": <rel>\|null}` — следующая/предыдущая папка в порядке дерева (обход в глубину, подпапки по имени естественно), в которой есть свои файлы (`own_photo + own_video > 0`); только кеш |
| GET | `/api/index` | `lib.index_status()` |
| POST | `/api/index/start` | `{"full": bool}` → `lib.start_index(full)` → статус |
| POST | `/api/index/stop` | `lib.stop_index()` → статус |
| GET | `/api/cache` | `{current: {root, thumbs, story, db, n_thumbs, n_story, limit, ready}, others: [{key, root, bytes, opened}], limit_gb}` (байты; `limit` 0 — без лимита) |
| POST | `/api/cache/limit` · `clear` · `reset` · `remove` | `{gb}` — лимит места миниатюр и раскадровок (в settings.json `cache_limit_gb`, по умолчанию 20); `clear` — удалить миниатюры и раскадровки этой библиотеки; `reset` — весь кеш этой библиотеки и полный обход; `remove {key}` — кеш другой библиотеки. Ответ — как GET `/api/cache` |
| POST | `/api/settings` | JSON настроек этой папки → `ctx.save_settings` → `{"ok": true}` |
| POST | `/api/root/pick` | `ctx.pick_folder()` → `ctx.switch_root(f)` → `{"ok": true}` или `{"cancelled": true}` |
| POST | `/api/root/recent` | `{"folder"}` — только из `ctx.recent()` → `ctx.switch_root` → `{"ok": true}` |

`rel` с клиента: нормализовать (`/` и `\`), запрещено `..`, абсолютные пути и выход за корень (как `inside_root()` в VSPO).
Каждый запрос `/api/dir`, `/f/`, `/t/` вызывает `lib.touch()`. Пока идёт `switch_root`, запросы ждут (блокировка в ctx).

---

## app.py

- `main()`: разбор параметров (`argparse`): `folder` (необязательный), `--port N` (0 — свободный), `--browser`, `--no-browser`.
- `setup_log()`: журнал в `<app_dir>/vomedia.log` (+ консоль, если есть); `die(msg)` — в Windows без консоли `MessageBoxW`, как в VSPO.
- Настройки — `<app_dir>/settings.json`: `{"recent": [...до 10], "last_folder": "...", "roots": {"<normcase(root)>": {...}}}`.
  Настройки папки (то, что пишет страница) — объект как есть, сервер в них не лезет. Запись через `.part` + `os.replace`, под блокировкой.
- Папка при запуске: аргумент → `last_folder` → диалог (`tkinter.filedialog.askdirectory`) → нет — `die`.
- Класс `App` — тот самый `ctx` для сервера (поля и методы — выше). `switch_root`: закрыть старую `Library`, открыть новую,
  запомнить в `recent`/`last_folder`, запустить обход (`start_index(full=False)`; если в БД ещё нет `full_done` — `full=True`).
- При запуске — то же: открыть `Library`, сразу запустить фоновый обход (см. правило выше). Окно не ждёт обхода.
- Окно: `run_window(url, title)` как в VSPO (pywebview, в Windows `gui='edgechromium'`, размер 1600×1000, `WindowApi.set_fullscreen(on)`
  через `window.toggle_fullscreen()`), нет pywebview/WebView2 → браузер (`webbrowser.open`), `--no-browser` — только сервер.
- `pick_folder()`: в окне pywebview — `create_file_dialog(FOLDER_DIALOG)`, иначе tkinter, как `ask_folder()` в VSPO.

---

## Страница (web/)

`index.html` содержит `<script>const BOOT = /*BOOT*/{};</script>` и маленький встроенный скрипт, который подключает
`/web/app.css?t=` + `BOOT.token` и `/web/app.js?t=` + `BOOT.token` (`document.head.append(...)`). Все запросы к серверу — с `?t=` / `&t=`.

### Вид

Тёмная тема, цвета — переменные в `:root`, акцент — градиент `#7c5cff → #1e9bff` (как в VSPO). Шрифт системный.

- **Шапка**: кнопка «Folder: <имя корня> ▾» (меню: недавние папки, «Open folder…»), хлебные крошки (`parents` + текущая),
  сортировка (Name / Date / Size / Duration, кнопка ↑↓), фильтр (All / Photos / Videos), ползунок размера плиток,
  переключатель вида папок (Tiles / List), статус индексации справа («Indexing… 12 345 folders · 1 234 567 files», кнопка Stop),
  меню ☰: «Update library» (`start_index` full=false), «Full rescan» (full=true), «Keyboard shortcuts», версия.
- **Дерево слева** (ширина меняется перетаскиванием, можно скрыть): ленивая подгрузка `/api/tree`, у каждой папки — число файлов
  (`n_photo + n_video`) и размер. Клик — открыть папку.
- **Основная область**: сначала подпапки, потом файлы.
  - Плитки папок: мозаика 2×2 из `thumbs` (или значок папки), имя, «120 photos · 4 videos», размер. В виде List — таблица
    Name / Photos / Videos / Size / Modified, сортируется тем же выбором.
  - Плитки файлов: миниатюра (`object-fit: cover`), имя, у видео — длительность `H:MM:SS` в углу и значок ▶.
  - **Виртуальная прокрутка**: в DOM только видимые ряды ± 2 ряда (папки на 50 000 файлов не должны тормозить).
- Пустая папка, папка ещё не прочитана — понятные сообщения («Reading folder…»).
- Открытие папки: сразу `GET /api/dir?rel=` (кеш) → отрисовать → `GET /api/dir?rel=&fresh=1` → если `changed` — перерисовать,
  сохранив выбор и прокрутку. Ответ, пришедший после перехода в другую папку, выбрасывается.

### Сортировка

Name — естественная (`localeCompare(…, {numeric: true, sensitivity: 'base'})`), Date — `mtime`, Size, Duration (у фото — 0, неизвестно — в конец).
Папки сортируются тем же ключом (Date → mtime, Size → size, Duration → по имени). Выбор хранится в настройках папки.

### Миниатюры

Плитка с `thumb=1` → `<img src="/t/<id>?v=<mtime>&t=…" loading="lazy" decoding="async">`; `thumb=0` — сразу в очередь генерации.
Встроенные EXIF-миниатюры не используются: они ~160 px, а миниатюры — 800 px (`Library` при смене размера сбрасывает старые: `meta_kv.thumb_px`).

Очередь генерации: только видимые плитки (ушла из вида — убрать из очереди), одновременно 2 задачи, приоритет — сверху вниз.
- Фото: `new Image()` → `src=/f/<id>` → `await img.decode()` → canvas, большая сторона 800 px → `toDataURL('image/jpeg', 0.8)` (не `toBlob`: Chromium откладывает его на ~1 с) → `POST /api/thumb/<id>`.
- Видео: скрытый `<video muted preload="metadata">`, после `loadedmetadata` — `currentTime = min(duration * 0.1, 60)`, по `seeked` — кадр в canvas.
  Таймаут 15 с. После — `removeAttribute('src'); load()`, чтобы освободить соединение.
- Неудача — запомнить на сеанс, не повторять; плитка показывает значок типа.
- После успешной отправки плитка показывает готовую миниатюру (можно сразу из canvas через `URL.createObjectURL`).

### Просмотрщик

Оверлей на всё окно: `<img>` и один переиспользуемый `<video>` (без атрибута `controls`), видим один из них. Внизу — тонкая панель:
имя, номер «12 / 340», размер, разрешение; у видео — шкала (клик/перетаскивание — перемотка), время `текущее / всего`, громкость.
Панель прячется через 2 с без движения мыши (в полноэкранном режиме) и по клавише I.

Список листания — файлы текущей папки **в текущей сортировке и фильтре** (фото и видео вперемешку). Видео при переходе на него
**не запускается** (показывается первый кадр/миниатюра как `poster`), запуск — Space. Предзагрузка: ±2 соседних фото
(`new Image()` + `decode()`, держать в небольшом кеше), у следующего видео — ничего (чтобы не занимать NAS).
Переход с видео: `pause()`, `removeAttribute('src')`, `load()` — освободить соединение.

Колёсико мыши над картинкой — следующий/предыдущий файл. Двойной клик — полный экран.
Одиночный клик по картинке/видео (не в полноэкранном режиме) — закрыть просмотрщик; ждать ~250 мс, чтобы не спутать с двойным.
В полноэкранном режиме клик по видео — play/pause, по фото — ничего. Клики по панели и кнопкам просмотрщик не закрывают.

**Переход между папками**: → на последнем файле — первый файл следующей папки (`/api/neighbor?step=1`), ← на первом — последний файл
предыдущей (`step=-1`). Папка открывается как обычно (кеш, потом `fresh=1`), сетка под просмотрщиком тоже переходит в неё,
список листания — в текущей сортировке и фильтре; если после фильтра файлов нет — следующая (до 50 попыток). Нет соседней — HUD
«Last folder» / «First folder». При переходе HUD с именем папки.

### Раскадровка видео (таймлайн и предпросмотр над шкалой)

Спрайт JPEG: `N = 30` кадров, сетка 6 × 5, ширина кадра 320 px, высота — по пропорции видео (`round(320 * h / w)`, чётная).
Кадр `i` (слева направо, сверху вниз) взят в момент `t_i = duration * (i + 0.5) / N`. Размеры кадра страница берёт из размеров
картинки (`naturalWidth / 6`, `naturalHeight / 5`). Хранится на сервере (`GET /s/<id>`, `POST /api/story/<id>`), привязан к id файла.

- Генерирует страница, когда раскадровка впервые нужна (открыт таймлайн или мышь над шкалой) и на сервере её нет (404): скрытый
  `<video muted preload="metadata">` по очереди перематывается в `t_i`, кадр рисуется в canvas-спрайт, таймлайн заполняется
  по мере готовности; в конце — `toDataURL('image/jpeg', 0.8)` → `POST /api/story/<id>`. Уход с видео — генерация отменяется,
  элемент освобождается (`removeAttribute('src'); load()`).
- **Таймлайн**: кнопка в панели и клавиша T — полоса из 30 кадров над панелью, клик по кадру — перемотка туда, отметка текущего
  положения, под мышью — время. Состояние (показан/скрыт) — в настройках `timeline`, сохраняется между видео.
- **Предпросмотр над шкалой**: при наведении на шкалу — всплывающее окно над курсором со временем и кадром: сразу — ближайший
  кадр раскадровки (если есть), через ~150 мс без движения — точный кадр: второй скрытый `<video>` того же файла, `currentTime`,
  по `seeked` — в canvas окна (одна перемотка за раз, следующая цель запоминается). Освобождается при уходе с видео.

Полный экран: в окне pywebview — `window.pywebview.api.set_fullscreen(bool)`, в браузере — Fullscreen API.
Esc в HTML-полноэкранном режиме перехватывает браузер — слушать `fullscreenchange`.

### Клавиши

Сетка:
- ←/→/↑/↓, Home/End, PgUp/PgDn — выбор плитки (папки и файлы в одном порядке); Enter или Space — открыть
  (папка — зайти, файл — просмотрщик); Backspace или Alt+↑ — на уровень вверх; `[` `]` — предыдущая/следующая папка того же уровня;
  F5 — `fresh=1` для текущей папки.

Просмотрщик:
- ←/→ — предыдущий/следующий файл; Home/End — первый/последний.
- Space — play/pause (на фото — ничего).
- Enter — полный экран вкл/выкл.
- Shift+←/→ — перемотка на 5 с, Ctrl+←/→ — на 30 с, Ctrl+Shift+←/→ — на 2 мин.
- T — таймлайн с кадрами вкл/выкл.
- ↑/↓ — громкость, M — звук вкл/выкл.
- I — показать/скрыть панель. Esc — выйти из полного экрана, иначе закрыть просмотрщик (вернуть выбор на текущий файл в сетке).

Окно «Keyboard shortcuts» (меню ☰) — этот же список.

### Настройки папки (POST /api/settings, с задержкой 500 мс после изменения)

`{"_root": BOOT.root (сервер сверяет с открытой папкой и не хранит), "sort": "name|date|size|duration", "desc": bool, "filter": "all|photo|video", "view": "tiles|list", "tile": 220,
  "tree": true, "treeW": 280, "last": "<rel последней открытой папки>", "volume": 0.8, "muted": false, "timeline": false}`
Начальные значения — из `BOOT.settings`; при запуске открывается `last`, если есть, иначе корень.

## Кеш: место и очистка

- `Library` считает место миниатюр и раскадровок (нить `vomedia-cache`: обход папки кеша при запуске, дальше — на ходу) и раз в 10 мин
  проверяет лимит: превышен — удаляет миниатюры и раскадровки папок, которые дольше всех не открывали (`dirs.seen`, ставит `refresh_dir`),
  до 90 % лимита; папки из `prioritize()` не трогает. В `meta_kv` пишет `bytes` и `opened` — их читает список «других» кешей.
- `app.py` при запуске фоном удаляет кеши библиотек, которые не открывали 90 дней (`CACHE_DAYS`).
