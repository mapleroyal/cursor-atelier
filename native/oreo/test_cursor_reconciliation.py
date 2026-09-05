"""Native state transitions with cursor registration replaced by a recorder.

These tests compile the real engine on macOS but never change desktop cursors.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest
import uuid


NATIVE_ROOT = pathlib.Path(__file__).resolve().parent


@unittest.skipUnless(sys.platform == "darwin", "Requires the macOS Cocoa SDK")
class CursorReconciliationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.build = tempfile.TemporaryDirectory()
        source = pathlib.Path(cls.build.name) / "ReconciliationHarness.m"
        source.write_text(
            textwrap.dedent(
                r'''
                #import "OreoCursorEngine.m"

                static NSUInteger resets;
                static NSInteger recordedSize;
                static BOOL operationLockHeld;

                @interface StateOnlyEngine : OreoCursorEngine
                @end
                @implementation StateOnlyEngine
                - (BOOL)loadPrivateAPI:(NSError **)error {
                    (void)error;
                    return YES;
                }
                - (BOOL)loadAndValidateTheme:(NSError **)error {
                    (void)error;
                    return YES;
                }
                - (void)bestEffortSystemReset { resets++; }
                @end

                @interface RecordingEngine : StateOnlyEngine
                @end
                @implementation RecordingEngine
                - (BOOL)applyLocked:(NSError **)error {
                    NSURL *url = [self valueForKey:@"operationLockURL"];
                    int descriptor = open(url.fileSystemRepresentation, O_RDWR);
                    operationLockHeld = descriptor >= 0 &&
                        flock(descriptor, LOCK_EX | LOCK_NB) != 0 &&
                        errno == EWOULDBLOCK;
                    if (descriptor >= 0) { close(descriptor); }
                    recordedSize = self.themeSizePercentage;
                    return [self persistAppliedState:error];
                }
                - (BOOL)refreshIfNeededLocked:(NSError **)error {
                    return [self applyLocked:error];
                }
                @end

                static OreoCursorEngine *Engine(Class cls, NSString *identifier,
                                                 NSInteger size) {
                    OreoCursorEngine *engine = [[cls alloc] initWithThemeIdentifier:identifier
                        resourceBundle:NSBundle.mainBundle
                        sizePercentage:size error:NULL];
                    NSURL *data = [engine valueForKey:@"dataDirectoryURL"];
                    NSURL *home = [NSURL fileURLWithPath:
                        [NSString stringWithUTF8String:getenv("CFFIXED_USER_HOME")]];
                    NSString *prefix = [home.URLByResolvingSymlinksInPath.path
                        stringByAppendingString:@"/"];
                    if (![data.URLByResolvingSymlinksInPath.path hasPrefix:prefix]) {
                        fprintf(stderr, "Test data directory is not isolated.\n");
                        exit(70);
                    }
                    return engine;
                }

                int main(int argc, const char **argv) {
                    @autoreleasepool {
                        if (argc != 4) { return 64; }
                        NSUserDefaults *defaults = OreoCursorDefaults();
                        NSString *mode = [NSString stringWithUTF8String:argv[1]];
                        NSString *scenario = [NSString stringWithUTF8String:argv[2]];
                        NSString *artifact = [NSString stringWithUTF8String:argv[3]];
                        [defaults setObject:@"OreoWhite"
                                     forKey:OreoCursorThemeDefaultsKey];
                        NSError *error = nil;
                        BOOL success;
                        OreoCursorEngine *engine;
                        BOOL replaced = NO;
                        if ([mode isEqualToString:@"helper"]) {
                            engine = Engine(RecordingEngine.class, @"OreoWhite", 100);
                            [defaults setObject:@{@"OreoWhite": @150}
                                         forKey:@"ThemeSizePercentages"];
                            if ([scenario isEqualToString:@"disabled"]) {
                                [defaults setBool:NO forKey:OreoCursorEnabledDefaultsKey];
                                [defaults setBool:NO forKey:OreoCursorEffectiveDefaultsKey];
                                [defaults synchronize];
                            } else {
                                NSString *identifier =
                                    [scenario isEqualToString:@"theme"]
                                        ? @"OreoBlue" : @"OreoWhite";
                                OreoCursorEngine *command =
                                    Engine(RecordingEngine.class, identifier, 150);
                                if (![command apply:&error]) { return 2; }
                            }
                            recordedSize = 0;
                            OreoCursorEngine *current =
                                [engine reconcileSelectedTheme:NULL error:&error];
                            success = current != nil;
                            replaced = current && current != engine;
                            if (current) { engine = current; }
                        } else {
                            engine = Engine(StateOnlyEngine.class, @"OreoWhite", 100);
                            [defaults setBool:NO forKey:OreoCursorEnabledDefaultsKey];
                            [defaults setBool:YES forKey:OreoCursorEffectiveDefaultsKey];
                            if (![scenario isEqualToString:@"unknown"]) {
                                [defaults setObject:
                                    ([scenario isEqualToString:@"current"]
                                        ? engine.bootSessionUUID
                                        : [scenario isEqualToString:@"malformed"]
                                            ? @"invalid boot identity"
                                            : @"00000000-0000-4000-8000-000000000000")
                                             forKey:@"ActiveBootSessionUUID"];
                            }
                            [defaults synchronize];
                            if ([artifact isEqualToString:@"corrupt"]) {
                                NSURL *snapshot = [engine valueForKey:@"snapshotURL"];
                                [@"invalid snapshot" writeToURL:snapshot atomically:YES
                                    encoding:NSUTF8StringEncoding error:NULL];
                                chmod(snapshot.fileSystemRepresentation, 0600);
                            }
                            success = [engine restore:&error];
                        }
                        NSDictionary *result = @{
                            @"success": @(success),
                            @"effective": @([defaults boolForKey:OreoCursorEffectiveDefaultsKey]),
                            @"desired": @([defaults boolForKey:OreoCursorEnabledDefaultsKey]),
                            @"selected": [defaults stringForKey:OreoCursorThemeDefaultsKey] ?: @"",
                            @"effectiveSize": @([OreoCursorEngine effectiveSizePercentage]),
                            @"engineSize": @(engine.themeSizePercentage),
                            @"engineReplaced": @(replaced),
                            @"recordedSize": @(recordedSize),
                            @"operationLockHeld": @(operationLockHeld),
                            @"resets": @(resets),
                            @"activeBoot": [defaults stringForKey:@"ActiveBootSessionUUID"] ?: @"",
                            @"error": error.localizedDescription ?: @"",
                        };
                        NSData *json = [NSJSONSerialization
                            dataWithJSONObject:result options:0 error:NULL];
                        fwrite(json.bytes, 1, json.length, stdout);
                        fputc('\n', stdout);
                        return 0;
                    }
                }
                '''
            ),
            encoding="utf-8",
        )
        cls.harness = pathlib.Path(cls.build.name) / "ReconciliationHarness"
        subprocess.run(
            [
                "/usr/bin/xcrun", "--sdk", "macosx", "clang",
                "-mmacosx-version-min=13.0", "-fobjc-arc", "-fblocks", "-fmodules",
                "-DOREO_CURSOR_ENGINE_TESTING=1", "-I", str(NATIVE_ROOT / "Sources"),
                str(source), "-framework", "Cocoa", "-framework", "ImageIO",
                "-o", str(cls.harness),
            ],
            check=True,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.build.cleanup()

    def run_scenario(self, mode: str, scenario: str, artifact="missing") -> dict:
        with tempfile.TemporaryDirectory() as home:
            environment = {
                **os.environ,
                "CFFIXED_USER_HOME": home,
                "OREO_TEST_THEME_ROOT": str(NATIVE_ROOT / "Resources" / "Themes"),
                "OREO_CURSOR_TEST_DEFAULTS_DOMAIN":
                    f"com.cursoratelier.CursorAtelier.NativeCursor.Tests.{uuid.uuid4()}",
            }
            result = subprocess.run(
                [str(self.harness), mode, scenario, artifact],
                env=environment, text=True, capture_output=True, check=True,
            )
            return json.loads(result.stdout)

    def test_helper_honors_newer_size_and_selection(self) -> None:
        for scenario, selected in [("size", "OreoWhite"), ("theme", "OreoBlue")]:
            with self.subTest(scenario=scenario):
                result = self.run_scenario("helper", scenario)
                self.assertTrue(result["success"])
                self.assertTrue(result["engineReplaced"])
                self.assertTrue(result["operationLockHeld"])
                self.assertEqual(result["recordedSize"], 150)
                self.assertEqual(result["effectiveSize"], 150)
                self.assertEqual(result["selected"], selected)

    def test_helper_does_not_reenable_after_a_newer_disable(self) -> None:
        result = self.run_scenario("helper", "disabled")
        self.assertTrue(result["success"])
        self.assertFalse(result["effective"])
        self.assertFalse(result["desired"])
        self.assertEqual(result["recordedSize"], 0)
        self.assertEqual(result["resets"], 0)

    def test_reboot_clears_failed_restore_without_reading_old_snapshot(self) -> None:
        for artifact in ["missing", "corrupt"]:
            with self.subTest(artifact=artifact):
                result = self.run_scenario("restore", "previous", artifact)
                self.assertTrue(result["success"])
                self.assertFalse(result["effective"])
                self.assertFalse(result["desired"])
                self.assertEqual(result["activeBoot"], "")
                self.assertEqual(result["resets"], 0)

    def test_current_or_unknown_boot_preserves_failed_restore_ownership(self) -> None:
        for scenario in ["current", "unknown", "malformed"]:
            for artifact in ["missing", "corrupt"]:
                with self.subTest(scenario=scenario, artifact=artifact):
                    result = self.run_scenario("restore", scenario, artifact)
                    self.assertFalse(result["success"])
                    self.assertTrue(result["effective"])
                    self.assertFalse(result["desired"])
                    self.assertEqual(result["resets"], 1)


if __name__ == "__main__":
    unittest.main()
