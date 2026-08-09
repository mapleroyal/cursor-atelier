"""Fast, dependency-light tests for the build-time cursor converter."""

from __future__ import annotations

import io
import json
import plistlib
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

import converter


def png_bytes(image: Image.Image) -> bytes:
    encoded = io.BytesIO()
    image.save(encoded, format="PNG", optimize=True)
    return encoded.getvalue()


def xcursor_images(
    images: list[tuple[int, int, int, int, int | list[int]]],
) -> bytes:
    """Return an Xcursor file for ``(width, height, hot_x, hot_y, pixels)`` rows."""

    toc_size = len(images) * 12
    chunk_offset = 16 + toc_size
    tocs: list[bytes] = []
    chunks: list[bytes] = []
    for width, height, hot_x, hot_y, pixel_value in images:
        pixels = (
            pixel_value
            if isinstance(pixel_value, list)
            else [pixel_value] * (width * height)
        )
        if len(pixels) != width * height:
            raise ValueError("Xcursor pixel count does not match its dimensions")
        chunk = (
            struct.pack(
                "<9I",
                36,
                0xFFFD0002,
                width,
                1,
                width,
                height,
                hot_x,
                hot_y,
                50,
            )
            + b"".join(struct.pack("<I", pixel) for pixel in pixels)
        )
        tocs.append(struct.pack("<3I", 0xFFFD0002, width, chunk_offset))
        chunks.append(chunk)
        chunk_offset += len(chunk)
    return (
        b"Xcur"
        + struct.pack("<3I", 16, 0x10000, len(images))
        + b"".join(tocs + chunks)
    )


def xcursor_file(
    width: int = 32,
    height: int = 32,
    hot_x: int = 3,
    hot_y: int = 4,
    pixels: int | list[int] = 0xFFFF0000,
) -> bytes:
    """Return one valid Xcursor image chunk, opaque red by default."""

    return xcursor_images([(width, height, hot_x, hot_y, pixels)])


def representation_images(record: dict[str, object]) -> list[Image.Image]:
    images: list[Image.Image] = []
    for representation in record["Representations"]:  # type: ignore[index]
        with Image.open(io.BytesIO(representation)) as image:
            images.append(image.convert("RGBA"))
    return images


