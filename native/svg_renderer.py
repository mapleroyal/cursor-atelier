"""Shared SVG rasterization for native cursor resources.

Developer builds use the conventional ``rsvg-convert`` executable.  The
released converter instead speaks a tiny JSON-lines protocol over its existing
stdin/stdout pipes so Electron can render with the Sharp/libvips/librsvg stack
that is already part of the application.  That keeps the frozen Python worker
self-contained without shipping a second copy of librsvg or depending on a
Homebrew installation.
"""

from __future__ import annotations

import itertools
import json
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path


_REQUEST_IDS = itertools.count(1)
_MAX_RENDER_DIMENSION = 8192


def _validate_dimensions(width: int, height: int) -> tuple[int, int]:
    if (
        isinstance(width, bool)
        or isinstance(height, bool)
        or not isinstance(width, int)
        or not isinstance(height, int)
        or not 1 <= width <= _MAX_RENDER_DIMENSION
        or not 1 <= height <= _MAX_RENDER_DIMENSION
    ):
        raise ValueError(f"invalid SVG render dimensions {width}x{height}")
    return width, height


def _validate_png(output: Path, width: int, height: int) -> None:
    try:
        with output.open("rb") as handle:
            header = handle.read(24)
    except OSError as exc:
        raise FileNotFoundError(f"SVG renderer did not create {output}") from exc
    if (
        len(header) != 24
        or header[:8] != b"\x89PNG\r\n\x1a\n"
        or header[12:16] != b"IHDR"
        or struct.unpack(">II", header[16:24]) != (width, height)
    ):
        raise RuntimeError(
            f"SVG renderer produced an invalid {width}x{height} PNG for {output}"
        )


def _render_over_stdio(
    source: Path,
    width: int,
    height: int,
    output: Path,
) -> None:
    request_id = str(next(_REQUEST_IDS))
    request = {
        "type": "render-svg",
        "requestId": request_id,
        "sourcePath": str(source.resolve()),
        "size": width,
        "width": width,
        "height": height,
        "outputPath": str(output.resolve()),
    }
    sys.stdout.write(json.dumps(request, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    raw_response = sys.stdin.readline()
    if not raw_response:
        raise RuntimeError("SVG renderer bridge closed before replying")
    try:
        response = json.loads(raw_response)
    except json.JSONDecodeError as exc:
        raise RuntimeError("SVG renderer bridge returned malformed JSON") from exc
    if (
        not isinstance(response, dict)
        or response.get("type") != "render-svg-result"
        or response.get("requestId") != request_id
    ):
        raise RuntimeError("SVG renderer bridge returned an unexpected reply")
    if response.get("ok") is not True:
        detail = response.get("error")
        raise RuntimeError(
            str(detail).strip()
            if isinstance(detail, str) and detail.strip()
            else f"SVG renderer bridge failed for {source}"
        )


def render_svg_file(
    source: Path,
    size: int,
    output: Path,
    *,
    height: int | None = None,
) -> None:
    """Render *source* to an exact PNG, square unless ``height`` is supplied."""

    source = Path(source)
    output = Path(output)
    width, render_height = _validate_dimensions(
        size,
        size if height is None else height,
    )
    if not source.is_file():
        raise FileNotFoundError(source)
    output.parent.mkdir(parents=True, exist_ok=True)

    if os.environ.get("CURSOR_SVG_RENDERER") == "stdio":
        _render_over_stdio(source, width, render_height, output)
        _validate_png(output, width, render_height)
        return

    executable = shutil.which("rsvg-convert")
    if executable is None:
        raise RuntimeError(
            "SVG conversion requires rsvg-convert (install librsvg; "
            "on macOS, run `brew install librsvg`; on Debian/Ubuntu, "
            "install `librsvg2-bin`)"
        )
    result = subprocess.run(
        [
            executable,
            "--format=png",
            "--width",
            str(width),
            "--height",
            str(render_height),
            "--output",
            str(output),
            str(source),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"rsvg-convert failed for {source}: {detail}")
    _validate_png(output, width, render_height)
