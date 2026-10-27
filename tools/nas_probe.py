#!/usr/bin/env python3
"""Разовые замеры библиотеки VO Media на NAS (только стандартная библиотека, Python 3.8+).

Запуск:
    python tools/nas_probe.py <папка> [--limit-seconds 120] [--mtime-test]

Что меряется:
  a) обход дерева (BFS, os.scandir, без ссылок): папки, файлы, фото/видео, размер, скорость, самые медленные папки;
  b) os.stat() уже обойдённых папок (стоимость проверки mtime при инкрементальном обновлении);
  c) открытие видео и чтение первых и последних 64 КБ, наличие moov в начале файла;
  d) только с --mtime-test: меняется ли mtime папки после создания и удаления файла внутри неё.

Без --mtime-test скрипт только читает библиотеку. С --mtime-test он создаёт и удаляет
временный файл _vomedia_probe.tmp (в папке и в её первой подпапке).
"""

import argparse
import heapq
import os
import platform
import random
import struct
import sys
import time
from collections import deque

PHOTO_EXT = frozenset({'.jpg', '.jpeg', '.png', '.webp', '.gif'})
VIDEO_EXT = frozenset({'.mp4', '.m4v'})
# Имена, начинающиеся с этих знаков, не обходим (скрытые, системные, служебные папки NAS)
SKIP_PREFIX = ('.', '@', '#', '$')
HEAD_BYTES = 64 * 1024
TAIL_BYTES = 64 * 1024
STAT_SAMPLE = 500       # сколько уже виденных папок проверяем через os.stat
VIDEO_SAMPLE = 30       # сколько видео открываем
SLOWEST = 5             # сколько самых медленных папок показываем
PROBE_NAME = '_vomedia_probe.tmp'
FILE_ATTRIBUTE_REPARSE_POINT = 0x400  # Windows: ссылка или junction


def fmt_bytes(n):
    """Человекочитаемый размер."""
    units = ['B', 'KB', 'MB', 'GB', 'TB']
    x = float(n)
    for u in units:
        if x < 1024 or u == units[-1]:
            return '%.2f %s' % (x, u)
        x /= 1024.0


def is_link(entry, st):
    """Ссылка (symlink) или junction/reparse point: в такие папки не заходим."""
    if entry.is_symlink():
        return True
    return bool(getattr(st, 'st_file_attributes', 0) & FILE_ATTRIBUTE_REPARSE_POINT)


def keep_slowest(heap, sec, rel):
    """Хранит SLOWEST самых медленных папок (мин-куча по времени)."""
    item = (sec, rel)
    if len(heap) < SLOWEST:
        heapq.heappush(heap, item)
    elif item > heap[0]:
        heapq.heapreplace(heap, item)


def add_error(res, path, exc):
    res['errors'] += 1
    if len(res['error_samples']) < 5:
        res['error_samples'].append('%s: %s' % (path, exc))


