"""Shared build-time SVG rasterization for native cursor resources."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def render_svg_file(source: Path, size: int, output: Path) -> None:
    """Render *source* to an exact square PNG with librsvg."""

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
            str(size),
            "--height",
            str(size),
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
    if not output.is_file():
        raise FileNotFoundError(f"rsvg-convert did not create {output}")
