#!/usr/bin/env python3
"""Convert one generated Oreo SVG variant into a MaCursor .cursor theme.

This intentionally emits MaCursor's native plist format instead of passing
through Windows .cur/.ani or Mousecape .cape importers.
"""

from __future__ import annotations

import argparse
import io
import plistlib
import re
import sys
import tempfile
import uuid
from collections import defaultdict
from pathlib import Path

from PIL import Image

NATIVE_ROOT = Path(__file__).resolve().parents[2]
if str(NATIVE_ROOT) not in sys.path:
    sys.path.insert(0, str(NATIVE_ROOT))

from svg_renderer import render_svg_file  # noqa: E402


# Explicit entries avoid ambiguous aliases (notably macOS's browser/link cursor)
# and preserve Oreo's specialized corner-resize artwork.
MAC_TO_OREO: dict[str, str | None] = {
    "com.apple.coregraphics.Arrow": "default",
    "com.apple.coregraphics.ArrowS": "default",
    "com.apple.coregraphics.ArrowCtx": "context-menu",
    "com.apple.coregraphics.IBeam": "text",
    "com.apple.coregraphics.IBeamS": "text",
    "com.apple.coregraphics.IBeamXOR": "text",
    "com.apple.coregraphics.Alias": "alias",
    "com.apple.coregraphics.Copy": "copy",
    "com.apple.coregraphics.Empty": None,
    "com.apple.coregraphics.Move": "fleur",
    "com.apple.coregraphics.Wait": "wait",
    # NSCursor.dragLinkCursor uses type 2; browsers use PointingHand/type 13.
    "com.apple.cursor.2": "alias",
    "com.apple.cursor.3": "not-allowed",
    "com.apple.cursor.4": "progress",
    "com.apple.cursor.5": "copy",
    "com.apple.cursor.7": "crosshair",
    "com.apple.cursor.8": "tcross",
    "com.apple.cursor.11": "dnd-move",
    "com.apple.cursor.12": "openhand",
    "com.apple.cursor.13": "pointer",
    "com.apple.cursor.17": "left_side",
    "com.apple.cursor.18": "right_side",
    "com.apple.cursor.19": "col-resize",
    # NSCursor.crosshairCursor reports core type 20 on current macOS.
    "com.apple.cursor.20": "crosshair",
    "com.apple.cursor.21": "top_side",
    "com.apple.cursor.22": "bottom_side",
    "com.apple.cursor.23": "row-resize",
    "com.apple.cursor.24": "context-menu",
    "com.apple.cursor.25": "pirate",
    "com.apple.cursor.26": "vertical-text",
    "com.apple.cursor.27": "right-arrow",
    "com.apple.cursor.28": "size_hor",
    "com.apple.cursor.29": "top_right_corner",
    "com.apple.cursor.30": "size_bdiag",
    "com.apple.cursor.31": "up-arrow",
    "com.apple.cursor.32": "size_ver",
    "com.apple.cursor.33": "top_left_corner",
    "com.apple.cursor.34": "size_fdiag",
    "com.apple.cursor.35": "bottom_right_corner",
    "com.apple.cursor.36": "down-arrow",
    "com.apple.cursor.37": "bottom_left_corner",
    "com.apple.cursor.38": "left-arrow",
    "com.apple.cursor.39": "fleur",
    "com.apple.cursor.40": "help",
    "com.apple.cursor.41": "cell",
    "com.apple.cursor.42": "zoom-in",
    "com.apple.cursor.43": "zoom-out",
}

MAX_MACOS_FRAMES = 24
REPRESENTATION_SIZES = (32, 64, 96, 128)


def parse_config(path: Path) -> dict[int, list[dict[str, object]]]:
    groups: dict[int, list[dict[str, object]]] = defaultdict(list)
    for line_number, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) not in (4, 5):
            raise ValueError(f"{path}:{line_number}: malformed cursor row")
        size, hotspot_x, hotspot_y = map(int, parts[:3])
        filename = parts[3]
        delay_ms = int(parts[4]) if len(parts) == 5 else None
        groups[size].append(
            {
                "hotspot": (hotspot_x, hotspot_y),
                "filename": filename,
                "delay_ms": delay_ms,
            }
        )
    return dict(groups)


def source_svg_name(configured_png_name: str) -> str:
    # Xcursor configs name size-specific PNGs, while Oreo stores one vector
    # source for both sizes.
    stem = re.sub(r"_(?:32|64)\.png$", "", configured_png_name)
    return stem + ".svg"


