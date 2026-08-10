"""Tests for the Ruby-free Oreo source recipe."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import oreo_recipe


class OreoRecipeTests(unittest.TestCase):
    def test_palette_parser_matches_all_curated_variants(self) -> None:
        config = (
            Path(__file__).resolve().parents[1]
            / "oreo/ArtworkSource/oreo-cursors/generator/colours.conf"
        )
        palettes = oreo_recipe.parse_oreo_palettes(config)
        self.assertEqual(
            set(palettes),
            {row[0] for row in oreo_recipe.OREO_VARIANTS},
        )
        self.assertEqual(palettes["white"].label, "#424242")
        self.assertEqual(palettes["spark_lite"].background, "#FEFEFE")
        self.assertEqual(palettes["black"].shadow_opacity, "0.3")

    def test_python_generation_is_byte_identical_to_upstream_ruby_output(self) -> None:
        source = (
            Path(__file__).resolve().parents[1]
            / "oreo/ArtworkSource/oreo-cursors"
        )
        with tempfile.TemporaryDirectory() as temporary:
            generated = oreo_recipe.prepare_oreo_source(
                source,
                Path(temporary) / "oreo",
            )
            count = 0
            for variant, _label in oreo_recipe.OREO_VARIANTS:
                expected = source / "src" / f"oreo_{variant}_cursors"
                actual = generated / "src" / f"oreo_{variant}_cursors"
                for path in actual.glob("*.svg"):
                    count += 1
                    self.assertEqual(
                        path.read_bytes(),
                        (expected / path.name).read_bytes(),
                        f"{variant}/{path.name}",
                    )
            self.assertEqual(count, 2945)


if __name__ == "__main__":
    unittest.main()
