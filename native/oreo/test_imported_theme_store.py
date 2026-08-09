"""Native integration tests for the fixed imported-pack store."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import plistlib
import pwd
import shutil
import struct
import subprocess
import tempfile
import textwrap
import unittest
import uuid
import zlib


NATIVE_ROOT = pathlib.Path(__file__).parent
ENGINE_SOURCE = NATIVE_ROOT / "Sources" / "OreoCursorEngine.m"
ENGINE_HEADER = NATIVE_ROOT / "Sources" / "OreoCursorEngine.h"
BASE_CURSOR = NATIVE_ROOT / "Resources" / "Themes" / "OreoWhite.cursor"


class ImportedThemeStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._build_directory = pathlib.Path(tempfile.mkdtemp())
        harness_source = cls._build_directory / "ImportedThemeHarness.m"
        harness_source.write_text(
            textwrap.dedent(
                """
                #import <Foundation/Foundation.h>
                #import "OreoCursorEngine.h"

                NSUInteger OreoCursorTestingSnapshotPreparation(
                    BOOL snapshotExists, BOOL effective, BOOL activeBootCurrent);
                NSUInteger OreoCursorTestingSnapshotRestore(
                    BOOL snapshotExists, BOOL effective, BOOL activeBootCurrent);
                NSUInteger OreoCursorTestingImportedValidationCount(void);
                void OreoCursorTestingResetImportedValidationCount(void);

                static void PrintJSON(id object) {
                    NSData *data = [NSJSONSerialization
                        dataWithJSONObject:object options:0 error:NULL];
                    fwrite(data.bytes, 1, data.length, stdout);
                    fputc('\\n', stdout);
                }

                int main(int argc, const char **argv) {
                    @autoreleasepool {
                        if (argc == 2 && strcmp(argv[1], "policy") == 0) {
                            PrintJSON(@{
                                @"preparation": @[
                                    @(OreoCursorTestingSnapshotPreparation(
                                        NO, NO, NO)),
                                    @(OreoCursorTestingSnapshotPreparation(
                                        YES, NO, NO)),
                                    @(OreoCursorTestingSnapshotPreparation(
                                        YES, YES, NO)),
                                    @(OreoCursorTestingSnapshotPreparation(
                                        YES, NO, YES)),
                                    @(OreoCursorTestingSnapshotPreparation(
                                        NO, YES, NO)),
                                    @(OreoCursorTestingSnapshotPreparation(
                                        NO, NO, YES)),
                                ],
                                @"restore": @[
                                    @(OreoCursorTestingSnapshotRestore(
                                        NO, NO, NO)),
                                    @(OreoCursorTestingSnapshotRestore(
                                        YES, NO, NO)),
                                    @(OreoCursorTestingSnapshotRestore(
                                        YES, YES, NO)),
                                    @(OreoCursorTestingSnapshotRestore(
                                        YES, NO, YES)),
                                    @(OreoCursorTestingSnapshotRestore(
                                        NO, YES, NO)),
                                    @(OreoCursorTestingSnapshotRestore(
                                        NO, NO, YES)),
                                ],
                            });
                            return 0;
                        }
                        if (argc == 2 && strcmp(argv[1], "list") == 0) {
                            PrintJSON([OreoCursorEngine availableThemes]);
                            return 0;
                        }
                        if (argc == 2 &&
                            strcmp(argv[1], "cached-list") == 0) {
                            [OreoCursorEngine availableThemes];
                            OreoCursorTestingResetImportedValidationCount();
                            NSArray *themes = [OreoCursorEngine availableThemes];
                            PrintJSON(@{
                                @"themeCount": @(themes.count),
                                @"fullValidationCount":
                                    @(OreoCursorTestingImportedValidationCount()),
                            });
                            return 0;
                        }
                        if (argc == 3 && strcmp(argv[1], "resource") == 0) {
                            NSString *identifier =
                                [NSString stringWithUTF8String:argv[2]];
                            NSError *error = nil;
                            NSData *data = [OreoCursorEngine
                                themeResourceDataForIdentifier:identifier
                                                               error:&error];
                            PrintJSON(@{
                                @"found": @(data != nil),
                                @"length": @(data.length),
                                @"error": error.localizedDescription ?: @"",
                            });
                            return data ? 0 : 2;
                        }
                        if (argc == 3 && strcmp(argv[1], "preview") == 0) {
                            NSString *identifier =
                                [NSString stringWithUTF8String:argv[2]];
                            NSDictionary *selected = nil;
                            for (NSDictionary *theme in
                                     [OreoCursorEngine availableThemes]) {
                                if ([theme[@"Identifier"]
                                        isEqualToString:identifier]) {
                                    selected = theme;
                                    break;
                                }
                            }
                            NSURL *preview = [OreoCursorEngine
                                themePreviewURLForTheme:selected ?: @{}];
                            PrintJSON(@{
                                @"found": @(preview != nil),
                                @"path": preview.path ?: @"",
                            });
                            return preview ? 0 : 2;
                        }
                    }
                    return 64;
                }
                """
            ),
            encoding="utf-8",
        )
        cls._harness = cls._build_directory / "ImportedThemeHarness"
        sdk_path = subprocess.check_output(
            ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"],
            text=True,
        ).strip()
        subprocess.run(
            [
                "/usr/bin/xcrun",
                "--sdk",
                "macosx",
                "clang",
                "-isysroot",
                sdk_path,
                "-mmacosx-version-min=13.0",
                "-fobjc-arc",
                "-fblocks",
                "-fmodules",
                "-DOREO_CURSOR_ENGINE_TESTING=1",
                "-I",
                str(ENGINE_HEADER.parent),
                str(ENGINE_SOURCE),
                str(harness_source),
                "-framework",
                "Cocoa",
                "-framework",
                "ImageIO",
                "-o",
                str(cls._harness),
            ],
            check=True,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls._build_directory)

    def setUp(self) -> None:
        self._temporary_home = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self._temporary_home.name)
        self.imported_root = (
            self.home
            / "Library"
            / "Application Support"
            / "Cursor Atelier"
            / "ImportedPacks"
        )
        self.imported_root.mkdir(parents=True, mode=0o700)
        self.imported_root.parent.chmod(0o700)
        self.imported_root.chmod(0o700)

    def tearDown(self) -> None:
        self._temporary_home.cleanup()

    def _cursor(self, identifier: str) -> tuple[bytes, dict[str, str]]:
        with BASE_CURSOR.open("rb") as handle:
            root = plistlib.load(handle)
        root["Identifier"] = identifier
        root["UUID"] = str(uuid.uuid5(uuid.NAMESPACE_URL, identifier)).upper()
        root["ThemeName"] = f"{identifier} Theme"
        data = plistlib.dumps(root, fmt=plistlib.FMT_BINARY, sort_keys=False)
        resource = f"{identifier}.cursor"
        return data, {
            "Identifier": identifier,
            "DisplayName": f"{identifier} Display",
            "Resource": resource,
            "SHA256": hashlib.sha256(data).hexdigest(),
            "UUID": root["UUID"],
            "ThemeName": root["ThemeName"],
            "Group": "Imported",
        }

    @staticmethod
    def _transparent_png(width: int, height: int) -> bytes:
        def chunk(kind: bytes, payload: bytes) -> bytes:
            return (
                struct.pack(">I", len(payload))
                + kind
                + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
            )

        header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
        row = b"\0" + b"\0" * (width * 4)
        pixels = zlib.compress(row * height, level=9)
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", pixels)
            + chunk(b"IEND", b"")
        )

    def _install(
        self,
        pack_identifier: str,
        theme_identifier: str = "ImportedFixture",
        *,
        write_resource: bool = True,
        write_preview: bool = False,
    ) -> tuple[pathlib.Path, bytes, dict[str, str]]:
        pack = self.imported_root / pack_identifier
        pack.mkdir(mode=0o700)
        data, entry = self._cursor(theme_identifier)
        if write_resource:
            resource = pack / entry["Resource"]
            resource.write_bytes(data)
            resource.chmod(0o600)
        if write_preview:
            preview_name = f"previews/{theme_identifier}/default.png"
            preview = pack / preview_name
            preview.parent.mkdir(parents=True, mode=0o700)
            (pack / "previews").chmod(0o700)
            preview.parent.chmod(0o700)
            preview.write_bytes(self._transparent_png(32, 32))
            preview.chmod(0o600)
            entry["preview"] = preview_name
        manifest = pack / "manifest.json"
        manifest.write_text(
            json.dumps({"schemaVersion": 2, "themes": [entry]}),
            encoding="utf-8",
        )
        manifest.chmod(0o600)
        return pack, data, entry

    def _run(
        self,
        *arguments: str,
        check: bool = True,
        theme_root: pathlib.Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment["HOME"] = str(self.home)
        environment["CFFIXED_USER_HOME"] = str(self.home)
        environment["OREO_TEST_THEME_ROOT"] = str(
            theme_root or (NATIVE_ROOT / "Resources" / "Themes")
        )
        return subprocess.run(
            [str(self._harness), *arguments],
            env=environment,
            text=True,
            capture_output=True,
            check=check,
        )

    def _themes(self) -> list[dict[str, str]]:
        return json.loads(self._run("list").stdout)

    def test_snapshot_ownership_policy_matrix_is_fail_closed(self) -> None:
        policy = json.loads(self._run("policy").stdout)
        # Preparation: create, discard orphan, reuse owned (effective/boot),
        # then reject missing owned state (effective/boot).
        self.assertEqual(policy["preparation"], [0, 1, 2, 2, 3, 3])
        # Restore: inactive is always a no-op, owned state restores only with a
        # snapshot, and missing owned state remains an explicit failure.
        self.assertEqual(policy["restore"], [0, 0, 1, 1, 2, 2])

    def test_builtin_catalog_loader_fails_closed_when_missing_or_invalid(self) -> None:
        self._install("orphaned-pack", "OrphanedFixture")
        for catalog in (None, "{}"):
            with self.subTest(catalog=catalog):
                with tempfile.TemporaryDirectory() as directory:
                    theme_root = pathlib.Path(directory)
                    if catalog is not None:
                        (theme_root / "catalog.json").write_text(catalog)
                    themes = json.loads(
                        self._run("list", theme_root=theme_root).stdout
                    )
                    self.assertEqual(themes, [])

    def test_builtin_catalog_orders_its_declared_default_first(self) -> None:
        source_root = NATIVE_ROOT / "Resources" / "Themes"
        with tempfile.TemporaryDirectory() as directory:
            theme_root = pathlib.Path(directory)
            for resource in source_root.glob("*.cursor"):
                shutil.copy2(resource, theme_root / resource.name)
            catalog = json.loads((source_root / "catalog.json").read_text())
            catalog["defaultThemeId"] = catalog["themes"][1]["nativeThemeId"]
            (theme_root / "catalog.json").write_text(json.dumps(catalog))

            themes = json.loads(self._run("list", theme_root=theme_root).stdout)

            self.assertEqual(themes[0]["Identifier"], catalog["defaultThemeId"])
            engine = ENGINE_SOURCE.read_text(encoding="utf-8")
            selection = engine[
                engine.index(
                    "+ (NSString *)selectedThemeIdentifierForResourceBundle:"
                ) : engine.index(
                    "+ (BOOL)saveSelectedThemeIdentifier:"
                )
            ]
            self.assertIn(
                "OreoThemeSpecifications(resourceBundle).firstObject",
                selection,
            )

    def test_bundled_preview_resolves_to_staged_asset_without_theme_decode(self) -> None:
        source_root = NATIVE_ROOT / "Resources" / "Themes"
        generated_root = NATIVE_ROOT.parent / "cursor-packs" / "generated"
        with tempfile.TemporaryDirectory() as directory:
            theme_root = pathlib.Path(directory)
            for resource in source_root.iterdir():
                if resource.is_file():
                    shutil.copy2(resource, theme_root / resource.name)
            shutil.copy2(generated_root / "manifest.json", theme_root)
            preview_source = generated_root / "previews" / "OreoWhite" / "default.png"
            preview_target = theme_root / "previews" / "OreoWhite" / "default.png"
            preview_target.parent.mkdir(parents=True)
            shutil.copy2(preview_source, preview_target)

            result = json.loads(
                self._run("preview", "OreoWhite", theme_root=theme_root).stdout
            )

            self.assertTrue(result["found"])
            self.assertEqual(pathlib.Path(result["path"]), preview_target)

    def test_imported_preview_resolves_lazily_and_rejects_a_symlink(self) -> None:
        identifier = "ImportedPreviewFixture"
        pack, _, entry = self._install(
            "preview-pack", identifier, write_preview=True
        )
        preview = pack / entry["preview"]

        result = json.loads(self._run("preview", identifier).stdout)

        self.assertTrue(result["found"])
        self.assertEqual(pathlib.Path(result["path"]).resolve(), preview.resolve())

        outside = self.home / "outside-preview.png"
        outside.write_bytes(preview.read_bytes())
        preview.unlink()
        preview.symlink_to(outside)
        rejected = self._run("preview", identifier, check=False)

        self.assertEqual(rejected.returncode, 2)
        self.assertFalse(json.loads(rejected.stdout)["found"])
        self.assertIn(
            identifier,
            {theme["Identifier"] for theme in self._themes()},
        )

    def test_discovers_and_integrity_checks_an_imported_resource(self) -> None:
        pack, data, entry = self._install("fixture-pack")

        imported = [
            theme
            for theme in self._themes()
            if theme["Identifier"] == entry["Identifier"]
        ]
        self.assertEqual(len(imported), 1)
        self.assertEqual(imported[0]["ImportedPackIdentifier"], "fixture-pack")
        resource = json.loads(
            self._run("resource", entry["Identifier"]).stdout
        )
        self.assertTrue(resource["found"])
        self.assertEqual(resource["length"], len(data))

        (pack / entry["Resource"]).write_bytes(data + b"tampered")
        self.assertNotIn(
            entry["Identifier"],
            {theme["Identifier"] for theme in self._themes()},
        )
        rejected = self._run("resource", entry["Identifier"], check=False)
        self.assertEqual(rejected.returncode, 2)

    def test_reuses_validation_receipts_for_unchanged_imports(self) -> None:
        self._install("cached-pack", "CachedFixture")

        result = json.loads(self._run("cached-list").stdout)

        self.assertGreater(result["themeCount"], 0)
        self.assertEqual(result["fullValidationCount"], 0)
        receipt = self.imported_root.parent / "ImportedThemeValidation.json"
        self.assertTrue(receipt.is_file())
        self.assertEqual(receipt.stat().st_mode & 0o077, 0)

    def test_invalidates_a_receipt_when_the_resource_identity_changes(self) -> None:
        pack, data, entry = self._install("changed-pack", "ChangedFixture")
        self._themes()

        (pack / entry["Resource"]).write_bytes(data + b"tampered")
        result = json.loads(self._run("cached-list").stdout)

        self.assertEqual(result["fullValidationCount"], 0)
        self.assertNotIn(
            entry["Identifier"],
            {theme["Identifier"] for theme in self._themes()},
        )

    def test_rejects_resource_manifest_and_pack_symlinks(self) -> None:
        scenarios = ("resource", "manifest", "pack")
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                with tempfile.TemporaryDirectory() as other_home:
                    outside = pathlib.Path(other_home)
                    pack, data, entry = self._install(
                        f"{scenario}-pack", f"{scenario.title()}Fixture"
                    )
                    if scenario == "resource":
                        target = outside / entry["Resource"]
                        target.write_bytes(data)
                        (pack / entry["Resource"]).unlink()
                        (pack / entry["Resource"]).symlink_to(target)
                    elif scenario == "manifest":
                        target = outside / "manifest.json"
                        target.write_bytes((pack / "manifest.json").read_bytes())
                        (pack / "manifest.json").unlink()
                        (pack / "manifest.json").symlink_to(target)
                    else:
                        target = outside / "pack"
                        pack.rename(target)
                        pack.symlink_to(target, target_is_directory=True)
                    self.assertNotIn(
                        entry["Identifier"],
                        {theme["Identifier"] for theme in self._themes()},
                    )

    def test_rejects_resource_escape_and_non_v2_manifest(self) -> None:
        pack, _, entry = self._install("escape-pack", "EscapeFixture")
        entry["Resource"] = "../EscapeFixture.cursor"
        (pack / "manifest.json").write_text(
            json.dumps({"schemaVersion": 2, "themes": [entry]}),
            encoding="utf-8",
        )
        legacy, _, legacy_entry = self._install(
            "legacy-pack", "LegacyFixture"
        )
        (legacy / "manifest.json").write_text(
            json.dumps({"schemaVersion": 1, "themes": [legacy_entry]}),
            encoding="utf-8",
        )
        identifiers = {theme["Identifier"] for theme in self._themes()}
        self.assertNotIn("EscapeFixture", identifiers)
        self.assertNotIn("LegacyFixture", identifiers)

    def test_rejects_a_special_file_without_blocking_on_it(self) -> None:
        pack, _, entry = self._install("fifo-pack", "FifoFixture")
        resource = pack / entry["Resource"]
        resource.unlink()
        os.mkfifo(resource)
        self.assertNotIn(
            entry["Identifier"],
            {theme["Identifier"] for theme in self._themes()},
        )

    def test_accepts_readable_but_non_writable_app_data_parent(self) -> None:
        pack, _, entry = self._install("readable-data", "ReadableDataFixture")
        self.imported_root.parent.chmod(0o755)
        try:
            self.assertIn(
                entry["Identifier"],
                {theme["Identifier"] for theme in self._themes()},
            )
        finally:
            self.imported_root.parent.chmod(0o700)

    def test_directory_quota_excludes_only_exact_transaction_entries(self) -> None:
        _, _, entry = self._install("quota-fixture", "QuotaFixture")
        prefixes = ("import", "metadata", "delete")
        for prefix in prefixes:
            for index in range(513):
                transaction = self.imported_root / (
                    f".{prefix}-Aa{index:04d}"
                )
                transaction.mkdir(mode=0o700)

        self.assertIn(
            entry["Identifier"],
            {theme["Identifier"] for theme in self._themes()},
        )

        # Exactly 512 near-misses plus the pack exceed the quota. If even one
        # near-miss is incorrectly exempted, the catalogue remains visible.
        invalid_templates = (
            ".metadata-{index:05d}",
            ".metadata-{index:06d}-stale",
            ".metadata-{index:05d}_",
            ".metadatax-{index:06d}",
            ".import-{index:05d}",
            ".delete-{index:06d}x",
            ".other-{index:06d}",
        )
        for index in range(512):
            template = invalid_templates[index % len(invalid_templates)]
            invalid = self.imported_root / template.format(index=index)
            invalid.mkdir(mode=0o700)

        self.assertNotIn(
            entry["Identifier"],
            {theme["Identifier"] for theme in self._themes()},
        )

    def test_rejects_insecure_store_pack_manifest_and_resource_modes(self) -> None:
        scenarios = ("writable-data", "store", "pack", "manifest", "resource")
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                pack, _, entry = self._install(
                    f"public-{scenario}", f"Public{scenario.title()}Fixture"
                )
                targets = {
                    "writable-data": self.imported_root.parent,
                    "store": self.imported_root,
                    "pack": pack,
                    "manifest": pack / "manifest.json",
                    "resource": pack / entry["Resource"],
                }
                target = targets[scenario]
                private_mode = 0o700 if target.is_dir() else 0o600
                public_mode = (
                    0o775
                    if scenario == "writable-data"
                    else (0o755 if target.is_dir() else 0o644)
                )
                target.chmod(public_mode)
                try:
                    self.assertNotIn(
                        entry["Identifier"],
                        {theme["Identifier"] for theme in self._themes()},
                    )
                finally:
                    target.chmod(private_mode)

    def test_rejects_hardlinked_manifest_and_resource_files(self) -> None:
        for scenario in ("manifest", "resource"):
            with self.subTest(scenario=scenario):
                pack, _, entry = self._install(
                    f"hardlink-{scenario}", f"Hardlink{scenario.title()}Fixture"
                )
                source = (
                    pack / "manifest.json"
                    if scenario == "manifest"
                    else pack / entry["Resource"]
                )
                os.link(source, self.home / f"{scenario}-outside")
                self.assertNotIn(
                    entry["Identifier"],
                    {theme["Identifier"] for theme in self._themes()},
                )

    @unittest.skipUnless(os.geteuid() == 0, "Changing file ownership requires root")
    def test_rejects_foreign_owned_store_entries(self) -> None:
        nobody_uid = pwd.getpwnam("nobody").pw_uid
        scenarios = ("data", "store", "pack", "manifest", "resource")
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                pack, _, entry = self._install(
                    f"foreign-{scenario}", f"Foreign{scenario.title()}Fixture"
                )
                targets = {
                    "data": self.imported_root.parent,
                    "store": self.imported_root,
                    "pack": pack,
                    "manifest": pack / "manifest.json",
                    "resource": pack / entry["Resource"],
                }
                target = targets[scenario]
                os.chown(target, nobody_uid, -1)
                try:
                    self.assertNotIn(
                        entry["Identifier"],
                        {theme["Identifier"] for theme in self._themes()},
                    )
                finally:
                    os.chown(target, os.geteuid(), -1)

    def test_excludes_hash_valid_structurally_invalid_cursor(self) -> None:
        for scenario in ("missing-role", "invalid-png"):
            with self.subTest(scenario=scenario):
                identifier = f"Malformed{scenario.title().replace('-', '')}Fixture"
                pack, _, entry = self._install(
                    f"malformed-{scenario}", identifier
                )
                resource = pack / entry["Resource"]
                with resource.open("rb") as handle:
                    root = plistlib.load(handle)
                if scenario == "missing-role":
                    root["Cursors"].pop(next(iter(root["Cursors"])))
                else:
                    cursor = root["Cursors"][next(iter(root["Cursors"]))]
                    cursor["Representations"][0] = b"\x89PNG\r\n\x1a\ninvalid!"
                malformed = plistlib.dumps(
                    root, fmt=plistlib.FMT_BINARY, sort_keys=False
                )
                resource.write_bytes(malformed)
                resource.chmod(0o600)
                entry["SHA256"] = hashlib.sha256(malformed).hexdigest()
                manifest = pack / "manifest.json"
                manifest.write_text(
                    json.dumps({"schemaVersion": 2, "themes": [entry]}),
                    encoding="utf-8",
                )
                manifest.chmod(0o600)

                self.assertNotIn(
                    entry["Identifier"],
                    {theme["Identifier"] for theme in self._themes()},
                )

    def test_rejects_theme_exceeding_aggregate_decoded_image_budget(self) -> None:
        identifier = "AggregateBudgetFixture"
        pack, _, entry = self._install("aggregate-budget", identifier)
        resource = pack / entry["Resource"]
        with resource.open("rb") as handle:
            root = plistlib.load(handle)

        def install_with_points(points: int) -> bytes:
            representations = [
                self._transparent_png(scale * points, scale * points)
                for scale in (1, 2, 3)
            ]
            for cursor in root["Cursors"].values():
                cursor.update(
                    {
                        "FrameCount": 1,
                        "FrameDuration": 1.0,
                        "HotSpotX": 0.0,
                        "HotSpotY": 0.0,
                        "PointsHigh": float(points),
                        "PointsWide": float(points),
                        "Representations": representations,
                    }
                )
            data = plistlib.dumps(
                root, fmt=plistlib.FMT_BINARY, sort_keys=False
            )
            resource.write_bytes(data)
            resource.chmod(0o600)
            entry["SHA256"] = hashlib.sha256(data).hexdigest()
            manifest = pack / "manifest.json"
            manifest.write_text(
                json.dumps({"schemaVersion": 2, "themes": [entry]}),
                encoding="utf-8",
            )
            manifest.chmod(0o600)
            return data

        control = install_with_points(128)
        self.assertLess(len(control), 32 * 1024 * 1024)
        self.assertIn(
            identifier,
            {theme["Identifier"] for theme in self._themes()},
        )

        oversized = install_with_points(256)
        self.assertLess(len(oversized), 32 * 1024 * 1024)
        self.assertNotIn(
            identifier,
            {theme["Identifier"] for theme in self._themes()},
        )

    def test_bundled_identifiers_take_precedence(self) -> None:
        pack = self.imported_root / "collision-pack"
        pack.mkdir(mode=0o700)
        data = BASE_CURSOR.read_bytes()
        with BASE_CURSOR.open("rb") as handle:
            root = plistlib.load(handle)
        entry = {
            "Identifier": root["Identifier"],
            "DisplayName": "Malicious replacement",
            "Resource": "OreoWhite.cursor",
            "SHA256": hashlib.sha256(data).hexdigest(),
            "UUID": root["UUID"],
            "ThemeName": root["ThemeName"],
            "Group": "Imported",
        }
        resource = pack / entry["Resource"]
        resource.write_bytes(data)
        resource.chmod(0o600)
        manifest = pack / "manifest.json"
        manifest.write_text(
            json.dumps({"schemaVersion": 2, "themes": [entry]}),
            encoding="utf-8",
        )
        manifest.chmod(0o600)

        matches = [
            theme
            for theme in self._themes()
            if theme["Identifier"] == "OreoWhite"
        ]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["DisplayName"], "White")
        self.assertNotIn("ImportedPackIdentifier", matches[0])

    def test_identifier_precedence_is_case_insensitive(self) -> None:
        self._install("bundled-case-collision", "oreowhite")
        self._install("a-imported-case", "ImportedCaseFixture")
        self._install("b-imported-case", "importedcasefixture")

        themes = self._themes()
        bundled_matches = [
            theme
            for theme in themes
            if theme["Identifier"].lower() == "oreowhite"
        ]
        self.assertEqual(len(bundled_matches), 1)
        self.assertEqual(bundled_matches[0]["Identifier"], "OreoWhite")
        self.assertNotIn("ImportedPackIdentifier", bundled_matches[0])

        imported_matches = [
            theme
            for theme in themes
            if theme["Identifier"].lower() == "importedcasefixture"
        ]
        self.assertEqual(len(imported_matches), 1)
        self.assertEqual(
            imported_matches[0]["ImportedPackIdentifier"], "a-imported-case"
        )

    def test_rejects_a_second_pack_with_the_same_imported_identifier(self) -> None:
        self._install("a-pack", "DuplicateFixture")
        self._install("b-pack", "DuplicateFixture")
        matches = [
            theme
            for theme in self._themes()
            if theme["Identifier"] == "DuplicateFixture"
        ]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["ImportedPackIdentifier"], "a-pack")

    def test_login_helper_uses_the_shared_import_aware_initializer(self) -> None:
        helper = (
            NATIVE_ROOT / "HelperSources" / "OreoLoginHelperMain.m"
        ).read_text(encoding="utf-8")
        self.assertIn(
            "selectedThemeIdentifierForResourceBundle:self.hostBundle",
            helper,
        )
        engine = ENGINE_SOURCE.read_text(encoding="utf-8")
        initializer = engine[
            engine.index("- (instancetype)initWithThemeIdentifier:") :
            engine.index("- (void)failWithError:")
        ]
        self.assertIn(
            "OreoThemeSpecificationForBundle(themeIdentifier,",
            initializer,
        )
        validation = engine[
            engine.index("- (BOOL)loadAndValidateTheme:") :
            engine.index("- (NSDictionary *)validatedThemeCursor:")
        ]
        self.assertIn("OreoThemeResourceData(_themeSpecification,", validation)
        self.assertIn(
            "OreoDecodedThemeCursors(data, _themeSpecification, error)",
            validation,
        )
        shared_decoder = engine[
            engine.rindex("OreoDecodedThemeCursors(NSData *data") :
            engine.index("- (BOOL)writePropertyList:")
        ]
        self.assertIn(
            "cursors.count != OreoExplicitThemeIdentifiers().count",
            shared_decoder,
        )


if __name__ == "__main__":
    unittest.main()
