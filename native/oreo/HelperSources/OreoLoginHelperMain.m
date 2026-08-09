#import "OreoCursorEngine.h"

#import <Cocoa/Cocoa.h>

static NSString * const OreoSettingsChangedNotification =
    @"com.cursoratelier.CursorAtelier.NativeCursor.SettingsChanged";
static NSString * const OreoStatusChangedNotification =
    @"com.cursoratelier.CursorAtelier.NativeCursor.StatusChanged";

@interface OreoLoginHelperDelegate : NSObject <NSApplicationDelegate>

@property (nonatomic, strong) NSBundle *hostBundle;
@property (nonatomic, strong) OreoCursorEngine *engine;
@property (nonatomic) BOOL busy;
@property (nonatomic) NSUInteger refreshGeneration;
@property (nonatomic) NSUInteger automaticRetryCount;
@property (nonatomic, strong) NSDate *retryCooldownUntil;

@end

@implementation OreoLoginHelperDelegate

- (NSBundle *)validatedHostBundle {
    NSURL *hostURL = NSBundle.mainBundle.bundleURL;
    for (NSUInteger level = 0; level < 4; level++) {
        hostURL = [hostURL URLByDeletingLastPathComponent];
    }
    NSBundle *bundle = [NSBundle bundleWithURL:hostURL];
    if (![bundle.bundleIdentifier
            isEqualToString:
                @"com.cursoratelier.CursorAtelier.NativeCursor"]) {
        NSLog(@"Cursor Atelier Login Helper: invalid native host bundle");
        return nil;
    }
    return bundle;
}

- (void)setLastStatus:(NSString *)status isError:(BOOL)isError {
    if (status.length == 0) {
        return;
    }
    NSUserDefaults *defaults = OreoCursorDefaults();
    NSString *priorStatus =
        [defaults stringForKey:OreoCursorLastStatusDefaultsKey];
    NSString *priorSource =
        [defaults stringForKey:OreoCursorLastStatusSourceDefaultsKey];
    if ([priorStatus isEqualToString:status] &&
        [priorSource isEqualToString:OreoCursorStatusSourceLogin] &&
        [defaults boolForKey:OreoCursorLastStatusIsErrorDefaultsKey] == isError) {
        return;
    }
    if (OreoCursorSaveStatus(status, isError,
                             OreoCursorStatusSourceLogin)) {
        [[NSDistributedNotificationCenter defaultCenter]
            postNotificationName:OreoStatusChangedNotification
                          object:nil
                        userInfo:nil
              deliverImmediately:YES];
    }
}

- (BOOL)reloadEngine:(NSError **)error {
    NSString *selected = [OreoCursorEngine
        selectedThemeIdentifierForResourceBundle:self.hostBundle];
    OreoCursorEngine *candidate = [[OreoCursorEngine alloc]
        initWithThemeIdentifier:selected
                 resourceBundle:self.hostBundle
                          error:error];
    self.engine = candidate;
    // A supported engine can recover or restore stock state even when the
    // selected theme resource itself is missing or invalid.
    return candidate.supported;
}

- (BOOL)bringStateCurrent:(NSError **)error {
    NSUserDefaults *defaults = OreoCursorDefaults();
    [defaults synchronize];
    NSString *selected = [OreoCursorEngine
        selectedThemeIdentifierForResourceBundle:self.hostBundle];
    BOOL effective =
        [defaults boolForKey:OreoCursorEffectiveDefaultsKey];
    NSInteger expectedSize = effective
        ? [OreoCursorEngine effectiveSizePercentage]
        : [OreoCursorEngine sizePercentageForThemeIdentifier:selected];
    BOOL reloaded = NO;
    if (!self.engine ||
        !self.engine.supported ||
        !self.engine.themeValid ||
        ![self.engine.themeIdentifier isEqualToString:selected] ||
        self.engine.themeSizePercentage != expectedSize) {
        NSError *reloadError = nil;
        if (![self reloadEngine:&reloadError]) {
            if (error) {
                *error = reloadError;
            }
            return NO;
        }
        reloaded = YES;
    }

    // A command-line apply or teardown can leave a journal while this helper
    // is already running. Recovery therefore belongs to every refresh pass,
    // not only engine construction or theme changes.
    BOOL recovered = NO;
    if (![self.engine recoverInterruptedTransaction:&recovered error:error]) {
        return NO;
    }
    if (recovered) {
        [self setLastStatus:
            @"An interrupted cursor change was safely restored; the custom "
             "theme is off."
                    isError:NO];
        return YES;
    }

    BOOL desired =
        [defaults boolForKey:OreoCursorEnabledDefaultsKey];
    effective = [defaults boolForKey:OreoCursorEffectiveDefaultsKey];
    if (!self.engine.themeValid) {
        // Restore also handles an ActiveBoot marker when effective state was
        // only partially persisted, and is a no-op for genuinely inactive
        // state. Do not let invalid artwork gate recovery-capable cleanup.
        if (![self.engine restore:error]) {
            return NO;
        }
        [self setLastStatus:
            @"The selected cursor theme is unavailable; Apple cursors are active."
                    isError:YES];
        return YES;
    }
    if (desired) {
        BOOL success = reloaded || !effective
            ? [self.engine apply:error]
            : [self.engine refreshIfNeeded:error];
        if (!success) {
            return NO;
        }
        [self setLastStatus:[NSString stringWithFormat:
            @"%@ is active.", self.engine.themeDisplayName]
                    isError:NO];
    } else if (effective) {
        if (![self.engine restore:error]) {
            return NO;
        }
        [self setLastStatus:@"Apple cursors are active." isError:NO];
    } else {
        [self setLastStatus:@"Apple cursors are active." isError:NO];
    }
    return YES;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    self.hostBundle = [self validatedHostBundle];
    if (!self.hostBundle) {
        [self setLastStatus:
            @"The login helper could not validate the Cursor Atelier app."
                    isError:YES];
        return;
    }

    NSError *startupError = nil;
    if (![self bringStateCurrent:&startupError]) {
        [self setLastStatus:(startupError.localizedDescription ?:
            @"Cursor Atelier could not apply the theme at login.")
                    isError:YES];
        [self scheduleRefreshAfter:2.0 beginIncident:YES];
    }
    [self installRefreshObservers];
}

