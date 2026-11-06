# CLAUDE.md

# VO Media

Быстрый просмотрщик фото и видео для огромной библиотеки на NAS (SMB): локальный кеш SQLite + миниатюры, листание фото и видео
в одном окне, сортировка по имени/дате/размеру/длительности, раскладка папок с числом файлов и размером.
Python 3.8+, только стандартная библиотека; `pywebview` необязателен; ffmpeg не нужен.

Устройство, схема БД, API, клавиши — `docs/CONTRACT.md` (договор модулей; при изменении интерфейсов — править его первым).
Родственный проект и образец решений — VSPO: `..\Steam_View\pairview.py` и его `CLAUDE.md`.

## Договорённости с владельцем

- Общаться по-русски, коротко, технически плотно. Интерфейс, сообщения, журнал, `--help` — на английском; комментарии в коде — по-русски.
- Можно: `py_compile`, проверка JS, тестовый сервер на временных папках (`VOMEDIA_HOME`) и проверка во встроенном браузере.
  **Без команды владельца не собирать exe локально. Сборку делает GitHub Actions при push, релиз — по тегу `v` + `VERSION` (или вручную с тегом).**
- Исполнители: Sonnet, Codex (Sol), Gemini Flash (agy). **Haiku не использовать.** Ревьюит не автор кода.
- Не пытаться воспроизводить Windows, SMB, WebView2 в песочнице: это проверяет владелец.
- Среда владельца: Windows 10/11, RTX 5080, библиотека на Synology по SMB (больше 1 млн файлов; мелкие запросы по сети дорогие).

## Сделано в v0.2

Контекстное меню и файловые действия (`files.py`: проводник, внешний плеер, переименование, удаление в корзину, буфер обмена),
режимы просмотрщика (автовоспроизведение, следующее видео, зацикливание, слайдшоу 4 режима, скорость, шаг по кадрам, зум/поворот фото,
продолжение с места), GIF/mkv/webm, поиск, плоский вид «Subfolders», «New», избранные папки, полоска «досмотрено», предзагрузка
начала видео и миниатюр следующей папки, кадры при наведении на плитку. Подробности — `docs/CONTRACT.md`, раздел «v0.2».

Страница разрезана на `core.js`, `grid.js`, `viewer.js`, `ui.js` (обычные скрипты по порядку; общие `const`/`let` видны между файлами;
код верхнего уровня не вызывает то, что объявлено ниже) и стили `app.css`, `grid.css`, `viewer.css`. Новый файл страницы — добавить
в `STATIC` в `server.py` и в загрузчик в `index.html`.

## На будущее (не делаем, пока владелец не попросит)

- Листы-превью как в VSPO «с условиями» (сетка кадров с таймкодами через ffmpeg, не для всех видео) — обсудить.
- Перепаковка ffmpeg на лету (mkv со звуком AC3/DTS, HEVC без расширения, `.ts`) — если окажется, что многие файлы не играют напрямую.
- macOS: диалог tkinter из нити HTTP; Linux: временный сбой stat по SMB убирает файл из кеша.
- Вытеснение кеша по одной папке за раз — грубое при папках на тысячи миниатюр.

## Грабли (из VSPO, не повторять)

1. `SO_REUSEADDR` в Windows → два экземпляра на одном порту: только `SO_EXCLUSIVEADDRUSE`.
2. `localStorage` для настроек → теряются при смене порта: настройки на сервере.
3. Системные `confirm()`/`alert()` в окне pywebview не гарантированы — свои диалоги.
4. Тело POST читать всегда (keep-alive).
5. Обходить NAS в обработчике запроса нельзя (кроме одной папки в `refresh_dir`): по SMB это секунды-минуты.
6. `canvas.toBlob` / `OffscreenCanvas.convertToBlob` для миниатюр → Chromium откладывает кодирование на простой потока, замерено ~0,9 с
   на штуку. Только `toDataURL` (~20 мс), см. `canvasBlob()` в `grid.js`.