def walk(root, limit):
    """Этап a: BFS-обход с лимитом времени. Возвращает статистику и данные для этапов b и c."""
    res = {'folders': 0, 'files': 0, 'photos': 0, 'videos': 0, 'size': 0,
           'errors': 0, 'error_samples': [], 'stopped': False,
           'slowest': [], 'folder_paths': [], 'video_sample': [], 'elapsed': 0.0}
    rng = random.Random(12345)  # фиксированное зерно: выборка воспроизводима
    videos_seen = 0
    t0 = time.perf_counter()
    queue = deque([(root, '')])  # (абсолютный путь, путь от корня для отчёта)
    while queue:
        if time.perf_counter() - t0 >= limit:
            res['stopped'] = True
            break
        path, rel = queue.popleft()
        res['folders'] += 1
        res['folder_paths'].append(path)
        t_dir = time.perf_counter()
        try:
            it = os.scandir(path)
        except OSError as e:
            add_error(res, path, e)
            continue
        with it:
            for entry in it:
                # лимит проверяем и внутри папки: огромная папка не должна держать обход дольше лимита
                if time.perf_counter() - t0 >= limit:
                    res['stopped'] = True
                    break
                name = entry.name
                if name[:1] in SKIP_PREFIX:
                    continue
                try:
                    # на Windows stat(follow_symlinks=False) у DirEntry берётся из данных листинга, без лишнего запроса
                    st = entry.stat(follow_symlinks=False)
                    if is_link(entry, st):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        queue.append((entry.path, rel + '/' + name if rel else name))
                        continue
                    if not entry.is_file(follow_symlinks=False):
                        continue
                except OSError as e:
                    add_error(res, entry.path, e)
                    continue
                size = st.st_size
                res['files'] += 1
                res['size'] += size
                ext = os.path.splitext(name)[1].lower()
                if ext in PHOTO_EXT:
                    res['photos'] += 1
                elif ext in VIDEO_EXT:
                    res['videos'] += 1
                    videos_seen += 1
                    # резервуарная выборка: каждое видео попадает в выборку с одинаковой вероятностью
                    if len(res['video_sample']) < VIDEO_SAMPLE:
                        res['video_sample'].append((entry.path, size))
                    else:
                        j = rng.randrange(videos_seen)
                        if j < VIDEO_SAMPLE:
                            res['video_sample'][j] = (entry.path, size)
        keep_slowest(res['slowest'], time.perf_counter() - t_dir, rel or '<root>')
    res['elapsed'] = time.perf_counter() - t0
    res['slowest'].sort(reverse=True)
    return res


