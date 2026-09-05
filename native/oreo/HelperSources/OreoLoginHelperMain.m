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
    if ((!self.engine || !self.engine.supported) &&
        ![self reloadEngine:error]) {
        return NO;
    }
    BOOL recovered = NO;
    OreoCursorEngine *current =
        [self.engine reconcileSelectedTheme:&recovered error:error];
    if (!current) {
        return NO;
    }
    self.engine = current;
    if (recovered) {
        [self setLastStatus:
            @"An interrupted cursor change was safely restored; the custom "
             "theme is off."
                    isError:NO];
    } else if (!current.themeValid) {
        [self setLastStatus:
            @"The selected cursor theme is unavailable; Apple cursors are active."
                    isError:YES];
    } else if ([OreoCursorDefaults()
                   boolForKey:OreoCursorEnabledDefaultsKey]) {
        [self setLastStatus:[NSString stringWithFormat:
            @"%@ is active.", current.themeDisplayName]
                    isError:NO];
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
