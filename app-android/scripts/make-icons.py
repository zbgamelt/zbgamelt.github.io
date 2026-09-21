#!/usr/bin/env python3
"""从站点自带的应用图标生成 Android 启动图标（各密度）。

用站点同一个图标，装了 App 一眼能认出是同一家。
素材：zbgamelt.github.io/assets/icons/icon-512.png
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
SRC = "/root/work/zbgamelt.github.io/assets/icons/icon-512.png"

# 密度目录 → 图标边长（px）
DENSITIES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}


def main():
    if not os.path.exists(SRC):
        raise SystemExit(f"找不到源图标：{SRC}")
    src = Image.open(SRC).convert("RGBA")
    print(f"源图标 {src.size[0]}x{src.size[1]}  ← {SRC}")

    for d, size in DENSITIES.items():
        out_dir = os.path.join(PROJ, "res", d)
        os.makedirs(out_dir, exist_ok=True)
        icon = src.resize((size, size), Image.LANCZOS)
        icon.save(os.path.join(out_dir, "ic_launcher.png"), "PNG", optimize=True)
        # 圆形图标：同一张图，系统自己会裁
        icon.save(os.path.join(out_dir, "ic_launcher_round.png"), "PNG", optimize=True)
        print(f"  ✓ {d}/ic_launcher.png  {size}x{size}")


if __name__ == "__main__":
    main()
