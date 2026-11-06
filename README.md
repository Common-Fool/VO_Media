# VO Media

Fast photo and video viewer for huge libraries on a NAS. Built for folders with more than a million files on a
Synology share over SMB: a local SQLite cache and thumbnails keep browsing responsive, and the NAS is read as little as possible.

- **Photos and videos in one flow**: browse photos and videos seamlessly in the grid and viewer; keyboard navigation, instant switching, and videos play in place.
- **Supported formats**:
  - Photos: `.jpg`, `.jpeg`, `.png`, `.webp`.
  - Videos: `.mp4`, `.m4v`, `.mkv`, `.webm`. GIF is treated as video (Videos filter, ▶ badge and duration on the tile) and simply loops in the viewer.
- **Fast local cache**: local SQLite database and 800 px thumbnails keep browsing fast with minimal network traffic.
- **Folder overview**: each folder displays the number of photos and videos and the total recursive size. Toggle between Tiles and List views; customize tile size with a slider; hover over a video tile to scrub storyboard frames.
- **Sorting & filtering**: sort by name, date, size, or duration (ascending or descending); filter by all, photos, or videos.
- **Library browsing**:
  - **Search**: find files and folders across the entire library by name (`Ctrl+F`).
  - **Subfolders** (flat view): view all media from the current folder and all its subfolders in one flat grid.
  - **New**: browse recently added media (since last launch, last 7 days, or last 30 days).
  - **Favourites**: pin favorite folders to the top of the folder tree.
- **Viewer**:
  - Autoplay, loop playback, and automatically advance to the next video on end.
  - Slideshow with 4 modes (off, play to folder end, loop folder, continuous across folders) and adjustable interval (0.5–5 s).
  - Playback speed control (0.5× to 2×) and frame-by-frame stepping (`,` / `.` when paused).
  - Photo zoom (1–8×, zoom to cursor, drag to pan), fit/100% toggle (`Z`), and 90° rotation (`R`).
  - Resume where you left off: remembers playback position across sessions.
  - Filmstrip timeline (`T`) and seek bar with hovering frame preview tooltip.
- **Context menu & file management**:
  - Right-click any file, folder, or tree row: Open, Play in external player, Show in Explorer, Rename, Copy file(s), Copy path, and Delete.
  - External player support: choose your preferred video player (MPC-HC, MPC-BE, VLC, mpv, PotPlayer, etc.) via `☰ → Video player…`.
  - Delete moves files to the Windows Recycle Bin; on a network share / NAS, files are caught by the share's recycle bin if enabled.
- **Cache management**:
  - Open `☰ → Cache…` to view storage usage for thumbnails, storyboards, and the database index, adjust size limits (5–100 GB or unlimited), clear thumbnails, or reset the library cache.
  - Automatic cleanup removes thumbnails of least recently opened folders when the limit is exceeded; caches unused for 90 days are cleaned up at startup.

> [!NOTE]
> MKV and MP4 files with audio/video codecs unsupported by the built-in browser player (such as AC3/DTS audio or HEVC/H.265 video) may not play directly. Use **Play in external player** from the context menu or error screen to open them in an external media player.

## Download

