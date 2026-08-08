#import "OreoAppController.h"

#import "OreoCursorEngine.h"
#import <Cocoa/Cocoa.h>
#import <ServiceManagement/ServiceManagement.h>

NSString * const OreoLoginHelperBundleIdentifier =
    @"com.cursoratelier.CursorAtelier.NativeCursor.LoginHelper";
NSString * const OreoSettingsChangedNotification =
    @"com.cursoratelier.CursorAtelier.NativeCursor.SettingsChanged";
NSString * const OreoStatusChangedNotification =
    @"com.cursoratelier.CursorAtelier.NativeCursor.StatusChanged";

static NSString * const OreoSetupErrorDomain =
    @"com.cursoratelier.CursorAtelier.NativeCursor.Setup";
static NSString * const OreoRegisteredHelperVersionDefaultsKey =
    @"RegisteredLoginHelperVersion";
static NSString * const OreoLoginItemDesiredDefaultsKey =
    @"LaunchAtLoginDesired";

static NSString *OreoServiceStatusString(SMAppServiceStatus status) {
    switch (status) {
        case SMAppServiceStatusNotRegistered:
            return @"notRegistered";
        case SMAppServiceStatusEnabled:
            return @"enabled";
        case SMAppServiceStatusRequiresApproval:
            return @"requiresApproval";
        case SMAppServiceStatusNotFound:
            return @"notFound";
    }
    return @"unknown";
}

SMAppService *OreoLoginItemService(void) {
    return [SMAppService
        loginItemServiceWithIdentifier:OreoLoginHelperBundleIdentifier];
}

NSString *OreoLoginItemStatusString(void) {
    return OreoServiceStatusString(OreoLoginItemService().status);
}

NSString *OreoLegacyMainLoginItemStatusString(void) {
    return OreoServiceStatusString(SMAppService.mainAppService.status);
}

void OreoSetLoginItemDesired(BOOL desired) {
    [OreoCursorDefaults() setBool:desired
                          forKey:OreoLoginItemDesiredDefaultsKey];
    [OreoCursorDefaults() synchronize];
}

BOOL OreoLoginItemDesired(void) {
    NSUserDefaults *defaults = OreoCursorDefaults();
    if ([defaults objectForKey:OreoLoginItemDesiredDefaultsKey]) {
        return [defaults boolForKey:OreoLoginItemDesiredDefaultsKey];
    }
    SMAppServiceStatus helperStatus = OreoLoginItemService().status;
    SMAppServiceStatus legacyStatus = SMAppService.mainAppService.status;
    BOOL inferred =
        helperStatus == SMAppServiceStatusEnabled ||
        helperStatus == SMAppServiceStatusRequiresApproval ||
        legacyStatus == SMAppServiceStatusEnabled ||
        legacyStatus == SMAppServiceStatusRequiresApproval ||
        [defaults
            stringForKey:OreoRegisteredHelperVersionDefaultsKey].length > 0;
    return inferred;
}