def selected_indices(frame_count: int) -> list[int]:
    if frame_count <= MAX_MACOS_FRAMES:
        return list(range(frame_count))
    return [(i * frame_count) // MAX_MACOS_FRAMES for i in range(MAX_MACOS_FRAMES)]


def normalize_svg(source: Path, destination: Path) -> None:
    data = source.read_text()
    # Upstream's generator currently leaves this template token unresolved.
    # SVG renderers treat the invalid value inconsistently; full opacity is
    # the intended/default rendering.
    data = data.replace('opacity="{{ opacity }}"', 'opacity="1"')
    destination.write_text(data)


def render_all(
    source_theme_dir: Path,
    configs: dict[str, dict[int, list[dict[str, object]]]],
    temp_root: Path,
) -> dict[tuple[str, int], Path]:
    normalized_dir = temp_root / "svg"
    normalized_dir.mkdir()

    needed_svg_names = {
        source_svg_name(str(frame["filename"]))
        for config in configs.values()
        for size_frames in config.values()
        for frame in size_frames
    }
    for svg_name in sorted(needed_svg_names):
        normalize_svg(source_theme_dir / svg_name, normalized_dir / svg_name)

    rendered: dict[tuple[str, int], Path] = {}
    for size in REPRESENTATION_SIZES:
        output_dir = temp_root / f"png-{size}"
        output_dir.mkdir()
        for svg_name in sorted(needed_svg_names):
            png_name = Path(svg_name).with_suffix(".png").name
            output = output_dir / png_name
            render_svg_file(normalized_dir / svg_name, size, output)
            rendered[(svg_name, size)] = output
    return rendered


def compose_representation(
    frames: list[dict[str, object]],
    size: int,
    rendered: dict[tuple[str, int], Path],
    indices: list[int],
) -> bytes:
    sheet = Image.new("RGBA", (size, size * len(indices)), (0, 0, 0, 0))
    for output_index, source_index in enumerate(indices):
        svg_name = source_svg_name(str(frames[source_index]["filename"]))
        with Image.open(rendered[(svg_name, size)]) as image:
            frame = image.convert("RGBA")
            if frame.size != (size, size):
                raise ValueError(f"{svg_name}: expected {size}x{size}, got {frame.size}")
            sheet.paste(frame, (0, output_index * size))
    buffer = io.BytesIO()
    sheet.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def build_cursor(
    name: str,
    config: dict[int, list[dict[str, object]]],
    rendered: dict[tuple[str, int], Path],
) -> dict[str, object]:
    if 32 not in config or 64 not in config:
        raise ValueError(f"{name}: both 32px and 64px source definitions are required")
    frames_1x = config[32]
    frames_2x = config[64]
    if len(frames_1x) != len(frames_2x):
        raise ValueError(f"{name}: 1x/2x frame counts differ")

    for one, two in zip(frames_1x, frames_2x):
        x1, y1 = one["hotspot"]
        x2, y2 = two["hotspot"]
        if (x2, y2) != (x1 * 2, y1 * 2):
            raise ValueError(f"{name}: 2x hotspot is not exactly double the 1x hotspot")

    indices = selected_indices(len(frames_1x))
    delays = {frame["delay_ms"] for frame in frames_1x}
    if len(delays) != 1:
        raise ValueError(f"{name}: variable frame delays are not representable by MaCursor")
    original_delay_ms = delays.pop()
    if len(frames_1x) == 1:
        frame_duration = 1.0
    else:
        if original_delay_ms is None:
            raise ValueError(f"{name}: animated cursor has no frame delay")
        total_duration = (original_delay_ms / 1000.0) * len(frames_1x)
        frame_duration = total_duration / len(indices)

    hotspot_x, hotspot_y = frames_1x[0]["hotspot"]
    return {
        "FrameCount": len(indices),
        "FrameDuration": frame_duration,
        "HotSpotX": float(hotspot_x),
        "HotSpotY": float(hotspot_y),
        "PointsWide": 32.0,
        "PointsHigh": 32.0,
        "Representations": [
            compose_representation(
                frames_1x if size == 32 else frames_2x,
                size,
                rendered,
                indices,
            )
            for size in REPRESENTATION_SIZES
        ],
    }


def transparent_cursor() -> dict[str, object]:
    representations = []
    for size in REPRESENTATION_SIZES:
        image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        representations.append(buffer.getvalue())
    return {
        "FrameCount": 1,
        "FrameDuration": 1.0,
        "HotSpotX": 0.0,
        "HotSpotY": 0.0,
        "PointsWide": 32.0,
        "PointsHigh": 32.0,
        "Representations": representations,
    }


def convert(oreo_root: Path, variant: str, output: Path) -> None:
    source_theme_dir = oreo_root / "src" / f"oreo_{variant}_cursors"
    config_dir = oreo_root / "src" / "config"
    if not source_theme_dir.is_dir():
        raise FileNotFoundError(f"generated Oreo variant not found: {source_theme_dir}")

    source_names = sorted({name for name in MAC_TO_OREO.values() if name is not None})
    configs = {
        name: parse_config(config_dir / f"{name}.cursor") for name in source_names
    }

    with tempfile.TemporaryDirectory(prefix="oreo-macursor-") as temp:
        rendered = render_all(source_theme_dir, configs, Path(temp))
        built_sources = {
            name: build_cursor(name, config, rendered)
            for name, config in configs.items()
        }

    title = " ".join(word.capitalize() for word in variant.split("_"))
    theme_name = f"Oreo {title}"
    namespace = uuid.UUID("193513ce-4c25-4e1a-9e28-878e5850bb6e")
    theme = {
        "Creator": "Varlesh / Sourav Goswami; macOS conversion by mapleroyal",
        "Cursors": {
            mac_identifier: (
                built_sources[oreo_name]
                if oreo_name is not None
                else transparent_cursor()
            )
            for mac_identifier, oreo_name in MAC_TO_OREO.items()
        },
        "HiDPI": True,
        "Identifier": f"Oreo{''.join(word.capitalize() for word in variant.split('_'))}",
        "ThemeName": theme_name,
        "ThemeVersion": 1.0,
        "UUID": str(uuid.uuid5(namespace, f"oreo-cursors:{variant}")).upper(),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        plistlib.dump(theme, handle, fmt=plistlib.FMT_BINARY, sort_keys=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("oreo_root", type=Path)
    parser.add_argument("variant")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    convert(args.oreo_root.resolve(), args.variant, args.output.resolve())
    print(args.output.resolve())


if __name__ == "__main__":
    main()