7. Пути длиннее 260 знаков в Windows без префикса `\\?\` дают `FileNotFoundError` — кеш принял бы папку за удалённую. Все пути к NAS — через `Library._abs()` (`long_path()`).
8. `currentTime =` на каждый повтор зажатой клавиши → каждая перемотка обрывает прошлую до показа кадра, видео стоит (по SMB особенно).
   Пока `$vv.seeking`, цель копится в `V.seekT`, последнюю отправляет `seeked` (`vSeekTo()` в `viewer.js`).

## Обновление с GitHub и донаты

- `VERSION` в `vomedia/__init__.py` — формат X.Y; тег релиза — `v` + `VERSION` (задача release проверяет совпадение).
  `REPO`, `LINKS`, `ASSETS` там же: `Common-Fool/VO_Media`, файлы `VO_Media.exe`, `VO_Media-mac.zip`, `VO_Media-x86_64.AppImage`.
- `vomedia/update.py` — перенос решений VO SP; зависит только от stdlib и `__init__.py`. `configure(read_all, write_all, SLOCK,
  app.prepare_restart)` передаёт настройки и остановку библиотеки из `app.py`, обратных импортов нет.
- `check_update()` читает `api.github.com/repos/<REPO>/releases/latest` через urllib без ключа: один раз за запуск в фоне
  по первому `GET /api/app`, далее по кнопке меню. Флаг `checking` ставится до запуска нити, чтобы страница начала опрос.
  Новая версия — зелёная точка на ☰, пункт «Update to vX.Y» с бейджем new, заметки релиза в окне Updates.
- `install_kind()`: `exe` (Windows), `app` (macOS), `appimage` (Linux с `APPIMAGE`), `source` (пакет исходников), `''` (неизвестная сборка).
  Исходники и неизвестная сборка не обновляются сами: только скачивание вручную со страницы релизов.
- `update_worker()` проверяет размер, MZ/PK/ELF и sha256 из GitHub `digest`, если он есть. exe переименовывается в `.old`, новый на место
  (при ошибке переименования — откат). macOS: `ditto -x -k` сохраняет права и ссылки, `VO_Media.app` → `VO_Media.app.old`, новый на место.
  AppImage — `os.replace`. `cleanup_old()` удаляет `VO_Media.exe.old` / `VO_Media.app.old` в фоне при следующем запуске.
- Перед `restart()` страница дожидается `flushS()`, `App.prepare_restart()` сохраняет текущую папку и закрывает `Library`, останавливая индексацию.
  Перезапуск получает текущую папку и прежние параметры запуска; окружение очищается от `_MEI*`/`_PYI*`/`APPIMAGE*`,
  ставится `PYINSTALLER_RESET_ENVIRONMENT=1`, затем старый процесс выходит через `os._exit(0)`.
- `fix_env()` при старте: Homebrew в PATH на macOS, исходный LD_LIBRARY_PATH для дочерних процессов в Linux. `die()` для .app — osascript.
- Внешние ссылки открываются браузером по умолчанию только по имени из `LINKS` (`POST /api/link {name}`): github, releases, monobank, kofi, crypto.
- Поддержка: кнопка Support в шапке и пункт меню → Monobank, Ko-fi, Crypto и исходный SVG QR банки Monobank из VO SP.
  Напоминания раз в 7 дней, после «Remind me less often» — 30 (`DONATE_DAYS`); частоту в интерфейсе не писать.
  Первый запуск только назначает срок. Общее состояние `donate: {next, rare}` в settings.json, вне настроек папок. GitHub — `.github/FUNDING.yml`.
- Стили дополнений — `update.css`; `app.css` не меняется. Новый файл страницы добавлять в `STATIC` и загрузчик `index.html`.

## Сборка (PyInstaller, GitHub Actions)

`.github/workflows/build.yml` (workflow Build) при каждом push и вручную собирает на Python 3.12:
Windows onefile `VO_Media.exe` с pywebview; macOS arm64 `VO_Media.app` → `VO_Media-mac.zip` через ditto;
Linux ubuntu-22.04 onedir без pywebview → `VO_Media-x86_64.AppImage` через appimagetool (открывает браузер).
Артефакты: VO_Media-windows, VO_Media-macos, VO_Media-linux. Тег `v*` или ручное поле release запускает задачу release:
проверка тега по `vomedia/__init__.py`, заметки из коммитов, публикация трёх файлов.
Точка входа — `vomedia.py`, страница включается через `--add-data`, иконки — `assets/vomedia.ico` / `assets/vomedia.png`.
`VO Media.spec` для workflow не нужен, не удалять его. macOS-сборка не подписана Apple: первый запуск правым кликом → Open или `xattr -cr`.
Локальная сборка Windows (только по команде владельца):

```
python -m PyInstaller --noconfirm --onefile --noconsole --name VO_Media --add-data "vomedia/web;vomedia/web" --collect-all webview --collect-all pythonnet --collect-all clr_loader --icon assets/vomedia.ico vomedia.py
```

Результат — `dist\VO_Media.exe`. Страница берётся из `sys._MEIPASS/vomedia/web` (`server.web_dir()`).
Иконка — `assets/vomedia.ico` (рисует `assets/make_icon.py`, нужен Pillow; во вкладке страницы — такой же SVG в `<link rel="icon">`).

## Как проверять

```
python -m py_compile vomedia.py vomedia/*.py
set VOMEDIA_HOME=%TEMP%\vomedia-test && python vomedia.py <папка> --no-browser --port 8765
```
