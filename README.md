# VO Media

Fast photo and video viewer for huge libraries on a NAS. Built for folders with more than a million files on a
Synology share over SMB: a local SQLite cache and thumbnails keep browsing responsive, and the NAS is read as little as possible.

- **Photos and videos in one flow**: move between them with the keyboard in the grid and in the viewer; videos play in place.
- **Sorting** by name, date, size or duration; filter by all, photos or videos.
- **Folder overview**: each folder shows the number of photos and videos and the total size, including subfolders.
- **View only**: nothing is created, moved or deleted in the library. The cache lives on your computer.

## Requirements

- Python 3.8+. Windows 10/11 is the main target; macOS and Linux should work too.
- Standard library only. Optional: `pip install pywebview` for a native window (without it the app opens in your browser).
- ffmpeg is **not** needed.

## Running

```
python vomedia.py "D:\Media"
```

| Option | Meaning |
|---|---|
| `folder` | library folder. If omitted, the last folder is used; if there is none, a folder dialog opens |
| `--port N` | HTTP port on 127.0.0.1 (`0` = any free port, the default) |
| `--browser` | open in the browser instead of a native window |
| `--no-browser` | start the server only, do not open anything |

`python vomedia.py --help` lists all options.

## Where data lives

- Cache: `<app folder>/cache/<hash of the library path>/library.sqlite` and a `thumbs/` folder.
- Settings and log: `<app folder>/settings.json`, `<app folder>/vomedia.log`.
- The app folder is `%APPDATA%\VO Media` on Windows, `~/Library/Application Support/VO Media` on macOS,
  and `$XDG_CONFIG_HOME/vo-media` (or `~/.config/vo-media`) on Linux.
- Set `VOMEDIA_HOME` to use another folder. To rebuild the index, close the app and delete the cache folder.

## Keyboard shortcuts

Grid:

| Key | Action |
|---|---|
| Arrows, Home/End, PgUp/PgDn | move selection (folders and files in one order) |
| Enter or Space | open: enter a folder or open a file in the viewer |
| Backspace or Alt+Up | go up one level |
| `[` and `]` | previous / next folder at the same level |
| F5 | rescan the current folder |

Viewer:

| Key | Action |
|---|---|
| Left / Right | previous / next file |
| Home / End | first / last file |
| Space | play / pause (no effect on photos) |
| Enter | toggle fullscreen |
| Ctrl+Left / Right | seek 5 s; Ctrl+Shift+Left / Right: seek 30 s |
| Up / Down, M | volume; mute |
| I | show / hide the info bar |
| Esc | leave fullscreen, otherwise close the viewer |

The mouse wheel over the picture moves to the next or previous file; double-click toggles fullscreen.

## Supported formats

- Photos: `.jpg .jpeg .png .webp .gif`
- Videos: `.mp4 .m4v` (H.264 is recommended; played directly by the page's video element)

Other files are not shown.
