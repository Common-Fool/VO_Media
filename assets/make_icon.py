"""Рисует иконку VO Media: фото (горы и солнце) со значком воспроизведения. Нужен Pillow (только для разработки).

    python assets/make_icon.py   ->  assets/vomedia.ico, assets/vomedia.png
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
TOP, BOTTOM = (124, 92, 255), (30, 170, 255)   # фон: фиолетовый → голубой, как у VSPO
INK = (84, 118, 255, 255)                      # цвет рисунка на белом
SS = 4                                           # сглаживание: рисуем крупнее и уменьшаем


def gradient(n):
    g = Image.new('RGB', (1, n))
    for y in range(n):
        k = y / max(1, n - 1)
        g.putpixel((0, y), tuple(round(a + (b - a) * k) for a, b in zip(TOP, BOTTOM)))
    return g.resize((n, n))


def draw(size):
    n = size * SS
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    mask = Image.new('L', (n, n), 0)
    pad = round(n * 0.04)
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, n - pad, n - pad], radius=round(n * 0.22), fill=255)
    img.paste(gradient(n), (0, 0), mask)
    over = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    # карточка-фото
    x0, y0, x1, y1 = n * 0.17, n * 0.22, n * 0.76, n * 0.68
    d.rounded_rectangle([x0, y0, x1, y1], radius=n * 0.07, fill=(255, 255, 255, 255))
    # горы внутри карточки
    w, h = x1 - x0, y1 - y0
    base = y1 - h * 0.14
    d.polygon([(x0 + w * 0.10, base), (x0 + w * 0.38, y0 + h * 0.36), (x0 + w * 0.62, base)], fill=INK)
    d.polygon([(x0 + w * 0.42, base), (x0 + w * 0.64, y0 + h * 0.52), (x0 + w * 0.90, base)], fill=INK + ())
    if size >= 32:  # солнце — на мелких размерах превращается в точку-шум
        r = h * 0.11
        cx, cy = x0 + w * 0.76, y0 + h * 0.30
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=INK)
    # значок воспроизведения в правом нижнем углу: белое кольцо, круг цвета рисунка, белый треугольник
    cx, cy, rad = n * 0.70, n * 0.70, n * 0.19
    d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=(255, 255, 255, 255))
    ri = rad * 0.80
    d.ellipse([cx - ri, cy - ri, cx + ri, cy + ri], fill=INK)
    t = ri * 0.48
    d.polygon([(cx - t * 0.62, cy - t), (cx - t * 0.62, cy + t), (cx + t * 1.0, cy)], fill=(255, 255, 255, 255))
    img = Image.alpha_composite(img, over)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    imgs = [draw(s) for s in sizes]
    imgs[-1].save(os.path.join(HERE, 'vomedia.ico'), sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
    draw(512).save(os.path.join(HERE, 'vomedia.png'))
