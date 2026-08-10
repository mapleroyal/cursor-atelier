"""Protocol tests for packaged Sharp-backed SVG rendering."""

from __future__ import annotations

import contextlib
import io
import json
import os
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

import svg_renderer


def _png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, value: bytes) -> bytes:
        return (
            struct.pack(">I", len(value))
            + kind
            + value
            + struct.pack(">I", zlib.crc32(kind + value) & 0xFFFFFFFF)
        )

    scanlines = b"".join(b"\0" + b"\0\0\0\0" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(scanlines))
        + chunk(b"IEND", b"")
    )


class _BridgeInput(io.StringIO):
    def __init__(self, requests: io.StringIO, output: Path, width: int, height: int):
        super().__init__()
        self.requests = requests
        self.output = output
        self.width = width
        self.height = height

    def readline(self, *args, **kwargs):
        request = json.loads(self.requests.getvalue().splitlines()[-1])
        self.output.write_bytes(_png(self.width, self.height))
        return json.dumps(
            {
                "type": "render-svg-result",
                "requestId": request["requestId"],
                "ok": True,
            }
        ) + "\n"


class SvgRendererProtocolTests(unittest.TestCase):
    def test_stdio_bridge_requests_and_validates_exact_dimensions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.svg"
            output = root / "output.png"
            source.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
            requests = io.StringIO()
            bridge_input = _BridgeInput(requests, output, 7, 11)
            previous = os.environ.get("CURSOR_SVG_RENDERER")
            os.environ["CURSOR_SVG_RENDERER"] = "stdio"
            try:
                with (
                    contextlib.redirect_stdout(requests),
                    mock.patch.object(sys, "stdin", bridge_input),
                ):
                    svg_renderer.render_svg_file(source, 7, output, height=11)
            finally:
                if previous is None:
                    os.environ.pop("CURSOR_SVG_RENDERER", None)
                else:
                    os.environ["CURSOR_SVG_RENDERER"] = previous
            request = json.loads(requests.getvalue())
            self.assertEqual(request["type"], "render-svg")
            self.assertEqual((request["width"], request["height"]), (7, 11))
            self.assertEqual(request["sourcePath"], str(source.resolve()))
            self.assertEqual(request["outputPath"], str(output.resolve()))

    def test_explicit_zero_height_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.svg"
            source.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
            with self.assertRaisesRegex(ValueError, "7x0"):
                svg_renderer.render_svg_file(
                    source,
                    7,
                    root / "output.png",
                    height=0,
                )


if __name__ == "__main__":
    unittest.main()
