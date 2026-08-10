"""Native CLI integration coverage for portable cursor preferences."""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import textwrap
import unittest
import uuid


NATIVE_ROOT = pathlib.Path(__file__).parent
SOURCE_ROOT = NATIVE_ROOT / "Sources"
ENGINE_SOURCE = SOURCE_ROOT / "OreoCursorEngine.m"
CONTROLLER_SOURCE = SOURCE_ROOT / "OreoAppController.m"


@unittest.skipUnless(os.uname().sysname == "Darwin", "macOS native CLI test")
class PortablePreferencesCLITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._build_directory = pathlib.Path(tempfile.mkdtemp())
        harness_source = cls._build_directory / "PortablePreferencesCLI.m"
        harness_source.write_text(
            textwrap.dedent(
                """
                #import <Foundation/Foundation.h>
                #import "OreoAppController.h"
                #import "OreoCursorEngine.h"
                #include <stdlib.h>

                static void PrintJSON(id object) {
                    NSData *data = [NSJSONSerialization
                        dataWithJSONObject:object options:0 error:NULL];
                    fwrite(data.bytes, 1, data.length, stdout);
                    fputc('\\n', stdout);
                }

                int main(int argc, const char **argv) {
                    @autoreleasepool {
                        NSUserDefaults *defaults = OreoCursorDefaults();
                        if (getenv("OREO_CURSOR_TEST_FORCE_ACTIVE")) {
                            [defaults setBool:YES
                                      forKey:OreoCursorEnabledDefaultsKey];
                            [defaults synchronize];
                        }
                        if (argc == 2 &&
                            strcmp(argv[1], "--test-defaults") == 0) {
                            PrintJSON(@{
                                @"desiredEnabled": @([defaults boolForKey:
                                    OreoCursorEnabledDefaultsKey]),
                                @"effectiveApplied": @([defaults boolForKey:
                                    OreoCursorEffectiveDefaultsKey]),
                            });
                            return 0;
                        }
                        return OreoRunCommandLineIfRequested(argc, argv);
                    }
                }
                """
            ),
            encoding="utf-8",
        )
        cls._harness = cls._build_directory / "PortablePreferencesCLI"
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
                str(SOURCE_ROOT),
                str(ENGINE_SOURCE),
                str(CONTROLLER_SOURCE),
                str(harness_source),
                "-framework",
                "Cocoa",
                "-framework",
                "ServiceManagement",
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
        self.defaults_domain = (
            "com.cursoratelier.CursorAtelier.NativeCursor.Tests."
            f"{uuid.uuid4().hex}"
        )

    def tearDown(self) -> None:
        self._temporary_home.cleanup()

    def _run(
        self, *arguments: str, force_active: bool = False
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.update(
            {
                "HOME": str(self.home),
                "CFFIXED_USER_HOME": str(self.home),
                "OREO_CURSOR_TEST_DEFAULTS_DOMAIN": self.defaults_domain,
                "OREO_TEST_THEME_ROOT": str(
                    NATIVE_ROOT / "Resources" / "Themes"
                ),
            }
        )
        if force_active:
            environment["OREO_CURSOR_TEST_FORCE_ACTIVE"] = "1"
        return subprocess.run(
            [str(self._harness), *arguments],
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )

    def _json(self, *arguments: str, force_active: bool = False) -> dict:
        result = self._run(*arguments, force_active=force_active)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_replace_and_reset_never_enable_or_apply_a_cursor(self) -> None:
        document = json.dumps(
            {
                "schemaVersion": 1,
                "selectedThemeIdentifier": "OreoWhite",
                "themeSizePercentages": {"OreoWhite": 150},
            },
            separators=(",", ":"),
        )
        replaced = self._json("--replace-portable-preferences", document)
        self.assertTrue(replaced["replaced"])
        self.assertEqual(
            self._json("--portable-preferences"),
            {
                "schemaVersion": 1,
                "selectedThemeIdentifier": "OreoWhite",
                "themeSizePercentages": {"OreoWhite": 150},
            },
        )
        self.assertEqual(
            self._json("--test-defaults"),
            {"desiredEnabled": False, "effectiveApplied": False},
        )
        data_root = (
            self.home
            / "Library"
            / "Application Support"
            / "Cursor Atelier"
        )
        self.assertFalse((data_root / "StockSnapshot.plist").exists())
        self.assertFalse((data_root / "Transaction.plist").exists())

        reset = self._json("--reset-preferences")
        self.assertTrue(reset["reset"])
        self.assertEqual(
            self._json("--portable-preferences"),
            {
                "schemaVersion": 1,
                "selectedThemeIdentifier": None,
                "themeSizePercentages": {},
            },
        )
        self.assertEqual(
            self._json("--test-defaults"),
            {"desiredEnabled": False, "effectiveApplied": False},
        )

    def test_replace_and_reset_refuse_active_native_state(self) -> None:
        document = json.dumps(
            {
                "schemaVersion": 1,
                "selectedThemeIdentifier": None,
                "themeSizePercentages": {},
            },
            separators=(",", ":"),
        )
        replace = self._run(
            "--replace-portable-preferences",
            document,
            force_active=True,
        )
        self.assertEqual(replace.returncode, 2, replace.stderr)
        self.assertFalse(json.loads(replace.stdout)["replaced"])

        reset = self._run("--reset-preferences", force_active=True)
        self.assertEqual(reset.returncode, 2, reset.stderr)
        self.assertFalse(json.loads(reset.stdout)["reset"])


if __name__ == "__main__":
    unittest.main()
