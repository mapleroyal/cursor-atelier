#import "OreoAppDelegate.h"

#import "OreoAppController.h"
#import "OreoCursorEngine.h"
#import <ServiceManagement/ServiceManagement.h>

@interface OreoAppDelegate ()

@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) OreoCursorEngine *engine;
@property (nonatomic, strong) NSPopUpButton *themePopup;
@property (nonatomic, strong) NSButton *cursorToggle;
@property (nonatomic, strong) NSButton *loginToggle;
@property (nonatomic, strong) NSButton *loginApprovalButton;
@property (nonatomic, strong) NSImageView *statusImageView;
@property (nonatomic, strong) NSTextField *statusLabel;
@property (nonatomic, strong) NSButton *reapplyButton;
@property (nonatomic, copy) NSString *statusMessage;
@property (nonatomic, copy) NSString *statusSource;
@property (nonatomic) BOOL statusIsError;
@property (nonatomic) BOOL busy;

- (void)refreshExternalState;
- (void)settingsDidChange:(NSNotification *)notification;
- (void)openLoginSettings:(id)sender;
- (void)setLoginErrorStatus:(NSString *)status;

@end

@implementation OreoAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *selected = [OreoCursorEngine selectedThemeIdentifier];
    [OreoCursorEngine saveSelectedThemeIdentifier:selected error:NULL];

    NSError *engineError = nil;
    self.engine = [[OreoCursorEngine alloc] initWithError:&engineError];
    BOOL recovered = NO;
    NSError *recoveryError = nil;
    if (self.engine.supported &&
        ![self.engine recoverInterruptedTransaction:&recovered
                                              error:&recoveryError]) {
        [self setErrorStatus:recoveryError.localizedDescription];
    } else if (!self.engine.supported) {
        [self setErrorStatus:engineError.localizedDescription ?: @"Unsupported"];
    } else if (!self.engine.themeValid) {
        NSError *restoreError = nil;
        if ([self.engine restore:&restoreError]) {
            [self setSuccessStatus:
                @"Cursor artwork validation failed; Apple cursors were restored."];
        } else {
            [self setErrorStatus:restoreError.localizedDescription ?:
                engineError.localizedDescription];
        }
    } else if (recovered) {
        [self setSuccessStatus:
            @"An interrupted cursor change was safely restored; the custom "
             "theme is off."];
    } else if ([OreoCursorDefaults()
                   boolForKey:OreoCursorEnabledDefaultsKey]) {
        NSError *applyError = nil;
        if ([self.engine apply:&applyError]) {
            [self setSuccessStatus:[NSString stringWithFormat:
                @"The %@ cursor theme is active.",
                self.engine.themeDisplayName]];
        } else {
            [self setErrorStatus:applyError.localizedDescription];
        }
    } else if ([OreoCursorDefaults()
                   boolForKey:OreoCursorEffectiveDefaultsKey]) {
        NSError *restoreError = nil;
        if ([self.engine restore:&restoreError]) {
            [self setSuccessStatus:@"Apple cursors are active."];
        } else {
            [self setErrorStatus:restoreError.localizedDescription];
        }
    } else {
        [self setSuccessStatus:@"Apple cursors are active."];
    }

    BOOL launchAtLoginDesired = OreoLoginItemDesired();
    if (launchAtLoginDesired) {
        NSError *updateError = nil;
        if (OreoRegisterLoginItem(&updateError)) {
            if (OreoSetLoginItemDesired(YES, &updateError)) {
                [self clearResolvedLoginError];
            } else {
                [self setLoginErrorStatus:updateError.localizedDescription];
            }
        } else {
            [self setLoginErrorStatus:updateError.localizedDescription];
        }
    } else {
        BOOL cursorDesired =
            [OreoCursorDefaults() boolForKey:OreoCursorEnabledDefaultsKey];
        BOOL cursorEffective =
            [OreoCursorDefaults() boolForKey:OreoCursorEffectiveDefaultsKey];
        BOOL restoreIncomplete = !cursorDesired && cursorEffective;
        if (!restoreIncomplete) {
            NSError *helperRemovalError = nil;
            BOOL removedHelper =
                OreoUnregisterLoginItem(&helperRemovalError);
            NSError *legacyRemovalError = nil;
            BOOL removedLegacy =
                OreoUnregisterLegacyMainLoginItem(&legacyRemovalError);
            if (removedHelper && removedLegacy) {
                [self clearResolvedLoginError];
            } else {
                [self setLoginErrorStatus:
                    (helperRemovalError ?: legacyRemovalError)
                        .localizedDescription];
            }
        }
    }

    NSError *migrationError = nil;
    if (!OreoMigrateLegacyLoginItemIfNeeded(&migrationError)) {
        [self setLoginErrorStatus:migrationError.localizedDescription];
    }
    [self createWindow];
    [self updateControls];
    [self showSettingsWindow];
}

