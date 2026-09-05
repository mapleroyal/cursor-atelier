"""Encode approved PNG frames with Clickgen inside the frozen app runtime."""

from __future__ import annotations

import json
import re
import struct
from pathlib import Path

from clickgen import __version__ as CLICKGEN_VERSION
from clickgen.cursors import CursorFrame, CursorImage
from clickgen.writer.x11 import to_x11
from PIL import Image


SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")


def encode_theme(manifest_path: Path, output_root: Path) -> None:
    """Write the app-generated manifest in order, retaining nominal sizes."""
    document = json.loads(manifest_path.read_text())
    if document.get("schemaVersion") != 1 or not document.get("cursors"):
        raise ValueError("unsupported Xcursor encoding manifest")
    for cursor in document["cursors"]:
        name = cursor["name"]
        if not SAFE_NAME.fullmatch(name):
            raise ValueError("invalid Xcursor output name")
        frames = []
        for source in cursor["frames"]:
            filename = source["filename"]
            if not SAFE_NAME.fullmatch(filename):
                raise ValueError("invalid Xcursor frame filename")
            with Image.open(manifest_path.parent / filename) as png:
                image = png.convert("RGBA")
            frames.append(
                CursorFrame(
                    [
                        CursorImage(
                            image,
                            (source["hotX"], source["hotY"]),
                            source["nominalSize"],
                        )
                    ],
                    delay=source["delay"],
                )
            )
        if not frames:
            raise ValueError("an Xcursor requires at least one frame")
        (output_root / name).write_bytes(to_x11(frames))


def self_test() -> str:
    """Exercise the same writer and native NumPy runtime used by application."""
    image = Image.new("RGBA", (2, 1), (255, 0, 0, 128))
    encoded = to_x11([CursorFrame([CursorImage(image, (1, 0), 24)], delay=60)])
    if (
        encoded[:4] != b"Xcur"
        or struct.unpack_from("<III", encoded, 16) != (0xFFFD0002, 24, 28)
        or struct.unpack_from("<IIIII", encoded, 44) != (2, 1, 1, 0, 60)
        or struct.unpack_from("<I", encoded, 64)[0] != 0x80800000
    ):
        raise RuntimeError("the packaged Xcursor encoder failed its self-test")
    return CLICKGEN_VERSION
