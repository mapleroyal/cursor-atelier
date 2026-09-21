"""Write validated Windows cursor jobs using the bundled Clickgen encoder."""
from __future__ import annotations
import json
import math
import re
import struct
from pathlib import Path
from clickgen.cursors import CursorFrame, CursorImage
from clickgen.writer.windows import to_win
from PIL import Image
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")


def encode_theme(manifest_path: Path, output_root: Path) -> None:
    document = json.loads(manifest_path.read_text(encoding="utf-8"))
    cursors = document.get("cursors")
    if document.get("schemaVersion") != 1 or not isinstance(cursors, list) or not 1 <= len(cursors) <= 32:
        raise ValueError("unsupported Windows encoding manifest")
    names = set()
    for cursor in cursors:
        name = cursor.get("name", "")
        if not SAFE_NAME.fullmatch(name) or name in names:
            raise ValueError("invalid Windows cursor output name")
        names.add(name)
        sources = cursor.get("frames")
        if not isinstance(sources, list) or not 1 <= len(sources) <= 24:
            raise ValueError("invalid Windows animation frame count")
        frames, elapsed, ticks = [], 0.0, 0
        for source in sources:
            filename = source.get("filename", "")
            if not SAFE_NAME.fullmatch(filename):
                raise ValueError("invalid Windows cursor frame filename")
            frame_path = manifest_path.parent / filename
            if frame_path.is_symlink() or not frame_path.is_file() or frame_path.stat().st_size > 16 * 1024 * 1024:
                raise ValueError("unsafe Windows cursor frame")
            with Image.open(frame_path) as png:
                if png.width != png.height or not 1 <= png.width <= 256:
                    raise ValueError("Windows cursor frames require a square canvas of at most 256 pixels")
                image = png.convert("RGBA")
            hot_x, hot_y = source["hotX"], source["hotY"]
            if not all(isinstance(value, int) and not isinstance(value, bool) and 0 <= value < image.width for value in (hot_x, hot_y)):
                raise ValueError("invalid Windows cursor hotspot")
            duration = source["durationSeconds"]
            if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0.001 <= duration <= 10:
                raise ValueError("invalid Windows cursor frame duration")
            # ANI uses 1/60-second jiffies. Cumulative rounding preserves the
            # cycle; Clickgen's Windows writer multiplies delay by two.
            elapsed += duration * 60
            next_ticks = max(ticks + 1, round(elapsed))
            frames.append(CursorFrame([CursorImage(image, (hot_x, hot_y), image.width, re_canvas=True)], delay=(next_ticks - ticks) / 2))
            ticks = next_ticks
        extension, encoded = to_win(frames)
        with (output_root / (name + extension)).open("xb") as target:
            target.write(encoded)


def self_test() -> str:
    frame = CursorFrame([CursorImage(Image.new("RGBA", (32, 32), (255, 0, 0, 128)), (3, 7), 32, re_canvas=True)], delay=1.5)
    extension, static = to_win([frame])
    if extension != ".cur" or static[:6] != b"\x00\x00\x02\x00\x01\x00" or struct.unpack_from("<HH", static, 10) != (3, 7):
        raise RuntimeError("the Windows static cursor writer failed its self-test")
    extension, animated = to_win([frame, frame])
    rate = animated.index(b"rate")
    if extension != ".ani" or animated[:4] != b"RIFF" or animated[8:12] != b"ACON" or struct.unpack_from("<III", animated, rate + 4) != (8, 3, 3):
        raise RuntimeError("the Windows animated cursor writer failed its self-test")
    return "cur-ani"