import hashlib
import json
import plistlib
import unittest
from pathlib import Path


NATIVE_ROOT = Path(__file__).resolve().parent
THEMES_ROOT = NATIVE_ROOT / "Resources" / "Themes"
CATALOG_PATH = THEMES_ROOT / "catalog.json"
UNIFIED_MANIFEST_PATH = (
    NATIVE_ROOT.parent / "cursor-packs" / "generated" / "manifest.json"
)


class BuiltInCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(CATALOG_PATH.read_text())

    def test_catalog_is_the_complete_unique_builtin_inventory(self):
        themes = self.catalog["themes"]
        self.assertEqual(self.catalog["schemaVersion"], 1)
        self.assertIn(
            self.catalog["defaultThemeId"],
            {theme["nativeThemeId"] for theme in themes},
        )
        self.assertEqual(len(themes), 19)
        self.assertEqual(
            {theme["resourceFile"] for theme in themes},
            {path.name for path in THEMES_ROOT.glob("*.cursor")},
        )
        self.assertEqual(len({theme["id"] for theme in themes}), 19)
        self.assertEqual(len({theme["nativeThemeId"] for theme in themes}), 19)

    def test_catalog_identity_matches_each_cursor_resource(self):
        for theme in self.catalog["themes"]:
            with self.subTest(theme=theme["nativeThemeId"]):
                data = (THEMES_ROOT / theme["resourceFile"]).read_bytes()
                cursor = plistlib.loads(data)
                self.assertEqual(hashlib.sha256(data).hexdigest(), theme["sha256"])
                self.assertEqual(cursor["Identifier"], theme["nativeThemeId"])
                self.assertEqual(cursor["ThemeName"], theme["plistName"])
                self.assertEqual(cursor["UUID"], theme["uuid"])

    def test_generated_manifest_derives_builtin_identity_from_catalog(self):
        generated = json.loads(UNIFIED_MANIFEST_PATH.read_text())
        builtins = {
            theme["Identifier"]: theme
            for theme in generated["themes"]
            if theme["Group"] == self.catalog["family"]
        }
        self.assertEqual(
            set(builtins),
            {theme["nativeThemeId"] for theme in self.catalog["themes"]},
        )
        for theme in self.catalog["themes"]:
            with self.subTest(theme=theme["nativeThemeId"]):
                generated_theme = builtins[theme["nativeThemeId"]]
                self.assertEqual(generated_theme["Resource"], theme["resourceFile"])
                self.assertEqual(generated_theme["SHA256"], theme["sha256"])
                self.assertEqual(generated_theme["UUID"], theme["uuid"])
                self.assertEqual(generated_theme["Variant"], theme["name"])
                self.assertEqual(
                    generated_theme["DisplayName"],
                    f"{self.catalog['family']} {theme['name']}",
                )
                self.assertEqual(generated_theme["Group"], self.catalog["family"])
                self.assertEqual(generated_theme["Author"], self.catalog["author"])
                self.assertEqual(generated_theme["License"], self.catalog["license"])
                self.assertEqual(
                    generated_theme["LicenseURL"], self.catalog["licenseUrl"]
                )
                self.assertEqual(
                    generated_theme["SourceURL"], self.catalog["upstreamUrl"]
                )


if __name__ == "__main__":
    unittest.main()
