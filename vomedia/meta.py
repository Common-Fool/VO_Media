"""Разбор заголовков медиафайлов без внешних зависимостей.

Поддерживаемые форматы:
  Фото: JPEG, PNG, GIF, WebP
  Видео: MP4, M4V
"""
import os
import struct
from typing import Any, Dict, Optional, Tuple

PHOTO_EXT = frozenset({'.jpg', '.jpeg', '.png', '.webp', '.gif'})
VIDEO_EXT = frozenset({'.mp4', '.m4v'})


def kind_of(name: str) -> Optional[str]:
    """Тип файла по расширению: 'photo', 'video' или None (регистронезависимо)."""
    try:
        dot = name.rfind('.')
        if dot < 0:
            return None
        ext = name[dot:].lower()
        if ext in PHOTO_EXT:
            return 'photo'
        if ext in VIDEO_EXT:
            return 'video'
        return None
    except Exception:
        return None


def _jpeg_sof_dims(data: bytes) -> Optional[Tuple[int, int]]:
    """Ширина и высота из собственного SOF маркера JPEG-потока байт."""
    if len(data) < 4 or data[:2] != b'\xff\xd8':
        return None
    idx = 2
    n = len(data)
    while idx < n:
        if data[idx] != 0xff:
            idx += 1
            continue
        while idx < n and data[idx] == 0xff:
            idx += 1
        if idx >= n:
            break
        marker = data[idx]
        idx += 1
        if marker in (0xd8, 0xd9, 0x01) or (0xd0 <= marker <= 0xd7):
            continue
        if marker == 0xda:  # SOS — начало сжатых данных
            break
        if idx + 2 > n:
            break
        seg_len = (data[idx] << 8) | data[idx + 1]
        if seg_len < 2:
            break
        # SOF0..SOF15 кроме C4, C8, CC
        if 0xc0 <= marker <= 0xcf and marker not in (0xc4, 0xc8, 0xcc):
            if seg_len >= 7 and idx + 7 <= n:
                h = (data[idx + 3] << 8) | data[idx + 4]
                w = (data[idx + 5] << 8) | data[idx + 6]
                if w > 0 and h > 0:
                    return w, h
            return None
        idx += seg_len
    return None