- (void)installRefreshObservers {
    __weak typeof(self) weakSelf = self;
    NSNotificationCenter *workspaceCenter =
        [NSWorkspace sharedWorkspace].notificationCenter;
    [workspaceCenter addObserverForName:
                         NSWorkspaceDidActivateApplicationNotification
                                 object:nil
                                  queue:NSOperationQueue.mainQueue
                             usingBlock:^(NSNotification *note) {
        (void)note;
        [weakSelf scheduleRefreshAfter:0.15 beginIncident:YES];
    }];
    [workspaceCenter addObserverForName:NSWorkspaceDidWakeNotification
                                 object:nil
                                  queue:NSOperationQueue.mainQueue
                             usingBlock:^(NSNotification *note) {
        (void)note;
        [weakSelf scheduleRefreshAfter:0.5 beginIncident:YES];
    }];
    [[NSNotificationCenter defaultCenter]
        addObserverForName:NSApplicationDidChangeScreenParametersNotification
                    object:nil
                     queue:NSOperationQueue.mainQueue
                usingBlock:^(NSNotification *note) {
        (void)note;
        [weakSelf scheduleRefreshAfter:0.5 beginIncident:YES];
    }];
    [[NSDistributedNotificationCenter defaultCenter]
        addObserverForName:OreoSettingsChangedNotification
                    object:nil
                     queue:NSOperationQueue.mainQueue
                usingBlock:^(NSNotification *note) {
        (void)note;
        weakSelf.automaticRetryCount = 0;
        weakSelf.retryCooldownUntil = nil;
        [weakSelf scheduleRefreshAfter:0.05 beginIncident:YES];
    }];
}

- (void)scheduleRefreshAfter:(NSTimeInterval)delay
               beginIncident:(BOOL)beginIncident {
    if (!self.hostBundle || self.busy) {
        return;
    }
    if (beginIncident && self.automaticRetryCount >= 3) {
        if (self.retryCooldownUntil &&
            [self.retryCooldownUntil timeIntervalSinceNow] > 0) {
            return;
        }
        self.automaticRetryCount = 0;
        self.retryCooldownUntil = nil;
    }
    if (self.automaticRetryCount >= 3) {
        return;
    }
    NSUInteger generation = ++self.refreshGeneration;
    __weak typeof(self) weakSelf = self;
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf || generation != strongSelf.refreshGeneration ||
            strongSelf.busy) {
            return;
        }
        strongSelf.busy = YES;
        NSError *error = nil;
        BOOL success = [strongSelf bringStateCurrent:&error];
        if (success) {
            strongSelf.automaticRetryCount = 0;
            strongSelf.retryCooldownUntil = nil;
        } else {
            strongSelf.automaticRetryCount++;
            [strongSelf setLastStatus:(error.localizedDescription ?:
                @"Cursor Atelier could not refresh the cursor theme.")
                              isError:YES];
            if (strongSelf.automaticRetryCount >= 3) {
                // Bound one failure incident, then allow a later independent
                // wake/screen/application event to begin a fresh sequence.
                strongSelf.retryCooldownUntil =
                    [NSDate dateWithTimeIntervalSinceNow:60.0];
            }
        }
        strongSelf.busy = NO;
        if (!success && strongSelf.automaticRetryCount < 3) {
            NSTimeInterval retryDelay =
                15.0 * (1 << (strongSelf.automaticRetryCount - 1));
            [strongSelf scheduleRefreshAfter:retryDelay
                               beginIncident:NO];
        }
    });
}

@end

int main(int argc, const char *argv[]) {
    (void)argc;
    (void)argv;
    @autoreleasepool {
        NSApplication *application = [NSApplication sharedApplication];
        OreoLoginHelperDelegate *delegate =
            [[OreoLoginHelperDelegate alloc] init];
        application.delegate = delegate;
        [application run];
    }
    return 0;
}