class ConverterTests(unittest.TestCase):
    def test_link_selection_and_drag_alias_roles_remain_distinct(self) -> None:
        self.assertEqual(converter.canonical_role("link"), "pointer")
        self.assertEqual(converter.canonical_role("dnd-link"), "alias")
        self.assertEqual(converter.canonical_role("hand1"), "openhand")
        self.assertEqual(converter.canonical_role("hand2"), "pointer")
        self.assertEqual(converter.canonical_role("grab"), "openhand")
        self.assertEqual(converter.canonical_role("grabbing"), "dnd-move")
        self.assertEqual(converter.canonical_role("closedhand"), "dnd-move")

    def test_google_build_aliases_fill_native_roles_without_overwriting_pointer(self) -> None:
        config = (
            Path(__file__).resolve().parent / "sources/google-cursor/build.toml"
        )
        specs = converter.parse_build_config(config)

        self.assertEqual(specs["pointer"].pattern, "hand2.png")
        self.assertEqual(specs["alias"].pattern, "link.png")
        self.assertEqual(specs["dnd-move"].pattern, "move.png")
        self.assertEqual(specs["openhand"].pattern, "hand1.png")
        self.assertEqual(specs["col-resize"].pattern, "sb_h_double_arrow.png")
        self.assertEqual(specs["row-resize"].pattern, "sb_v_double_arrow.png")

    def test_bitmap_variants_share_the_declared_full_animation_cycle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("left.png", "wait-01.png", "wait-02.png"):
                (root / name).write_bytes(
                    png_bytes(Image.new("RGBA", (32, 32), (10, 20, 30, 255)))
                )
            config = root / "build.toml"
            config.write_text(
                """
[cursors.fallback_settings]
x_hotspot = 4
y_hotspot = 4
x11_delay = 10
[cursors.left_ptr]
png = 'left.png'
[cursors.wait]
png = 'wait-*.png'
""".strip()
            )

            roles = converter.frames_from_bitmap_config(
                root,
                config,
                {"wait": 1.0},
            )

        self.assertEqual(len(roles["wait"]), 2)
        self.assertEqual([frame.delay_ms for frame in roles["wait"]], [500, 500])
        self.assertEqual(roles["default"][0].delay_ms, 10)

    def test_smil_cycle_duration_includes_finite_repeats(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "animated.svg"
            source.write_text(
                """<svg xmlns="http://www.w3.org/2000/svg">
  <animate attributeName="opacity" dur="1s" repeatCount="2"/>
  <animateTransform attributeName="transform" type="rotate" dur="500ms" repeatCount="3"/>
</svg>"""
            )
            self.assertEqual(converter.smil_cycle_duration(source), 2.0)

    def test_xcursor_decodes_argb_words_and_hotspot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "default"
            path.write_bytes(xcursor_file())
            frames = converter.parse_xcursor(path)
            self.assertEqual(len(frames), 1)
            self.assertEqual(frames[0].image.getpixel((0, 0)), (255, 0, 0, 255))
            self.assertEqual((frames[0].hotspot_x, frames[0].hotspot_y), (3, 4))

    def test_xcursor_same_directory_symlink_aliases_are_roles(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cursors = Path(temporary) / "cursors"
            cursors.mkdir()
            (cursors / "left_ptr").write_bytes(xcursor_file())
            (cursors / "crosshair").write_bytes(xcursor_file())
            (cursors / "tcross").symlink_to("crosshair")

            frames = converter._frames_from_xcursor(cursors)
            self.assertIn("default", frames)
            self.assertIn("tcross", frames)

            (cursors / "unsafe").symlink_to("../outside")
            with self.assertRaisesRegex(ValueError, "same directory"):
                converter._frames_from_xcursor(cursors)

    def test_simp1e_watch_source_resolves_native_wait_without_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cursors = Path(temporary)
            (cursors / "left_ptr").write_bytes(xcursor_file())
            (cursors / "left_ptr_watch").write_bytes(
                xcursor_file(pixels=0xFF00FF00)
            )
            (cursors / "watch").write_bytes(xcursor_file(pixels=0xFF0000FF))
            (cursors / "wait").symlink_to("watch")

            roles = converter._frames_from_xcursor(cursors)

        self.assertIn("wait", roles)
        self.assertEqual(
            converter._role_bindings(roles)["com.apple.coregraphics.Wait"],
            ("wait", "wait", False),
        )

    def test_xcursor_explicit_role_wins_over_historical_alias(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cursors = Path(temporary)
            (cursors / "alias").write_bytes(xcursor_file(pixels=0xFFFF0000))
            (cursors / "dnd-link").write_bytes(xcursor_file(pixels=0xFF0000FF))
            (cursors / "arrow").write_bytes(xcursor_file(pixels=0xFF0000FF))
            (cursors / "default").write_bytes(xcursor_file(pixels=0xFFFF0000))

            roles = converter._frames_from_xcursor(cursors)

        self.assertEqual(
            roles["alias"][32][0].image.getpixel((0, 0)),
            (255, 0, 0, 255),
        )
        self.assertEqual(
            roles["default"][32][0].image.getpixel((0, 0)),
            (255, 0, 0, 255),
        )

    def test_downsampling_preserves_total_animation_cycle_time(self) -> None:
        frames = [
            converter.Frame(Image.new("RGBA", (32, 32)), 16, 16, 40)
            for _ in range(54)
        ]

        record = converter.build_cursor(frames)

        self.assertEqual(record["FrameCount"], 24)
        self.assertAlmostEqual(
            record["FrameDuration"] * record["FrameCount"],
            2.16,
        )

    def test_resolution_tiers_with_different_frame_counts_share_a_timeline(self) -> None:
        groups = {
            32: [
                converter.Frame(
                    Image.new("RGBA", (32, 32), (value, 0, 0, 255)),
                    4,
                    5,
                )
                for value in (10, 20, 30)
            ],
            64: [
                converter.Frame(
                    Image.new("RGBA", (64, 64), (0, value, 0, 255)),
                    8,
                    10,
                )
                for value in (10, 20, 30, 40, 50)
            ],
        }

        record = converter.build_cursor(groups)
        by_width = {image.width: image for image in representation_images(record)}

        self.assertEqual(record["FrameCount"], 5)
        self.assertEqual(record["FrameDuration"], 0.05)
        self.assertEqual(
            [by_width[32].getpixel((16, index * 32 + 16))[0] for index in range(5)],
            [10, 10, 20, 30, 30],
        )
        self.assertEqual(
            [by_width[64].getpixel((32, index * 64 + 32))[1] for index in range(5)],
            [10, 20, 30, 40, 50],
        )

    def test_nearest_32_tier_owns_the_authored_animation_cycle(self) -> None:
        groups = {
            32: [
                converter.Frame(Image.new("RGBA", (32, 32)), 16, 16, 100)
                for _ in range(3)
            ],
            64: [
                converter.Frame(Image.new("RGBA", (64, 64)), 32, 32, 40)
                for _ in range(5)
            ],
        }

        record = converter.build_cursor(groups)

        self.assertEqual(record["FrameCount"], 5)
        self.assertAlmostEqual(record["FrameDuration"], 0.06)
        self.assertAlmostEqual(
            record["FrameCount"] * record["FrameDuration"],
            0.3,
        )

    def test_variable_dwell_is_preserved_on_uniform_mac_timeline(self) -> None:
        frames = [
            converter.Frame(
                Image.new("RGBA", (32, 32), color),
                16,
                16,
                delay,
            )
            for color, delay in zip(
                (
                    (255, 0, 0, 255),
                    (0, 255, 0, 255),
                    (0, 0, 255, 255),
                ),
                (900, 50, 50),
            )
        ]

        record = converter.build_cursor(frames)
        sheet = representation_images(record)[0]
        colors = [
            sheet.getpixel((16, index * 32 + 16))
            for index in range(record["FrameCount"])
        ]

        self.assertEqual(record["FrameCount"], 20)
        self.assertEqual(record["FrameDuration"], 0.05)
        self.assertEqual(colors.count((255, 0, 0, 255)), 18)
        self.assertEqual(colors[-2:], [(0, 255, 0, 255), (0, 0, 255, 255)])

    def test_hotspot_uses_per_tier_then_cross_tier_medians(self) -> None:
        transparent = lambda size: Image.new("RGBA", (size, size), (0, 0, 0, 0))
        groups = {
            24: [
                converter.Frame(transparent(24), hotspot, hotspot, 50)
                for hotspot in (6, 6, 23)
            ],
            32: [converter.Frame(transparent(32), 8, 8, 50)],
            48: [converter.Frame(transparent(48), 47, 47, 50)],
        }

        record = converter.build_cursor(groups)

        self.assertEqual((record["HotSpotX"], record["HotSpotY"]), (8.0, 8.0))

    def test_rectangular_frames_are_square_padded_without_stretching(self) -> None:
        record = converter.build_cursor(
            [
                converter.Frame(
                    Image.new("RGBA", (64, 32), (255, 0, 0, 255)),
                    16,
                    8,
                )
            ]
        )
        by_width = {image.width: image for image in representation_images(record)}

        self.assertEqual((record["HotSpotX"], record["HotSpotY"]), (8.0, 4.0))
        self.assertEqual(by_width[64].getpixel((32, 16)), (255, 0, 0, 255))
        self.assertEqual(by_width[64].getpixel((32, 48)), (0, 0, 0, 0))

    def test_small_per_frame_hotspot_drift_is_visually_aligned(self) -> None:
        frames = []
        for position in (5, 7):
            image = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
            image.putpixel((position, 5), (255, 255, 255, 255))
            frames.append(converter.Frame(image, position, 5))

        record = converter.build_cursor(frames)
        sheet = representation_images(record)[0]

        self.assertEqual((record["HotSpotX"], record["HotSpotY"]), (6.0, 5.0))
        self.assertEqual(sheet.getpixel((6, 5)), (255, 255, 255, 255))
        self.assertEqual(sheet.getpixel((6, 32 + 5)), (255, 255, 255, 255))

    def test_identical_animated_wait_and_progress_synthesizes_progress(self) -> None:
        pointer = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        pointer.putpixel((2, 3), (255, 0, 0, 255))
        wait = [
            converter.Frame(Image.new("RGBA", (32, 32), color), 16, 16, 50)
            for color in ((0, 0, 255, 255), (0, 255, 0, 255))
        ]
        theme = converter._build_theme(
            {
                "default": [converter.Frame(pointer, 2, 3)],
                "wait": wait,
                "progress": list(wait),
            },
            "Synthetic",
            "Synthetic",
        )
        wait_record = theme["Cursors"]["com.apple.coregraphics.Wait"]
        progress = theme["Cursors"]["com.apple.cursor.4"]
        progress_sheet = representation_images(progress)[0]

        self.assertEqual(progress["FrameCount"], wait_record["FrameCount"])
        self.assertEqual(progress["FrameDuration"], wait_record["FrameDuration"])
        self.assertEqual((progress["HotSpotX"], progress["HotSpotY"]), (2.0, 3.0))
        self.assertNotEqual(progress["Representations"], wait_record["Representations"])
        self.assertEqual(progress_sheet.getpixel((2, 3)), (255, 0, 0, 255))
        self.assertEqual(progress_sheet.getpixel((24, 24)), (0, 0, 255, 255))
        self.assertEqual(progress_sheet.getpixel((24, 32 + 24)), (0, 255, 0, 255))

    def test_near_phase_spinner_sequences_synthesize_progress(self) -> None:
        positions = ((16, 4), (27, 16), (16, 27), (4, 16))
        wait = []
        for position in positions:
            image = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
            image.putpixel(position, (255, 255, 255, 255))
            wait.append(converter.Frame(image, 16, 16, 50))
        progress = []
        for source in wait[1:] + wait[:1]:
            image = source.image.copy()
            image.putpixel(image.getbbox()[:2], (253, 253, 253, 255))
            progress.append(converter.Frame(image, 16, 16, 50))

        self.assertTrue(converter._frame_sources_share_animation_art(wait, progress))
        theme = converter._build_theme(
            {
                "default": [
                    converter.Frame(Image.new("RGBA", (32, 32)), 2, 3)
                ],
                "wait": wait,
                "progress": progress,
            },
            "Synthetic",
            "Synthetic",
        )
        record = theme["Cursors"]["com.apple.cursor.4"]

        self.assertEqual((record["HotSpotX"], record["HotSpotY"]), (2.0, 3.0))

    def test_pointer_plus_spinner_mask_is_not_treated_as_duplicate_wait(self) -> None:
        positions = ((16, 4), (27, 16), (16, 27), (4, 16))
        wait = []
        progress = []
        for position in positions:
            spinner = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
            spinner.putpixel(position, (255, 255, 255, 255))
            wait.append(converter.Frame(spinner, 16, 16, 50))
            composed = spinner.copy()
            composed.paste((255, 0, 0, 255), (0, 0, 8, 12))
            progress.append(converter.Frame(composed, 16, 16, 50))

        self.assertFalse(converter._frame_sources_share_animation_art(wait, progress))
        theme = converter._build_theme(
            {
                "default": [
                    converter.Frame(Image.new("RGBA", (32, 32)), 2, 3)
                ],
                "wait": wait,
                "progress": progress,
            },
            "Synthetic",
            "Synthetic",
        )
        record = theme["Cursors"]["com.apple.cursor.4"]
        sheet = representation_images(record)[0]

        self.assertEqual((record["HotSpotX"], record["HotSpotY"]), (16.0, 16.0))
        self.assertEqual(sheet.getpixel((2, 3)), (255, 0, 0, 255))

    def test_distinct_animated_progress_art_is_preserved(self) -> None:
        wait = [
            converter.Frame(Image.new("RGBA", (32, 32), color), 16, 16, 50)
            for color in ((0, 0, 255, 255), (0, 255, 0, 255))
        ]
        progress = [
            converter.Frame(Image.new("RGBA", (32, 32), color), 16, 16, 50)
            for color in ((255, 0, 255, 255), (255, 255, 0, 255))
        ]
        theme = converter._build_theme(
            {
                "default": [
                    converter.Frame(Image.new("RGBA", (32, 32)), 2, 3)
                ],
                "wait": wait,
                "progress": progress,
            },
            "Synthetic",
            "Synthetic",
        )
        record = theme["Cursors"]["com.apple.cursor.4"]
        sheet = representation_images(record)[0]

        self.assertEqual(sheet.getpixel((16, 16)), (255, 0, 255, 255))
        self.assertEqual(sheet.getpixel((16, 32 + 16)), (255, 255, 0, 255))

    def test_xcursor_unpremultiplies_translucent_argb_edges(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "default"
            # Xcursor stores premultiplied ARGB. At alpha 85, (85, 34, 17)
            # represents the straight-alpha color (255, 102, 51).
            path.write_bytes(
                xcursor_file(
                    width=2,
                    height=1,
                    pixels=[0x55552211, 0x00000000],
                )
            )
            image = converter.parse_xcursor(path)[0].image
            self.assertEqual(image.getpixel((0, 0)), (255, 102, 51, 85))
            self.assertEqual(image.getpixel((1, 0)), (0, 0, 0, 0))

    def test_xcursor_preserves_native_tiers_and_uses_exact_retina_preview(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "cursors"
            source.mkdir()
            (source / "default").write_bytes(
                xcursor_images(
                    [
                        (32, 32, 3, 4, 0xFFFF0000),
                        (64, 64, 6, 8, 0xFF00FF00),
                        (96, 96, 9, 12, 0xFF0000FF),
                        (128, 128, 12, 16, 0xFFFFFF00),
                    ]
                )
            )
            output = root / "Synthetic.cursor"
            entry = converter.convert_theme(
                source,
                output,
                "Synthetic",
                "Synthetic",
                preview_root=root / "previews",
                manifest_root=root,
            )

            theme = plistlib.loads(output.read_bytes())
            record = theme["Cursors"]["com.apple.coregraphics.Arrow"]
            images = representation_images(record)
            widths = [image.width for image in images]
            by_width = {image.width: image for image in images}
            self.assertTrue({32, 64, 96}.issubset(by_width))
            self.assertEqual(widths, sorted(set(widths)))
            self.assertEqual(by_width[32].getpixel((16, 16)), (255, 0, 0, 255))
            self.assertEqual(by_width[64].getpixel((32, 32)), (0, 255, 0, 255))
            self.assertEqual(by_width[96].getpixel((48, 48)), (0, 0, 255, 255))
            self.assertEqual(
                by_width[128].getpixel((64, 64)), (255, 255, 0, 255)
            )
            converter.validate_theme(output)

            with Image.open(root / entry["preview"]) as preview:
                self.assertEqual(preview.size, (96, 96))
                self.assertEqual(
                    preview.convert("RGBA").getpixel(
                        (preview.width // 2, preview.height // 2)
                    ),
                    (0, 0, 255, 255),
                )

    def test_animated_preview_preserves_every_frame_and_timing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            frames = [
                converter.Frame(Image.new("RGBA", (32, 32), color), 4, 5, 40)
                for color in (
                    (255, 0, 0, 255),
                    (0, 255, 0, 255),
                    (0, 0, 255, 255),
                )
            ]
            entry = converter.convert_frames(
                {"default": frames},
                root / "Synthetic.cursor",
                "Synthetic",
                "Synthetic",
                preview_root=root / "previews",
                manifest_root=root,
            )
            converter.validate_preview_entry(entry, root)

            with Image.open(root / entry["preview"]) as preview:
                self.assertEqual(preview.size, (96, 96))
                self.assertEqual(preview.n_frames, 3)
                self.assertEqual(preview.info["loop"], 0)
                self.assertEqual(preview.info["duration"], 40.0)
                colors = []
                for index in range(preview.n_frames):
                    preview.seek(index)
                    colors.append(preview.convert("RGBA").getpixel((48, 48)))
                self.assertEqual(
                    colors,
                    [
                        (255, 0, 0, 255),
                        (0, 255, 0, 255),
                        (0, 0, 255, 255),
                    ],
                )

    def test_svg_is_rendered_directly_at_each_output_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "svg"
            source.mkdir()
            (source / "default.svg").write_text(
                '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>'
            )

            def render_at_size(_path: Path, size: int, _cache: Path) -> Image.Image:
                return Image.new("RGBA", (size, size), (size, size // 2, size // 4, 255))

            output = root / "Synthetic.cursor"
            with mock.patch.object(converter, "render_svg", side_effect=render_at_size) as render:
                converter.convert_theme(source, output, "Synthetic", "Synthetic")

            rendered_sizes = {call.args[1] for call in render.call_args_list}
            self.assertTrue({32, 64, 96, 128}.issubset(rendered_sizes))
            theme = plistlib.loads(output.read_bytes())
            record = theme["Cursors"]["com.apple.coregraphics.Arrow"]
            images = representation_images(record)
            self.assertEqual([image.width for image in images], [32, 64, 96, 128])
            for image in images:
                size = image.width
                self.assertEqual(
                    image.getpixel((size // 2, size // 2)),
                    (size, size // 2, size // 4, 255),
                )

    def test_svg_renderer_accepts_compact_arc_flags(self) -> None:
        compact_path = (
            "M10.3431 10.3431a8 8 0 0111.3138 0 8 8 0 010 11.3138 "
            "8 8 0 01-11.3138 0 8 8 0 010-11.3138z"
        )
        explicit_path = (
            "M10.3431 10.3431 a8 8 0 0 1 11.3138 0 "
            "a8 8 0 0 1 0 11.3138 a8 8 0 0 1 -11.3138 0 "
            "a8 8 0 0 1 0 -11.3138 z"
        )
        template = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
            '<path d="{}" fill="#f44336"/></svg>'
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            compact = root / "compact.svg"
            explicit = root / "explicit.svg"
            compact.write_text(template.format(compact_path))
            explicit.write_text(template.format(explicit_path))

            compact_image = converter.render_svg(compact, 64, root / "cache")
            explicit_image = converter.render_svg(explicit, 64, root / "cache")

        self.assertEqual(compact_image.tobytes(), explicit_image.tobytes())

    def test_cape_preserves_each_native_representation_scale(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cape = {
                "CapeName": "Synthetic",
                "Cursors": {
                    "com.apple.coregraphics.Arrow": {
                        "FrameCount": 1,
                        "FrameDuration": 1.0,
                        "HotSpotX": 16.0,
                        "HotSpotY": 24.0,
                        "PointsWide": 64.0,
                        "PointsHigh": 64.0,
                        "Representations": [
                            png_bytes(Image.new("RGBA", (64, 64), (255, 0, 0, 255))),
                            png_bytes(Image.new("RGBA", (128, 128), (0, 255, 0, 255))),
                            png_bytes(Image.new("RGBA", (320, 320), (0, 0, 255, 255))),
                        ],
                    }
                },
            }
            cape_path = root / "synthetic.cape"
            cape_path.write_bytes(plistlib.dumps(cape))
            output = root / "Synthetic.cursor"
            converter.convert_theme(cape_path, output, "Synthetic", "Synthetic")

            theme = plistlib.loads(output.read_bytes())
            record = theme["Cursors"]["com.apple.coregraphics.Arrow"]
            images = representation_images(record)
            self.assertEqual([image.width for image in images], [32, 64, 96, 160])
            self.assertEqual(
                [image.getpixel((0, 0)) for image in images],
                [
                    (255, 0, 0, 255),
                    (0, 255, 0, 255),
                    (0, 0, 255, 255),
                    (0, 0, 255, 255),
                ],
            )
            self.assertEqual((record["HotSpotX"], record["HotSpotY"]), (8.0, 12.0))
            converter.validate_theme(output)

    def test_cape_normalizes_only_associated_alpha_payloads(self) -> None:
        associated = Image.new("RGBA", (1, 1), (8, 4, 2, 8))
        straight = Image.new("RGBA", (1, 1), (255, 128, 64, 8))

        self.assertEqual(
            converter._normalize_cape_alpha(associated).getpixel((0, 0)),
            (255, 128, 64, 8),
        )
        self.assertEqual(
            converter._normalize_cape_alpha(straight).getpixel((0, 0)),
            (255, 128, 64, 8),
        )

    def test_resize_clears_hidden_rgb_without_changing_visible_pixels(self) -> None:
        source = Image.new("RGBA", (2, 2))
        source.putdata(
            [
                (19, 23, 29, 0),
                (255, 128, 64, 8),
                (0, 0, 0, 0),
                (0, 0, 0, 0),
            ]
        )

        resized = converter._resize(source, 2)

        self.assertEqual(resized.getpixel((0, 0)), (0, 0, 0, 0))
        self.assertEqual(resized.getpixel((1, 0)), (255, 128, 64, 8))

    def test_svg_config_scales_hotspots_from_rendered_bitmap_dimensions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            svg_dir = root / "svg"
            config_dir = root / "config"
            svg_dir.mkdir()
            config_dir.mkdir()
            (svg_dir / "default.svg").write_text(
                '<svg xmlns="http://www.w3.org/2000/svg" '
                'width="32" height="32" viewBox="0 0 32 32"/>'
            )
            (config_dir / "default.cursor").write_text(
                "24 4 4 x1/default.png\n"
                "30 5 5 x1_25/default.png\n"
                "36 6 6 x1_5/default.png\n"
                "48 8 8 x2/default.png\n"
            )

            def render_at_size(
                _path: Path, size: int, _cache: Path
            ) -> Image.Image:
                return Image.new("RGBA", (size, size), (0, 0, 0, 0))

            with mock.patch.object(
                converter, "render_svg", side_effect=render_at_size
            ):
                frames = converter.frames_from_svg_config(svg_dir, config_dir)

            self.assertEqual(sorted(frames["default"]), [32, 64, 96, 128])
            for size, tier in frames["default"].items():
                self.assertEqual(
                    (tier[0].hotspot_x, tier[0].hotspot_y),
                    (size / 8, size / 8),
                )

    def test_svg_config_prefers_exact_animation_frame_over_size_suffix(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            svg_dir = root / "svg"
            config_dir = root / "config"
            svg_dir.mkdir()
            config_dir.mkdir()
            svg = (
                '<svg xmlns="http://www.w3.org/2000/svg" '
                'viewBox="0 0 24 24"/>'
            )
            for name in (
                "default.svg",
                "wait.svg",
                "wait-15.svg",
                "wait-16.svg",
                "wait-17.svg",
            ):
                (svg_dir / name).write_text(svg)
            (config_dir / "default.cursor").write_text(
                "24 4 4 x1/default.png\n"
            )
            (config_dir / "wait.cursor").write_text(
                "24 12 12 x1/wait-15.png 30\n"
                "24 12 12 x1/wait-16.png 30\n"
                "24 12 12 x1/wait-17.png 30\n"
            )
            colors = {
                "wait-15.svg": (255, 0, 0, 255),
                "wait-16.svg": (0, 255, 0, 255),
                "wait-17.svg": (0, 0, 255, 255),
            }

            def render_at_size(
                path: Path, size: int, _cache: Path
            ) -> Image.Image:
                color = colors.get(path.name, (0, 0, 0, 255))
                return Image.new("RGBA", (size, size), color)

            with mock.patch.object(
                converter, "render_svg", side_effect=render_at_size
            ):
                frames = converter.frames_from_svg_config(svg_dir, config_dir)

            for tier in frames["wait"].values():
                self.assertEqual(
                    [frame.image.getpixel((0, 0)) for frame in tier],
                    list(colors.values()),
                )

    def test_smil_sampling_preserves_the_complete_source_cycle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            animated = root / "animated"
            animated.mkdir()
            (animated / "wait.svg").write_text(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
                '<g><animateTransform attributeName="transform" type="rotate" '
                'values="0 100 100;360 100 100" dur="0.3367s" '
                'repeatCount="9"/></g></svg>'
            )
            hotspots = root / "constants.py"
            hotspots.write_text(
                'X_CURSORS_CFG = {"wait": {"xhot": 100, "yhot": 100}}\n'
            )

            def render_frame(
                _content: str, size: int, _cache: Path
            ) -> Image.Image:
                return Image.new("RGBA", (size, size))

            with mock.patch.object(
                converter,
                "_render_svg_content",
                side_effect=render_frame,
            ):
                sources = converter.frames_from_svg_assets(root, hotspots, {})

            wait_frames = sources["wait"][32]  # type: ignore[index]
            record = converter.build_cursor(sources["wait"])

        self.assertEqual(len(wait_frames), converter.MAX_MACOS_FRAMES)
        self.assertAlmostEqual(wait_frames[0].delay_ms or 0, 126.2625)
        self.assertAlmostEqual(
            record["FrameDuration"] * record["FrameCount"],
            3.0303,
        )

    def test_generated_theme_is_complete_and_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "cursors"
            source.mkdir()
            (source / "default").write_bytes(xcursor_file())
            first = Path(temporary) / "one.cursor"
            second = Path(temporary) / "two.cursor"
            result = converter.convert_theme(source, first, "Synthetic", "Synthetic")
            converter.convert_theme(source, second, "Synthetic", "Synthetic")
            self.assertEqual(result["Identifier"], "Synthetic")
            self.assertEqual(first.read_bytes(), second.read_bytes())
            report = converter.validate_theme(first)
            self.assertEqual(report["Cursors"], len(converter.MAC_CURSOR_IDENTIFIERS))
            self.assertEqual(report["Identifier"], "Synthetic")

    def test_validator_matches_native_cursor_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            valid_path = root / "valid.cursor"
            converter.convert_frames(
                {
                    "default": [
                        converter.Frame(
                            Image.new("RGBA", (32, 32), (255, 255, 255, 255)),
                            3,
                            4,
                        )
                    ]
                },
                valid_path,
                "Synthetic",
                "Synthetic",
            )
            valid_theme = plistlib.loads(valid_path.read_bytes())
            arrow = "com.apple.coregraphics.Arrow"

            def replace_arrow(theme: dict[str, object]) -> dict[str, object]:
                cursors = theme["Cursors"]
                self.assertIsInstance(cursors, dict)
                record = dict(cursors[arrow])  # type: ignore[index]
                record["Representations"] = list(record["Representations"])
                cursors[arrow] = record  # type: ignore[index]
                return record

            def extra_identifier(theme: dict[str, object]) -> None:
                cursors = theme["Cursors"]
                self.assertIsInstance(cursors, dict)
                cursors["unexpected.cursor"] = dict(cursors[arrow])

            def edge_hotspot(theme: dict[str, object]) -> None:
                record = replace_arrow(theme)
                record["HotSpotX"] = record["PointsWide"]

            def zero_duration(theme: dict[str, object]) -> None:
                replace_arrow(theme)["FrameDuration"] = 0.0

            def boolean_frame_count(theme: dict[str, object]) -> None:
                replace_arrow(theme)["FrameCount"] = True

            def missing_three_x(theme: dict[str, object]) -> None:
                record = replace_arrow(theme)
                record["Representations"][-1] = png_bytes(
                    Image.new("RGBA", (128, 128), (255, 255, 255, 255))
                )

            def mismatched_sheet_geometry(theme: dict[str, object]) -> None:
                record = replace_arrow(theme)
                record["Representations"][-1] = png_bytes(
                    Image.new("RGBA", (96, 95), (255, 255, 255, 255))
                )

            cases = (
                ("extra-identifier", extra_identifier, "identifier"),
                ("edge-hotspot", edge_hotspot, "HotSpotX"),
                ("zero-duration", zero_duration, "FrameDuration"),
                ("boolean-frame-count", boolean_frame_count, "FrameCount"),
                ("missing-three-x", missing_three_x, "1x, 2x, or 3x"),
                (
                    "mismatched-sheet-geometry",
                    mismatched_sheet_geometry,
                    "sprite-sheet dimensions",
                ),
            )
            for name, mutate, error_pattern in cases:
                with self.subTest(name=name):
                    theme = plistlib.loads(plistlib.dumps(valid_theme))
                    mutate(theme)
                    candidate = root / f"{name}.cursor"
                    candidate.write_bytes(plistlib.dumps(theme))
                    with self.assertRaisesRegex(ValueError, error_pattern):
                        converter.validate_theme(candidate)

    def test_validator_uses_declared_point_geometry_not_fixed_pixels(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "scaled.cursor"
            theme = converter._build_theme(
                {
                    "default": [
                        converter.Frame(Image.new("RGBA", (32, 32)), 3, 4)
                    ]
                },
                "Synthetic",
                "Synthetic",
            )
            arrow = "com.apple.coregraphics.Arrow"
            record = dict(theme["Cursors"][arrow])
            record.update(
                {
                    "HotSpotX": 2.0,
                    "HotSpotY": 3.0,
                    "PointsWide": 16.0,
                    "PointsHigh": 16.0,
                    "Representations": [
                        png_bytes(Image.new("RGBA", (size, size)))
                        for size in (16, 32, 48)
                    ],
                }
            )
            theme["Cursors"][arrow] = record
            path.write_bytes(plistlib.dumps(theme))

            converter.validate_theme(path)

    def test_converter_rejects_hotspot_on_canvas_edge(self) -> None:
        with self.assertRaisesRegex(ValueError, "outside its 32px canvas"):
            converter.build_cursor(
                [converter.Frame(Image.new("RGBA", (32, 32)), 32, 4)]
            )

    def test_cape_animation_sprite_sheet_is_downsampled(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            # Build a tiny Cape with 25 frames; conversion must cap at 24.
            sheet = Image.new("RGBA", (32, 32 * 25), (0, 0, 0, 0))
            for index in range(25):
                sheet.putpixel((index % 32, index * 32), (255, 255, 255, 255))
            encoded = io.BytesIO()
            sheet.save(encoded, format="PNG", optimize=True)
            cape = {
                "CapeName": "Synthetic",
                "Cursors": {
                    "com.apple.coregraphics.Arrow": {
                        "FrameCount": 25,
                        "FrameDuration": 0.05,
                        "HotSpotX": 3.0,
                        "HotSpotY": 4.0,
                        "PointsWide": 32.0,
                        "PointsHigh": 32.0,
                        "Representations": [encoded.getvalue()],
                    }
                },
            }
            cape_path = Path(temporary) / "synthetic.cape"
            cape_path.write_bytes(plistlib.dumps(cape))
            output = Path(temporary) / "Synthetic.cursor"
            converter.convert_theme(cape_path, output, "Synthetic", "Synthetic")
            theme = plistlib.loads(output.read_bytes())
            cursor = theme["Cursors"]["com.apple.coregraphics.Arrow"]
            self.assertEqual(cursor["FrameCount"], 24)
            self.assertEqual(cursor["Representations"][0][:8], b"\x89PNG\r\n\x1a\n")

    def test_build_config_preserves_hotspots_and_animation_frames(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("left_ptr.png", "wait-0001.png", "wait-0002.png"):
                Image.new("RGBA", (200, 200), (15, 30, 45, 255)).save(root / name)
            config = root / "build.toml"
            config.write_text(
                """
[cursors.fallback_settings]
x_hotspot = 100
y_hotspot = 100
x11_delay = 17
[cursors.left_ptr]
png = 'left_ptr.png'
x_hotspot = 25
y_hotspot = 50
[cursors.wait]
png = 'wait-*.png'
"""
            )
            frames = converter.frames_from_bitmap_config(root, config)
            self.assertEqual((frames["default"][0].hotspot_x, frames["default"][0].hotspot_y), (25, 50))
            self.assertEqual(len(frames["wait"]), 2)
            self.assertEqual(frames["wait"][0].delay_ms, 17)

    def test_capitaine_spec_uses_pixel_hotspots_and_keeps_all_frames(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "progress.spec"
            path.write_text("4 2 24 30\n")
            rows = converter.parse_spec(path)
            self.assertEqual(len(rows), 24)
            self.assertEqual((rows[0].hotspot_x, rows[0].hotspot_y), (4, 2))
            self.assertEqual(rows[-1].filename, "progress-23.svg")
            record = converter.build_cursor(
                [converter.Frame(Image.new("RGBA", (24, 24)), 4, 2, 30)]
            )
            self.assertAlmostEqual(record["HotSpotX"], 16 / 3)
            self.assertAlmostEqual(record["HotSpotY"], 8 / 3)

    def test_preview_manifest_maps_every_native_role_without_base64(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "cursors"
            source.mkdir()
            (source / "default").write_bytes(xcursor_file())
            entry = converter.convert_theme(
                source,
                root / "Synthetic.cursor",
                "Synthetic",
                "Synthetic",
                preview_root=root / "previews",
                manifest_root=root,
            )
            converter.validate_preview_entry(entry, root)
            self.assertEqual(len(entry["rolePreviews"]), len(converter.MAC_CURSOR_IDENTIFIERS))
            self.assertEqual(entry["preview"], "previews/Synthetic/default.png")
            self.assertNotIn("base64", json.dumps(entry).lower())


if __name__ == "__main__":
    unittest.main()