- (NSTextField *)labelWithString:(NSString *)string
                            font:(NSFont *)font {
    NSTextField *label = [NSTextField labelWithString:string];
    label.font = font;
    label.selectable = NO;
    return label;
}

- (NSImage *)previewImageForTheme:
                 (NSDictionary<NSString *, id> *)theme {
    NSURL *previewURL = [OreoCursorEngine
        themePreviewURLForTheme:theme];
    NSImage *image = previewURL
        ? [[NSImage alloc] initByReferencingURL:previewURL] : nil;
    image.size = NSMakeSize(22, 22);
    return image;
}

- (void)populateThemePopup {
    [self.themePopup removeAllItems];
    NSString *previousGroup = nil;
    for (NSDictionary<NSString *, id> *theme in
             [OreoCursorEngine availableThemes]) {
        NSString *group = theme[@"Group"];
        if (previousGroup && ![previousGroup isEqualToString:group]) {
            [self.themePopup.menu addItem:[NSMenuItem separatorItem]];
        }
        NSMenuItem *item =
            [[NSMenuItem alloc] initWithTitle:theme[@"DisplayName"]
                                      action:nil
                               keyEquivalent:@""];
        item.representedObject = theme[@"Identifier"];
        item.image = [self previewImageForTheme:theme];
        [self.themePopup.menu addItem:item];
        previousGroup = group;
    }
}

- (NSView *)statusView {
    NSView *view = [[NSView alloc] initWithFrame:NSZeroRect];
    view.translatesAutoresizingMaskIntoConstraints = NO;
    view.wantsLayer = YES;
    view.layer.cornerRadius = 8.0;
    view.layer.backgroundColor =
        NSColor.controlBackgroundColor.CGColor;

    self.statusImageView =
        [[NSImageView alloc] initWithFrame:NSZeroRect];
    self.statusImageView.translatesAutoresizingMaskIntoConstraints = NO;
    self.statusImageView.imageScaling = NSImageScaleProportionallyUpOrDown;
    self.statusLabel = [self labelWithString:@""
                                       font:[NSFont systemFontOfSize:12.0]];
    self.statusLabel.translatesAutoresizingMaskIntoConstraints = NO;
    self.statusLabel.maximumNumberOfLines = 4;
    self.statusLabel.lineBreakMode = NSLineBreakByWordWrapping;
    self.statusLabel.alignment = NSTextAlignmentLeft;
    [self.statusLabel
        setContentHuggingPriority:NSLayoutPriorityRequired
                  forOrientation:NSLayoutConstraintOrientationVertical];
    [self.statusLabel
        setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow
                                 forOrientation:
                                     NSLayoutConstraintOrientationHorizontal];
    NSStackView *statusContent =
        [[NSStackView alloc] initWithFrame:NSZeroRect];
    statusContent.translatesAutoresizingMaskIntoConstraints = NO;
    statusContent.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    statusContent.alignment = NSLayoutAttributeTop;
    statusContent.spacing = 10.0;
    [statusContent addArrangedSubview:self.statusImageView];
    [statusContent addArrangedSubview:self.statusLabel];
    [view addSubview:statusContent];
    [NSLayoutConstraint activateConstraints:@[
        [statusContent.leadingAnchor
            constraintEqualToAnchor:view.leadingAnchor constant:12.0],
        [statusContent.trailingAnchor
            constraintEqualToAnchor:view.trailingAnchor constant:-12.0],
        [statusContent.centerYAnchor
            constraintEqualToAnchor:view.centerYAnchor],
        [statusContent.topAnchor
            constraintGreaterThanOrEqualToAnchor:view.topAnchor constant:10.0],
        [statusContent.bottomAnchor
            constraintLessThanOrEqualToAnchor:view.bottomAnchor constant:-10.0],
        [self.statusImageView.widthAnchor constraintEqualToConstant:20.0],
        [self.statusImageView.heightAnchor constraintEqualToConstant:20.0],
        [view.heightAnchor constraintGreaterThanOrEqualToConstant:52.0],
    ]];
    return view;
}

