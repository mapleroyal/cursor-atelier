"""Focused source contracts for command-line lifecycle transactions."""

from __future__ import annotations

import pathlib
import plistlib
import unittest


CONTROLLER = pathlib.Path(__file__).parent / "Sources" / "OreoAppController.m"
ENGINE = CONTROLLER.parent / "OreoCursorEngine.m"
HELPER = CONTROLLER.parent.parent / "HelperSources" / "OreoLoginHelperMain.m"
BUILD_SCRIPT = CONTROLLER.parent.parent / "build.sh"


class AppControllerContractTests(unittest.TestCase):
    def _function(self, source: str, start: str, end: str) -> str:
        begin = source.index(start)
        return source[begin : source.index(end, begin)]

    def test_failed_teardown_preserves_login_preference(self) -> None:
        source = CONTROLLER.read_text(encoding="utf-8")
        start = source.index('} else if ([command isEqual:@"--teardown"]) {')
        end = source.index(
            '} else if ([command isEqual:@"--select-theme"]) {', start
        )
        teardown = source[start:end]

        capture = "BOOL priorLoginDesired = OreoLoginItemDesired();"
        disable = "OreoSetLoginItemDesired(NO);"
        restore = "success = [engine restore:&actionError];"
        rollback = "OreoSetLoginItemDesired(priorLoginDesired);"
        self.assertLess(teardown.index(capture), teardown.index(disable))
        self.assertLess(teardown.index(disable), teardown.index(restore))
        self.assertIn("if (!success) {", teardown)
        self.assertGreater(teardown.index(rollback), teardown.index(restore))

    def test_failed_theme_switch_reapplies_an_active_prior_theme(self) -> None:
        source = CONTROLLER.read_text(encoding="utf-8")
        apply_theme = self._function(
            source,
            "static BOOL OreoApplyTheme(",
            "int OreoRunCommandLineIfRequested(",
        )
        self.assertNotIn("BOOL cursorRestored = !cursorChanged ||", apply_theme)
        self.assertIn(
            "[candidate recoverInterruptedTransaction:NULL error:&cleanupError]",
            apply_theme,
        )
        self.assertIn(
            "BOOL priorThemeUsable = priorEngine.supported && priorEngine.themeValid;",
            apply_theme,
        )
        self.assertIn(
            "? [priorEngine apply:&cleanupError]\n"
            "            : [candidate restore:&cleanupError]",
            apply_theme,
        )
        self.assertIn(
            "OreoSetLoginItemDesired(priorThemeUsable ? priorLoginDesired : NO);",
            apply_theme,
        )
        self.assertIn(
            "*engine = priorThemeUsable ? priorEngine : candidate;",
            apply_theme,
        )

    def test_replacement_command_can_recover_from_an_invalid_selection(self) -> None:
        source = CONTROLLER.read_text(encoding="utf-8")
        command = self._function(
            source,
            "int OreoRunCommandLineIfRequested(",
            "BOOL approvalRequired =",
        )
        self.assertIn("BOOL replacesSelectedTheme =", command)
        self.assertIn("recoveryEngine = [[OreoCursorEngine alloc]", command)
        self.assertIn("BOOL requiresSelectedTheme =", command)
        self.assertIn(
            "[recoveryEngine recoverInterruptedTransaction:NULL",
            command,
        )

    def test_nested_bundle_identifiers_are_distinct(self) -> None:
        native_root = CONTROLLER.parent.parent
        with (native_root / "Info.plist").open("rb") as handle:
            native_info = plistlib.load(handle)
        with (native_root / "LoginHelper-Info.plist").open("rb") as handle:
            helper_info = plistlib.load(handle)
        self.assertEqual(
            native_info["CFBundleIdentifier"],
            "com.cursoratelier.CursorAtelier.NativeCursor",
        )
        self.assertEqual(
            helper_info["CFBundleIdentifier"],
            "com.cursoratelier.CursorAtelier.NativeCursor.LoginHelper",
        )
        self.assertEqual(
            helper_info["CFBundleDisplayName"], "Cursor Atelier Login Helper"
        )
        self.assertNotEqual(
            native_info["CFBundleIdentifier"], helper_info["CFBundleIdentifier"]
        )
        helper_source = HELPER.read_text(encoding="utf-8")
        self.assertIn("validatedHostBundle", helper_source)
        self.assertIn(
            f'@"{native_info["CFBundleIdentifier"]}"', helper_source
        )

    def test_each_delivery_has_a_distinct_resident_helper_build(self) -> None:
        build = BUILD_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("CURSOR_ATELIER_BUILD_VERSION", build)
        self.assertIn("/bin/date -u +%Y%m%d%H%M%S", build)
        self.assertIn(
            '"Set :CFBundleVersion $build_version"',
            build,
        )
        self.assertNotIn(
            '"Set :CFBundleVersion $product_version"',
            build,
        )

        controller = CONTROLLER.read_text(encoding="utf-8")
        register = self._function(
            controller,
            "BOOL OreoRegisterLoginItem(NSError **error)",
            "BOOL OreoUnregisterLoginItem(NSError **error)",
        )
        version_match = register.index(
            "[registeredVersion isEqualToString:currentVersion]"
        )
        restart = register.index(
            "OreoWaitForLoginItemUnregister(service, error)",
            version_match,
        )
        self.assertLess(version_match, restart)

        reconcile = self._function(
            controller,
            "BOOL OreoReconcileLoginItems(NSError **error)",
            "BOOL OreoMigrateLegacyLoginItemIfNeeded(NSError **error)",
        )
        self.assertIn("OreoLoginItemDesired()", reconcile)
        self.assertIn("OreoRegisterLoginItem(error)", reconcile)
        self.assertIn("OreoUnregisterLoginItem(error)", reconcile)
        self.assertIn("OreoUnregisterLegacyMainLoginItem(error)", reconcile)

        command = self._function(
            controller,
            "int OreoRunCommandLineIfRequested(",
            "BOOL approvalRequired =",
        )
        self.assertIn('@"--reconcile-login-items"', command)
        self.assertIn("OreoReconcileLoginItems(&actionError)", command)

    def test_native_processes_share_the_native_preferences_domain(self) -> None:
        domain = "com.cursoratelier.CursorAtelier.NativeCursor"
        engine = ENGINE.read_text(encoding="utf-8")
        controller = CONTROLLER.read_text(encoding="utf-8")
        helper = HELPER.read_text(encoding="utf-8")
        self.assertIn(f'initWithSuiteName:\n                    @"{domain}"', engine)
        self.assertIn(f'@"{domain}.SettingsChanged"', controller)
        self.assertIn(f'@"{domain}.SettingsChanged"', helper)

    def test_running_helper_recovers_every_refresh_before_state_actions(self) -> None:
        helper = HELPER.read_text(encoding="utf-8")
        reload_engine = self._function(
            helper,
            "- (BOOL)reloadEngine:(NSError **)error",
            "- (BOOL)bringStateCurrent:(NSError **)error",
        )
        bring_current = self._function(
            helper,
            "- (BOOL)bringStateCurrent:(NSError **)error",
            "- (void)applicationDidFinishLaunching:",
        )

        self.assertNotIn("recoverInterruptedTransaction", reload_engine)
        recovery = bring_current.index(
            "[self.engine recoverInterruptedTransaction:&recovered error:error]"
        )
        desired = bring_current.index("BOOL desired =", recovery)
        self.assertLess(recovery, desired)
        recovered_branch = bring_current.index("if (recovered) {", recovery)
        self.assertIn("return YES;", bring_current[recovered_branch:desired])

    def test_theme_validity_does_not_define_api_support(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        initialize = self._function(
            engine,
            "- (instancetype)initWithThemeIdentifier:(NSString *)themeIdentifier\n"
            "                          resourceBundle:(NSBundle *)resourceBundle\n"
            "                          sizePercentage:",
            "- (void)failWithError:",
        )
        api = "self.supported = [self loadPrivateAPI:&apiError];"
        invalid = "if (!_themeSpecification || !_themeResourceBundle) {"
        self.assertLess(initialize.index(api), initialize.index(invalid))
        invalid_block = initialize[
            initialize.index(invalid) : initialize.index("NSError *themeError", initialize.index(invalid))
        ]
        self.assertNotIn("self.supported = NO;", invalid_block)
        self.assertIn("self.themeValid = NO;", invalid_block)

    def test_engine_apply_failure_restores_prior_desired_intent(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        apply_locked = self._function(
            engine,
            "- (BOOL)applyLocked:(NSError **)error {",
            "- (BOOL)restore:(NSError **)error {",
        )
        capture = (
            "BOOL previouslyDesired =\n"
            "        [defaults boolForKey:OreoCursorEnabledDefaultsKey];"
        )
        self.assertIn(capture, apply_locked)
        self.assertGreaterEqual(
            apply_locked.count("persistDesiredState:previouslyDesired"), 3
        )
        rollback = apply_locked.index("BOOL rollbackCommitted =")
        self.assertIn(
            "persistDesiredState:previouslyDesired",
            apply_locked[rollback:],
        )

    def test_diagnostics_use_theme_neutral_sentinel_key(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        self.assertIn('@"currentSentinelsMatchTheme"', engine)
        self.assertNotIn("currentSentinelsMatchOreo", engine)

    def test_theme_validation_accepts_bounded_ordered_scale_ladders(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        self.assertIn(
            "static const NSUInteger OreoMaximumThemeRepresentations = 16;",
            engine,
        )
        self.assertIn(
            "static const double OreoMaximumThemeScale = 10;", engine
        )
        validation = self._function(
            engine,
            "static NSDictionary * _Nullable OreoValidatedThemeCursor(",
            "- (NSDictionary *)validatedThemeCursor:",
        )
        self.assertIn("representations.count < 3", validation)
        self.assertIn(
            "representations.count > OreoMaximumThemeRepresentations",
            validation,
        )
        self.assertIn(
            "scaleValue >= 1 && scaleValue <= OreoMaximumThemeScale",
            validation,
        )
        self.assertIn("scaleValue > previousScale", validation)
        self.assertIn(
            "OreoNearlyEqual(scaleValue, heightScale)", validation
        )
        self.assertIn(
            "imageBytes <= OreoMaximumDecodedBytes - decodedBytes", validation
        )
        self.assertIn("hasOneX = hasOneX || scaleValue == 1", validation)
        self.assertIn("hasTwoX = hasTwoX || scaleValue == 2", validation)
        self.assertIn("hasThreeX = hasThreeX || scaleValue == 3", validation)
        self.assertIn("if (!hasOneX || !hasTwoX || !hasThreeX)", validation)
        self.assertNotIn("representations.count != 2", validation)

    def test_theme_size_scales_registration_geometry_without_resampling(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        scaling = self._function(
            engine,
            "OreoThemeCursorsByScalingGeometry(",
            "@interface OreoCursorEngine ()",
        )
        self.assertIn('scaledRecord[@"PointsWide"] = @(width);', scaling)
        self.assertIn('scaledRecord[@"PointsHigh"] = @(height);', scaling)
        self.assertIn('scaledRecord[@"HotSpotX"] = @(hotX);', scaling)
        self.assertIn('scaledRecord[@"HotSpotY"] = @(hotY);', scaling)
        self.assertNotIn('scaledRecord[@"Images"]', scaling)
        self.assertNotIn('scaledRecord[@"FrameCount"]', scaling)
        self.assertNotIn('scaledRecord[@"FrameDuration"]', scaling)

        load = self._function(
            engine,
            "- (BOOL)loadAndValidateTheme:(NSError **)error",
            "static NSDictionary * _Nullable OreoValidatedThemeCursor(",
        )
        self.assertIn("OreoDecodedThemeCursors", load)
        self.assertIn("OreoThemeCursorsByScalingGeometry", load)

        verify = self._function(
            engine,
            "- (BOOL)verifyThemeIdentifiers:",
            "- (BOOL)verifySnapshot:",
        )
        self.assertIn("_themeCursors[identifier]", verify)
        self.assertIn(
            "[self recordsMatch:_themeCursors[identifier] actual:actual]", verify
        )

    def test_size_draft_and_effective_state_cannot_race_the_helper(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        controller = CONTROLLER.read_text(encoding="utf-8")
        helper = HELPER.read_text(encoding="utf-8")

        apply_theme = self._function(
            controller,
            "static BOOL OreoApplyTheme(",
            "static BOOL OreoParseThemeSizePercentage(",
        )
        self.assertIn(
            "sizePercentage:[OreoCursorEngine\n"
            "                     sizePercentageForThemeIdentifier:identifier]",
            apply_theme,
        )

        set_size = self._function(
            controller,
            'if ([command isEqual:@"--set-theme-size"]) {',
            'if ([command isEqual:@"--validate-themes"]) {',
        )
        self.assertIn("saveSizePercentage:sizePercentage", set_size)
        self.assertNotIn("OreoPostSettingsChangedNotification", set_size)

        apply_locked = self._function(
            engine,
            "- (BOOL)applyLocked:(NSError **)error {",
            "- (BOOL)restore:(NSError **)error {",
        )
        verification = apply_locked.index("verifyThemeIdentifiers:")
        persist_effective = apply_locked.index("persistAppliedState:")
        clear_journal = apply_locked.index("clearTransaction:", persist_effective)
        self.assertLess(verification, persist_effective)
        self.assertLess(persist_effective, clear_journal)

        bring_current = self._function(
            helper,
            "- (BOOL)bringStateCurrent:(NSError **)error",
            "- (void)applicationDidFinishLaunching:",
        )
        self.assertIn("[OreoCursorEngine effectiveSizePercentage]", bring_current)
        self.assertIn(
            "self.engine.themeSizePercentage != expectedSize", bring_current
        )

    def test_theme_size_map_has_a_dedicated_full_catalogue_bound(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        self.assertIn(
            "static const NSUInteger OreoMaximumThemeSizeEntries = 2048;",
            engine,
        )
        save_size = self._function(
            engine,
            "+ (BOOL)saveSizePercentage:(NSInteger)sizePercentage",
            "- (instancetype)initWithError:",
        )
        self.assertNotIn("OreoMaximumImportedThemes", save_size)
        self.assertIn("OreoMaximumThemeSizeEntries - 1", save_size)
        self.assertIn("[availableIdentifiers containsObject:identifier]", save_size)
        self.assertIn("[identifier isEqualToString:themeIdentifier]", save_size)

    def test_deleted_theme_size_cleanup_does_not_require_a_manifest(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        controller = CONTROLLER.read_text(encoding="utf-8")
        forget_size = self._function(
            engine,
            "+ (BOOL)forgetSizePercentageForThemeIdentifier:",
            "- (instancetype)initWithError:",
        )
        self.assertIn("OreoIsSafeThemeIdentifier(themeIdentifier)", forget_size)
        self.assertIn("removeObjectForKey:themeIdentifier", forget_size)
        self.assertNotIn("OreoThemeSpecificationForBundle", forget_size)
        self.assertNotIn("OreoThemeSpecificationsForBundle", forget_size)

        command = self._function(
            controller,
            'if ([command isEqual:@"--forget-theme-size"]) {',
            'if ([command isEqual:@"--validate-themes"]) {',
        )
        self.assertIn("forgetSizePercentageForThemeIdentifier", command)
        self.assertNotIn("OreoPostSettingsChangedNotification", command)

    def test_failed_cursor_removal_is_verified_before_restore_fails(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        restore = self._function(
            engine,
            "- (BOOL)restoreSnapshot:(NSDictionary *)snapshot",
            "- (void)bestEffortSystemReset",
        )
        remove = restore.index("CGError removeResult =")
        query = restore.index("_api.registeredCursorDataSize(", remove)
        removal = restore[remove : restore.index("CGError arrowResult", remove)]
        absence = restore.index("if (isAbsent) {", query)
        capture = restore.index("[self captureRegisteredCursor:", absence)
        alias = restore.index("[self nativeAliasForIdentifier:", capture)
        repair = restore.index(
            "[self restoreSystemAliasForIdentifier:", alias
        )
        failure = restore.index(
            "*error = aliasRestoreError ?: captureError ?: OreoError(", repair
        )

        before_query = restore[remove:query]
        self.assertNotIn("return NO;", before_query)
        self.assertNotIn("continue;", before_query)
        self.assertLess(remove, query)
        self.assertLess(query, absence)
        self.assertLess(absence, capture)
        self.assertLess(capture, alias)
        self.assertLess(alias, repair)
        self.assertLess(repair, failure)
        self.assertLess(alias, failure)
        self.assertEqual(removal.count("continue;"), 3)
        self.assertNotIn("continue;", restore[failure : failure + 300])
        self.assertIn("return NO;", restore[failure : failure + 300])
        self.assertIn("identifier, removeResult, sizeResult", restore[failure:])

    def test_native_alias_restore_acceptance_is_fail_closed(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        alias = self._function(
            engine,
            "- (BOOL)nativeAliasForIdentifier:(NSString *)identifier",
            "- (BOOL)restoreSystemAliasForIdentifier:",
        )
        self.assertIn("OreoSupplementalAliasMap()[identifier]", alias)
        self.assertIn(
            "if (sourceIdentifier.length == 0) {\n"
            "        return NO;\n"
            "    }",
            alias,
        )
        self.assertIn(
            'if ([sourceRecord[@"WasRegistered"] boolValue] &&\n'
            "        [self recordsMatch:sourceRecord actual:actual])",
            alias,
        )
        self.assertIn(
            "if (OreoSystemCursorFolderMap()[identifier].length == 0) {\n"
            "        return NO;\n"
            "    }",
            alias,
        )
        self.assertIn(
            "NSDictionary *nativeRecord = fallbacks[identifier];",
            alias,
        )
        self.assertIn(
            "return nativeRecord && [self recordsMatch:nativeRecord actual:actual];",
            alias,
        )

    def test_unremovable_supplemental_alias_uses_verified_system_artwork(
        self,
    ) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        repair = self._function(
            engine,
            "- (BOOL)restoreSystemAliasForIdentifier:",
            "- (BOOL)verifyThemeIdentifiers:",
        )
        self.assertIn("OreoSupplementalAliasMap()[identifier]", repair)
        self.assertIn("OreoSystemCursorFolderMap()[identifier]", repair)
        fallback = repair.index("NSDictionary *nativeRecord = fallbacks[identifier]")
        register = repair.index(
            "[self registerRecord:nativeRecord identifier:identifier error:error]"
        )
        capture = repair.index(
            "[self captureRegisteredCursor:identifier error:&captureError]"
        )
        verify = repair.index(
            "[self recordsMatch:nativeRecord actual:actual]", capture
        )
        self.assertLess(fallback, register)
        self.assertLess(register, capture)
        self.assertLess(capture, verify)

    def test_restore_prepares_system_fallbacks_before_cursor_mutation(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        restore = self._function(
            engine,
            "- (BOOL)restoreSnapshot:(NSDictionary *)snapshot",
            "- (void)bestEffortSystemReset",
        )
        prepare = restore.index("[self preparedSystemFallbacksForSnapshot:")
        dock_override = restore.index("_api.setDockOverride(")
        reset = restore.index("_api.unregisterAllCoreCursors(")
        register = restore.index("[self registerRecord:")
        self.assertLess(prepare, dock_override)
        self.assertLess(prepare, reset)
        self.assertLess(prepare, register)
        self.assertIn("systemFallbacks:systemFallbacks", restore)

    def test_static_apple_fallback_can_omit_both_animation_keys(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        fallback = self._function(
            engine,
            "- (NSDictionary * _Nullable)systemFallbackRecordForIdentifier:",
            "- (NSDictionary * _Nullable)downsampledRecordForImages:",
        )
        self.assertIn('BOOL hasFrames = info[@"frames"] != nil;', fallback)
        self.assertIn('BOOL hasDelay = info[@"delay"] != nil;', fallback)
        self.assertIn("BOOL validAnimation = hasFrames == hasDelay;", fallback)
        self.assertIn("if (validAnimation && !hasFrames) {", fallback)
        self.assertIn("frameValue = 1;", fallback)
        self.assertIn("delay = 0;", fallback)
        self.assertIn(
            'OreoIsFiniteNumber(info[@"frames"], 1, 24, &frameValue)',
            fallback,
        )
        self.assertIn(
            'OreoIsFiniteNumber(info[@"delay"], 0, 10, &delay)',
            fallback,
        )
        self.assertIn("if (!validAnimation ||", fallback)

    def test_system_fallback_validation_is_read_only_and_exhaustive(self) -> None:
        engine = ENGINE.read_text(encoding="utf-8")
        validation = self._function(
            engine,
            "- (BOOL)validateSystemFallbackResources:",
            "- (NSDictionary<NSString *, id> *)diagnostics",
        )
        self.assertIn("OreoSystemCursorFolderMap().allKeys", validation)
        self.assertIn("sortedArrayUsingSelector:@selector(compare:)", validation)
        self.assertIn(
            "[self systemResourceFallbackRecordForIdentifier:identifier",
            validation,
        )
        self.assertNotIn("registerRecord:", validation)
        self.assertNotIn("removeRegisteredCursor", validation)
        self.assertNotIn("setCoreCursor", validation)
        self.assertNotIn("setSystemCursor", validation)

        controller = CONTROLLER.read_text(encoding="utf-8")
        command = self._function(
            controller,
            'if ([command isEqual:@"--validate-system-fallbacks"]) {',
            'if ([command isEqual:@"--open-login-settings"]) {',
        )
        self.assertIn("validateSystemFallbackResources", command)
        self.assertIn('validation[@"valid"] = @(valid);', command)
        self.assertNotIn("recoverInterruptedTransaction", command)
        self.assertNotIn("[engine apply:", command)
        self.assertNotIn("[engine restore:", command)

    def test_login_settings_command_is_narrow_and_non_mutating(self) -> None:
        source = CONTROLLER.read_text(encoding="utf-8")
        self.assertIn('@"--open-login-settings"', source)
        start = source.index('if ([command isEqual:@"--open-login-settings"]) {')
        end = source.index("BOOL replacesSelectedTheme =", start)
        command = source[start:end]
        self.assertIn("[SMAppService openSystemSettingsLoginItems];", command)
        self.assertIn("OreoPrintJSON(OreoCombinedDiagnostics", command)
        self.assertNotIn("[engine apply:", command)
        self.assertNotIn("[engine restore:", command)


if __name__ == "__main__":
    unittest.main()
