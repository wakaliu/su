#!/usr/bin/env python3
"""Export su app icon pack from the confirmed master PNG (A2 + larger glyph)."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "branding" / "icons" / "preview" / "su-icon-final-master.png"
OUT = ROOT / "branding" / "icons"
WIN32 = OUT / "win32"
DARWIN = OUT / "darwin"
PNG = OUT / "png"
MASTER_OUT = OUT / "master"


def rounded_mask(size: int, radius_ratio: float = 0.22) -> Image.Image:
    """Alpha mask for squircle-like rounded square used by Windows app tiles."""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    r = max(1, int(size * radius_ratio))
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=255)
    return mask


def prepare_master(src: Path, canvas: int = 1024) -> Image.Image:
    im = Image.open(src).convert("RGBA")
    # Upscale/downscale to working canvas with high-quality filter.
    im = im.resize((canvas, canvas), Image.Resampling.LANCZOS)
    # Re-apply rounded alpha so exports stay consistent at every size.
    rgb = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 255))
    rgb.paste(im, (0, 0), im)
    mask = rounded_mask(canvas)
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.paste(rgb, (0, 0))
    out.putalpha(mask)
    return out


def save_png(im: Image.Image, path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    resized = im.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(path, format="PNG", optimize=True)


def save_ico(im: Image.Image, path: Path, sizes: list[int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Pillow ICO writer expects the largest image + sizes= list.
    largest = max(sizes)
    base = im.resize((largest, largest), Image.Resampling.LANCZOS)
    base.save(
        path,
        format="ICO",
        sizes=[(s, s) for s in sorted(set(sizes))],
    )


def try_export_darwin_icns(im: Image.Image) -> None:
    """Build branding/icons/darwin/code.icns when iconutil is available (macOS)."""
    import platform
    import shutil
    import subprocess
    import tempfile

    if platform.system() != "Darwin" or not shutil.which("iconutil"):
        print("Skip darwin/code.icns (iconutil only on macOS); CI build-mac may generate it.")
        return

    sizes = [16, 32, 64, 128, 256, 512, 1024]
    with tempfile.TemporaryDirectory(prefix="su-iconset-") as tmp:
        iconset = Path(tmp) / "code.iconset"
        iconset.mkdir()
        for s in sizes:
            save_png(im, iconset / f"icon_{s}x{s}.png", s)
            if s <= 512:
                save_png(im, iconset / f"icon_{s}x{s}@2x.png", s * 2)
        out = DARWIN / "code.icns"
        DARWIN.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(out)],
            check=True,
        )
        print(f"Wrote {out}")


def main() -> None:
    if not MASTER.exists():
        raise SystemExit(f"Missing master: {MASTER}")

    master = prepare_master(MASTER, 1024)
    MASTER_OUT.mkdir(parents=True, exist_ok=True)
    master.save(MASTER_OUT / "su-1024.png", format="PNG", optimize=True)

    png_sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
    for s in png_sizes:
        save_png(master, PNG / f"su-{s}.png", s)

    # VS Code / Electron Windows packaging names.
    save_ico(master, WIN32 / "code.ico", [16, 24, 32, 48, 64, 128, 256])
    save_png(master, WIN32 / "code_150x150.png", 150)
    save_png(master, WIN32 / "code_70x70.png", 70)
    # Also ship as su.ico for documentation / installers.
    save_ico(master, OUT / "su.ico", [16, 24, 32, 48, 64, 128, 256])

    # Darwin: keep a PNG staging copy; .icns is built on macOS via iconutil.
    DARWIN.mkdir(parents=True, exist_ok=True)
    save_png(master, DARWIN / "su-1024.png", 1024)
    try_export_darwin_icns(master)

    print(f"Exported icon pack -> {OUT}")
    for p in sorted(OUT.rglob("*")):
        if p.is_file() and p.suffix.lower() in {".png", ".ico", ".icns", ".jpg"}:
            print(f"  {p.relative_to(OUT)} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