def _parse_exif(app1_payload: bytes) -> Tuple[int, Optional[Tuple[int, int]]]:
    """Разбор EXIF (TIFF).

    Возвращает (orientation, (thumb_offset, thumb_length) или None).
    Смещения миниатюры считаются от начала заголовка TIFF.
    """
    if not app1_payload.startswith(b'Exif\x00\x00'):
        return 1, None
    tiff = app1_payload[6:]
    if len(tiff) < 8:
        return 1, None

    endian_sig = tiff[:2]
    if endian_sig == b'II':
        endian = '<'
    elif endian_sig == b'MM':
        endian = '>'
    else:
        return 1, None

    tag42 = struct.unpack(endian + 'H', tiff[2:4])[0]
    if tag42 != 42:
        return 1, None

    ifd0_offset = struct.unpack(endian + 'I', tiff[4:8])[0]
    if ifd0_offset + 2 > len(tiff):
        return 1, None

    num_entries_0 = struct.unpack(endian + 'H', tiff[ifd0_offset : ifd0_offset + 2])[0]
    orientation = 1
    t0_offset = None
    t0_len = None

    p0 = ifd0_offset + 2
    for _ in range(num_entries_0):
        if p0 + 12 > len(tiff):
            break
        tag, typ, _cnt = struct.unpack(endian + 'HHI', tiff[p0 : p0 + 8])
        if tag == 0x0112:  # Orientation
            if typ == 3:
                val = struct.unpack(endian + 'H', tiff[p0 + 8 : p0 + 10])[0]
            elif typ == 4:
                val = struct.unpack(endian + 'I', tiff[p0 + 8 : p0 + 12])[0]
            else:
                val = 1
            if 1 <= val <= 8:
                orientation = val
        elif tag == 0x0201:  # JPEGInterchangeFormat
            if typ == 3:
                t0_offset = struct.unpack(endian + 'H', tiff[p0 + 8 : p0 + 10])[0]
            elif typ == 4:
                t0_offset = struct.unpack(endian + 'I', tiff[p0 + 8 : p0 + 12])[0]
        elif tag == 0x0202:  # JPEGInterchangeFormatLength
            if typ == 3:
                t0_len = struct.unpack(endian + 'H', tiff[p0 + 8 : p0 + 10])[0]
            elif typ == 4:
                t0_len = struct.unpack(endian + 'I', tiff[p0 + 8 : p0 + 12])[0]
        p0 += 12

    # IFD1 — миниатюра
    t1_offset = None
    t1_len = None
    if p0 + 4 <= len(tiff):
        ifd1_offset = struct.unpack(endian + 'I', tiff[p0 : p0 + 4])[0]
        if ifd1_offset > 0 and ifd1_offset + 2 <= len(tiff):
            num_entries_1 = struct.unpack(endian + 'H', tiff[ifd1_offset : ifd1_offset + 2])[0]
            p1 = ifd1_offset + 2
            for _ in range(num_entries_1):
                if p1 + 12 > len(tiff):
                    break
                tag1, typ1, _cnt1 = struct.unpack(endian + 'HHI', tiff[p1 : p1 + 8])
                if tag1 == 0x0201:
                    if typ1 == 3:
                        t1_offset = struct.unpack(endian + 'H', tiff[p1 + 8 : p1 + 10])[0]
                    elif typ1 == 4:
                        t1_offset = struct.unpack(endian + 'I', tiff[p1 + 8 : p1 + 12])[0]
                elif tag1 == 0x0202:
                    if typ1 == 3:
                        t1_len = struct.unpack(endian + 'H', tiff[p1 + 8 : p1 + 10])[0]
                    elif typ1 == 4:
                        t1_len = struct.unpack(endian + 'I', tiff[p1 + 8 : p1 + 12])[0]
                p1 += 12

    thumb_span = None
    if t1_offset is not None and t1_len is not None:
        thumb_span = (t1_offset, t1_len)
    elif t0_offset is not None and t0_len is not None:
        thumb_span = (t0_offset, t0_len)

    return orientation, thumb_span


