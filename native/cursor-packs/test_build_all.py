"""High-signal inventory checks for the pinned upstream variant set."""

from __future__ import annotations

import collections
import json
import unittest
from pathlib import Path

import build_all
import converter
from converter import parse_xcursor


class BuildInventoryTests(unittest.TestCase):
    def test_every_pinned_variant_is_a_distinct_job(self) -> None:
        jobs = build_all._jobs()
        counts = collections.Counter(job.family for job in jobs)
        self.assertEqual(counts["Bibata"], 12)
        self.assertEqual(counts["Bibata Extra"], 8)
        self.assertEqual(counts["Google"], 4)
        self.assertEqual(counts["Simp1e"], 25)
        self.assertEqual(counts["Nordzy"], 133)
        self.assertEqual(counts["Moga"], 16)
        self.assertEqual(counts["Future"], 2)
        identifiers = [job.identifier for job in jobs]
        self.assertEqual(len(identifiers), len(set(identifiers)))
        self.assertEqual(len(identifiers), 221)
        self.assertEqual(
            build_all._identifier_digest(identifiers),
            build_all.EXPECTED_EXTERNAL_IDENTIFIER_SHA256,
        )

    def test_builtin_inventory_is_an_exact_set(self) -> None:
        catalog = json.loads(
            (
                Path(__file__).resolve().parents[1]
                / "oreo/Resources/Themes/catalog.json"
            ).read_text()
        )
        built_in_identifiers = {
            theme["nativeThemeId"] for theme in catalog["themes"]
        }
        self.assertEqual(len(built_in_identifiers), 19)
        unified = [job.identifier for job in build_all._jobs()]
        unified.extend(built_in_identifiers)
        self.assertEqual(len(unified), 240)
        self.assertEqual(
            build_all._identifier_digest(unified),
            build_all.EXPECTED_UNIFIED_IDENTIFIER_SHA256,
        )

    def test_representative_variant_metadata_is_human_facing(self) -> None:
        jobs = {job.identifier: job for job in build_all._jobs()}
        expected = {
            "MogaClassic": ("Moga Classic Black", "Classic Black"),
            "BibataModernAmber": ("Bibata Modern Amber", "Modern Amber"),
            "BibataExtraModernDarkRed": (
                "Bibata Extra Modern Dark Red",
                "Modern Dark Red",
            ),
            "NordzyCatppuccinFrappeBlue": (
                "Nordzy Catppuccin Frappé Blue",
                "Catppuccin Frappé Blue",
            ),
            "Simp1eAdwDark": ("Simp1e Adwaita Dark", "Adwaita Dark"),
        }
        for identifier, metadata in expected.items():
            self.assertEqual(build_all._variant_metadata(jobs[identifier]), metadata)

    def test_nordzy_uses_native_xcursor_tiers(self) -> None:
        jobs = [job for job in build_all._jobs() if job.family == "Nordzy"]
        self.assertEqual(len(jobs), 133)
        for job in jobs:
            self.assertEqual(job.source.name, "cursors")
            self.assertEqual(job.source.parent.parent.name, "xcursors")

        # Upstream publishes the default artwork under both legacy Cape names,
        # but only one authoritative Xcursor package.
        by_identifier = {job.identifier: job for job in jobs}
        self.assertEqual(by_identifier["Nordzy"].source, by_identifier["NordzyCursors"].source)

        source = by_identifier["Nordzy"].source
        arrow_frames = parse_xcursor(source / "left_ptr")
        self.assertEqual([frame.image.width for frame in arrow_frames], [24, 32, 48, 64, 96])
        arrow_32 = next(frame for frame in arrow_frames if frame.image.width == 32)
        self.assertEqual((arrow_32.hotspot_x, arrow_32.hotspot_y), (4, 3))

        for role, expected_hotspot in (("wait", (16, 16)), ("progress", (4, 3))):
            frames = parse_xcursor(source / role)
            frames_32 = [frame for frame in frames if frame.image.width == 32]
            self.assertEqual(len(frames_32), 16)
            self.assertEqual(
                {(frame.hotspot_x, frame.hotspot_y) for frame in frames_32},
                {expected_hotspot},
            )

        bindings = converter._role_bindings(converter._frames_from_xcursor(source))
        self.assertFalse(
            [identifier for identifier, binding in bindings.items() if binding[2]]
        )

    def test_simp1e_palette_colors_are_validated_and_normalized(self) -> None:
        schemes = Path(build_all._repo("simp1e", "src", "color_schemes"))
        for filename, spinner_background in (
            ("Simp1e-Rose-Pine.txt", "191724"),
            ("Simp1e-Rose-Pine-Moon.txt", "232136"),
            ("Simp1e-Rose-Pine-Dawn.txt", "faf4ed"),
        ):
            values = build_all._simp1e_scheme(schemes / filename)
            self.assertEqual(values["spinner_bg"], spinner_background)

    def test_build_config_aliases_complete_google_and_bibata_roles(self) -> None:
        configs = (
            Path(build_all._repo("google-cursor", "build.toml")),
            Path(
                build_all._repo(
                    "Bibata_Cursor", "configs", "normal", "x.build.toml"
                )
            ),
        )
        required_roles = {role for role in converter.MAC_TO_ROLE.values() if role}
        for config in configs:
            self.assertFalse(required_roles - set(converter.parse_build_config(config)))


if __name__ == "__main__":
    unittest.main()