static NSError *OreoSetupError(NSInteger code, NSString *message) {
    return [NSError errorWithDomain:OreoSetupErrorDomain
                               code:code
                           userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSBundle *OreoEmbeddedLoginHelper(NSError **error) {
    NSURL *helperURL = [NSBundle.mainBundle.bundleURL
        URLByAppendingPathComponent:
            @"Contents/Library/LoginItems/Oreo Cursor Login Helper.app"
                   isDirectory:YES];
    NSBundle *helperBundle = [NSBundle bundleWithURL:helperURL];
    BOOL validIdentifier =
        [helperBundle.bundleIdentifier
            isEqualToString:OreoLoginHelperBundleIdentifier];
    BOOL executableExists =
        helperBundle.executableURL &&
        [[NSFileManager defaultManager]
            isExecutableFileAtPath:helperBundle.executableURL.path];
    if (!validIdentifier || !executableExists) {
        if (error) {
            *error = OreoSetupError(
                1, @"The signed Cursor Atelier login helper is missing or "
                   @"malformed. Reinstall the app before enabling Launch at "
                   @"Login.");
        }
        return nil;
    }
    return helperBundle;
}

BOOL OreoLoginItemRegistrationCurrent(void) {
    NSBundle *helperBundle = OreoEmbeddedLoginHelper(NULL);
    NSString *currentVersion =
        [helperBundle objectForInfoDictionaryKey:@"CFBundleVersion"];
    NSString *registeredVersion =
        [OreoCursorDefaults()
            stringForKey:OreoRegisteredHelperVersionDefaultsKey];
    SMAppServiceStatus status = OreoLoginItemService().status;
    BOOL registered =
        status == SMAppServiceStatusEnabled ||
        status == SMAppServiceStatusRequiresApproval;
    return registered && currentVersion.length > 0 &&
        [registeredVersion isEqualToString:currentVersion];
}

static BOOL OreoWaitForLoginItemUnregister(SMAppService *service,
                                            NSError **error) {
    dispatch_semaphore_t completion = dispatch_semaphore_create(0);
    __block NSError *completionError = nil;
    [service unregisterWithCompletionHandler:^(NSError *result) {
        completionError = result;
        dispatch_semaphore_signal(completion);
    }];
    if (dispatch_semaphore_wait(
            completion,
            dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
        if (error) {
            *error = OreoSetupError(
                5, @"Timed out while restarting the Cursor Atelier login "
                   @"helper.");
        }
        return NO;
    }
    if (completionError &&
        service.status != SMAppServiceStatusNotRegistered &&
        service.status != SMAppServiceStatusNotFound) {
        if (error) {
            *error = completionError;
        }
        return NO;
    }
    return YES;
}

static NSError *OreoErrorByAppendingCleanup(NSError *primary,
                                             NSString *description,
                                             NSError *cleanup) {
    return OreoSetupError(
        6, [NSString stringWithFormat:@"%@ %@: %@",
            primary.localizedDescription ?: @"The requested setup failed.",
            description,
            cleanup.localizedDescription ?: @"unknown error"]);
}

BOOL OreoRegisterLoginItem(NSError **error) {
    NSBundle *helperBundle = OreoEmbeddedLoginHelper(error);
    if (!helperBundle) {
        return NO;
    }
    NSString *currentVersion =
        [helperBundle objectForInfoDictionaryKey:@"CFBundleVersion"];
    if (currentVersion.length == 0) {
        if (error) {
            *error = OreoSetupError(
                7, @"The Cursor Atelier login helper has no build version.");
        }
        return NO;
    }

    SMAppService *service = OreoLoginItemService();
    if (service.status == SMAppServiceStatusEnabled ||
        service.status == SMAppServiceStatusRequiresApproval) {
        NSString *registeredVersion =
            [OreoCursorDefaults()
                stringForKey:OreoRegisteredHelperVersionDefaultsKey];
        if ([registeredVersion isEqualToString:currentVersion]) {
            return YES;
        }
        if (!OreoWaitForLoginItemUnregister(service, error)) {
            return NO;
        }
        service = OreoLoginItemService();
    }

    switch (service.status) {
        case SMAppServiceStatusEnabled:
        case SMAppServiceStatusRequiresApproval:
            if (error) {
                *error = OreoSetupError(
                    9, @"macOS did not finish restarting the Cursor Atelier "
                       @"login helper.");
            }
            return NO;
        case SMAppServiceStatusNotFound:
            // Tahoe reports NotFound before the embedded helper has its first
            // BTM record. Only treat it as first registration after checking
            // the exact signed-bundle layout and identifier ourselves.
            break;
        case SMAppServiceStatusNotRegistered:
            break;
    }

    NSError *registrationError = nil;
    BOOL registered =
        [service registerAndReturnError:&registrationError];
    SMAppServiceStatus resultingStatus = service.status;
    if (!registered &&
        resultingStatus != SMAppServiceStatusRequiresApproval) {
        if (error) {
            *error = registrationError ?: OreoSetupError(
                2, @"macOS did not register the Cursor Atelier login helper.");
        }
        return NO;
    }
    if (resultingStatus != SMAppServiceStatusEnabled &&
        resultingStatus != SMAppServiceStatusRequiresApproval) {
        if (error) {
            *error = OreoSetupError(
                3, @"macOS returned an unexpected login-helper status.");
        }
        return NO;
    }
    [OreoCursorDefaults() setObject:currentVersion
                             forKey:OreoRegisteredHelperVersionDefaultsKey];
    [OreoCursorDefaults() synchronize];
    if (error) {
        *error = nil;
    }
    return YES;
}

BOOL OreoUnregisterLoginItem(NSError **error) {
    SMAppService *service = OreoLoginItemService();
    if (service.status == SMAppServiceStatusNotRegistered ||
        service.status == SMAppServiceStatusNotFound) {
        [OreoCursorDefaults()
            removeObjectForKey:OreoRegisteredHelperVersionDefaultsKey];
        [OreoCursorDefaults() synchronize];
        return YES;
    }
    NSError *unregisterError = nil;
    if ([service unregisterAndReturnError:&unregisterError]) {
        [OreoCursorDefaults()
            removeObjectForKey:OreoRegisteredHelperVersionDefaultsKey];
        [OreoCursorDefaults() synchronize];
        return YES;
    }
    if (service.status == SMAppServiceStatusNotRegistered ||
        service.status == SMAppServiceStatusNotFound) {
        [OreoCursorDefaults()
            removeObjectForKey:OreoRegisteredHelperVersionDefaultsKey];
        [OreoCursorDefaults() synchronize];
        return YES;
    }
    if (error) {
        *error = unregisterError;
    }
    return NO;
}

BOOL OreoUnregisterLegacyMainLoginItem(NSError **error) {
    NSError *unregisterError = nil;
    for (NSUInteger attempt = 0; attempt < 2; attempt++) {
        SMAppService *service = SMAppService.mainAppService;
        if (service.status == SMAppServiceStatusNotRegistered ||
            service.status == SMAppServiceStatusNotFound) {
            return YES;
        }
        NSError *attemptError = nil;
        if ([service unregisterAndReturnError:&attemptError]) {
            return YES;
        }
        unregisterError = attemptError;
        if (service.status == SMAppServiceStatusNotRegistered ||
            service.status == SMAppServiceStatusNotFound) {
            return YES;
        }
    }
    if (error) {
        *error = unregisterError ?: OreoSetupError(
            10, @"The older Cursor Atelier startup item could not be removed.");
    }
    return NO;
}

BOOL OreoReconcileLoginItems(NSError **error) {
    BOOL desired = OreoLoginItemDesired();
    BOOL helperCurrent = desired
        ? OreoRegisterLoginItem(error)
        : OreoUnregisterLoginItem(error);
    if (!helperCurrent) {
        return NO;
    }
    return OreoUnregisterLegacyMainLoginItem(error);
}

BOOL OreoMigrateLegacyLoginItemIfNeeded(NSError **error) {
    SMAppServiceStatus legacyStatus = SMAppService.mainAppService.status;
    if (legacyStatus != SMAppServiceStatusEnabled &&
        legacyStatus != SMAppServiceStatusRequiresApproval) {
        return YES;
    }
    NSUserDefaults *defaults = OreoCursorDefaults();
    if ([defaults objectForKey:OreoLoginItemDesiredDefaultsKey] &&
        ![defaults boolForKey:OreoLoginItemDesiredDefaultsKey]) {
        return OreoUnregisterLegacyMainLoginItem(error);
    }
    OreoSetLoginItemDesired(YES);
    SMAppServiceStatus priorHelperStatus = OreoLoginItemService().status;
    BOOL helperWasRegistered =
        priorHelperStatus == SMAppServiceStatusEnabled ||
        priorHelperStatus == SMAppServiceStatusRequiresApproval;
    NSError *registrationError = nil;
    if (!OreoRegisterLoginItem(&registrationError)) {
        if (error) {
            *error = registrationError;
        }
        return NO;
    }
    NSError *legacyError = nil;
    if (OreoUnregisterLegacyMainLoginItem(&legacyError)) {
        return YES;
    }
    if (!helperWasRegistered) {
        NSError *rollbackError = nil;
        if (!OreoUnregisterLoginItem(&rollbackError)) {
            legacyError = OreoErrorByAppendingCleanup(
                legacyError,
                @"The newly registered helper also could not be removed",
                rollbackError);
        }
    }
    if (error) {
        *error = legacyError;
    }
    return NO;
}

void OreoPostSettingsChangedNotification(void) {
    [[NSDistributedNotificationCenter defaultCenter]
        postNotificationName:OreoSettingsChangedNotification
                      object:nil
                    userInfo:nil
          deliverImmediately:YES];
}

static void OreoPrintJSON(id object) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                   options:
                                                       NSJSONWritingPrettyPrinted |
                                                       NSJSONWritingSortedKeys
                                                     error:&error];
    if (!data) {
        fprintf(stderr, "Could not serialize diagnostics: %s\n",
                error.localizedDescription.UTF8String);
        return;
    }
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
}

static NSDictionary *OreoLoginItemDiagnostics(NSString *action,
                                               NSError *actionError) {
    NSUserDefaults *defaults = OreoCursorDefaults();
    NSMutableDictionary *result = [NSMutableDictionary dictionaryWithDictionary:@{
        @"action": action,
        @"selectedThemeIdentifier":
            ([defaults stringForKey:OreoCursorThemeDefaultsKey] ?: @""),
        @"desiredEnabled":
            @([defaults boolForKey:OreoCursorEnabledDefaultsKey]),
        @"effectiveApplied":
            @([defaults boolForKey:OreoCursorEffectiveDefaultsKey]),
        @"loginItemStatus": OreoLoginItemStatusString(),
        @"legacyMainLoginItemStatus":
            OreoLegacyMainLoginItemStatusString(),
        @"loginApprovalRequired":
            @(OreoLoginItemService().status ==
              SMAppServiceStatusRequiresApproval),
        @"launchAtLoginDesired": @(OreoLoginItemDesired()),
        @"loginItemRegistrationCurrent":
            @(OreoLoginItemRegistrationCurrent()),
    }];
    if (actionError) {
        result[@"actionError"] = actionError.localizedDescription;
    }
    return [result copy];
}

static NSDictionary *OreoCombinedDiagnostics(OreoCursorEngine *engine,
                                              NSString *action,
                                              NSError *actionError) {
    NSMutableDictionary *result = [[engine diagnostics] mutableCopy];
    [result addEntriesFromDictionary:
        OreoLoginItemDiagnostics(action, actionError)];
    result[@"selectedThemeIdentifier"] =
        [OreoCursorEngine selectedThemeIdentifier];
    return [result copy];
}

static NSDictionary *OreoValidateThemeResources(void) {
    NSArray<NSDictionary<NSString *, id> *> *themes =
        [OreoCursorEngine availableThemes];
    NSMutableArray<NSDictionary *> *results =
        [NSMutableArray arrayWithCapacity:themes.count];
    NSUInteger invalidCount = 0;
    for (NSDictionary<NSString *, id> *theme in themes) {
        NSError *error = nil;
        OreoCursorEngine *engine = [[OreoCursorEngine alloc]
            initWithThemeIdentifier:theme[@"Identifier"]
                     resourceBundle:NSBundle.mainBundle
                     sizePercentage:100
                              error:&error];
        BOOL valid = engine.supported && engine.themeValid;
        if (!valid) {
            invalidCount++;
        }
        NSMutableDictionary *result = [NSMutableDictionary dictionaryWithDictionary:@{
            @"Identifier": theme[@"Identifier"] ?: @"",
            @"DisplayName": theme[@"DisplayName"] ?: @"",
            @"Resource": theme[@"Resource"] ?: @"",
            @"valid": @(valid),
        }];
        if (error.localizedDescription.length > 0) {
            result[@"error"] = error.localizedDescription;
        }
        [results addObject:[result copy]];
    }
    return @{
        @"action": @"validate-themes",
        @"valid": @(invalidCount == 0),
        @"themeCount": @(themes.count),
        @"invalidCount": @(invalidCount),
        @"themes": results,
    };
}

static void OreoSaveCommandStatus(OreoCursorEngine *engine,
                                  NSString *command,
                                  BOOL success,
                                  NSError *error,
                                  NSString *source) {
    NSString *message = error.localizedDescription;
    if (success) {
        BOOL desired =
            [OreoCursorDefaults() boolForKey:OreoCursorEnabledDefaultsKey];
        if ([command isEqual:@"--disable"] ||
            [command isEqual:@"--teardown"] || !desired) {
            message = @"Apple cursors are active.";
        } else {
            message = [NSString stringWithFormat:
                @"%@ is active.", engine.themeDisplayName];
        }
    }
    OreoCursorSaveStatus(message ?: @"The requested cursor action failed.",
                         !success, source);
}

static BOOL OreoSelectTheme(NSString *identifier,
                            OreoCursorEngine **engine,
                            NSError **error) {
    OreoCursorEngine *priorEngine = *engine;
    OreoCursorEngine *candidate = [[OreoCursorEngine alloc]
        initWithThemeIdentifier:identifier
                 resourceBundle:NSBundle.mainBundle
                 sizePercentage:[OreoCursorEngine
                     sizePercentageForThemeIdentifier:identifier]
                          error:error];
    if (!candidate.supported || !candidate.themeValid) {
        return NO;
    }
    BOOL desired =
        [OreoCursorDefaults() boolForKey:OreoCursorEnabledDefaultsKey];
    BOOL effective =
        [OreoCursorDefaults() boolForKey:OreoCursorEffectiveDefaultsKey];
    if (!desired && effective) {
        if (error) {
            *error = OreoSetupError(
                4, @"Finish restoring Apple cursors before changing colors.");
        }
        return NO;
    }
    if (desired) {
        NSError *applyError = nil;
        if (![candidate apply:&applyError]) {
            NSError *rollbackError = nil;
            if (![priorEngine apply:&rollbackError]) {
                applyError = OreoErrorByAppendingCleanup(
                    applyError, @"The previous cursor theme could not be restored",
                    rollbackError);
            }
            if (error) {
                *error = applyError;
            }
            return NO;
        }
    }
    if (![OreoCursorEngine saveSelectedThemeIdentifier:identifier
                                                error:error]) {
        if (desired) {
            NSError *rollbackError = nil;
            if (![priorEngine apply:&rollbackError] && error) {
                *error = OreoErrorByAppendingCleanup(
                    *error, @"The previous cursor theme could not be restored",
                    rollbackError);
            }
        }
        return NO;
    }
    *engine = candidate;
    OreoPostSettingsChangedNotification();
    return YES;
}

static BOOL OreoApplyTheme(NSString *identifier,
                           OreoCursorEngine **engine,
                           NSError **error) {
    OreoCursorEngine *priorEngine = *engine;
    NSString *priorIdentifier = [OreoCursorEngine selectedThemeIdentifier];
    BOOL priorDesired =
        [OreoCursorDefaults() boolForKey:OreoCursorEnabledDefaultsKey];
    BOOL priorEffective =
        [OreoCursorDefaults() boolForKey:OreoCursorEffectiveDefaultsKey];
    BOOL priorLoginDesired = OreoLoginItemDesired();
    SMAppServiceStatus priorHelperStatus = OreoLoginItemService().status;
    BOOL helperWasRegistered =
        priorHelperStatus == SMAppServiceStatusEnabled ||
        priorHelperStatus == SMAppServiceStatusRequiresApproval;

    if (!priorDesired && priorEffective) {
        if (error) {
            *error = OreoSetupError(
                4, @"Finish restoring Apple cursors before applying a theme.");
        }
        return NO;
    }

    NSError *actionError = nil;
    OreoCursorEngine *candidate = [[OreoCursorEngine alloc]
        initWithThemeIdentifier:identifier
                 resourceBundle:NSBundle.mainBundle
                 sizePercentage:[OreoCursorEngine
                     sizePercentageForThemeIdentifier:identifier]
                          error:&actionError];
    if (!candidate.supported || !candidate.themeValid) {
        if (error) {
            *error = actionError;
        }
        return NO;
    }

    BOOL cursorChanged = [candidate apply:&actionError];
    BOOL selectionChanged = NO;
    BOOL candidateSelectionPersisted = NO;
    BOOL helperCreated = NO;
    if (cursorChanged) {
        selectionChanged =
            [OreoCursorEngine saveSelectedThemeIdentifier:identifier
                                                    error:&actionError];
        candidateSelectionPersisted = selectionChanged;
    }
    if (cursorChanged && selectionChanged) {
        if (OreoRegisterLoginItem(&actionError)) {
            helperCreated =
                !helperWasRegistered &&
                (OreoLoginItemService().status ==
                     SMAppServiceStatusEnabled ||
                 OreoLoginItemService().status ==
                     SMAppServiceStatusRequiresApproval);
        } else {
            selectionChanged = NO;
        }
    }
    if (cursorChanged && selectionChanged &&
        !OreoUnregisterLegacyMainLoginItem(&actionError)) {
        selectionChanged = NO;
    }

    if (cursorChanged && selectionChanged) {
        OreoSetLoginItemDesired(YES);
        *engine = candidate;
        OreoPostSettingsChangedNotification();
        return YES;
    }

    NSError *cleanupError = nil;
    if (helperCreated && !OreoUnregisterLoginItem(&cleanupError)) {
        actionError = OreoErrorByAppendingCleanup(
            actionError, @"The new helper could not be removed", cleanupError);
    }
    cleanupError = nil;
    BOOL rollbackReady =
        [candidate recoverInterruptedTransaction:NULL error:&cleanupError];
    if (!rollbackReady) {
        actionError = OreoErrorByAppendingCleanup(
            actionError, @"The interrupted cursor change could not be recovered",
            cleanupError);
    }
    cleanupError = nil;
    BOOL priorThemeUsable = priorEngine.supported && priorEngine.themeValid;
    BOOL restorePriorTheme =
        priorThemeUsable && (priorDesired || priorEffective);
    // candidate.apply can fail after setting desired=true and can internally
    // restore Apple cursors. Always perform an explicit rollback: reapply a
    // valid prior live theme, otherwise restore verified stock state and clear
    // the candidate's desired/effective flags.
    BOOL cursorRestored = rollbackReady &&
        (restorePriorTheme
            ? [priorEngine apply:&cleanupError]
            : [candidate restore:&cleanupError]);
    if (!cursorRestored) {
        actionError = OreoErrorByAppendingCleanup(
            actionError, @"The previous cursor state could not be restored",
            cleanupError);
    }
    cleanupError = nil;
    NSString *rollbackIdentifier = priorThemeUsable
        ? priorIdentifier
        : identifier;
    BOOL selectionRestored = candidateSelectionPersisted && !priorThemeUsable;
    if (!selectionRestored &&
        ![OreoCursorEngine saveSelectedThemeIdentifier:rollbackIdentifier
                                                  error:&cleanupError]) {
        actionError = OreoErrorByAppendingCleanup(
            actionError, @"A valid theme selection could not be restored",
            cleanupError);
    }
    OreoSetLoginItemDesired(priorThemeUsable ? priorLoginDesired : NO);
    *engine = priorThemeUsable ? priorEngine : candidate;
    if (error) {
        *error = actionError ?: OreoSetupError(
            11, @"The cursor theme could not be applied.");
    }
    return NO;
}

static BOOL OreoParseThemeSizePercentage(const char *value,
                                         NSInteger *result) {
    if (!value || value[0] == '\0') {
        return NO;
    }
    errno = 0;
    char *end = NULL;
    long parsed = strtol(value, &end, 10);
    if (errno != 0 || !end || *end != '\0' || parsed < 50 || parsed > 200) {
        return NO;
    }
    if (result) {
        *result = (NSInteger)parsed;
    }
    return YES;
}

int OreoRunCommandLineIfRequested(
    int argc, const char * _Nonnull * _Nonnull argv) {
    if (argc < 2) {
        return -1;
    }
    NSString *command = [NSString stringWithUTF8String:argv[1]];
    NSSet *supportedCommands = [NSSet setWithArray:@[
        @"--status", @"--setup", @"--enable", @"--disable", @"--teardown",
        @"--list-themes", @"--validate-themes", @"--validate-theme",
        @"--select-theme", @"--set-theme-size", @"--forget-theme-size",
        @"--validate-system-fallbacks", @"--apply-theme",
        @"--open-login-settings", @"--reconcile-login-items"
    ]];
    BOOL commandNeedsIdentifier =
        [command isEqual:@"--select-theme"] ||
        [command isEqual:@"--apply-theme"] ||
        [command isEqual:@"--validate-theme"] ||
        [command isEqual:@"--forget-theme-size"];
    BOOL commandNeedsIdentifierAndSize =
        [command isEqual:@"--set-theme-size"];
    if (![supportedCommands containsObject:command] ||
        (commandNeedsIdentifier && argc != 3) ||
        (commandNeedsIdentifierAndSize && argc != 4) ||
        (!commandNeedsIdentifier && !commandNeedsIdentifierAndSize &&
         argc != 2)) {
        fprintf(stderr,
                "Usage: OreoCursor "
                "[--status|--setup|--enable|--disable|--teardown|"
                "--list-themes|--validate-themes|"
                "--validate-theme IDENTIFIER|"
                "--validate-system-fallbacks|"
                "--select-theme IDENTIFIER|--apply-theme IDENTIFIER|"
                "--set-theme-size IDENTIFIER PERCENTAGE|"
                "--forget-theme-size IDENTIFIER|"
                "--reconcile-login-items|"
                "--open-login-settings]\n");
        return 64;
    }

    if ([command isEqual:@"--list-themes"]) {
        OreoPrintJSON([OreoCursorEngine availableThemes]);
        return 0;
    }

    if ([command isEqual:@"--set-theme-size"]) {
        NSString *identifier = [NSString stringWithUTF8String:argv[2]];
        NSInteger sizePercentage = 0;
        NSError *sizeError = nil;
        BOOL success = OreoParseThemeSizePercentage(argv[3], &sizePercentage);
        if (!success) {
            sizeError = OreoSetupError(
                13, @"Cursor size must be an integer between 50%% and 200%%.");
        } else {
            success = [OreoCursorEngine saveSizePercentage:sizePercentage
                                        forThemeIdentifier:identifier
                                                     error:&sizeError];
        }
        NSMutableDictionary *result = [NSMutableDictionary dictionaryWithDictionary:@{
            @"action": command,
            @"identifier": identifier ?: @"",
            @"sizePercentage": @(sizePercentage),
            @"saved": @(success),
        }];
        if (sizeError) {
            result[@"actionError"] = sizeError.localizedDescription;
        }
        OreoPrintJSON([result copy]);
        // This command only persists the configured size. The renderer
        // explicitly reapplies a theme when its active size is committed.
        return success ? 0 : 2;
    }

    if ([command isEqual:@"--forget-theme-size"]) {
        NSString *identifier = [NSString stringWithUTF8String:argv[2]];
        NSError *forgetError = nil;
        BOOL success =
            [OreoCursorEngine
                forgetSizePercentageForThemeIdentifier:identifier
                                                  error:&forgetError];
        NSMutableDictionary *result = [NSMutableDictionary dictionaryWithDictionary:@{
            @"action": command,
            @"identifier": identifier ?: @"",
            @"forgotten": @(success),
        }];
        if (forgetError) {
            result[@"actionError"] = forgetError.localizedDescription;
        }
        OreoPrintJSON([result copy]);
        return success ? 0 : 2;
    }

    if ([command isEqual:@"--validate-themes"]) {
        // Validation decodes every signed resource but never calls apply,
        // restore, or any mutating CoreGraphics registration API.
        [NSApplication sharedApplication];
        NSDictionary *validation = OreoValidateThemeResources();
        OreoPrintJSON(validation);
        return [validation[@"valid"] boolValue] ? 0 : 2;
    }

    if ([command isEqual:@"--validate-theme"]) {
        // This resolves identifiers through the same fixed bundled/imported
        // allowlist as apply, then performs the complete decode without
        // changing cursor registrations or preferences.
        [NSApplication sharedApplication];
        NSString *identifier = [NSString stringWithUTF8String:argv[2]];
        NSError *validationError = nil;
        OreoCursorEngine *validationEngine = [[OreoCursorEngine alloc]
            initWithThemeIdentifier:identifier
                     resourceBundle:NSBundle.mainBundle
                     sizePercentage:100
                              error:&validationError];
        BOOL valid = validationEngine.supported &&
            validationEngine.themeValid;
        NSMutableDictionary *validation =
            [OreoCombinedDiagnostics(validationEngine, command,
                                     validationError) mutableCopy];
        validation[@"valid"] = @(valid);
        OreoPrintJSON([validation copy]);
        return valid ? 0 : 2;
    }

    if ([command isEqual:@"--reconcile-login-items"]) {
        // Login-item reconciliation depends only on ServiceManagement and the
        // embedded helper identity. Avoid decoding the selected cursor and the
        // complete imported-theme store during every packaged app launch.
        [NSApplication sharedApplication];
        NSError *actionError = nil;
        BOOL success = OreoReconcileLoginItems(&actionError);
        NSString *message = success
            ? (OreoLoginItemDesired()
                ? @"Cursor Atelier’s login helper is current."
                : @"Cursor Atelier’s login helper is off.")
            : (actionError.localizedDescription ?:
                @"The Cursor Atelier login helper could not be reconciled.");
        OreoCursorSaveStatus(message, !success, OreoCursorStatusSourceLogin);
        OreoPostSettingsChangedNotification();
        OreoPrintJSON(OreoLoginItemDiagnostics(command, actionError));
        if (!success) {
            return 4;
        }
        return OreoLoginItemService().status ==
            SMAppServiceStatusRequiresApproval ? 5 : 0;
    }

    // Establishes the graphical-session connection used by the cursor APIs.
    // LSUIElement keeps command invocations out of both the Dock and menu bar.
    [NSApplication sharedApplication];

    NSError *engineError = nil;
    OreoCursorEngine *engine =
        [[OreoCursorEngine alloc] initWithError:&engineError];
    if ([command isEqual:@"--status"]) {
        OreoPrintJSON(OreoCombinedDiagnostics(engine, @"status", engineError));
        return engine.supported && engine.themeValid ? 0 : 2;
    }
    if ([command isEqual:@"--validate-system-fallbacks"]) {
        NSError *validationError = nil;
        BOOL valid = [engine validateSystemFallbackResources:&validationError];
        NSMutableDictionary *validation =
            [OreoCombinedDiagnostics(engine, command, validationError)
                mutableCopy];
        validation[@"valid"] = @(valid);
        OreoPrintJSON([validation copy]);
        return valid ? 0 : 2;
    }
    if ([command isEqual:@"--open-login-settings"]) {
        if (@available(macOS 13.0, *)) {
            [SMAppService openSystemSettingsLoginItems];
            OreoPrintJSON(OreoCombinedDiagnostics(engine, command, nil));
            return 0;
        }
        NSError *settingsError = OreoSetupError(
            12, @"Login Items settings are unavailable on this macOS version.");
        OreoPrintJSON(OreoCombinedDiagnostics(engine, command, settingsError));
        return 2;
    }
    BOOL replacesSelectedTheme =
        [command isEqual:@"--select-theme"] ||
        [command isEqual:@"--apply-theme"];
    OreoCursorEngine *recoveryEngine = engine;
    if (replacesSelectedTheme &&
        (!engine.supported || !engine.themeValid)) {
        NSError *candidateError = nil;
        recoveryEngine = [[OreoCursorEngine alloc]
            initWithThemeIdentifier:
                [NSString stringWithUTF8String:argv[2]]
                 resourceBundle:NSBundle.mainBundle
                 sizePercentage:[OreoCursorEngine
                     sizePercentageForThemeIdentifier:
                         [NSString stringWithUTF8String:argv[2]]]
                          error:&candidateError];
        if (!recoveryEngine.supported || !recoveryEngine.themeValid) {
            engineError = candidateError;
        }
    }
    BOOL requiresSelectedTheme =
        [command isEqual:@"--setup"] || [command isEqual:@"--enable"];
    if (!recoveryEngine.supported ||
        (requiresSelectedTheme && !engine.themeValid)) {
        OreoSaveCommandStatus(recoveryEngine, command, NO, engineError,
                              OreoCursorStatusSourceCursor);
        OreoPostSettingsChangedNotification();
        OreoPrintJSON(OreoCombinedDiagnostics(
            recoveryEngine, command, engineError));
        return 2;
    }

    NSError *actionError = nil;
    if (![recoveryEngine recoverInterruptedTransaction:NULL
                                                  error:&actionError]) {
        OreoSaveCommandStatus(recoveryEngine, command, NO, actionError,
                              OreoCursorStatusSourceCursor);
        OreoPostSettingsChangedNotification();
        OreoPrintJSON(OreoCombinedDiagnostics(
            recoveryEngine, command, actionError));
        return 3;
    }

    BOOL success = YES;
    NSString *actionSource = OreoCursorStatusSourceCursor;
    if ([command isEqual:@"--setup"]) {
        BOOL priorLoginDesired = OreoLoginItemDesired();
        BOOL wasDesired =
            [OreoCursorDefaults() boolForKey:OreoCursorEnabledDefaultsKey];
        BOOL wasEffective =
            [OreoCursorDefaults() boolForKey:OreoCursorEffectiveDefaultsKey];
        SMAppServiceStatus priorHelperStatus = OreoLoginItemService().status;
        BOOL helperWasRegistered =
            priorHelperStatus == SMAppServiceStatusEnabled ||
            priorHelperStatus == SMAppServiceStatusRequiresApproval;
        if (!wasDesired && wasEffective) {
            actionError = OreoSetupError(
                8, @"Finish restoring Apple cursors before running setup.");
            success = NO;
        }
        if (success) {
            success = [engine apply:&actionError];
        }
        if (success) {
            actionSource = OreoCursorStatusSourceLogin;
            success = OreoRegisterLoginItem(&actionError);
        }
        BOOL helperWasCreated =
            !helperWasRegistered &&
            (OreoLoginItemService().status == SMAppServiceStatusEnabled ||
             OreoLoginItemService().status ==
                 SMAppServiceStatusRequiresApproval);
        if (success) {
            success = OreoUnregisterLegacyMainLoginItem(&actionError);
        }
        if (success) {
            OreoSetLoginItemDesired(YES);
        }
        if (!success) {
            if (helperWasCreated) {
                NSError *cleanupError = nil;
                if (!OreoUnregisterLoginItem(&cleanupError)) {
                    actionError = OreoErrorByAppendingCleanup(
                        actionError, @"The new helper could not be removed",
                        cleanupError);
                }
            }
            if (!wasDesired && !wasEffective) {
                NSError *restoreError = nil;
                if (![engine restore:&restoreError]) {
                    actionError = OreoErrorByAppendingCleanup(
                        actionError, @"Apple cursors could not be restored",
                        restoreError);
                }
            }
            OreoSetLoginItemDesired(priorLoginDesired);
        }
    } else if ([command isEqual:@"--enable"]) {
        success = [engine apply:&actionError];
    } else if ([command isEqual:@"--disable"]) {
        success = [engine restore:&actionError];
    } else if ([command isEqual:@"--teardown"]) {
        BOOL priorLoginDesired = OreoLoginItemDesired();
        OreoSetLoginItemDesired(NO);
        success = [engine restore:&actionError];
        if (success) {
            actionSource = OreoCursorStatusSourceLogin;
            NSError *loginError = nil;
            BOOL removedHelper = OreoUnregisterLoginItem(&loginError);
            NSError *legacyError = nil;
            BOOL removedLegacy =
                OreoUnregisterLegacyMainLoginItem(&legacyError);
            if (!removedHelper) {
                actionError = loginError;
            } else if (!removedLegacy) {
                actionError = legacyError;
            }
            success = removedHelper && removedLegacy;
        }
        if (!success) {
            OreoSetLoginItemDesired(priorLoginDesired);
        }
    } else if ([command isEqual:@"--select-theme"]) {
        NSString *identifier = [NSString stringWithUTF8String:argv[2]];
        success = OreoSelectTheme(identifier, &engine, &actionError);
    } else if ([command isEqual:@"--apply-theme"]) {
        NSString *identifier = [NSString stringWithUTF8String:argv[2]];
        success = OreoApplyTheme(identifier, &engine, &actionError);
    }
    [OreoCursorDefaults() synchronize];
    OreoSaveCommandStatus(engine, command, success, actionError, actionSource);
    OreoPostSettingsChangedNotification();

    BOOL approvalRequired =
        ([command isEqual:@"--setup"] ||
         [command isEqual:@"--apply-theme"]) &&
        OreoLoginItemService().status ==
            SMAppServiceStatusRequiresApproval;
    OreoPrintJSON(OreoCombinedDiagnostics(engine, command, actionError));
    if (!success) {
        return 4;
    }
    return approvalRequired ? 5 : 0;
}
