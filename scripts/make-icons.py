#!/usr/bin/env python3
"""
生成 PWA / 手机桌面图标（assets/icons/）。

图形跟站点 favicon（scripts/build.mjs 里的 FAVICON）是同一个标记：
近黑圆角方块 + 黄色对话气泡。改这里之后重跑一次即可：

    python3 scripts/make-icons.py

产物：
  icon-192.png            普通图标（圆角、外圈透明）
  icon-512.png            普通图标
  icon-maskable-512.png   给 Android 自适应图标用（满幅、无圆角，标记缩到安全区）
  apple-touch-icon.png    180×180，iOS 自己会切圆角，所以不能留透明
"""
import os
from PIL import Image, ImageDraw

BG = (11, 12, 14)        # 近黑，跟站点 --bg 一致
FG = (255, 216, 61)      # 黄，跟站点 --accent 一致
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'icons')
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

# 标记在 32 单位见方里的归一化坐标（照搬 favicon 的 SVG path）
MARK = {
    'box': (8 / 32, 10.5 / 32, 24 / 32, 21.5 / 32),   # x0, y0, x1, y1
    'r': 2 / 32,
    'tail': [(14 / 32, 21.5 / 32), (9.5 / 32, 25 / 32), (9.5 / 32, 21.5 / 32)],
}
# 标记自身的视觉中心（尾巴往下坠，所以重心比 0.5 低一点）
CX = (MARK['tail'][1][0] + MARK['box'][2]) / 2
CY = (MARK['box'][1] + MARK['tail'][1][1]) / 2

SS = 4  # 超采样倍数，先大后缩，边缘才干净


def _scale(p, k):
    """把归一化坐标按标记中心放大 k 倍。"""
    return (CX + (p[0] - CX) * k, CY + (p[1] - CY) * k)


def draw_mark(d, size, k):
    x0, y0 = _scale((MARK['box'][0], MARK['box'][1]), k)
    x1, y1 = _scale((MARK['box'][2], MARK['box'][3]), k)
    box = [x0 * size, y0 * size, x1 * size, y1 * size]
    r = MARK['r'] * k * size
    tail = [_scale(p, k) for p in MARK['tail']]
    d.polygon([(px * size, py * size) for px, py in tail], fill=FG)
    d.rounded_rectangle(box, radius=r, fill=FG)


def render(size, k, corner_ratio):
    """corner_ratio=0 表示满幅（无圆角），否则圆角半径 = size*corner_ratio。"""
    n = size * SS
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    if corner_ratio <= 0:
        base = Image.new('RGBA', (n, n), BG + (255,))
    else:
        base = Image.new('RGBA', (n, n), (0, 0, 0, 0))
        ImageDraw.Draw(base).rounded_rectangle(
            [0, 0, n - 1, n - 1], radius=n * corner_ratio, fill=BG + (255,))
    draw_mark(ImageDraw.Draw(base), n, k)
    img = Image.alpha_composite(img, base)
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ('icon-192.png', 192, 1.34, 0.22),
        ('icon-512.png', 512, 1.34, 0.22),
        # maskable：满幅无圆角，标记收进中心安全区（半径 40% 的圆内）
        ('icon-maskable-512.png', 512, 1.10, 0.0),
        # iOS 会自己切圆角，留透明会露出黑边，所以满幅
        ('apple-touch-icon.png', 180, 1.30, 0.0),
    ]
    for name, size, k, cr in jobs:
        p = os.path.join(OUT, name)
        render(size, k, cr).save(p, 'PNG', optimize=True)
        print(f'  {name:26s} {size}×{size}  {os.path.getsize(p):>6d} B')

    # 站点根的 favicon：浏览器/爬虫的兜底，也给子站（hugo.toml 的 params.assets）引用。
    # 子站发布在 /zbgamelttwo/ 下，所以这两个文件必须放在**源根**。
    ico = os.path.join(ROOT, 'favicon.ico')
    render(64, 1.34, 0.22).save(ico, sizes=[(16, 16), (32, 32), (48, 48)])
    print(f'  {"favicon.ico":26s} 16/32/48     {os.path.getsize(ico):>6d} B')
    for name, size in (('favicon-16x16.png', 16), ('favicon-32x32.png', 32)):
        p = os.path.join(ROOT, name)
        render(size, 1.34, 0.22).save(p, 'PNG', optimize=True)
        print(f'  {name:26s} {size}×{size}  {os.path.getsize(p):>6d} B')


if __name__ == '__main__':
    print(f'→ {os.path.normpath(OUT)}')
    main()
