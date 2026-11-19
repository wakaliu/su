#!/usr/bin/env python3
"""Export the su icon pack from branding/icons/master/su.svg (requires Pillow)."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "branding" / "icons"
MASTER = OUT / "master" / "su.svg"
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def render_master(size: int = 1024) -> Image.Image:
    """Rasterize our restricted SVG: one rounded rect and rounded polylines."""
    svg = ET.parse(MASTER).getroot()
    ns = "{http://www.w3.org/2000/svg}"
    rect = svg.find(f"{ns}rect")
    strokes = svg.find(f"{ns}g")
    if rect is None or strokes is None:
        raise ValueError("Expected a rounded rect and a group of polylines in su.svg")
    scale = size / 64  # viewBox="0 0 64 64"
    image = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(image)
    x, y = (float(rect.attrib[k]) * scale for k in ("x", "y"))
    w, h = (float(rect.attrib[k]) * scale for k in ("width", "height"))
    draw.rounded_rectangle((x, y, x + w, y + h), radius=float(rect.attrib["rx"]) * scale,
                           fill=rect.attrib["fill"])
    width = round(float(strokes.attrib["stroke-width"]) * scale)
    r = width / 2
    for stroke in strokes:
        if stroke.tag != f"{ns}polyline":
            raise ValueError(f"Unsupported SVG glyph element: {stroke.tag}")
        points = [tuple(float(v) * scale for v in point.split(","))
                  for point in stroke.attrib["points"].split()]
        color = stroke.attrib["stroke"]
        draw.line(points, fill=color, width=width)
        for px, py in points:  # round joins and caps, as in the SVG
            draw.ellipse((px - r, py - r, px + r, py + r), fill=color)
    return image


def resized(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.Resampling.LANCZOS)


def save_png(image: Image.Image, path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    resized(image, size).save(path, optimize=True)


def main() -> None:
    master = render_master(2048)
    save_png(master, OUT / "master" / "su-1024.png", 1024)
    for size in [16, 24, 32, 48, 64, 128, 256, 512, 1024]:
        save_png(master, OUT / "png" / f"su-{size}.png", size)

    win = OUT / "win32"
    save_png(master, win / "code_150x150.png", 150)
    save_png(master, win / "code_70x70.png", 70)
    frames = [resized(master, size) for size in ICO_SIZES]
    ico = win / "code.ico"
    frames[-1].save(ico, sizes=[frame.size for frame in frames], append_images=frames[:-1])
    (OUT / "su.ico").write_bytes(ico.read_bytes())

    darwin = OUT / "darwin"
    save_png(master, darwin / "su-1024.png", 1024)
    # Pillow writes the PNG-backed ICNS variants on any platform.
    resized(master, 1024).save(darwin / "code.icns")
    print(f"Exported su icons -> {OUT}")


if __name__ == "__main__":
    main()