Ready builds are on the [releases page](https://github.com/Common-Fool/VO_Media/releases/latest).

| System | File | Notes |
|---|---|---|
| Windows 10/11 | `VO_Media.exe` | Single file, just run it. The exe is not code-signed; on the first start SmartScreen may ask you to choose **More info** → **Run anyway**. |
| macOS 11+ (Apple Silicon) | `VO_Media-mac.zip` | Unpack and move `VO_Media.app` to Applications. The app is not signed by Apple: right-click → **Open** → **Open**, or run `xattr -cr /Applications/VO_Media.app` once. |
| Linux x86-64 | `VO_Media-x86_64.AppImage` | `chmod +x VO_Media-x86_64.AppImage` and run it. Opens the library in your browser. |

## Updates

Open **☰ → Check for updates**. A green dot on the menu button and **Update to vX.Y** mean a new release is available.
**Update and restart** downloads the build from GitHub, checks its size, file signature and SHA-256 when GitHub provides it,
replaces the program and restarts VO Media with the current folder and launch options. Pending settings are saved and
indexing is stopped before restarting. Release notes and the **Release page** button are in the same window.

Source installations and unrecognized builds show a link to the release page instead of installing an update.
Update the source package manually; the updater never replaces individual Python modules.

## Requirements (running from source)

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
- Set `VOMEDIA_HOME` to use another folder. To rebuild the index, close the app and delete the cache folder (or use `☰ → Cache… → Reset library cache`).

## Keyboard shortcuts

Folder view:

| Key | Action |
|---|---|
| `←` `→` `↑` `↓` | Select a tile (folders and files in one order) |
| `Home` `End` | First / last tile |
| `PgUp` `PgDn` | Previous / next folder with files (through the whole tree) |
| `Enter` or `Space` | Open: enter a folder or view a file |
| `Backspace` or `Alt+↑` | Up one level |
| `[` and `]` | Previous / next folder of the same level |
| `F5` | Reread the current folder from disk (in a search or the New view: run it again) |
| `Ctrl+F` | Search names in the whole library |
| `Esc` | In the search field, in search results or in the New view: back to the folder |
| Right click | Menu of a file, folder or tree row (open, play, rename, copy, delete, favourites) |

Viewer:

| Key | Action |
|---|---|
| `←` `→` | Previous / next file (past the last or first file: the next / previous folder) |
| `Home` `End` | First / last file |
| `Space` | Play / pause a video |
| `Enter` | Full screen on / off |
| `Shift+←` `→` | Seek 5 s |
| `Ctrl+←` `→` | Seek 30 s |
| `Ctrl+Shift+←` `→` | Seek 2 min |
| `T` | Timeline with video frames on / off |
| `Shift+,` `Shift+.` | Slower / faster playback (0.5× to 2×) |
| `,` `.` | On pause: one frame back / forward |
| `Z` | Photo: fit the window / 100 % |
| `R` | Photo: rotate 90° (display only) |
| `Ctrl` + Mouse wheel | Photo: zoom to the cursor; drag to move |
| Buttons in the bar | Autoplay, next video at the end, loop video, speed (if enabled in the menu); top left: slideshow, hover for its interval |
| `↑` `↓` | Volume |
| `M` | Mute |
| `I` | Show / hide the bottom bar |
| `Esc` | Leave full screen, otherwise close the viewer |
| `\` | Close the viewer (also from full screen) |
| `Backspace` | Video: back to the start |
| Mouse wheel | Next / previous file |
| Click on the picture | Close the viewer (in full screen: play / pause a video) |
| Double click | Full screen on / off |

## Supported formats

- Photos: `.jpg .jpeg .png .webp`
- Videos: `.mp4 .m4v .mkv .webm .gif` (GIF is treated as video)

Other files are not shown.

## Building

GitHub Actions builds `VO_Media.exe`, `VO_Media-mac.zip` and `VO_Media-x86_64.AppImage` on every push
(workflow **Build**, also runnable by hand). Download them from the run's **Artifacts**.
Pushing a tag such as `v0.3`, or running the workflow with that tag in the **release** field, also publishes all three
files as a GitHub release. The tag must equal `v` + `VERSION` in `vomedia/__init__.py`; the release job checks this.

For a local Windows build:

```bat
pip install pyinstaller pywebview
pyinstaller --onefile --noconsole --name VO_Media --icon assets/vomedia.ico --add-data "vomedia/web;vomedia/web" --collect-all webview --collect-all pythonnet --collect-all clr_loader vomedia.py
```

The result is `dist\VO_Media.exe`. The page is bundled from `vomedia/web`. macOS and Linux commands are in
[`.github/workflows/build.yml`](.github/workflows/build.yml); Linux uses an onedir build without pywebview, packed as an AppImage.
The workflow uses Python 3.12 and the existing icons in `assets/`; it does not use `VO Media.spec`.

## Support

VO Media is free and open source. If it saves you time, you can support its development from the **Support** button
or **☰ → Support the project**, or use these links:

- [Monobank jar](https://send.monobank.ua/jar/6m4nBQCW9B) (card of any bank)
- [Ko-fi](https://ko-fi.com/commonfool)
- [Crypto (NOWPayments)](https://nowpayments.io/donation/commonfool)