def stat_folders(paths):
    """Этап b: os.stat уже обойдённых папок (та же проверка, что делает инкрементальный обход)."""
    if not paths:
        return None
    step = max(1, len(paths) // STAT_SAMPLE)
    sample = paths[::step][:STAT_SAMPLE]
    times, errs = [], 0
    for p in sample:
        t = time.perf_counter()
        try:
            os.stat(p)
        except OSError:
            errs += 1
            continue
        times.append(time.perf_counter() - t)
    return {
        'n': len(times), 'errors': errs,
        'avg': sum(times) / len(times) if times else 0.0,
        'max': max(times) if times else 0.0,
    }


def has_moov_top(buf):
    """Ищет moov среди атомов верхнего уровня; смотрит только заголовки, которые уместились в буфер."""
    pos, n = 0, len(buf)
    while pos + 8 <= n:
        size, typ = struct.unpack('>I4s', buf[pos:pos + 8])
        hdr = 8
        if size == 1:  # 64-битный размер
            if pos + 16 > n:
                return False
            size = struct.unpack('>Q', buf[pos + 8:pos + 16])[0]
            hdr = 16
        elif size == 0:  # атом тянется до конца файла
            return typ == b'moov'
        if typ == b'moov':
            return True
        if size < hdr:  # битый заголовок, дальше не идём
            return False
        pos += size
    return False


def probe_video(path, size):
    """Этап c: открыть файл и прочитать первые и последние 64 КБ (два чтения, без буферизации)."""
    t = time.perf_counter()
    with open(path, 'rb', buffering=0) as f:
        head = f.read(HEAD_BYTES)
        f.seek(max(0, size - TAIL_BYTES))
        f.read(TAIL_BYTES)
    return time.perf_counter() - t, head


def first_subdir(top):
    """Первая подпапка верхнего уровня (порядок листинга) или None."""
    try:
        with os.scandir(top) as it:
            for e in it:
                if e.name[:1] in SKIP_PREFIX:
                    continue
                try:
                    if e.is_dir(follow_symlinks=False) and not e.is_symlink():
                        return e.path
                except OSError:
                    continue
    except OSError:
        return None
    return None


def _mtime(p):
    return os.stat(p).st_mtime


def _remove_probe(p):
    """Удалить временный файл, если он остался (вызывается из finally)."""
    try:
        if os.path.exists(p):
            os.remove(p)
    except OSError as e:
        print('  WARNING: could not delete %s: %s' % (p, e))


def mtime_test(top):
    """Этап d: меняется ли mtime папки при создании и удалении файла внутри неё."""
    out = {'top_create': 'n/a', 'top_delete': 'n/a', 'sub_create': 'n/a', 'error': ''}
    top_file = os.path.join(top, PROBE_NAME)
    sub = first_subdir(top)
    sub_file = os.path.join(sub, PROBE_NAME) if sub else None
    print()
    print('[d] mtime test  *** WRITES A TINY TEMP FILE "%s" (created, then deleted) ***' % PROBE_NAME)
    try:
        # 1) файл в верхней папке
        m0 = _mtime(top)
        with open(top_file, 'wb') as f:
            f.write(b'probe')
        m1 = _mtime(top)
        os.remove(top_file)
        m2 = _mtime(top)
        out['top_create'] = 'changed' if m1 != m0 else 'UNCHANGED'
        out['top_delete'] = 'changed' if m2 != m1 else 'UNCHANGED'
        print('  Top folder: %s' % top)
        print('  mtime before create: %.6f' % m0)
        print('  mtime after create:  %.6f  -> %s' % (m1, out['top_create']))
        print('  mtime after delete:  %.6f  -> %s' % (m2, out['top_delete']))
        # 2) файл в первой подпапке: mtime верхней папки не должен меняться
        if sub:
            t0 = _mtime(top)
            with open(sub_file, 'wb') as f:
                f.write(b'probe')
            t1 = _mtime(top)
            out['sub_create'] = 'changed' if t1 != t0 else 'UNCHANGED'
            print('  First subfolder: %s' % sub)
            print('  Top mtime before create inside subfolder: %.6f' % t0)
            print('  Top mtime after create inside subfolder:  %.6f  -> top changed: %s (expected: UNCHANGED)'
                  % (t1, out['sub_create']))
        else:
            print('  No subfolder found: subfolder check skipped')
    except OSError as e:
        out['error'] = str(e)
        print('  ERROR: %s' % e)
    finally:
        _remove_probe(top_file)
        if sub_file:
            _remove_probe(sub_file)
    return out


def _fmt_ms(sec):
    return '%.2f' % (sec * 1000.0)


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='replace')  # не падать на именах, которые консоль не умеет печатать

    ap = argparse.ArgumentParser(description='VO Media: one-off NAS library probe (stdlib only).')
    ap.add_argument('folder', help='library folder, e.g. Z:\\Media or \\\\NAS\\video')
    ap.add_argument('--limit-seconds', type=float, default=120.0,
                    help='time limit for the directory walk, seconds (default: 120)')
    ap.add_argument('--mtime-test', action='store_true',
                    help='also test folder mtime: WRITES and then deletes a tiny temp file')
    args = ap.parse_args()

    root = os.path.abspath(args.folder)
    if not os.path.isdir(root):
        print('ERROR: not a folder: %s' % root)
        return 2
    if args.limit_seconds <= 0:
        print('ERROR: --limit-seconds must be positive')
        return 2

    print('=== VO Media NAS probe ===')
    print('Folder: %s' % root)
    print('Time limit: %.0f s   Python %s on %s' % (args.limit_seconds, platform.python_version(), platform.system()))
    if args.mtime_test:
        print('WARNING: --mtime-test will create and then delete a tiny temp file "%s" in the library.' % PROBE_NAME)

    # a) обход
    print()
    print('[a] Directory walk (BFS, os.scandir, no links, skipping names that start with . @ # $)')
    w = walk(root, args.limit_seconds)
    el = w['elapsed']
    folders_per_sec = w['folders'] / el if el > 0 else 0.0
    files_per_sec = w['files'] / el if el > 0 else 0.0
    print('  Stopped by time limit: %s' % ('yes' if w['stopped'] else 'no (whole tree walked)'))
    print('  Elapsed: %.1f s' % el)
    print('  Folders listed: %d' % w['folders'])
    print('  Files seen: %d' % w['files'])
    print('  Photos (%s): %d' % (' '.join(sorted(PHOTO_EXT)), w['photos']))
    print('  Videos (.mp4 .m4v): %d' % w['videos'])
    print('  Total size of files seen: %s' % fmt_bytes(w['size']))
    print('  Folders/sec: %.1f   Files/sec: %.1f' % (folders_per_sec, files_per_sec))
    print('  Errors: %d' % w['errors'])
    for s in w['error_samples']:
        print('    ' + s)
    print('  Slowest %d folders (scandir + stat of entries):' % len(w['slowest']))
    for sec, rel in w['slowest']:
        print('    %9s ms  %s' % (_fmt_ms(sec), rel))

    # b) os.stat уже виденных папок
    print()
    print('[b] os.stat of already-seen folders (cost of the folder mtime check)')
    st = stat_folders(w['folder_paths'])
    if st is None or st['n'] == 0:
        print('  No folders to test')
    else:
        print('  Folders checked: %d (errors: %d)' % (st['n'], st['errors']))
        print('  avg %s ms   max %s ms' % (_fmt_ms(st['avg']), _fmt_ms(st['max'])))

    # c) видео
    print()
    print('[c] Video: open + read first 64 KB + last 64 KB (up to %d files)' % VIDEO_SAMPLE)
    samples = w['video_sample']
    times, moov_hits, probe_errs = [], 0, 0
    if not samples:
        print('  No .mp4/.m4v found, skipped')
    for path, size in samples:
        try:
            dt, head = probe_video(path, size)
        except OSError as e:
            probe_errs += 1
            print('  ERROR %s: %s' % (path, e))
            continue
        times.append(dt)
        moov = has_moov_top(head)
        if moov:
            moov_hits += 1
        print('  %9s ms  moov_in_first_64KB=%-3s  %s  (%s)'
              % (_fmt_ms(dt), 'yes' if moov else 'no', os.path.basename(path), fmt_bytes(size)))
    if times:
        print('  Probed: %d (errors: %d)   avg %s ms   max %s ms'
              % (len(times), probe_errs, _fmt_ms(sum(times) / len(times)), _fmt_ms(max(times))))
        print('  moov in first 64 KB: %d of %d   (not there: %d, probably moov at the end of the file)'
              % (moov_hits, len(times), len(times) - moov_hits))

    # d) mtime (только по ключу)
    mt = None
    if args.mtime_test:
        mt = mtime_test(root)

    # Итог: одним блоком, чтобы скопировать и отправить
    print()
    print('===== SUMMARY (paste back) =====')
    print('folder: %s' % root)
    print('walk: limit=%.0fs stopped=%s elapsed=%.1fs folders=%d files=%d photos=%d videos=%d size=%s errors=%d'
          % (args.limit_seconds, 'yes' if w['stopped'] else 'no', el, w['folders'], w['files'],
             w['photos'], w['videos'], fmt_bytes(w['size']), w['errors']))
    print('rates: folders/s=%.1f files/s=%.1f' % (folders_per_sec, files_per_sec))
    if w['slowest']:
        print('slowest folders (ms): ' + ', '.join('%s=%s' % (rel, _fmt_ms(sec)) for sec, rel in w['slowest']))
    if st and st['n']:
        print('stat folders: n=%d avg=%s ms max=%s ms' % (st['n'], _fmt_ms(st['avg']), _fmt_ms(st['max'])))
    else:
        print('stat folders: n/a')
    if times:
        print('videos: n=%d avg=%s ms max=%s ms moov_in_first_64KB=%d/%d'
              % (len(times), _fmt_ms(sum(times) / len(times)), _fmt_ms(max(times)), moov_hits, len(times)))
    else:
        print('videos: n/a')
    if mt is None:
        print('mtime: not run (use --mtime-test)')
    elif mt['error']:
        print('mtime: ERROR %s' % mt['error'])
    else:
        print('mtime: top after create=%s, top after delete=%s, top after create in subfolder=%s (expected UNCHANGED)'
              % (mt['top_create'], mt['top_delete'], mt['sub_create']))
    print('===== END =====')
    return 0


if __name__ == '__main__':
    sys.exit(main())
