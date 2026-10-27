# CLAUDE.md

# VO Media

Быстрый просмотрщик фото и видео для огромной библиотеки на NAS (SMB): локальный кеш SQLite + миниатюры, листание фото и видео
в одном окне, сортировка по имени/дате/размеру/длительности, раскладка папок с числом файлов и размером.
Python 3.8+, только стандартная библиотека; `pywebview` необязателен; ffmpeg не нужен. Первая версия — только просмотр.

Устройство, схема БД, API, клавиши — `docs/CONTRACT.md` (договор модулей; при изменении интерфейсов — править его первым).
Родственный проект и образец решений — VSPO: `..\Steam_View\pairview.py` и его `CLAUDE.md`.

## Договорённости с владельцем

- Общаться по-русски, коротко, технически плотно. Интерфейс, сообщения, журнал, `--help` — на английском; комментарии в коде — по-русски.
- **Без прямого разрешения владельца не запускать** приложение, `py_compile`, проверки JS, сборку. Проверка — чтением кода и ревью.
- Не пытаться воспроизводить Windows, SMB, WebView2 в песочнице: это проверяет владелец.
- Среда владельца: Windows 10/11, RTX 5080, библиотека на Synology по SMB (больше 1 млн файлов; мелкие запросы по сети дорогие).

## Грабли (из VSPO, не повторять)

1. `SO_REUSEADDR` в Windows → два экземпляра на одном порту: только `SO_EXCLUSIVEADDRUSE`.
2. `localStorage` для настроек → теряются при смене порта: настройки на сервере.
3. Системные `confirm()`/`alert()` в окне pywebview не гарантированы — свои диалоги.
4. Тело POST читать всегда (keep-alive).
5. Обходить NAS в обработчике запроса нельзя (кроме одной папки в `refresh_dir`): по SMB это секунды-минуты.
6. `canvas.toBlob` / `OffscreenCanvas.convertToBlob` для миниатюр → Chromium откладывает кодирование на простой потока, замерено ~0,9 с
   на штуку. Только `toDataURL` (~20 мс), см. `canvasBlob()` в `app.js`.
7. Пути длиннее 260 знаков в Windows без префикса `\\?\` дают `FileNotFoundError` — кеш принял бы папку за удалённую. Все пути к NAS — через `Library._abs()` (`long_path()`).

## Сборка exe (только с разрешения владельца)

```
python -m PyInstaller --noconfirm --onefile --noconsole --name "VO Media" --add-data "vomedia/web;vomedia/web" --collect-all webview --collect-all pythonnet --collect-all clr_loader vomedia.py
```

Результат — `dist\VO Media.exe` (~23 МБ). Страница берётся из `sys._MEIPASS/vomedia/web` (`server.web_dir()`). Иконки пока нет.
Workflow GitHub Actions пока нет — сборка вручную.

## Как проверять (только с разрешения владельца)

```
python -m py_compile vomedia.py vomedia/*.py
set VOMEDIA_HOME=%TEMP%\vomedia-test && python vomedia.py <папка> --no-browser --port 8765
```