def _parse_jpeg_stream(f, initial_buf: bytes) -> Dict[str, Any]:
    """Разбор JPEG из открытого потока с минимальным чтением."""
    empty = {'w': None, 'h': None, 'duration': None, 'rot': 1}
    buf = initial_buf
    buf_offset = 0
    pos = 2
    w = None
    h = None
    rot = 1

    try:
        while True:
            # Поиск следующего байта 0xFF
            while pos < len(buf) and buf[pos] != 0xff:
                pos += 1
            if pos >= len(buf):
                buf_offset += pos
                f.seek(buf_offset)
                buf = f.read(65536)
                pos = 0
                if not buf:
                    break
                continue

            # Пропуск повторяющихся 0xFF (байт-заполнитель); FF может оказаться последним байтом буфера —
            # тогда после подкачки сразу идёт байт маркера, искать следующий 0xFF нельзя
            while True:
                while pos < len(buf) and buf[pos] == 0xff:
                    pos += 1
                if pos < len(buf):
                    break
                buf_offset += pos
                f.seek(buf_offset)
                buf = f.read(65536)
                pos = 0
                if not buf:
                    break
            if not buf:
                break

            marker = buf[pos]
            pos += 1

            if marker in (0xd8, 0xd9, 0x01) or (0xd0 <= marker <= 0xd7):
                continue
            if marker == 0xda:  # SOS — заголовок завершён
                break

            # Читаем 2 байта длины сегмента
            if pos + 2 > len(buf):
                buf_offset += pos
                f.seek(buf_offset)
                buf = f.read(65536)
                pos = 0
                if len(buf) < 2:
                    break

            seg_len = (buf[pos] << 8) | buf[pos + 1]
            if seg_len < 2:
                break

            # SOF0..SOF15 кроме C4, C8, CC
            if 0xc0 <= marker <= 0xcf and marker not in (0xc4, 0xc8, 0xcc):
                if pos + 7 <= len(buf):
                    h = (buf[pos + 3] << 8) | buf[pos + 4]
                    w = (buf[pos + 5] << 8) | buf[pos + 6]
                else:
                    f.seek(buf_offset + pos)
                    hdr = f.read(7)
                    if len(hdr) >= 7:
                        h = (hdr[3] << 8) | hdr[4]
                        w = (hdr[5] << 8) | hdr[6]
                # В стандартном JPEG APP1 всегда предшествует SOF, поэтому rot уже известен
                break

            # APP1 Exif
            if marker == 0xe1:
                payload_len = seg_len - 2
                if pos + 2 + payload_len <= len(buf):
                    payload = buf[pos + 2 : pos + 2 + payload_len]
                else:
                    f.seek(buf_offset + pos + 2)
                    payload = f.read(payload_len)
                if payload.startswith(b'Exif\x00\x00'):
                    rot_val, _ = _parse_exif(payload)
                    if 1 <= rot_val <= 8:
                        rot = rot_val

            # Пропуск полезной нагрузки сегмента через seek при выходе за буфер
            if pos + seg_len <= len(buf):
                pos += seg_len
            else:
                buf_offset += pos + seg_len
                f.seek(buf_offset)
                buf = f.read(65536)
                pos = 0
                if not buf:
                    break

        if w is not None and h is not None:
            if 5 <= rot <= 8:
                w, h = h, w
            return {'w': w, 'h': h, 'duration': None, 'rot': rot}
    except Exception:
        pass

    return empty


def _parse_webp(buf: bytes) -> Dict[str, Any]:
    """Разбор размеров WebP (VP8, VP8L, VP8X) из первых байт."""
    empty = {'w': None, 'h': None, 'duration': None, 'rot': 1}
    try:
        pos = 12
        n = len(buf)
        while pos + 8 <= n:
            fourcc = buf[pos : pos + 4]
            chunk_size = struct.unpack('<I', buf[pos + 4 : pos + 8])[0]
            p = pos + 8

            if fourcc == b'VP8 ':
                # Lossy VP8: 3 байта тег, затем 9D 01 2A, затем 14-битные w и h (<H & 0x3fff)
                if p + 10 <= n and buf[p + 3 : p + 6] == b'\x9d\x01\x2a':
                    w = struct.unpack('<H', buf[p + 6 : p + 8])[0] & 0x3fff
                    h = struct.unpack('<H', buf[p + 8 : p + 10])[0] & 0x3fff
                    if w > 0 and h > 0:
                        return {'w': w, 'h': h, 'duration': None, 'rot': 1}
                return empty

            if fourcc == b'VP8L':
                # Lossless VP8L: сигнатура 0x2F, затем 14 бит w-1, 14 бит h-1
                if p + 5 <= n and buf[p] == 0x2f:
                    val = struct.unpack('<I', buf[p + 1 : p + 5])[0]
                    w = (val & 0x3fff) + 1
                    h = ((val >> 14) & 0x3fff) + 1
                    if w > 0 and h > 0:
                        return {'w': w, 'h': h, 'duration': None, 'rot': 1}
                return empty

            if fourcc == b'VP8X':
                # Extended VP8X: ширина и высота холста (24 бита + 1) со смещений 4 и 7
                if p + 10 <= n:
                    w = (buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16)) + 1
                    h = (buf[p + 7] | (buf[p + 8] << 8) | (buf[p + 9] << 16)) + 1
                    if w > 0 and h > 0:
                        return {'w': w, 'h': h, 'duration': None, 'rot': 1}
                return empty

            pos = p + chunk_size + (chunk_size & 1)
    except Exception:
        pass
    return empty