- (void)createWindow {
    NSRect frame = NSMakeRect(0, 0, 460, 380);
    self.window = [[NSWindow alloc]
        initWithContentRect:frame
                  styleMask:NSWindowStyleMaskTitled |
                            NSWindowStyleMaskClosable
                    backing:NSBackingStoreBuffered
                      defer:NO];
    self.window.title = @"Cursor Atelier";
    self.window.delegate = self;
    self.window.releasedWhenClosed = NO;
    self.window.restorable = NO;
    self.window.movableByWindowBackground = YES;
    [self.window center];

    NSView *content = self.window.contentView;
    NSStackView *root = [[NSStackView alloc] initWithFrame:NSZeroRect];
    root.translatesAutoresizingMaskIntoConstraints = NO;
    root.orientation = NSUserInterfaceLayoutOrientationVertical;
    root.alignment = NSLayoutAttributeLeading;
    root.spacing = 14.0;
    [content addSubview:root];

    NSStackView *header = [[NSStackView alloc] initWithFrame:NSZeroRect];
    header.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    header.alignment = NSLayoutAttributeCenterY;
    header.spacing = 18.0;
    NSImageView *headerIcon = [[NSImageView alloc] initWithFrame:NSZeroRect];
    headerIcon.translatesAutoresizingMaskIntoConstraints = NO;
    NSURL *brandMarkURL =
        [NSBundle.mainBundle URLForResource:@"BrandMark" withExtension:@"svg"];
    NSImage *brandMark = brandMarkURL
        ? [[NSImage alloc] initWithContentsOfURL:brandMarkURL] : nil;
    brandMark.template = YES;
    brandMark.accessibilityDescription = @"Cursor Atelier";
    headerIcon.image = brandMark;
    headerIcon.imageScaling = NSImageScaleProportionallyUpOrDown;
    headerIcon.contentTintColor = NSColor.controlAccentColor;
    [NSLayoutConstraint activateConstraints:@[
        [headerIcon.widthAnchor constraintEqualToConstant:82.0],
        [headerIcon.heightAnchor constraintEqualToConstant:82.0],
    ]];
    NSStackView *headerText = [[NSStackView alloc] initWithFrame:NSZeroRect];
    headerText.orientation = NSUserInterfaceLayoutOrientationVertical;
    headerText.alignment = NSLayoutAttributeLeading;
    headerText.spacing = 2.0;
    [headerText addArrangedSubview:
        [self labelWithString:@"Cursor Atelier"
                         font:[NSFont systemFontOfSize:21.0
                                              weight:NSFontWeightSemibold]]];
    NSTextField *subtitle =
        [self labelWithString:@"Choose a color and apply it to this Mac."
                         font:[NSFont systemFontOfSize:12.0]];
    subtitle.textColor = NSColor.secondaryLabelColor;
    [headerText addArrangedSubview:subtitle];
    [header addArrangedSubview:headerIcon];
    [header addArrangedSubview:headerText];
    [root addArrangedSubview:header];

    NSStackView *themeRow = [[NSStackView alloc] initWithFrame:NSZeroRect];
    themeRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    themeRow.alignment = NSLayoutAttributeCenterY;
    themeRow.spacing = 12.0;
    NSTextField *colorLabel =
        [self labelWithString:@"Color:"
                         font:[NSFont systemFontOfSize:13.0
                                              weight:NSFontWeightMedium]];
    [colorLabel.widthAnchor constraintEqualToConstant:54.0].active = YES;
    self.themePopup = [[NSPopUpButton alloc] initWithFrame:NSZeroRect
                                                 pullsDown:NO];
    self.themePopup.target = self;
    self.themePopup.action = @selector(changeTheme:);
    [self.themePopup.widthAnchor constraintEqualToConstant:250.0].active = YES;
    [self populateThemePopup];
    [themeRow addArrangedSubview:colorLabel];
    [themeRow addArrangedSubview:self.themePopup];
    [root addArrangedSubview:themeRow];

    self.cursorToggle =
        [NSButton checkboxWithTitle:@"Use custom cursors"
                             target:self
                             action:@selector(toggleCursor:)];
    self.cursorToggle.allowsMixedState = YES;

    self.loginToggle =
        [NSButton checkboxWithTitle:@"Start invisibly at login"
                             target:self
                             action:@selector(toggleLogin:)];
    self.loginToggle.allowsMixedState = YES;
    self.loginApprovalButton =
        [NSButton buttonWithTitle:@"Open Login Items…"
                           target:self
                           action:@selector(openLoginSettings:)];
    self.loginApprovalButton.hidden = YES;
    NSView *loginSpacer = [[NSView alloc] initWithFrame:NSZeroRect];
    [loginSpacer
        setContentHuggingPriority:NSLayoutPriorityDefaultLow
                  forOrientation:NSLayoutConstraintOrientationHorizontal];
    NSStackView *loginRow =
        [[NSStackView alloc] initWithFrame:NSZeroRect];
    loginRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    loginRow.alignment = NSLayoutAttributeFirstBaseline;
    loginRow.spacing = 8.0;
    [loginRow addArrangedSubview:self.loginToggle];
    [loginRow addArrangedSubview:loginSpacer];
    [loginRow addArrangedSubview:self.loginApprovalButton];
    NSStackView *toggleGroup =
        [[NSStackView alloc] initWithFrame:NSZeroRect];
    toggleGroup.orientation = NSUserInterfaceLayoutOrientationVertical;
    toggleGroup.alignment = NSLayoutAttributeLeading;
    toggleGroup.spacing = 6.0;
    [toggleGroup addArrangedSubview:self.cursorToggle];
    [toggleGroup addArrangedSubview:loginRow];
    [root addArrangedSubview:toggleGroup];

    NSView *status = [self statusView];
    [root addArrangedSubview:status];

    NSStackView *buttons = [[NSStackView alloc] initWithFrame:NSZeroRect];
    buttons.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    buttons.alignment = NSLayoutAttributeCenterY;
    buttons.spacing = 8.0;
    NSButton *aboutButton =
        [NSButton buttonWithTitle:@"About & Licenses…"
                           target:self
                           action:@selector(showAbout:)];
    self.reapplyButton =
        [NSButton buttonWithTitle:@"Reapply"
                           target:self
                           action:@selector(reapply:)];
    NSButton *doneButton =
        [NSButton buttonWithTitle:@"Done"
                           target:self
                           action:@selector(done:)];
    doneButton.keyEquivalent = @"\r";
    NSView *spacer = [[NSView alloc] initWithFrame:NSZeroRect];
    [spacer setContentHuggingPriority:NSLayoutPriorityDefaultLow
                       forOrientation:NSLayoutConstraintOrientationHorizontal];
    [buttons addArrangedSubview:aboutButton];
    [buttons addArrangedSubview:spacer];
    [buttons addArrangedSubview:self.reapplyButton];
    [buttons addArrangedSubview:doneButton];
    [root addArrangedSubview:buttons];

    [NSLayoutConstraint activateConstraints:@[
        [root.leadingAnchor constraintEqualToAnchor:content.leadingAnchor
                                          constant:24.0],
        [root.trailingAnchor constraintEqualToAnchor:content.trailingAnchor
                                           constant:-24.0],
        [root.topAnchor constraintEqualToAnchor:content.topAnchor
                                      constant:22.0],
        [root.bottomAnchor constraintEqualToAnchor:content.bottomAnchor
                                         constant:-20.0],
        [header.widthAnchor constraintEqualToAnchor:root.widthAnchor],
        [themeRow.widthAnchor constraintEqualToAnchor:root.widthAnchor],
        [toggleGroup.widthAnchor constraintEqualToAnchor:root.widthAnchor],
        [self.cursorToggle.widthAnchor
            constraintEqualToAnchor:toggleGroup.widthAnchor],
        [loginRow.widthAnchor constraintEqualToAnchor:toggleGroup.widthAnchor],
        [status.widthAnchor constraintEqualToAnchor:root.widthAnchor],
        [buttons.widthAnchor constraintEqualToAnchor:root.widthAnchor],
    ]];

    [[NSDistributedNotificationCenter defaultCenter]
        addObserver:self
           selector:@selector(settingsDidChange:)
               name:OreoSettingsChangedNotification
             object:nil];
    [[NSDistributedNotificationCenter defaultCenter]
        addObserver:self
           selector:@selector(settingsDidChange:)
               name:OreoStatusChangedNotification
             object:nil];
}

