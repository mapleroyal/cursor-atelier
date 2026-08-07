#!/usr/bin/env python3
"""Build Linux/Xcursor artwork as native MaCursor ``.cursor`` themes.

The cursor engine consumes the same binary property-list shape used by
Mousecape/MaCursor.  This module deliberately keeps conversion at build time:
it accepts already checked-in source trees (SVG/PNG, Xcursor binaries, or
Mousecape ``.cape`` files), renders deterministic multi-scale PNG sprite
sheets, and emits a manifest alongside the resulting themes.

The converter does not download source repositories.  Fetching and pinning
upstream artwork belongs in the release pipeline; this file only transforms a
resolved source directory. Pillow is the sole Python dependency. SVG artwork
is rendered consistently with the build-time librsvg dependency.
"""

from __future__ import annotations

import argparse
import ast
import bisect
import hashlib
import io
import json
import math
import os
import plistlib
import re
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import uuid
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence, Union
from xml.etree import ElementTree

from PIL import Image, ImageChops, ImageStat

NATIVE_ROOT = Path(__file__).resolve().parents[1]
if str(NATIVE_ROOT) not in sys.path:
    sys.path.insert(0, str(NATIVE_ROOT))

from svg_renderer import render_svg_file  # noqa: E402


# These identifiers are the private CoreGraphics cursor names used by the
# native engine.  Keep this list in lockstep with OreoCursorEngine.m.  The
# source role on the right is canonicalized against common Xcursor aliases.
MAC_TO_ROLE: dict[str, str | None] = {
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

MAC_CURSOR_IDENTIFIERS = tuple(MAC_TO_ROLE)
MAX_MACOS_FRAMES = 24
MACURSOR_UUID_NAMESPACE = uuid.UUID("193513ce-4c25-4e1a-9e28-878e5850bb6e")
BASE_REPRESENTATION_SIZES = (32, 64, 96)
VECTOR_REPRESENTATION_SIZES = (*BASE_REPRESENTATION_SIZES, 128)
MAX_REPRESENTATION_SIZE = 320
DEFAULT_ANIMATION_DELAY_MS = 50.0
MAX_HOTSPOT_ALIGNMENT_FRACTION = 0.25


# Xcursor aliases and the spelling used by the requested sources differ.  We
# normalize before lookup rather than maintaining per-project conversion
# tables.  Unknown roles are retained, which lets a source add a future role
# without making this converter fail.
ROLE_ALIASES: dict[str, str] = {
    "left-ptr": "default",
    "left_ptr": "default",
    "arrow": "default",
    "right-ptr": "right-arrow",
    "right_ptr": "right-arrow",
    "xterm": "text",
    "ibeam": "text",
    "hand1": "openhand",
    "hand2": "pointer",
    "link": "pointer",
    "pointinghand": "pointer",
    "open-hand": "openhand",
    "closedhand": "dnd-move",
    "grab": "openhand",
    "grabbing": "dnd-move",
    "move": "fleur",
    "all-scroll": "fleur",
    "all_scroll": "fleur",
    "bd-double-arrow": "size_fdiag",
    "bd_double_arrow": "size_fdiag",
    "fd-double-arrow": "size_bdiag",
    "fd_double_arrow": "size_bdiag",
    "forbidden": "not-allowed",
    "crossed-circle": "not-allowed",
    "crossed_circle": "not-allowed",
    "dnd-no-drop": "not-allowed",
    "dnd_no_drop": "not-allowed",
    "dnd-copy": "copy",
    "dnd_copy": "copy",
    "dnd-link": "alias",
    "dnd_link": "alias",
    "dnd-ask": "help",
    "dnd_ask": "help",
    "left-ptr-watch": "progress",
    "left_ptr_watch": "progress",
    "watch": "wait",
    "question-arrow": "help",
    "question_arrow": "help",
    "circle": "not-allowed",
    "crossed-circle": "not-allowed",
    "crossed_circle": "not-allowed",
    "cross": "crosshair",
    "plus": "cell",
    "pointer-move": "dnd-move",
    "pointer_move": "dnd-move",
    "x-cursor": "pirate",
    "x_cursor": "pirate",
    "sb-down-arrow": "down-arrow",
    "sb_down_arrow": "down-arrow",
    "sb-left-arrow": "left-arrow",
    "sb_left_arrow": "left-arrow",
    "sb-right-arrow": "right-arrow",
    "sb_right_arrow": "right-arrow",
    "sb-up-arrow": "up-arrow",
    "sb_up_arrow": "up-arrow",
    "sb-h-double-arrow": "size_hor",
    "sb_h_double_arrow": "size_hor",
    "sb-v-double-arrow": "size_ver",
    "sb_v_double_arrow": "size_ver",
    "size-hor": "size_hor",
    "size_ver": "size_ver",
    "size-hor": "size_hor",
    "h_double_arrow": "size_hor",
    "sb-h-double-arrow": "size_hor",
    "sb_h_double_arrow": "size_hor",
    "v_double_arrow": "size_ver",
    "sb-v-double-arrow": "size_ver",
    "sb_v_double_arrow": "size_ver",
    "nwse-resize": "size_fdiag",
    "nwse_resize": "size_fdiag",
    "nesw-resize": "size_bdiag",
    "nesw_resize": "size_bdiag",
    "e-resize": "right_side",
    "w-resize": "left_side",
    "n-resize": "top_side",
    "s-resize": "bottom_side",
    "ew-resize": "col-resize",
    "ns-resize": "row-resize",
    "ne-resize": "top_right_corner",
    "nw-resize": "top_left_corner",
    "se-resize": "bottom_right_corner",
    "sw-resize": "bottom_left_corner",
    "zoom_in": "zoom-in",
    "zoom_out": "zoom-out",
    "vertical_text": "vertical-text",
    "top_side": "top_side",
    "bottom_side": "bottom_side",
}


@dataclass(frozen=True)
class Frame:
    """One rendered cursor frame at its source pixel dimensions."""

    image: Image.Image
    hotspot_x: float
    hotspot_y: float
    delay_ms: float | None = None
    nominal_size: int | None = None


# A source may provide one raster sequence or independent sequences for
# several output scales. Keeping those sequences separate is essential:
# Xcursor and Cape files often contain genuine high-resolution artwork that
# must not be reconstructed from their smallest bitmap.
FrameSource = Union[Sequence[Frame], Mapping[int, Sequence[Frame]]]


@dataclass(frozen=True)
class ConfigFrame:
    size: int
    hotspot_x: float
    hotspot_y: float
    filename: str
    delay_ms: int | None = None


@dataclass(frozen=True)
class AssetSpec:
    """One upstream build-config entry for bitmap/SVG artwork."""

    role: str
    pattern: str
    hotspot_x: float
    hotspot_y: float
    delay_ms: int
    aliases: tuple[str, ...] = ()


def _normalized_role_name(value: str) -> str:
    role = Path(value).name
    role = re.sub(r"\.(?:png|svg|cursor|spec|cur)$", "", role, flags=re.I)
    # Names from source generators commonly end in ``_24_24`` or ``-32``;
    # peel every trailing pixel-size component, not just one.
    while re.search(r"(?:[-_](?:\d{2,4})(?:x\d{2,4})?)$", role):
        role = re.sub(r"(?:[-_](?:\d{2,4})(?:x\d{2,4})?)$", "", role)
    role = role.strip().lower().replace(" ", "-")
    return role


def canonical_role(value: str) -> str:
    """Return a stable role spelling used by :data:`MAC_TO_ROLE`."""

    role = _normalized_role_name(value)
    return ROLE_ALIASES.get(role, role)


def _xcursor_role_priority(value: str) -> int:
    """Prefer an explicitly named role over a historical Xcursor alias."""

    role = _normalized_role_name(value)
    return 2 if role == canonical_role(role) else 1


def _natural_key(value: str | Path) -> tuple[Any, ...]:
    """Sort numbered animation frames numerically and deterministically."""

    return tuple(
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", str(value))
    )


def selected_indices(frame_count: int, maximum: int = MAX_MACOS_FRAMES) -> list[int]:
    """Evenly sample one cyclic animation phase without repeating its endpoint."""

    if frame_count <= 0:
        raise ValueError("a cursor must contain at least one frame")
    if frame_count <= maximum:
        return list(range(frame_count))
    return [(index * frame_count) // maximum for index in range(maximum)]


def _png_bytes(image: Image.Image) -> bytes:
    out = io.BytesIO()
    image.convert("RGBA").save(out, format="PNG", optimize=True)
    return out.getvalue()


def _transparent_cursor() -> dict[str, Any]:
    return {
        "FrameCount": 1,
        "FrameDuration": 1.0,
        "HotSpotX": 0.0,
        "HotSpotY": 0.0,
        "PointsWide": 32.0,
        "PointsHigh": 32.0,
        "Representations": [
            _png_bytes(Image.new("RGBA", (size, size), (0, 0, 0, 0)))
            for size in VECTOR_REPRESENTATION_SIZES
        ],
    }


def _square_pad(image: Image.Image) -> Image.Image:
    """Pad a raster at its bottom/right edge without changing its geometry."""

    image = image.convert("RGBA")
    canvas_size = max(image.size)
    if image.size == (canvas_size, canvas_size):
        return image
    padded = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    padded.paste(image, (0, 0))
    return padded


def _resize(image: Image.Image, size: int) -> Image.Image:
    image = _square_pad(image)
    if image.size == (size, size):
        resized = image
    else:
        # Resampling straight-alpha RGBA independently lets fully transparent
        # RGB bleed into the visible edge. Pillow's RGBa mode performs the
        # filter on associated (premultiplied) channels, then converts back to
        # PNG's required straight-alpha representation.
        resized = (
            image.convert("RGBa")
            .resize((size, size), Image.Resampling.LANCZOS)
            .convert("RGBA")
        )

    # RGB is undefined where alpha is zero. Clear the tiny rounding residue
    # left by RGBa -> RGBA conversion so a later non-premultiplied consumer
    # cannot pull hidden color back into the edge.
    visible = resized.getchannel("A").point([0] + [255] * 255)
    return Image.composite(
        resized,
        Image.new("RGBA", resized.size, (0, 0, 0, 0)),
        visible,
    )


def _normalized_hotspot(frame: Frame) -> tuple[float, float]:
    canvas_size = max(1, *frame.image.size)

    def coordinate(value: float) -> float:
        normalized = float(value) / canvas_size
        if not math.isfinite(normalized):
            return 0.0
        return min(1.0, max(0.0, normalized))

    return coordinate(frame.hotspot_x), coordinate(frame.hotspot_y)


def _tier_hotspot(frames: Sequence[Frame]) -> tuple[float, float]:
    normalized = [_normalized_hotspot(frame) for frame in frames]
    return (
        statistics.median(point[0] for point in normalized),
        statistics.median(point[1] for point in normalized),
    )


def _common_hotspot(groups: Mapping[int, Sequence[Frame]]) -> tuple[float, float]:
    """Find a robust normalized hotspot without letting one tier dominate."""

    tier_hotspots = [
        _tier_hotspot(groups[size]) for size in sorted(groups) if groups[size]
    ]
    if not tier_hotspots:
        return 0.0, 0.0
    return (
        statistics.median(point[0] for point in tier_hotspots),
        statistics.median(point[1] for point in tier_hotspots),
    )


def _aligned_frame(
    frame: Frame,
    size: int,
    tier_hotspot: tuple[float, float],
) -> Image.Image:
    """Resize and align small authored hotspot drift without clipping artwork."""

    image = _resize(frame.image, size)
    source_hotspot = _normalized_hotspot(frame)
    requested = (
        (tier_hotspot[0] - source_hotspot[0]) * size,
        (tier_hotspot[1] - source_hotspot[1]) * size,
    )
    maximum_shift = size * MAX_HOTSPOT_ALIGNMENT_FRACTION
    # A large discrepancy is almost always bad tier metadata, not animated
    # artwork that should be moved across the canvas. The median hotspot still
    # repairs the record, while leaving that frame's pixels undisturbed.
    if any(abs(delta) > maximum_shift for delta in requested):
        return image

    shift_x, shift_y = (round(requested[0]), round(requested[1]))
    alpha_bounds = image.getchannel("A").getbbox()
    if alpha_bounds is None or (shift_x == 0 and shift_y == 0):
        return image
    left, top, right, bottom = alpha_bounds
    shift_x = min(size - right, max(-left, shift_x))
    shift_y = min(size - bottom, max(-top, shift_y))
    if shift_x == 0 and shift_y == 0:
        return image
    aligned = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    aligned.alpha_composite(image, (shift_x, shift_y))
    return aligned


def _compose(
    frames: Sequence[Frame],
    indices: Sequence[int],
    size: int,
    tier_hotspot: tuple[float, float],
) -> bytes:
    sheet = Image.new("RGBA", (size, size * len(indices)), (0, 0, 0, 0))
    for output_index, source_index in enumerate(indices):
        frame = _aligned_frame(frames[source_index], size, tier_hotspot)
        sheet.paste(frame, (0, output_index * size))
    return _png_bytes(sheet)


def _frame_groups(source: FrameSource) -> tuple[dict[int, list[Frame]], bool]:
    if isinstance(source, Mapping):
        groups = {
            int(size): list(frames)
            for size, frames in source.items()
            if int(size) > 0 and frames
        }
        return groups, True
    frames = list(source)
    if not frames:
        return {}, False
    source_size = max(1, *frames[0].image.size)
    return {source_size: frames}, False


def _representation_sizes(
    groups: Mapping[int, Sequence[Frame]],
    scale_specific: bool,
) -> list[int]:
    sizes = set(BASE_REPRESENTATION_SIZES)
    if scale_specific:
        sizes.update(
            size
            for size in groups
            if BASE_REPRESENTATION_SIZES[0] <= size <= MAX_REPRESENTATION_SIZE
        )
    elif groups:
        # A single large bitmap can safely be reduced for a 4x master. The
        # standard 1x/2x/3x ladder is always present; 4x is added only when the
        # source actually contains enough information.
        source_size = max(groups)
        if source_size >= VECTOR_REPRESENTATION_SIZES[-1]:
            sizes.add(VECTOR_REPRESENTATION_SIZES[-1])
    return sorted(sizes)


def _frames_for_size(
    groups: Mapping[int, Sequence[Frame]], target_size: int
) -> list[Frame]:
    if target_size in groups:
        return list(groups[target_size])
    larger = [size for size in groups if size > target_size]
    source_size = min(larger) if larger else max(groups)
    return list(groups[source_size])


def _frame_delays(frames: Sequence[Frame]) -> tuple[list[float], bool]:
    authored = [
        float(frame.delay_ms)
        for frame in frames
        if frame.delay_ms is not None
        and math.isfinite(float(frame.delay_ms))
        and float(frame.delay_ms) > 0
    ]
    if not authored:
        return [DEFAULT_ANIMATION_DELAY_MS] * len(frames), False
    fallback = statistics.median(authored)
    return (
        [
            float(frame.delay_ms)
            if frame.delay_ms is not None
            and math.isfinite(float(frame.delay_ms))
            and float(frame.delay_ms) > 0
            else fallback
            for frame in frames
        ],
        True,
    )


def _phase_indices_at(
    frames: Sequence[Frame],
    output_count: int,
    offset: float,
) -> list[int]:
    delays, _authored = _frame_delays(frames)
    cycle = sum(delays)
    boundaries: list[float] = []
    elapsed = 0.0
    for delay in delays:
        elapsed += delay
        boundaries.append(elapsed)
    return [
        min(
            len(frames) - 1,
            bisect.bisect_right(
                boundaries,
                ((index + offset) / output_count) * cycle,
            ),
        )
        for index in range(output_count)
    ]


def _phase_indices(frames: Sequence[Frame], output_count: int) -> list[int]:
    return _phase_indices_at(frames, output_count, 0.5)


def _animation_timeline(
    groups: Mapping[int, Sequence[Frame]],
) -> tuple[int, float]:
    """Return a common frame count and uniform MaCursor delay for all tiers."""

    maximum_source_count = max(len(frames) for frames in groups.values())
    if maximum_source_count == 1:
        return 1, 1.0

    output_count = min(MAX_MACOS_FRAMES, maximum_source_count)
    all_delays_absent = not any(
        _frame_delays(frames)[1] for frames in groups.values()
    )
    if all_delays_absent:
        return output_count, DEFAULT_ANIMATION_DELAY_MS / 1000.0

    canonical_size = min(
        groups,
        key=lambda size: (abs(size - BASE_REPRESENTATION_SIZES[0]), size),
    )
    canonical_delays, _authored = _frame_delays(groups[canonical_size])
    cycle_ms = sum(canonical_delays)
    if max(canonical_delays) - min(canonical_delays) > 1e-9:
        dwell_count = math.ceil(cycle_ms / min(canonical_delays))
        output_count = min(
            MAX_MACOS_FRAMES,
            max(output_count, dwell_count),
        )
    return output_count, max(0.001, cycle_ms / output_count / 1000.0)


def build_cursor(frames: FrameSource) -> dict[str, Any]:
    """Build one MaCursor cursor record from source frames.

    Hotspots are expressed in source image coordinates. MaCursor has one
    hotspot and one delay for every tier/frame, so both are normalized across
    the full source pyramid while retaining authored animation dwell.
    """

    groups, scale_specific = _frame_groups(frames)
    if not groups:
        return _transparent_cursor()
    representation_sizes = _representation_sizes(groups, scale_specific)
    frame_count, duration = _animation_timeline(groups)
    hotspot = _common_hotspot(groups)
    return {
        "FrameCount": frame_count,
        "FrameDuration": duration,
        "HotSpotX": hotspot[0] * 32.0,
        "HotSpotY": hotspot[1] * 32.0,
        "PointsWide": 32.0,
        "PointsHigh": 32.0,
        "Representations": [
            _compose(
                tier_frames,
                _phase_indices(tier_frames, frame_count),
                size,
                _tier_hotspot(tier_frames),
            )
            for size in representation_sizes
            for tier_frames in [_frames_for_size(groups, size)]
        ],
    }


def parse_xcursor(path: Path) -> list[Frame]:
    """Decode an Xcursor image file without requiring Linux ``xcursorgen``.

    Xcursor stores ARGB pixels in little-endian CARD32 words.  Reading words
    (rather than treating the payload as RGBA bytes) keeps colors correct on
    both little- and big-endian hosts.
    """

    data = path.read_bytes()
    if len(data) < 16 or data[:4] != b"Xcur":
        raise ValueError(f"{path} is not an Xcursor file")
    header, version, toc_count = struct.unpack_from("<3I", data, 4)
    if header < 16 or version != 0x10000:
        raise ValueError(f"{path}: unsupported Xcursor header")
    frames: list[Frame] = []
    for index in range(toc_count):
        offset = 16 + index * 12
        if offset + 12 > len(data):
            raise ValueError(f"{path}: truncated TOC")
        chunk_type, toc_subtype, chunk_offset = struct.unpack_from("<3I", data, offset)
        # XCURSOR_IMAGE_TYPE is 0xfffd0002 (the value is unsigned in files).
        if chunk_type != 0xFFFD0002 or chunk_offset + 36 > len(data):
            continue
        values = struct.unpack_from("<9I", data, chunk_offset)
        chunk_header, _type, nominal_size, chunk_version = values[:4]
        width, height, hot_x, hot_y, delay = values[4:]
        if chunk_header < 36 or chunk_version != 1:
            continue
        pixel_start = chunk_offset + chunk_header
        pixel_count = width * height
        pixel_end = pixel_start + pixel_count * 4
        if width == 0 or height == 0 or pixel_end > len(data):
            raise ValueError(f"{path}: invalid image chunk")
        image = Image.new("RGBA", (width, height))
        pixels: list[tuple[int, int, int, int]] = []
        for (word,) in struct.iter_unpack("<I", data[pixel_start:pixel_end]):
            alpha = word >> 24
            red = (word >> 16) & 0xFF
            green = (word >> 8) & 0xFF
            blue = word & 0xFF
            if alpha == 0:
                pixels.append((0, 0, 0, 0))
            elif alpha == 255:
                pixels.append((red, green, blue, alpha))
            else:
                # xcursorgen stores associated ARGB. PNG stores unassociated
                # alpha, so recover straight color exactly once at this format
                # boundary instead of darkening the edge during composition.
                pixels.append(
                    (
                        min(255, (red * 255 + alpha // 2) // alpha),
                        min(255, (green * 255 + alpha // 2) // alpha),
                        min(255, (blue * 255 + alpha // 2) // alpha),
                        alpha,
                    )
                )
        image.putdata(pixels)
        frames.append(
            Frame(
                image,
                hot_x,
                hot_y,
                delay if delay else None,
                int(nominal_size or toc_subtype or width),
            )
        )
    if not frames:
        raise ValueError(f"{path}: no image chunks")
    # Xcursor TOCs are usually grouped by size. Preserve chunk order for
    # animation, but prefer the most useful size when a source has aliases.
    return frames


def _extract_sprite(image: Image.Image, frame_count: int) -> list[Image.Image]:
    image = image.convert("RGBA")
    if frame_count <= 1 or image.height < image.width * frame_count:
        return [image]
    frame_height = image.height // frame_count
    if frame_height <= 0:
        return [image]
    return [image.crop((0, index * frame_height, image.width, (index + 1) * frame_height)) for index in range(frame_count)]


def _unpremultiply_image(image: Image.Image) -> Image.Image:
    """Convert associated RGBA channels to PNG-compatible straight alpha."""

    image = image.convert("RGBA")
    pixels: list[tuple[int, int, int, int]] = []
    for red, green, blue, alpha in image.getdata():
        if alpha == 0:
            pixels.append((0, 0, 0, 0))
        elif alpha == 255:
            pixels.append((red, green, blue, alpha))
        else:
            pixels.append(
                (
                    min(255, (red * 255 + alpha // 2) // alpha),
                    min(255, (green * 255 + alpha // 2) // alpha),
                    min(255, (blue * 255 + alpha // 2) // alpha),
                    alpha,
                )
            )
    output = Image.new("RGBA", image.size)
    output.putdata(pixels)
    return output


def _normalize_cape_alpha(image: Image.Image) -> Image.Image:
    """Normalize Mousecape's mixed associated/straight-alpha PNG payloads."""

    image = image.convert("RGBA")
    partial = [pixel for pixel in image.getdata() if 0 < pixel[3] < 255]
    if not partial:
        return image
    # Associated-alpha channels cannot exceed alpha. Some Nordzy capes mix
    # associated 1x/2x payloads with a straight-alpha high-resolution payload,
    # so treating every embedded PNG alike damages one tier or the other.
    if any(max(red, green, blue) > alpha for red, green, blue, alpha in partial):
        return image
    return _unpremultiply_image(image)


def parse_cape(path: Path) -> dict[str, dict[int, list[Frame]]]:
    """Read a Mousecape ``.cape`` plist and normalize its sprite sheets."""

    try:
        plist = plistlib.loads(path.read_bytes())
    except Exception as exc:  # pragma: no cover - plistlib supplies detail
        raise ValueError(f"{path}: invalid cape plist: {exc}") from exc
    cursors = plist.get("Cursors")
    if not isinstance(cursors, Mapping):
        raise ValueError(f"{path}: cape has no Cursors dictionary")
    result: dict[str, dict[int, list[Frame]]] = {}
    for mac_identifier, record in cursors.items():
        if not isinstance(record, Mapping):
            continue
        representations = record.get("Representations", [])
        if not representations:
            continue
        frame_count = max(1, int(record.get("FrameCount", 1)))
        images: list[Image.Image] = []
        for representation in representations:
            with Image.open(io.BytesIO(representation)) as source:
                images.append(_normalize_cape_alpha(source))
        points_width = float(record.get("PointsWide", images[0].width) or images[0].width)
        hot_x_points = float(record.get("HotSpotX", 0.0))
        hot_y_points = float(record.get("HotSpotY", 0.0))
        delay = float(record.get("FrameDuration", 1.0)) * 1000.0
        pyramid: dict[int, list[Frame]] = {}
        for image in sorted(images, key=lambda candidate: candidate.width):
            source_scale = image.width / max(1.0, points_width)
            target_size = max(1, round(32.0 * source_scale))
            source_frames = _extract_sprite(image, frame_count)
            pyramid[target_size] = [
                Frame(
                    frame,
                    hot_x_points * source_scale,
                    hot_y_points * source_scale,
                    round(delay),
                    target_size,
                )
                for frame in source_frames
            ]
        result[str(mac_identifier)] = pyramid
    return result


def parse_config(path: Path) -> dict[str, list[ConfigFrame]]:
    """Parse the plain-text ``xcursorgen`` config format."""

    groups: dict[str, list[ConfigFrame]] = defaultdict(list)
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
        groups[canonical_role(Path(filename).name)].append(
            ConfigFrame(size, hotspot_x, hotspot_y, filename, delay_ms)
        )
    return dict(groups)


def parse_spec(path: Path) -> list[ConfigFrame]:
    """Parse Capitaine's compact hotspot/animation ``.spec`` format.

    Static files contain ``xhot yhot``; animated files append
    ``frame_count delay_ms``. Coordinates are pixels in the 24px SVG canvas,
    not normalized fractions. Generated frames are named ``role.svg`` or
    ``role-00.svg``.
    """

    rows: list[ConfigFrame] = []
    for line_number, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            xhot, yhot = float(parts[0]), float(parts[1])
            frame_count = int(parts[2]) if len(parts) >= 4 else 1
            delay = int(parts[3]) if len(parts) >= 4 else None
        except ValueError as exc:
            raise ValueError(f"{path}:{line_number}: malformed spec row") from exc
        role = path.stem
        for index in range(max(1, frame_count)):
            filename = f"{role}.svg" if frame_count == 1 else f"{role}-{index:02d}.svg"
            rows.append(ConfigFrame(24, xhot, yhot, filename, delay))
    return rows


def render_svg(svg: Path, size: int, cache: Path) -> Image.Image:
    """Render SVG with librsvg at an exact square size using a local cache."""

    cache.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(
        b"librsvg\0" + svg.read_bytes() + str(size).encode()
    ).hexdigest()[:24]
    output = cache / f"{key}.png"
    if not output.exists():
        render_svg_file(svg, size, output)
    with Image.open(output) as image:
        return image.convert("RGBA")


def _strip_toml_comment(line: str) -> str:
    quote: str | None = None
    escaped = False
    for index, character in enumerate(line):
        if escaped:
            escaped = False
            continue
        if character == "\\" and quote == '"':
            escaped = True
            continue
        if character in {"'", '"'}:
            quote = None if quote == character else character if quote is None else quote
        elif character == "#" and quote is None:
            return line[:index]
    return line


def _toml_scalar(value: str) -> Any:
    value = value.strip()
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    try:
        return ast.literal_eval(value)
    except (SyntaxError, ValueError):
        return value


def parse_build_config(path: Path) -> dict[str, AssetSpec]:
    """Read the clickgen/ctgen TOML subset used by Bibata and Google.

    Python 3.9 ships on the project's minimum macOS development target, so
    the converter intentionally avoids a runtime dependency on ``tomllib``.
    Only cursor sections and the Xcursor aliases that carry semantic role
    information are interpreted; other platform packaging fields are ignored.
    """

    defaults: dict[str, Any] = {}
    cursors: dict[str, dict[str, Any]] = {}
    current: dict[str, Any] | None = None
    pending_array: tuple[dict[str, Any], str, list[str]] | None = None
    for raw in path.read_text().splitlines():
        line = _strip_toml_comment(raw).strip()
        if not line:
            continue
        if pending_array is not None:
            target, key, parts = pending_array
            parts.append(line)
            if line.endswith("]"):
                target[key] = _toml_scalar(" ".join(parts))
                pending_array = None
            continue
        section = re.fullmatch(r"\[cursors\.([^]]+)\]", line)
        if section:
            name = section.group(1)
            current = defaults if name == "fallback_settings" else cursors.setdefault(name, {})
            continue
        if line.startswith("["):
            current = None
            continue
        if current is None or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if key not in {
            "png",
            "x_hotspot",
            "y_hotspot",
            "x11_delay",
            "x11_symlinks",
        }:
            continue
        value = raw_value.strip()
        if key == "x11_symlinks" and value.startswith("[") and not value.endswith("]"):
            pending_array = (current, key, [value])
        else:
            current[key] = _toml_scalar(value)

    if pending_array is not None:
        raise ValueError(f"{path}: unterminated Xcursor alias array")

    result: dict[str, AssetSpec] = {}
    priorities: dict[str, int] = {}
    for name, values in cursors.items():
        pattern = values.get("png")
        if not isinstance(pattern, str) or not pattern:
            continue
        aliases = values.get("x11_symlinks", [])
        if not isinstance(aliases, list) or not all(
            isinstance(alias, str) for alias in aliases
        ):
            raise ValueError(f"{path}: invalid Xcursor aliases for {name}")
        roles = [
            (canonical_role(name), 0),
            *((canonical_role(alias), 1) for alias in aliases),
        ]
        for role, priority in roles:
            # An explicit upstream alias is stronger evidence than a broad
            # historical name such as hand1/link. At equal priority the first
            # section remains authoritative, matching upstream's own order.
            if priorities.get(role, -1) >= priority:
                continue
            priorities[role] = priority
            result[role] = AssetSpec(
                role,
                pattern,
                float(values.get("x_hotspot", defaults.get("x_hotspot", 0))),
                float(values.get("y_hotspot", defaults.get("y_hotspot", 0))),
                int(values.get("x11_delay", defaults.get("x11_delay", 0)) or 0),
                tuple(canonical_role(alias) for alias in aliases),
            )
    if "default" not in result:
        raise ValueError(f"{path}: build config has no default/left_ptr cursor")
    return result


def _paths_for_pattern(root: Path, pattern: str) -> list[Path]:
    matches = [path for path in root.glob(pattern) if path.is_file()]
    return sorted(matches, key=_natural_key)


def frames_from_bitmap_config(
    bitmap_dir: Path,
    config_path: Path,
    cycle_durations: Mapping[str, float] | None = None,
) -> dict[str, list[Frame]]:
    """Load upstream bitmaps, optionally retaining source animation clocks.

    Optimized color variants can contain different numbers of PNG frames for
    the same SMIL animation. A fixed per-frame Xcursor delay would therefore
    make those variants run at different speeds; a declared full-cycle clock
    is divided across the actual source frames instead.
    """

    output: dict[str, list[Frame]] = {}
    cycle_durations = cycle_durations or {}
    for role, spec in parse_build_config(config_path).items():
        paths = _paths_for_pattern(bitmap_dir, spec.pattern)
        if not paths:
            raise FileNotFoundError(f"{config_path}: {spec.pattern} not found in {bitmap_dir}")
        cycle_duration = cycle_durations.get(role)
        delay_ms = (
            cycle_duration * 1000.0 / len(paths)
            if cycle_duration is not None and len(paths) > 1
            else spec.delay_ms or None
        )
        frames: list[Frame] = []
        for path in paths:
            with Image.open(path) as image:
                frames.append(
                    Frame(
                        image.convert("RGBA"),
                        spec.hotspot_x,
                        spec.hotspot_y,
                        delay_ms,
                    )
                )
        output[role] = frames
    return output


def _replace_colors(svg: str, replacements: Mapping[str, str]) -> str:
    for source, replacement in replacements.items():
        svg = re.sub(re.escape(source), replacement, svg, flags=re.I)
        if source.lower() != replacement.lower() and re.search(re.escape(source), svg, flags=re.I):
            raise ValueError(f"SVG palette substitution failed for {source}")
    return svg


def _render_svg_content(content: str, size: int, cache: Path) -> Image.Image:
    key = hashlib.sha256(content.encode("utf-8")).hexdigest()
    source = cache / f"{key}.svg"
    if not source.exists():
        source.write_text(content)
    return render_svg(source, size, cache)


def frames_from_svg_build_config(
    svg_dir: Path,
    config_path: Path,
    replacements: Mapping[str, str],
) -> dict[str, FrameSource]:
    """Render Bibata SVG templates with the pinned palette and build config."""

    cache = Path(tempfile.mkdtemp(prefix="cursor-svg-profile-"))
    output: dict[str, FrameSource] = {}
    try:
        for role, spec in parse_build_config(config_path).items():
            stem_pattern = re.sub(r"\.png$", ".svg", spec.pattern, flags=re.I)
            if "*" in stem_pattern:
                directory_name = stem_pattern.split("-*", 1)[0].split("_*", 1)[0]
                animation_dir = svg_dir / directory_name
                paths = sorted(animation_dir.glob("*.svg"), key=_natural_key)
            else:
                paths = [svg_dir / stem_pattern]
            if not paths or any(not path.is_file() for path in paths):
                raise FileNotFoundError(f"{config_path}: SVG input for {spec.pattern} not found in {svg_dir}")
            contents = [
                _replace_colors(path.read_text(), replacements) for path in paths
            ]
            pyramid: dict[int, list[Frame]] = {}
            for size in VECTOR_REPRESENTATION_SIZES:
                coordinate_scale = size / 256.0
                pyramid[size] = [
                    Frame(
                        _render_svg_content(content, size, cache),
                        spec.hotspot_x * coordinate_scale,
                        spec.hotspot_y * coordinate_scale,
                        spec.delay_ms or None,
                        size,
                    )
                    for content in contents
                ]
            output[role] = pyramid
    finally:
        shutil.rmtree(cache, ignore_errors=True)
    return output


def parse_python_mapping(path: Path, variable: str) -> dict[str, dict[str, int]]:
    """Safely read a literal metadata mapping from a pinned Python source."""

    tree = ast.parse(path.read_text(), filename=str(path))
    for statement in tree.body:
        if not isinstance(statement, (ast.Assign, ast.AnnAssign)):
            continue
        targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
        if any(isinstance(target, ast.Name) and target.id == variable for target in targets):
            value = ast.literal_eval(statement.value)
            if not isinstance(value, dict):
                break
            return value
    raise ValueError(f"{path}: literal mapping {variable} was not found")


def _seconds(value: str) -> float:
    match = re.fullmatch(r"([0-9.]+)(ms|s)", value.strip())
    if not match:
        raise ValueError(f"unsupported SMIL duration {value!r}")
    number = float(match.group(1))
    return number / 1000.0 if match.group(2) == "ms" else number


def smil_cycle_duration(path: Path) -> float:
    """Return the longest finite repeated SMIL clock declared by an SVG."""

    root = ElementTree.fromstring(path.read_text())
    durations: list[float] = []
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] not in {"animate", "animateTransform"}:
            continue
        duration = node.attrib.get("dur")
        if not duration:
            continue
        repeat = node.attrib.get("repeatCount", "1")
        try:
            repeat_count = float(repeat)
        except ValueError as exc:
            raise ValueError(f"unsupported SMIL repeat count {repeat!r}") from exc
        if repeat_count <= 0:
            raise ValueError(f"invalid SMIL repeat count {repeat!r}")
        durations.append(_seconds(duration) * repeat_count)
    if not durations:
        raise ValueError(f"{path}: no finite SMIL animation duration")
    return max(durations)


def _sample_smil_frames(
    content: str,
    frame_count: int = MAX_MACOS_FRAMES,
) -> tuple[list[str], float | None]:
    """Freeze rotation SMIL and return its complete cycle duration in seconds."""

    root = ElementTree.fromstring(content)
    parent_by_child = {child: parent for parent in root.iter() for child in parent}
    animations = [node for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "animateTransform"]
    if not animations:
        return [content], None
    total_duration = max(
        _seconds(node.attrib["dur"]) * float(node.attrib.get("repeatCount", "1"))
        for node in animations
    )
    frames: list[str] = []
    for index in range(frame_count):
        frame_root = ElementTree.fromstring(content)
        frame_parents = {child: parent for parent in frame_root.iter() for child in parent}
        frame_animations = [node for node in frame_root.iter() if node.tag.rsplit("}", 1)[-1] == "animateTransform"]
        timestamp = total_duration * index / frame_count
        for node in frame_animations:
            if node.attrib.get("type") != "rotate":
                raise ValueError("only rotate animateTransform is supported")
            start_raw, end_raw = node.attrib["values"].split(";", 1)
            start = [float(value) for value in start_raw.split()]
            end = [float(value) for value in end_raw.split()]
            duration = _seconds(node.attrib["dur"])
            progress = (timestamp % duration) / duration
            angle = start[0] + (end[0] - start[0]) * progress
            center_x = start[1] if len(start) > 1 else 0.0
            center_y = start[2] if len(start) > 2 else 0.0
            parent = frame_parents[node]
            parent.set("transform", f"rotate({angle:.6f} {center_x:g} {center_y:g})")
            parent.remove(node)
        frames.append(ElementTree.tostring(frame_root, encoding="unicode"))
    return frames, total_duration


def frames_from_svg_assets(
    svg_dir: Path,
    hotspot_config: Path,
    replacements: Mapping[str, str],
) -> dict[str, FrameSource]:
    """Render Bibata Extra's palette templates and deterministic SMIL frames."""

    hotspot_rows = parse_python_mapping(hotspot_config, "X_CURSORS_CFG")
    hotspots = {
        canonical_role(key): (float(value.get("xhot", 0)), float(value.get("yhot", 0)))
        for key, value in hotspot_rows.items()
    }
    cache = Path(tempfile.mkdtemp(prefix="cursor-svg-profile-"))
    output: dict[str, FrameSource] = {}
    try:
        for path in sorted((svg_dir / "static").glob("*.svg"), key=_natural_key):
            role = canonical_role(path.stem)
            if role not in hotspots:
                raise ValueError(f"{hotspot_config}: no hotspot for {path.name}")
            content = _replace_colors(path.read_text(), replacements)
            hot_x, hot_y = hotspots[role]
            output[role] = {
                size: [
                    Frame(
                        _render_svg_content(content, size, cache),
                        hot_x * size / 200.0,
                        hot_y * size / 200.0,
                        nominal_size=size,
                    )
                ]
                for size in VECTOR_REPRESENTATION_SIZES
            }
        for path in sorted((svg_dir / "animated").glob("*.svg"), key=_natural_key):
            role = canonical_role(path.stem)
            if role not in hotspots:
                raise ValueError(f"{hotspot_config}: no hotspot for {path.name}")
            content = _replace_colors(path.read_text(), replacements)
            hot_x, hot_y = hotspots[role]
            frame_svgs, total_duration = _sample_smil_frames(content)
            delay_ms = (
                total_duration * 1000.0 / len(frame_svgs)
                if total_duration is not None
                else None
            )
            output[role] = {
                size: [
                    Frame(
                        _render_svg_content(frame_svg, size, cache),
                        hot_x * size / 200.0,
                        hot_y * size / 200.0,
                        delay_ms,
                        size,
                    )
                    for frame_svg in frame_svgs
                ]
                for size in VECTOR_REPRESENTATION_SIZES
            }
    finally:
        shutil.rmtree(cache, ignore_errors=True)
    return output


def _candidate_asset(root: Path, filename: str, role: str) -> Path | None:
    relative = Path(filename)
    basename = relative.name
    exact_stem = relative.stem
    # Animation frame numbers can also be conventional cursor sizes (for
    # example ``wait-16.png``). Resolve the exact basename, including an
    # alternate SVG extension, before interpreting a trailing number as a
    # generated bitmap-size suffix.
    exact_candidates: list[Path] = [root / relative]
    for suffix in (".png", ".svg"):
        exact_candidates += [
            root / f"{exact_stem}{suffix}",
            root / "svg" / f"{exact_stem}{suffix}",
        ]
    for candidate in exact_candidates:
        if candidate.is_file():
            return candidate
    for pattern in (f"{exact_stem}.svg", basename):
        for candidate in root.rglob(pattern):
            if candidate.is_file():
                return candidate

    stem = exact_stem
    stem = re.sub(r"(?:[-_]?(?:16|20|22|24|28|30|32|36|40|48|56|64|72|80|88|96)(?:x\d+)?)$", "", stem)
    candidates: list[Path] = []
    for suffix in (".png", ".svg"):
        candidates += [root / f"{stem}{suffix}", root / "svg" / f"{stem}{suffix}"]
    static_stem = re.sub(r"[-_]\d+$", "", stem)
    if static_stem != stem:
        for suffix in (".png", ".svg"):
            candidates += [root / f"{static_stem}{suffix}", root / "svg" / f"{static_stem}{suffix}"]
    # Configured asset names often live in a per-theme svg directory.
    for candidate in root.rglob(f"{stem}.svg"):
        candidates.append(candidate)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _load_asset(path: Path, size: int, cache: Path) -> Image.Image:
    if path.suffix.lower() == ".svg":
        return render_svg(path, size, cache)
    with Image.open(path) as image:
        return image.convert("RGBA")


def _config_frame_key(row: ConfigFrame) -> str:
    if row.delay_ms is None:
        return "static"
    return re.sub(
        r"(?:_(?:16|20|22|24|28|30|32|36|40|48|56|64|72|80|88|96)(?:_(?:16|20|22|24|28|30|32|36|40|48|56|64|72|80|88|96))?)$",
        "",
        Path(row.filename).stem,
    )


def _svg_canvas_dimensions(path: Path) -> tuple[float, float]:
    root = ElementTree.parse(path).getroot()
    view_box = root.attrib.get("viewBox")
    if view_box:
        values = view_box.replace(",", " ").split()
        if len(values) == 4:
            width, height = float(values[2]), float(values[3])
            if width > 0 and height > 0:
                return width, height

    def dimension(name: str) -> float | None:
        raw = root.attrib.get(name, "")
        match = re.fullmatch(
            r"\s*([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[A-Za-z]+)?\s*", raw
        )
        return float(match.group(1)) if match else None

    width, height = dimension("width"), dimension("height")
    if width and height:
        return width, height
    raise ValueError(f"{path}: SVG has no usable canvas dimensions")


def _configured_bitmap_dimensions(
    row: ConfigFrame, asset: Path
) -> tuple[float, float]:
    """Resolve the pixel canvas to which an Xcursor hotspot belongs."""

    canvas_width, canvas_height = _svg_canvas_dimensions(asset)
    configured = Path(row.filename)
    for part in configured.parts[:-1]:
        dimensions = re.fullmatch(r"([0-9]+)x([0-9]+)", part, flags=re.I)
        if dimensions:
            return float(dimensions.group(1)), float(dimensions.group(2))
        scale = re.fullmatch(r"x([0-9]+)(?:_([0-9]+))?", part, flags=re.I)
        if scale:
            factor = float(
                scale.group(1)
                + (f".{scale.group(2)}" if scale.group(2) else "")
            )
            return canvas_width * factor, canvas_height * factor

    # Volantes encodes the generated bitmap size in names such as
    # ``default_24_48.png``; the final number is the actual pixel dimension.
    suffix = re.search(r"_([0-9]+)(?:_([0-9]+))?$", configured.stem)
    if suffix:
        size = float(suffix.group(2) or suffix.group(1))
        return size, size
    if configured.suffix.lower() == ".svg":
        return canvas_width, canvas_height
    return float(row.size), float(row.size)


def _frames_from_configs(
    source: Path, config_paths: Sequence[Path]
) -> dict[str, FrameSource]:
    groups: dict[str, list[ConfigFrame]] = defaultdict(list)
    for config_path in config_paths:
        # A config may contain rows for every role or one role per file.
        if config_path.suffix.lower() == ".spec":
            groups[canonical_role(config_path.stem)].extend(parse_spec(config_path))
        else:
            for role, rows in parse_config(config_path).items():
                groups[role].extend(rows)
    cache = Path(tempfile.mkdtemp(prefix="cursor-svg-cache-"))
    output: dict[str, FrameSource] = {}
    try:
        for role, rows in groups.items():
            rows = sorted(rows, key=lambda row: (row.size, row.filename))
            # Resolve one authoritative row per logical frame. SVG-backed
            # configs are then rendered directly at every output tier, keeping
            # their configured coordinate system only for hotspot scaling.
            by_frame: dict[str, ConfigFrame] = {}
            for row in rows:
                key = _config_frame_key(row)
                if key not in by_frame or row.size > by_frame[key].size:
                    by_frame[key] = row
            logical_rows = sorted(
                by_frame.values(), key=lambda item: _natural_key(item.filename)
            )
            resolved: list[tuple[ConfigFrame, Path]] = []
            for row in logical_rows:
                asset = _candidate_asset(source, row.filename, role)
                if asset is None:
                    raise FileNotFoundError(f"{role}: configured asset {row.filename} not found under {source}")
                resolved.append((row, asset))

            if resolved and all(asset.suffix.lower() == ".svg" for _, asset in resolved):
                pyramid: dict[int, list[Frame]] = {}
                for size in VECTOR_REPRESENTATION_SIZES:
                    frames: list[Frame] = []
                    for row, asset in resolved:
                        configured_width, configured_height = (
                            _configured_bitmap_dimensions(row, asset)
                        )
                        frames.append(
                            Frame(
                                render_svg(asset, size, cache),
                                row.hotspot_x * size / configured_width,
                                row.hotspot_y * size / configured_height,
                                row.delay_ms,
                                size,
                            )
                        )
                    pyramid[size] = frames
                output[role] = pyramid
                continue

            # Bitmap-backed configs retain each supplied size group. Missing
            # standard targets are derived later from the nearest larger
            # source, never from a smaller source when a larger one exists.
            pyramid = {}
            for config_size in sorted({row.size for row in rows}):
                per_size: dict[str, ConfigFrame] = {}
                for row in rows:
                    if row.size == config_size:
                        per_size[_config_frame_key(row)] = row
                frames: list[Frame] = []
                for row in sorted(
                    per_size.values(), key=lambda item: _natural_key(item.filename)
                ):
                    asset = _candidate_asset(source, row.filename, role)
                    if asset is None:
                        raise FileNotFoundError(
                            f"{role}: configured asset {row.filename} not found under {source}"
                        )
                    frames.append(
                        Frame(
                            _load_asset(asset, config_size, cache),
                            row.hotspot_x,
                            row.hotspot_y,
                            row.delay_ms,
                            config_size,
                        )
                    )
                if frames:
                    pyramid[config_size] = frames
            if pyramid:
                output[role] = pyramid
    finally:
        shutil.rmtree(cache, ignore_errors=True)
    return output


def frames_from_svg_config(
    svg_dir: Path,
    config_dir: Path,
    replacements: Mapping[str, str] | None = None,
) -> dict[str, FrameSource]:
    """Render an SVG/config tree directly, optionally applying a palette."""

    configs = sorted(config_dir.rglob("*.cursor")) + sorted(
        config_dir.rglob("*.spec")
    )
    if not configs:
        raise FileNotFoundError(f"no cursor configs found under {config_dir}")
    if not replacements:
        return _frames_from_configs(svg_dir, configs)

    temporary = Path(tempfile.mkdtemp(prefix="cursor-svg-palette-"))
    try:
        for source in sorted(svg_dir.rglob("*.svg")):
            destination = temporary / source.relative_to(svg_dir)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(_replace_colors(source.read_text(), replacements))
        return _frames_from_configs(temporary, configs)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def _frames_from_assets(source: Path) -> dict[str, FrameSource]:
    """Infer roles for SVG/PNG-only trees (Bibata Extra and Google)."""

    assets: dict[str, list[Path]] = defaultdict(list)
    for path in sorted(source.rglob("*")):
        if path.suffix.lower() not in {".svg", ".png"}:
            continue
        role = canonical_role(path.stem)
        if role in {"logo", "preview", "preview-white"}:
            continue
        assets[role].append(path)
    cache = Path(tempfile.mkdtemp(prefix="cursor-svg-cache-"))
    output: dict[str, FrameSource] = {}
    try:
        for role, paths in assets.items():
            # Prefer static over animated files when both exist. Supported
            # SMIL is sampled explicitly elsewhere instead of relying on an
            # SVG renderer's implicit timestamp.
            paths = sorted(paths, key=lambda p: ("animated" in p.parts, p.name))
            path = paths[0]
            if path.suffix.lower() == ".svg":
                pyramid: dict[int, list[Frame]] = {}
                for size in VECTOR_REPRESENTATION_SIZES:
                    image = render_svg(path, size, cache)
                    hotspot = _default_hotspot(role, size)
                    pyramid[size] = [
                        Frame(image, hotspot[0], hotspot[1], 60, size)
                    ]
                output[role] = pyramid
            else:
                image = _load_asset(path, 64, cache)
                hotspot = _default_hotspot(role, image.width)
                output[role] = [Frame(image, hotspot[0], hotspot[1], 60)]
    finally:
        shutil.rmtree(cache, ignore_errors=True)
    return output


def _default_hotspot(role: str, size: int) -> tuple[float, float]:
    # Standard Xcursor conventions. Source trees without a config (notably
    # Bibata Extra/Google) use 200/256-unit SVG canvases, so scale this table.
    points: dict[str, tuple[float, float]] = {
        "default": (4, 4),
        "pointer": (8, 2),
        "text": (16, 16),
        "context-menu": (8, 8),
        "wait": (16, 16),
        "progress": (16, 16),
        "openhand": (16, 16),
        "fleur": (16, 16),
        "crosshair": (16, 16),
    }
    x, y = points.get(role, (16, 16))
    return x * size / 32.0, y * size / 32.0


def _find_xcursor_dirs(source: Path) -> list[Path]:
    result: list[Path] = []
    matches: set[Path] = set()
    for path in source.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            with path.open("rb") as handle:
                if handle.read(4) == b"Xcur":
                    matches.add(path.parent)
        except OSError:
            continue
    for directory in sorted(matches):
        result.append(directory)
    return result


def _frames_from_xcursor(directory: Path) -> dict[str, FrameSource]:
    result: dict[str, FrameSource] = {}
    priorities: dict[str, int] = {}
    canonical_directory = directory.resolve()
    parsed_files: dict[Path, list[Frame]] = {}
    for path in sorted(directory.iterdir()):
        source = path
        if path.is_symlink():
            raw_target = Path(os.readlink(path))
            if raw_target.is_absolute() or raw_target.parent != Path("."):
                raise ValueError(
                    f"{path}: Xcursor aliases must target a filename in the same directory"
                )
            try:
                source = path.resolve(strict=True)
            except (OSError, RuntimeError) as exc:
                raise ValueError(f"{path}: dangling or cyclic Xcursor alias") from exc
            if source.parent != canonical_directory or not source.is_file():
                raise ValueError(
                    f"{path}: Xcursor alias target escapes its cursors directory"
                )
        elif not path.is_file():
            continue
        try:
            all_frames = parsed_files.get(source)
            if all_frames is None:
                all_frames = parse_xcursor(source)
                parsed_files[source] = all_frames
            # Xcursor stores one chunk per nominal size for a static cursor
            # (and one chunk per frame at each size for animations). Preserve
            # those groups independently so a native 64/96px frame never gets
            # reconstructed from the 32px artwork.
            groups: dict[int, list[Frame]] = defaultdict(list)
            for frame in all_frames:
                # The Xcursor subtype is its requested desktop size, while the
                # decoded bitmap width is the representation's actual pixel
                # density. CoreGraphics infers scale from pixel dimensions, so
                # preserve the latter as the MaCursor tier.
                groups[max(frame.image.size)].append(frame)
            role = canonical_role(path.name)
            priority = _xcursor_role_priority(path.name)
            # Conventional themes commonly include both a canonical filename
            # and several historical aliases with different artwork.  The
            # canonical role is authoritative; deterministic first-wins ties
            # avoid making selection depend on filesystem iteration order.
            if priorities.get(role, -1) >= priority:
                continue
            priorities[role] = priority
            result[role] = dict(groups)
        except ValueError:
            if path.is_symlink():
                raise
            continue
    return result


def _frames_from_cape(path: Path) -> dict[str, FrameSource]:
    result = parse_cape(path)
    # Cape dictionaries already use Mac identifiers. Convert them to source
    # roles so the standard alias/fallback pipeline can fill missing keys.
    by_role: dict[str, FrameSource] = {}
    for identifier, frames in result.items():
        role = MAC_TO_ROLE.get(identifier)
        if role:
            by_role[role] = frames
    return by_role


def _find_configs(source: Path) -> list[Path]:
    return sorted(source.rglob("*.cursor")) + sorted(source.rglob("*.spec"))


def _copy_frame_source(source: FrameSource) -> FrameSource:
    if isinstance(source, Mapping):
        return {int(size): list(frames) for size, frames in source.items() if frames}
    return list(source)


def _merge_roles(source_frames: Mapping[str, FrameSource]) -> dict[str, FrameSource]:
    normalized = {
        canonical_role(role): _copy_frame_source(frames)
        for role, frames in source_frames.items()
        if frames
    }
    if "default" not in normalized:
        for role in ("pointer", "right-arrow", "left-arrow"):
            if role in normalized:
                normalized["default"] = normalized[role]
                break
    if "default" not in normalized:
        # A source with no recognized cursor is an actionable conversion error;
        # emitting a theme full of transparent cursors is worse.
        raise ValueError("source has no default/left_ptr cursor")
    return normalized


def _role_bindings(source_frames: Mapping[str, FrameSource]) -> dict[str, tuple[str, str, bool]]:
    roles = _merge_roles(source_frames)
    bindings: dict[str, tuple[str, str, bool]] = {}
    for mac_identifier, role in MAC_TO_ROLE.items():
        if role is None:
            bindings[mac_identifier] = ("empty", "empty", False)
        elif role in roles:
            bindings[mac_identifier] = (role, role, False)
        else:
            bindings[mac_identifier] = (role, "default", True)
    return bindings


def _records_share_animation_art(
    first: Mapping[str, Any],
    second: Mapping[str, Any],
) -> bool:
    """Return whether two normalized animated records have identical pixels."""

    frame_count = int(first.get("FrameCount", 1))
    if frame_count <= 1 or int(second.get("FrameCount", 1)) != frame_count:
        return False
    if not math.isclose(
        float(first.get("FrameDuration", 1.0)) * frame_count,
        float(second.get("FrameDuration", 1.0)) * frame_count,
        rel_tol=1e-6,
        abs_tol=1e-6,
    ):
        return False
    if any(
        abs(float(first.get(key, 0.0)) - float(second.get(key, 0.0))) > 2.0
        for key in ("HotSpotX", "HotSpotY")
    ):
        return False
    first_representations = first.get("Representations", [])
    second_representations = second.get("Representations", [])
    if len(first_representations) != len(second_representations):
        return False
    for first_data, second_data in zip(
        first_representations,
        second_representations,
    ):
        with Image.open(io.BytesIO(first_data)) as first_image, Image.open(
            io.BytesIO(second_data)
        ) as second_image:
            first_rgba = first_image.convert("RGBA")
            second_rgba = second_image.convert("RGBA")
            if (
                first_rgba.size != second_rgba.size
                or first_rgba.tobytes() != second_rgba.tobytes()
            ):
                return False
    return True


def _frame_source_cycle(source: FrameSource) -> tuple[float, bool]:
    groups, _scale_specific = _frame_groups(source)
    canonical_size = min(
        groups,
        key=lambda size: (abs(size - BASE_REPRESENTATION_SIZES[0]), size),
    )
    delays, authored = _frame_delays(groups[canonical_size])
    return sum(delays), authored


def _frame_sources_share_animation_art(
    first: FrameSource,
    second: FrameSource,
) -> bool:
    """Recognize the same artwork under safe frame/phase optimization."""

    first_groups, _first_scale_specific = _frame_groups(first)
    second_groups, _second_scale_specific = _frame_groups(second)
    if not first_groups or not second_groups:
        return False
    first_count = max(len(frames) for frames in first_groups.values())
    second_count = max(len(frames) for frames in second_groups.values())
    if max(first_count, second_count) <= 1:
        return False
    first_dimensions = {
        frame.image.size for frames in first_groups.values() for frame in frames
    }
    second_dimensions = {
        frame.image.size for frames in second_groups.values() for frame in frames
    }
    if first_dimensions != second_dimensions:
        return False
    first_hotspot = _common_hotspot(first_groups)
    second_hotspot = _common_hotspot(second_groups)
    if any(
        abs(first_coordinate - second_coordinate) > 1.0 / 16.0
        for first_coordinate, second_coordinate in zip(
            first_hotspot,
            second_hotspot,
        )
    ):
        return False
    first_cycle, first_authored = _frame_source_cycle(first)
    second_cycle, second_authored = _frame_source_cycle(second)
    if first_authored != second_authored or not math.isclose(
        first_cycle,
        second_cycle,
        rel_tol=1e-6,
        abs_tol=1e-6,
    ):
        return False

    sample_count = min(MAX_MACOS_FRAMES, max(first_count, second_count))
    comparison_size = BASE_REPRESENTATION_SIZES[-1]
    first_frames = _frames_for_size(first_groups, comparison_size)
    second_frames = _frames_for_size(second_groups, comparison_size)
    first_images = [
        _resize(first_frames[index].image, comparison_size)
        for index in _phase_indices_at(first_frames, sample_count, 0.0)
    ]
    second_images = [
        _resize(second_frames[index].image, comparison_size)
        for index in _phase_indices_at(second_frames, sample_count, 0.0)
    ]

    # Compare every cyclic alignment. Requiring nearly identical alpha masks
    # prevents a sparse pointer from disappearing inside a whole-canvas mean,
    # while alpha-weighted RGB error tolerates only subpixel raster differences
    # within otherwise matching visible artwork.
    for shift in range(sample_count):
        intersection_sum = 0.0
        union_sum = 0.0
        weighted_rgb_error = 0.0
        minimum_frame_iou = 1.0
        for index, first_image in enumerate(first_images):
            second_image = second_images[(index + shift) % sample_count]
            first_alpha = first_image.getchannel("A")
            second_alpha = second_image.getchannel("A")
            intersection = ImageChops.darker(first_alpha, second_alpha)
            union = ImageChops.lighter(first_alpha, second_alpha)
            frame_intersection = ImageStat.Stat(intersection).sum[0]
            frame_union = ImageStat.Stat(union).sum[0]
            if frame_union <= 0:
                return False
            intersection_sum += frame_intersection
            union_sum += frame_union
            minimum_frame_iou = min(
                minimum_frame_iou,
                frame_intersection / frame_union,
            )
            difference = ImageChops.difference(first_image, second_image)
            for channel in difference.convert("RGB").split():
                weighted = ImageChops.multiply(channel, union)
                weighted_rgb_error += ImageStat.Stat(weighted).sum[0]

        alpha_iou = intersection_sum / union_sum
        normalized_rgb_error = weighted_rgb_error / (3.0 * union_sum)
        if (
            minimum_frame_iou >= 0.98
            and alpha_iou >= 0.995
            and normalized_rgb_error <= 0.03
        ):
            return True
    return False


def _record_frames_by_size(
    record: Mapping[str, Any],
) -> dict[int, list[Image.Image]]:
    frame_count = max(1, int(record.get("FrameCount", 1)))
    result: dict[int, list[Image.Image]] = {}
    for representation in record.get("Representations", []):
        with Image.open(io.BytesIO(representation)) as source:
            sheet = source.convert("RGBA")
        size = sheet.width
        if sheet.height != size * frame_count:
            raise ValueError("cursor representation has invalid sprite geometry")
        result[size] = [
            sheet.crop((0, index * size, size, (index + 1) * size))
            for index in range(frame_count)
        ]
    return result


def _synthesize_progress_record(
    default: Mapping[str, Any],
    wait: Mapping[str, Any],
) -> dict[str, Any]:
    """Compose a pointer plus a compact wait spinner using the wait cycle."""

    default_tiers = _record_frames_by_size(default)
    wait_tiers = _record_frames_by_size(wait)
    if not default_tiers or not wait_tiers:
        raise ValueError("cannot synthesize progress without cursor artwork")
    representations: list[bytes] = []
    for size, wait_frames in sorted(wait_tiers.items()):
        default_size = min(
            default_tiers,
            key=lambda candidate: (abs(candidate - size), candidate),
        )
        pointer = _resize(default_tiers[default_size][0], size)
        spinner_size = max(1, round(size * 0.44))
        margin = max(1, round(size * 0.03))
        spinner_origin = size - spinner_size - margin
        sheet = Image.new(
            "RGBA",
            (size, size * len(wait_frames)),
            (0, 0, 0, 0),
        )
        for index, wait_frame in enumerate(wait_frames):
            composed = pointer.copy()
            spinner = _resize(wait_frame, spinner_size)
            composed.alpha_composite(spinner, (spinner_origin, spinner_origin))
            sheet.paste(composed, (0, index * size))
        representations.append(_png_bytes(sheet))

    progress = dict(wait)
    progress["HotSpotX"] = float(default.get("HotSpotX", 0.0))
    progress["HotSpotY"] = float(default.get("HotSpotY", 0.0))
    progress["PointsWide"] = float(default.get("PointsWide", 32.0))
    progress["PointsHigh"] = float(default.get("PointsHigh", 32.0))
    progress["Representations"] = representations
    return progress


def _build_theme(source_frames: Mapping[str, FrameSource], identifier: str, display_name: str, *, author: str | None = None, source_url: str | None = None, license_name: str | None = None, group: str = "External") -> dict[str, Any]:
    roles = _merge_roles(source_frames)
    bindings = _role_bindings(roles)
    records = {role: build_cursor(frames) for role, frames in roles.items()}
    if (
        "wait" in records
        and "progress" in records
        and (
            _records_share_animation_art(records["wait"], records["progress"])
            or _frame_sources_share_animation_art(
                roles["wait"],
                roles["progress"],
            )
        )
    ):
        records["progress"] = _synthesize_progress_record(
            records["default"],
            records["wait"],
        )
    cursors: dict[str, Any] = {}
    for mac_identifier, (_requested_role, resolved_role, _fallback) in bindings.items():
        if resolved_role == "empty":
            cursors[mac_identifier] = _transparent_cursor()
            continue
        cursors[mac_identifier] = records[resolved_role]
    creator = author or "Cursor Atelier conversion pipeline"
    theme: dict[str, Any] = {
        "Creator": creator,
        "Cursors": cursors,
        "HiDPI": True,
        "Identifier": identifier,
        "ThemeName": display_name,
        "ThemeVersion": 1.0,
        "UUID": str(uuid.uuid5(MACURSOR_UUID_NAMESPACE, f"cursor-atelier:{identifier}")) .upper(),
    }
    if source_url:
        theme["SourceURL"] = source_url
    if license_name:
        theme["License"] = license_name
    theme["Group"] = group
    return theme


def _write_theme(theme: Mapping[str, Any], output: Path) -> dict[str, Any]:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        plistlib.dump(dict(theme), handle, fmt=plistlib.FMT_BINARY, sort_keys=True)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    return {
        "Identifier": theme["Identifier"],
        "DisplayName": theme.get("ThemeName", theme["Identifier"]),
        "Resource": output.name,
        "SHA256": digest,
        "UUID": theme["UUID"],
        "ThemeName": theme.get("ThemeName", theme["Identifier"]),
        "Group": theme.get("Group", "External"),
        **({"SourceURL": theme["SourceURL"]} if theme.get("SourceURL") else {}),
        **({"License": theme["License"]} if theme.get("License") else {}),
        **({"Author": theme["Creator"]} if theme.get("Creator") else {}),
    }


def _preview_png(record: Mapping[str, Any]) -> bytes:
    representations = record.get("Representations", [])
    if not representations:
        raise ValueError("cursor record has no representations")
    # The detail grid displays cursors at 48 CSS pixels. Prefer the exact 3x
    # representation so a Retina display receives a 1:1 96-pixel raster
    # instead of asking Chromium to resample a larger cursor tier.
    encoded = representations[-1]
    for candidate in representations:
        with Image.open(io.BytesIO(candidate)) as image:
            if image.width == BASE_REPRESENTATION_SIZES[-1]:
                encoded = candidate
                break
    frame_count = int(record.get("FrameCount", 1))
    with Image.open(io.BytesIO(encoded)) as sheet:
        size = sheet.width
        if frame_count < 1 or sheet.height != size * frame_count:
            raise ValueError(
                "cursor representation does not match its declared frame count"
            )
        rgba = sheet.convert("RGBA")
        frames = [
            rgba.crop((0, index * size, size, (index + 1) * size))
            for index in range(frame_count)
        ]

    if frame_count == 1:
        return _png_bytes(frames[0])

    # Chromium renders animated PNG natively, so retain the exact cursor loop
    # instead of reducing animated roles to a misleading still frame.
    duration_ms = max(1, round(float(record.get("FrameDuration", 1.0)) * 1000))
    output = io.BytesIO()
    frames[0].save(
        output,
        format="PNG",
        save_all=True,
        append_images=frames[1:],
        duration=duration_ms,
        loop=0,
        disposal=0,
        blend=0,
        optimize=True,
    )
    return output.getvalue()


def export_theme_previews(
    theme_path: Path,
    preview_root: Path,
    *,
    bindings: Mapping[str, tuple[str, str, bool]] | None = None,
    manifest_root: Path | None = None,
) -> dict[str, Any]:
    """Write deduplicated static/animated PNGs and return manifest metadata."""

    theme = plistlib.loads(theme_path.read_bytes())
    identifier = str(theme.get("Identifier") or theme_path.stem)
    cursors = theme.get("Cursors")
    if not isinstance(cursors, Mapping):
        raise ValueError(f"{theme_path}: missing Cursors dictionary")
    preview_root = preview_root / identifier
    preview_root.mkdir(parents=True, exist_ok=True)
    manifest_root = manifest_root or preview_root.parent.parent
    bindings = bindings or {
        mac_identifier: (role or "empty", role or "empty", False)
        for mac_identifier, role in MAC_TO_ROLE.items()
    }

    assets: dict[str, str] = {}
    role_previews: list[dict[str, Any]] = []
    for mac_identifier, requested_role in MAC_TO_ROLE.items():
        record = cursors.get(mac_identifier)
        if not isinstance(record, Mapping):
            raise ValueError(f"{theme_path}: missing preview record {mac_identifier}")
        requested, resolved, fallback = bindings[mac_identifier]
        if resolved not in assets:
            asset_path = preview_root / f"{resolved}.png"
            asset_path.write_bytes(_preview_png(record))
            assets[resolved] = asset_path.relative_to(manifest_root).as_posix()
        role_previews.append(
            {
                "asset": assets[resolved],
                "fallback": fallback,
                "frameCount": int(record.get("FrameCount", 1)),
                "frameDuration": float(record.get("FrameDuration", 1.0)),
                "hotspot": {
                    "x": float(record.get("HotSpotX", 0.0)),
                    "y": float(record.get("HotSpotY", 0.0)),
                },
                "macIdentifier": mac_identifier,
                "resolvedRole": resolved,
                "role": requested_role or requested,
            }
        )
    return {
        "preview": assets["default"],
        "rolePreviews": role_previews,
    }


def convert_frames(
    frames: Mapping[str, FrameSource],
    output: Path,
    identifier: str,
    display_name: str,
    *,
    author: str | None = None,
    source_url: str | None = None,
    license_name: str | None = None,
    group: str = "External",
    preview_root: Path | None = None,
    manifest_root: Path | None = None,
) -> dict[str, Any]:
    """Build one theme from already-normalized, upstream-aware frames."""

    theme = _build_theme(
        frames,
        identifier,
        display_name,
        author=author,
        source_url=source_url,
        license_name=license_name,
        group=group,
    )
    entry = _write_theme(theme, output)
    if preview_root is not None:
        entry.update(
            export_theme_previews(
                output,
                preview_root,
                bindings=_role_bindings(frames),
                manifest_root=manifest_root or output.parent,
            )
        )
    return entry


def _source_frames(source: Path) -> dict[str, FrameSource]:
    cape_files = sorted(source.glob("*.cape")) if source.is_dir() else []
    if len(cape_files) == 1:
        return _frames_from_cape(cape_files[0])
    xcursor_dirs = _find_xcursor_dirs(source)
    if xcursor_dirs:
        # A caller converting one variant should pass its `cursors` directory;
        # when a root contains several, the first deterministic variant is used
        # and `convert_many` should be preferred.
        return _frames_from_xcursor(xcursor_dirs[0])
    configs = _find_configs(source)
    if not configs and source.is_dir():
        # Volantes/Oreo-style variants keep shared configs in ``src/config``
        # beside each ``*_cursors`` artwork directory. Allow callers to pass
        # the variant directory itself without copying the config files.
        ancestor_candidates: list[Path] = []
        for ancestor in (source.parent, *source.parents):
            ancestor_candidates.extend((ancestor / "config", ancestor / "configs"))
        for sibling in ancestor_candidates:
            if sibling.is_dir():
                configs = sorted(sibling.rglob("*.cursor")) + sorted(sibling.rglob("*.spec"))
                if configs:
                    break
    if configs:
        return _frames_from_configs(source, configs)
    return _frames_from_assets(source)


def slug_identifier(value: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", value)
    return "".join(word[:1].upper() + word[1:] for word in words) or "CursorPack"


def convert_theme(source: Path, output: Path, identifier: str | None = None, display_name: str | None = None, *, author: str | None = None, source_url: str | None = None, license_name: str | None = None, group: str = "External", preview_root: Path | None = None, manifest_root: Path | None = None) -> dict[str, Any]:
    """Convert one source directory or ``.cape`` into a binary plist theme."""

    source = source.resolve()
    if source.is_file() and source.suffix.lower() == ".cape":
        frames = _frames_from_cape(source)
        default_identifier = slug_identifier(source.stem)
    elif source.is_dir():
        frames = _source_frames(source)
        default_identifier = slug_identifier(source.name)
    else:
        raise FileNotFoundError(source)
    identifier = identifier or default_identifier
    display_name = display_name or re.sub(r"[-_]", " ", source.stem if source.is_file() else source.name).title()
    return convert_frames(
        frames,
        output,
        identifier,
        display_name,
        author=author,
        source_url=source_url,
        license_name=license_name,
        group=group,
        preview_root=preview_root,
        manifest_root=manifest_root,
    )


def convert_many(source_root: Path, output: Path, *, manifest_path: Path | None = None, metadata: Mapping[str, Mapping[str, str]] | None = None) -> list[dict[str, Any]]:
    """Convert every discoverable variant below *source_root*.

    A directory containing Xcursor files is one variant.  A directory with
    configs/SVG is also one variant.  ``.cape`` files are individually named
    variants.  Results are sorted by Identifier and the optional manifest is
    written with stable key ordering.
    """

    source_root = source_root.resolve()
    output.mkdir(parents=True, exist_ok=True)
    jobs: list[tuple[Path, str]] = []
    cape_files = sorted(source_root.rglob("*.cape"))
    if cape_files:
        jobs.extend((path, slug_identifier(path.stem)) for path in cape_files)
    else:
        xcursor_dirs = _find_xcursor_dirs(source_root)
        if xcursor_dirs:
            jobs.extend((directory, slug_identifier(directory.parent.name)) for directory in xcursor_dirs)
        elif _find_configs(source_root):
            jobs.append((source_root, slug_identifier(source_root.name)))
        else:
            jobs.append((source_root, slug_identifier(source_root.name)))
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for source, identifier in jobs:
        if identifier in seen:
            continue
        seen.add(identifier)
        result = convert_theme(source, output / f"{identifier}.cursor", identifier, metadata.get(identifier, {}).get("DisplayName") if metadata else None, author=metadata.get(identifier, {}).get("Author") if metadata else None, source_url=metadata.get(identifier, {}).get("SourceURL") if metadata else None, license_name=metadata.get(identifier, {}).get("License") if metadata else None, preview_root=output / "previews", manifest_root=output)
        results.append(result)
    results.sort(key=lambda entry: str(entry["Identifier"]))
    if manifest_path:
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps({"roleCount": len(MAC_CURSOR_IDENTIFIERS), "schemaVersion": 2, "themes": results}, indent=2, sort_keys=True) + "\n")
    return results


def validate_theme(
    path: Path,
    *,
    required_animated_roles: Sequence[str] = (),
    forbidden_rgb: Sequence[tuple[int, int, int]] = (),
) -> dict[str, Any]:
    """Validate structure plus optional high-signal cursor semantics."""

    theme = plistlib.loads(path.read_bytes())
    if not isinstance(theme.get("Cursors"), Mapping):
        raise ValueError(f"{path}: missing Cursors dictionary")
    missing = [identifier for identifier in MAC_CURSOR_IDENTIFIERS if identifier not in theme["Cursors"]]
    if missing:
        raise ValueError(f"{path}: missing cursor identifiers: {', '.join(missing)}")
    for identifier, record in theme["Cursors"].items():
        if not isinstance(record, Mapping):
            raise ValueError(f"{path}: {identifier} is not a cursor record")
        count = int(record.get("FrameCount", 0))
        if count < 1 or count > MAX_MACOS_FRAMES:
            raise ValueError(f"{path}: {identifier} invalid frame count {count}")
        representations = record.get("Representations", [])
        if not (len(BASE_REPRESENTATION_SIZES) <= len(representations) <= 16):
            raise ValueError(
                f"{path}: {identifier} must have between "
                f"{len(BASE_REPRESENTATION_SIZES)} and 16 representations"
            )
        widths: list[int] = []
        for representation in representations:
            with Image.open(io.BytesIO(representation)) as image:
                width = image.width
                if not (32 <= width <= MAX_REPRESENTATION_SIZE):
                    raise ValueError(
                        f"{path}: {identifier} has unsupported representation width {width}"
                    )
                if image.size != (width, width * count):
                    raise ValueError(
                        f"{path}: {identifier} has invalid {width}px sheet {image.size}"
                    )
                widths.append(width)
                if forbidden_rgb:
                    forbidden = set(forbidden_rgb)
                    if any(pixel[3] and pixel[:3] in forbidden for pixel in image.convert("RGBA").getdata()):
                        raise ValueError(f"{path}: {identifier} retains an upstream placeholder color")
        if widths != sorted(set(widths)) or not set(
            BASE_REPRESENTATION_SIZES
        ).issubset(widths):
            raise ValueError(
                f"{path}: {identifier} representations must be unique, ascending, "
                f"and include {'/'.join(map(str, BASE_REPRESENTATION_SIZES))}px: {widths}"
            )
        hot_x = float(record.get("HotSpotX", -1.0))
        hot_y = float(record.get("HotSpotY", -1.0))
        if not (0.0 <= hot_x <= 32.0 and 0.0 <= hot_y <= 32.0):
            raise ValueError(f"{path}: {identifier} hotspot is outside the 32-point cursor: {(hot_x, hot_y)}")
    for role in required_animated_roles:
        identifiers = [identifier for identifier, mapped in MAC_TO_ROLE.items() if mapped == role]
        if not identifiers or all(int(theme["Cursors"][identifier].get("FrameCount", 1)) <= 1 for identifier in identifiers):
            raise ValueError(f"{path}: required {role} cursor is not animated")
    return {
        "Identifier": theme.get("Identifier"),
        "Cursors": len(theme["Cursors"]),
        "SHA256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def validate_preview_entry(entry: Mapping[str, Any], root: Path) -> None:
    role_previews = entry.get("rolePreviews")
    if not isinstance(role_previews, list) or len(role_previews) != len(MAC_CURSOR_IDENTIFIERS):
        raise ValueError(f"{entry.get('Identifier')}: preview metadata must contain {len(MAC_CURSOR_IDENTIFIERS)} roles")
    identifiers = [row.get("macIdentifier") for row in role_previews if isinstance(row, Mapping)]
    if identifiers != list(MAC_CURSOR_IDENTIFIERS):
        raise ValueError(f"{entry.get('Identifier')}: preview roles are out of order or incomplete")
    assets: dict[str, tuple[int, float]] = {}
    for row in role_previews:
        if not isinstance(row, Mapping):
            continue
        asset = str(row.get("asset"))
        expected = (
            int(row.get("frameCount", 1)),
            float(row.get("frameDuration", 1.0)),
        )
        if asset in assets and assets[asset] != expected:
            raise ValueError(
                f"{entry.get('Identifier')}: shared preview {asset} has "
                "inconsistent animation metadata"
            )
        assets[asset] = expected
    if str(entry.get("preview")) not in assets:
        raise ValueError(f"{entry.get('Identifier')}: primary preview is not a role preview")
    for relative, (frame_count, frame_duration) in assets.items():
        path = root / relative
        if not path.is_file():
            raise FileNotFoundError(path)
        with Image.open(path) as image:
            expected_size = BASE_REPRESENTATION_SIZES[-1]
            if image.size != (expected_size, expected_size):
                raise ValueError(
                    f"{path}: preview must be a {expected_size}px square, "
                    f"got {image.size}"
                )
            if image.n_frames != frame_count:
                raise ValueError(
                    f"{path}: preview contains {image.n_frames} frames, "
                    f"expected {frame_count}"
                )
            if frame_count > 1:
                if image.info.get("loop") != 0:
                    raise ValueError(f"{path}: animated preview must loop indefinitely")
                expected_duration_ms = max(1, round(frame_duration * 1000))
                for frame_index in range(frame_count):
                    image.seek(frame_index)
                    if image.info.get("duration") != expected_duration_ms:
                        raise ValueError(
                            f"{path}: frame {frame_index} lasts "
                            f"{image.info.get('duration')}ms, expected "
                            f"{expected_duration_ms}ms"
                        )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    single = subparsers.add_parser("convert", help="convert one source directory or .cape")
    single.add_argument("--source", required=True, type=Path)
    single.add_argument("--output", required=True, type=Path)
    single.add_argument("--id", dest="identifier")
    single.add_argument("--name", dest="display_name")
    single.add_argument("--author")
    single.add_argument("--source-url")
    single.add_argument("--license", dest="license_name")
    single.add_argument("--group", default="External")
    batch = subparsers.add_parser("batch", help="convert all variants under a source root")
    batch.add_argument("--source-root", required=True, type=Path)
    batch.add_argument("--output", required=True, type=Path)
    batch.add_argument("--manifest", type=Path)
    validate = subparsers.add_parser("validate", help="validate one generated .cursor file")
    validate.add_argument("path", type=Path)
    previews = subparsers.add_parser(
        "previews", help="export static and animated preview PNGs"
    )
    previews.add_argument("path", type=Path)
    previews.add_argument("--output", required=True, type=Path)
    previews.add_argument("--manifest-root", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "convert":
            result = convert_theme(args.source, args.output, args.identifier, args.display_name, author=args.author, source_url=args.source_url, license_name=args.license_name, group=args.group)
            print(json.dumps(result, sort_keys=True))
        elif args.command == "batch":
            results = convert_many(args.source_root, args.output, manifest_path=args.manifest)
            print(json.dumps(results, indent=2, sort_keys=True))
        elif args.command == "validate":
            print(json.dumps(validate_theme(args.path), sort_keys=True))
        else:
            print(
                json.dumps(
                    export_theme_previews(
                        args.path,
                        args.output,
                        manifest_root=args.manifest_root,
                    ),
                    indent=2,
                    sort_keys=True,
                )
            )
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"converter: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