def _iter_boxes(data: bytes):
    """Итератор атомов внутри буфера данных (box_type, payload)."""
    idx = 0
    n = len(data)
    while idx + 8 <= n:
        size, box_type = struct.unpack('>I4s', data[idx : idx + 8])
        header_len = 8
        if size == 1:
            if idx + 16 > n:
                break
            size = struct.unpack('>Q', data[idx + 8 : idx + 16])[0]
            header_len = 16
        elif size == 0:
            size = n - idx

        if size < header_len or idx + size > n:
            break

        payload = data[idx + header_len : idx + size]
        yield box_type, payload
        idx += size


def _parse_moov(moov_data: bytes) -> Tuple[Optional[int], Optional[int], Optional[float]]:
    """Разбор атома moov: извлечение w, h и duration."""
    duration = None
    video_w = None
    video_h = None

    for atom_type, payload in _iter_boxes(moov_data):
        if atom_type == b'mvhd':
            if len(payload) >= 4:
                version = payload[0]
                if version == 0 and len(payload) >= 20:
                    timescale, raw_dur = struct.unpack('>II', payload[12:20])
                    if timescale > 0 and raw_dur > 0:
                        duration = round(raw_dur / float(timescale), 3)
                elif version == 1 and len(payload) >= 32:
                    timescale = struct.unpack('>I', payload[20:24])[0]
                    raw_dur = struct.unpack('>Q', payload[24:32])[0]
                    if timescale > 0 and raw_dur > 0:
                        duration = round(raw_dur / float(timescale), 3)

        elif atom_type == b'trak' and (video_w is None or video_h is None):
            is_video = False
            tkhd_payload = None

            for t_type, t_payload in _iter_boxes(payload):
                if t_type == b'tkhd':
                    tkhd_payload = t_payload
                elif t_type == b'mdia':
                    for m_type, m_payload in _iter_boxes(t_payload):
                        if m_type == b'hdlr' and len(m_payload) >= 12:
                            handler_type = m_payload[8:12]
                            if handler_type == b'vide':
                                is_video = True

            if is_video and tkhd_payload is not None and len(tkhd_payload) >= 4:
                ver = tkhd_payload[0]
                if ver == 0 and len(tkhd_payload) >= 84:
                    w = struct.unpack('>I', tkhd_payload[76:80])[0] >> 16
                    h = struct.unpack('>I', tkhd_payload[80:84])[0] >> 16
                    if w > 0 and h > 0:
                        video_w, video_h = w, h
                elif ver == 1 and len(tkhd_payload) >= 96:
                    w = struct.unpack('>I', tkhd_payload[88:92])[0] >> 16
                    h = struct.unpack('>I', tkhd_payload[92:96])[0] >> 16
                    if w > 0 and h > 0:
                        video_w, video_h = w, h

    return video_w, video_h, duration


def _read_mp4_meta(path: str) -> Dict[str, Any]:
    """Чтение метаданных mp4/m4v без загрузки файла целиком."""
    empty = {'w': None, 'h': None, 'duration': None, 'rot': 1}
    try:
        with open(path, 'rb', buffering=0) as f:
            f.seek(0, os.SEEK_END)
            file_size = f.tell()
            f.seek(0)

            pos = 0
            moov_data = None

            while pos < file_size:
                f.seek(pos)
                header = f.read(16)
                if len(header) < 8:
                    break
                size, atom_type = struct.unpack('>I4s', header[:8])
                header_len = 8
                if size == 1:
                    if len(header) < 16:
                        break
                    size = struct.unpack('>Q', header[8:16])[0]
                    header_len = 16
                elif size == 0:
                    size = file_size - pos

                # Защита от зацикливания: атом размером < 8 — стоп
                if size < 8:
                    break

                if atom_type == b'moov':
                    payload_size = size - header_len
                    # если > 64 МБ — сдаться
                    if payload_size <= 0 or payload_size > 64 * 1024 * 1024:
                        return empty
                    f.seek(pos + header_len)
                    moov_data = f.read(payload_size)
                    break

                pos += size
                if pos > file_size:
                    break

            if moov_data is None:
                return empty

            w, h, duration = _parse_moov(moov_data)
            return {'w': w, 'h': h, 'duration': duration, 'rot': 1}
    except Exception:
        return empty