- (void)showSettingsWindow {
    [self refreshExternalState];
    [self updateControls];
    if (@available(macOS 14.0, *)) {
        [NSApp activate];
    } else {
        [NSApp activateIgnoringOtherApps:YES];
    }
    [self.window makeKeyAndOrderFront:nil];
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender
                    hasVisibleWindows:(BOOL)flag {
    (void)sender;
    (void)flag;
    [self showSettingsWindow];
    return YES;
}

- (void)applicationDidBecomeActive:(NSNotification *)notification {
    (void)notification;
    [self refreshExternalState];
    [self updateControls];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:
            (NSApplication *)sender {
    (void)sender;
    return YES;
}

- (void)setLastStatus:(NSString *)status
               isError:(BOOL)isError
                source:(NSString *)source {
    if (status.length == 0) {
        return;
    }
    if (OreoCursorSaveStatus(status, isError, source)) {
        self.statusMessage = status;
        self.statusIsError = isError;
        self.statusSource = source;
    } else {
        NSUserDefaults *defaults = OreoCursorDefaults();
        [defaults synchronize];
        self.statusMessage =
            [defaults stringForKey:OreoCursorLastStatusDefaultsKey];
        self.statusIsError =
            [defaults boolForKey:OreoCursorLastStatusIsErrorDefaultsKey];
        self.statusSource =
            [defaults stringForKey:OreoCursorLastStatusSourceDefaultsKey];
    }
}

- (void)setSuccessStatus:(NSString *)status {
    [self setLastStatus:status
                isError:NO
                 source:OreoCursorStatusSourceCursor];
}

- (void)setErrorStatus:(NSString *)status {
    [self setLastStatus:status
                isError:YES
                 source:OreoCursorStatusSourceCursor];
}

- (void)setLoginErrorStatus:(NSString *)status {
    [self setLastStatus:status
                isError:YES
                 source:OreoCursorStatusSourceLogin];
}

- (void)clearResolvedLoginError {
    if (![self.statusSource
            isEqualToString:OreoCursorStatusSourceLogin]) {
        return;
    }
    BOOL desired =
        [OreoCursorDefaults() boolForKey:OreoCursorEnabledDefaultsKey];
    BOOL effective =
        [OreoCursorDefaults() boolForKey:OreoCursorEffectiveDefaultsKey];
    NSString *message =
        desired && effective ?
            [NSString stringWithFormat:@"The %@ cursor theme is active.",
                                       self.engine.themeDisplayName] :
            @"Apple cursors are active.";
    [self setLastStatus:message
                isError:NO
                 source:OreoCursorStatusSourceLogin];
}

- (NSString *)lastStatus {
    return self.statusMessage ?:
        [OreoCursorDefaults()
            stringForKey:OreoCursorLastStatusDefaultsKey] ?: @"Ready.";
}

- (NSMenuItem *)selectedThemeItem {
    NSString *selected = [OreoCursorEngine selectedThemeIdentifier];
    for (NSMenuItem *item in self.themePopup.itemArray) {
        if ([item.representedObject isEqual:selected]) {
            return item;
        }
    }
    return nil;
}

- (void)refreshExternalState {
    NSUserDefaults *defaults = OreoCursorDefaults();
    [defaults synchronize];
    NSString *persistedStatus =
        [defaults stringForKey:OreoCursorLastStatusDefaultsKey];
    NSString *persistedSource =
        [defaults stringForKey:OreoCursorLastStatusSourceDefaultsKey];
    if (persistedStatus.length > 0) {
        self.statusMessage = persistedStatus;
    }
    if (persistedSource.length > 0) {
        self.statusSource = persistedSource;
    }
    self.statusIsError =
        [defaults boolForKey:OreoCursorLastStatusIsErrorDefaultsKey];

    SMAppServiceStatus helperStatus = OreoLoginItemService().status;
    SMAppServiceStatus legacyStatus = SMAppService.mainAppService.status;
    BOOL legacyRegistered =
        legacyStatus == SMAppServiceStatusEnabled ||
        legacyStatus == SMAppServiceStatusRequiresApproval;
    BOOL loginDesired = OreoLoginItemDesired();
    BOOL loginResolved =
        loginDesired ?
            (helperStatus == SMAppServiceStatusEnabled &&
             OreoLoginItemRegistrationCurrent() && !legacyRegistered) :
            ((helperStatus == SMAppServiceStatusNotRegistered ||
              helperStatus == SMAppServiceStatusNotFound) &&
             !legacyRegistered);
    if (self.statusIsError &&
        [self.statusSource
            isEqualToString:OreoCursorStatusSourceLogin] &&
        loginResolved) {
        [self clearResolvedLoginError];
    }

    NSString *selected = [OreoCursorEngine selectedThemeIdentifier];
    BOOL effective =
        [defaults boolForKey:OreoCursorEffectiveDefaultsKey];
    NSInteger expectedSize = effective
        ? [OreoCursorEngine effectiveSizePercentage]
        : [OreoCursorEngine sizePercentageForThemeIdentifier:selected];
    if (self.engine.supported &&
        self.engine.themeValid &&
        [self.engine.themeIdentifier isEqualToString:selected] &&
        self.engine.themeSizePercentage == expectedSize &&
        !(self.engine.lastErrorMessage.length > 0 &&
          !self.statusIsError)) {
        return;
    }

    NSError *error = nil;
    OreoCursorEngine *candidate = [[OreoCursorEngine alloc]
        initWithThemeIdentifier:selected
                 resourceBundle:NSBundle.mainBundle
                          error:&error];
    if (candidate.supported && candidate.themeValid) {
        self.engine = candidate;
    } else {
        [self setErrorStatus:error.localizedDescription ?:
            @"The selected cursor theme could not be loaded."];
    }
}

- (void)settingsDidChange:(NSNotification *)notification {
    (void)notification;
    if (self.busy) {
        return;
    }
    [self refreshExternalState];
    [self updateControls];
}

- (void)updateControls {
    if (!self.window) {
        return;
    }
    BOOL desired =
        [OreoCursorDefaults() boolForKey:OreoCursorEnabledDefaultsKey];
    BOOL effective =
        [OreoCursorDefaults() boolForKey:OreoCursorEffectiveDefaultsKey];
    BOOL restoreIncomplete = !desired && effective;
    self.cursorToggle.state =
        desired ? NSControlStateValueOn :
        restoreIncomplete ? NSControlStateValueMixed : NSControlStateValueOff;
    self.cursorToggle.enabled =
        !self.busy && self.engine.supported &&
        (self.engine.themeValid || effective);

    NSMenuItem *selectedItem = [self selectedThemeItem];
    if (selectedItem) {
        [self.themePopup selectItem:selectedItem];
    }
    self.themePopup.enabled =
        !self.busy && self.engine.supported && self.engine.themeValid &&
        !restoreIncomplete;

    SMAppServiceStatus loginStatus = OreoLoginItemService().status;
    SMAppServiceStatus legacyStatus = SMAppService.mainAppService.status;
    BOOL loginDesired = OreoLoginItemDesired();
    BOOL helperEnabled =
        loginStatus == SMAppServiceStatusEnabled;
    BOOL helperPending =
        loginStatus == SMAppServiceStatusRequiresApproval;
    BOOL helperCurrent = OreoLoginItemRegistrationCurrent();
    BOOL legacyRegistered =
        legacyStatus == SMAppServiceStatusEnabled ||
        legacyStatus == SMAppServiceStatusRequiresApproval;
    BOOL startupNeedsRepair =
        loginDesired &&
        ((!helperEnabled && !helperPending) || !helperCurrent);
    BOOL startupNeedsRemoval =
        !loginDesired &&
        (helperEnabled || helperPending || legacyRegistered);
    self.loginToggle.state =
        loginDesired && helperEnabled && helperCurrent &&
        !legacyRegistered ?
            NSControlStateValueOn :
        (helperPending || legacyRegistered || startupNeedsRepair ||
         startupNeedsRemoval) ? NSControlStateValueMixed :
            NSControlStateValueOff;
    self.loginToggle.title = @"Start invisibly at login";
    self.loginToggle.enabled = !self.busy;
    self.loginApprovalButton.hidden =
        !loginDesired || !helperPending;
    self.loginApprovalButton.enabled = !self.busy;
    self.reapplyButton.enabled =
        desired && !self.busy && self.engine.supported &&
        self.engine.themeValid;

    NSString *symbol = @"cursorarrow";
    NSColor *tint = NSColor.secondaryLabelColor;
    NSString *stateText = [self lastStatus];
    if (desired && effective && self.engine.lastErrorMessage.length == 0 &&
        !self.statusIsError &&
        !helperPending && !legacyRegistered && !startupNeedsRepair &&
        !startupNeedsRemoval) {
        symbol = @"checkmark.circle.fill";
        tint = NSColor.systemGreenColor;
        stateText = [NSString stringWithFormat:
            @"The %@ cursor theme is active.", self.engine.themeDisplayName];
    } else if (self.statusIsError || restoreIncomplete ||
               (desired && !effective) ||
               self.engine.lastErrorMessage.length > 0 ||
               helperPending || legacyRegistered || startupNeedsRepair ||
               startupNeedsRemoval) {
        symbol = @"exclamationmark.triangle.fill";
        tint = NSColor.systemOrangeColor;
        if (helperPending && loginDesired &&
            desired && effective && !self.statusIsError) {
            stateText = [NSString stringWithFormat:
                @"The %@ cursor theme is active. Startup needs approval in "
                 "System "
                 "Settings.", self.engine.themeDisplayName];
        } else if (helperPending && loginDesired && !self.statusIsError) {
            stateText =
                @"Apple cursors are active. Startup needs approval in System "
                 "Settings.";
        } else if (startupNeedsRemoval && !self.statusIsError) {
            stateText =
                @"Launch at login is off, but an old startup item still "
                 "needs removal.";
        } else if (legacyRegistered && !self.statusIsError) {
            stateText =
                @"An older Cursor Atelier startup item is still active and needs "
                 "cleanup.";
        } else if (startupNeedsRepair && !self.statusIsError) {
            stateText =
                @"Launch at login is selected, but its helper needs to be "
                 "registered again.";
        }
    }
    self.statusImageView.image =
        [NSImage imageWithSystemSymbolName:symbol
                  accessibilityDescription:@"Cursor Atelier status"];
    self.statusImageView.contentTintColor = tint;
    self.statusLabel.stringValue = stateText;
}

- (void)presentError:(NSError *)error {
    if (!error) {
        return;
    }
    NSAlert *alert = [NSAlert alertWithError:error];
    [alert beginSheetModalForWindow:self.window completionHandler:nil];
}

- (void)toggleCursor:(NSButton *)sender {
    (void)sender;
    if (self.busy) {
        return;
    }
    self.busy = YES;
    BOOL desired =
        [OreoCursorDefaults() boolForKey:OreoCursorEnabledDefaultsKey];
    BOOL effective =
        [OreoCursorDefaults() boolForKey:OreoCursorEffectiveDefaultsKey];
    BOOL turnOn = !desired && !effective;
    NSError *error = nil;
    BOOL success = turnOn ? [self.engine apply:&error]
                          : [self.engine restore:&error];
    NSString *message =
        success ?
            (turnOn ? [NSString stringWithFormat:
                           @"The %@ cursor theme is active.",
                                                  self.engine.themeDisplayName]
                    : @"Apple cursors are active.")
                : error.localizedDescription;
    if (success) {
        [self setSuccessStatus:message];
    } else {
        [self setErrorStatus:message];
    }
    self.busy = NO;
    [self updateControls];
    OreoPostSettingsChangedNotification();
    if (!success) {
        [self presentError:error];
    }
}

- (void)toggleLogin:(NSButton *)sender {
    (void)sender;
    if (self.busy) {
        return;
    }
    self.busy = YES;
    SMAppServiceStatus status = OreoLoginItemService().status;
    SMAppServiceStatus legacyStatus = SMAppService.mainAppService.status;
    BOOL loginDesired = OreoLoginItemDesired();
    BOOL anyRegistered =
        status == SMAppServiceStatusEnabled ||
        status == SMAppServiceStatusRequiresApproval ||
        legacyStatus == SMAppServiceStatusEnabled ||
        legacyStatus == SMAppServiceStatusRequiresApproval;
    NSError *error = nil;
    BOOL success = YES;
    if (anyRegistered || loginDesired) {
        success = OreoSetLoginItemDesired(NO, &error);
        if (success) {
            success = OreoUnregisterLoginItem(&error);
        }
        NSError *legacyError = nil;
        BOOL removedLegacy = success
            ? OreoUnregisterLegacyMainLoginItem(&legacyError)
            : NO;
        if (success && !removedLegacy) {
            error = legacyError;
            success = NO;
        }
    } else {
        success = OreoSetLoginItemDesired(YES, &error);
        BOOL helperWasRegistered =
            status == SMAppServiceStatusEnabled ||
            status == SMAppServiceStatusRequiresApproval;
        if (success) {
            success = OreoRegisterLoginItem(&error);
        }
        if (success) {
            success = OreoUnregisterLegacyMainLoginItem(&error);
        }
        if (!success && !helperWasRegistered &&
            (OreoLoginItemService().status == SMAppServiceStatusEnabled ||
             OreoLoginItemService().status ==
                 SMAppServiceStatusRequiresApproval)) {
            NSError *rollbackError = nil;
            if (!OreoUnregisterLoginItem(&rollbackError)) {
                error = [NSError errorWithDomain:
                    error.domain ?:
                        @"com.cursoratelier.CursorAtelier.NativeCursor"
                                            code:error.code
                                        userInfo:@{
                    NSLocalizedDescriptionKey: [NSString stringWithFormat:
                        @"%@ The newly registered helper also could not be "
                         "removed: %@",
                        error.localizedDescription ?: @"Startup setup failed.",
                        rollbackError.localizedDescription ?:
                            @"unknown error"]
                }];
            }
        }
    }
    if (!success) {
        NSError *rollbackError = nil;
        if (!OreoSetLoginItemDesired(loginDesired, &rollbackError)) {
            error = [NSError errorWithDomain:
                error.domain ?:
                    @"com.cursoratelier.CursorAtelier.NativeCursor"
                                        code:error.code
                                    userInfo:@{
                NSLocalizedDescriptionKey: [NSString stringWithFormat:
                    @"%@ The prior Launch at Login preference also could not be "
                     "restored: %@",
                    error.localizedDescription ?: @"Startup setup failed.",
                    rollbackError.localizedDescription ?: @"unknown error"]
            }];
        }
    }
    self.busy = NO;
    if (success) {
        [self clearResolvedLoginError];
    }
    [self updateControls];
    if (!success) {
        [self setLoginErrorStatus:error.localizedDescription];
        [self updateControls];
        [self presentError:error];
    }
    OreoPostSettingsChangedNotification();
}

- (void)openLoginSettings:(id)sender {
    (void)sender;
    [SMAppService openSystemSettingsLoginItems];
}

- (void)changeTheme:(NSPopUpButton *)sender {
    if (self.busy) {
        return;
    }
    NSString *identifier = sender.selectedItem.representedObject;
    if (![identifier isKindOfClass:[NSString class]] ||
        [identifier isEqualToString:self.engine.themeIdentifier]) {
        return;
    }

    self.busy = YES;
    NSError *error = nil;
    OreoCursorEngine *candidate = [[OreoCursorEngine alloc]
        initWithThemeIdentifier:identifier
                 resourceBundle:NSBundle.mainBundle
                          error:&error];
    BOOL success = candidate.supported && candidate.themeValid;
    BOOL desired =
        [OreoCursorDefaults() boolForKey:OreoCursorEnabledDefaultsKey];
    if (success && desired) {
        success = [candidate apply:&error];
    }
    if (success && !desired) {
        success =
            [OreoCursorEngine saveSelectedThemeIdentifier:identifier
                                                    error:&error];
    }
    if (success) {
        self.engine = candidate;
        [self setSuccessStatus:desired ?
            [NSString stringWithFormat:@"The %@ cursor theme is active.",
                                       candidate.themeDisplayName] :
            [NSString stringWithFormat:@"The %@ cursor theme is selected.",
                                       candidate.themeDisplayName]];
    } else {
        NSError *rollbackError = nil;
        BOOL restoredOldTheme =
            desired && [self.engine apply:&rollbackError];
        if (!restoredOldTheme && rollbackError) {
            error = [NSError errorWithDomain:
                error.domain ?:
                    @"com.cursoratelier.CursorAtelier.NativeCursor"
                                        code:error.code
                                    userInfo:@{
                NSLocalizedDescriptionKey: [NSString stringWithFormat:
                    @"%@ The previous color also could not be reapplied: %@",
                    error.localizedDescription ?: @"Color change failed.",
                    rollbackError.localizedDescription]
            }];
        }
        [self setErrorStatus:error.localizedDescription];
    }
    self.busy = NO;
    [self updateControls];
    OreoPostSettingsChangedNotification();
    if (!success) {
        [self presentError:error];
    }
}

- (void)reapply:(id)sender {
    (void)sender;
    if (self.busy) {
        return;
    }
    self.busy = YES;
    NSError *error = nil;
    BOOL success = [self.engine apply:&error];
    if (success) {
        [self setSuccessStatus:[NSString stringWithFormat:
            @"The %@ cursor theme was reapplied.",
            self.engine.themeDisplayName]];
    } else {
        [self setErrorStatus:error.localizedDescription];
    }
    self.busy = NO;
    [self updateControls];
    OreoPostSettingsChangedNotification();
    if (!success) {
        [self presentError:error];
    }
}

- (void)showAbout:(id)sender {
    (void)sender;
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Cursor Atelier";
    alert.informativeText =
        @"A local macOS cursor theme manager.\n\n"
         "Artwork remains credited to each bundled cursor pack. Oreo artwork "
         "is by Alexey Varfolomeev (varlesh), with additional colors by "
         "Sourav Goswami, under GPL-2.0.";
    [alert addButtonWithTitle:@"OK"];
    [alert addButtonWithTitle:@"Open License"];
    NSModalResponse response = [alert runModal];
    if (response == NSAlertSecondButtonReturn) {
        NSURL *licenseURL = [NSBundle.mainBundle
            URLForResource:@"Oreo-GPL-2.0" withExtension:@"txt"];
        if (licenseURL) {
            [[NSWorkspace sharedWorkspace] openURL:licenseURL];
        }
    }
}

- (void)done:(id)sender {
    (void)sender;
    [self.window close];
}

@end