def read_meta(path: str, kind: str) -> Dict[str, Any]:
    """Разбор метаданных файла.

    Возвращает {'w': int|None, 'h': int|None, 'duration': float|None, 'rot': int}.
    При ошибке или неизвестном формате возвращает поля со значениями None и rot=1.
    """
    empty = {'w': None, 'h': None, 'duration': None, 'rot': 1}
    try:
        if kind == 'video':
            return _read_mp4_meta(path)
        if kind != 'photo':
            return empty

        with open(path, 'rb', buffering=0) as f:
            buf = f.read(65536)
            if not buf:
                return empty

            # JPEG
            if len(buf) >= 2 and buf[:2] == b'\xff\xd8':
                return _parse_jpeg_stream(f, buf)

            # PNG: IHDR (сигнатура 8 байт, затем 4 байта длина, 4 байта 'IHDR', 8 байт w и h)
            if buf.startswith(b'\x89PNG\r\n\x1a\n') and len(buf) >= 24:
                if buf[12:16] == b'IHDR':
                    w, h = struct.unpack('>II', buf[16:24])
                    return {'w': w, 'h': h, 'duration': None, 'rot': 1}
                return empty

            # GIF: логический экран (<HH после сигнатуры GIF87a/GIF89a)
            if (buf.startswith(b'GIF87a') or buf.startswith(b'GIF89a')) and len(buf) >= 10:
                w, h = struct.unpack('<HH', buf[6:10])
                return {'w': w, 'h': h, 'duration': None, 'rot': 1}

            # WebP: RIFF ... WEBP
            if len(buf) >= 30 and buf.startswith(b'RIFF') and buf[8:12] == b'WEBP':
                return _parse_webp(buf)

            return empty
    except Exception:
        return empty


def exif_thumb(path: str) -> Optional[bytes]:
    """Встроенная JPEG-миниатюра из EXIF (APP1, IFD1).

    Возвращает None, если миниатюры нет, она меньше 120 px по большей стороне,
    Orientation основного снимка != 1 или размер > 128 КБ.
    """
    try:
        with open(path, 'rb', buffering=0) as f:
            data = f.read(131072)
    except Exception:
        return None

    if len(data) < 4 or data[:2] != b'\xff\xd8':
        return None

    try:
        idx = 2
        n = len(data)
        app1_payload = None

        while idx < n:
            if data[idx] != 0xff:
                idx += 1
                continue
            while idx < n and data[idx] == 0xff:
                idx += 1
            if idx >= n:
                break
            marker = data[idx]
            idx += 1
            if marker in (0xd8, 0xd9, 0x01) or (0xd0 <= marker <= 0xd7):
                continue
            if marker == 0xda:
                break
            if idx + 2 > n:
                break
            seg_len = (data[idx] << 8) | data[idx + 1]
            if seg_len < 2:
                break
            if marker == 0xe1:
                payload = data[idx + 2 : min(idx + seg_len, n)]
                if payload.startswith(b'Exif\x00\x00'):
                    app1_payload = payload
                    break
            idx += seg_len

        if app1_payload is None:
            return None

        rot, thumb_span = _parse_exif(app1_payload)
        if rot != 1 or thumb_span is None:
            return None

        t_offset, t_len = thumb_span
        if t_len <= 0 or t_len > 131072:
            return None

        tiff = app1_payload[6:]
        if t_offset + t_len > len(tiff):
            return None

        thumb_bytes = tiff[t_offset : t_offset + t_len]
        if len(thumb_bytes) != t_len or not thumb_bytes.startswith(b'\xff\xd8'):
            return None

        dims = _jpeg_sof_dims(thumb_bytes)
        if dims is None:
            return None
        tw, th = dims
        if max(tw, th) < 120:
            return None

        return thumb_bytes
    except Exception:
        return None
