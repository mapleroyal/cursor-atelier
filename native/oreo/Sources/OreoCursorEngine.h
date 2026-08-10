#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

/// Applies one allowlisted, validated cursor theme and maintains a same-boot
/// recovery snapshot. All methods must be called on the main thread.
@interface OreoCursorEngine : NSObject

@property (nonatomic, readonly) BOOL supported;
@property (nonatomic, readonly) BOOL themeValid;
@property (nonatomic, readonly, copy) NSString *bootSessionUUID;
@property (nonatomic, readonly, copy) NSString *osBuild;
@property (nonatomic, readonly, copy, nullable) NSString *lastErrorMessage;
@property (nonatomic, readonly, copy) NSString *themeIdentifier;
@property (nonatomic, readonly, copy) NSString *themeDisplayName;
@property (nonatomic, readonly) NSInteger themeSizePercentage;

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithError:(NSError * _Nullable * _Nullable)error;

/// Initializes a validated, allowlisted bundled or installed theme. The
/// explicit resource bundle lets the embedded login helper use the outer
/// app's signed artwork; installed themes always resolve from the fixed
/// Application Support store.
- (instancetype)initWithThemeIdentifier:(NSString *)themeIdentifier
                          resourceBundle:(NSBundle *)resourceBundle
                                   error:(NSError * _Nullable * _Nullable)error;

/// Initializes a theme with registration geometry scaled independently from
/// its validated raster representations. The resource itself remains
/// immutable, including frame order and timing.
- (instancetype)initWithThemeIdentifier:(NSString *)themeIdentifier
                          resourceBundle:(NSBundle *)resourceBundle
                          sizePercentage:(NSInteger)sizePercentage
                                   error:(NSError * _Nullable * _Nullable)error
    NS_DESIGNATED_INITIALIZER;

/// Trusted theme metadata used by the graphical selector.
+ (NSArray<NSDictionary<NSString *, id> *> *)availableThemes;

/// Returns integrity-checked property-list bytes for a discovered theme.
/// Installed resources are opened without following links and are never
/// resolved from a caller-provided path.
+ (nullable NSData *)themeResourceDataForIdentifier:(NSString *)identifier
                                               error:
    (NSError * _Nullable * _Nullable)error;

/// Returns a validated preview asset staged for an available theme. The
/// graphical selector references this URL lazily and never decodes a full
/// cursor resource merely to populate its menu.
+ (nullable NSURL *)themePreviewURLForTheme:
    (NSDictionary<NSString *, id> *)theme;

/// Returns the saved syntactically safe theme, defaulting to the first
/// currently available bundled or installed theme in the main bundle.
+ (NSString *)selectedThemeIdentifier;

/// Equivalent lookup using an explicit resource bundle. The embedded login
/// helper uses the outer app bundle because its own bundle has no theme catalog.
+ (NSString *)selectedThemeIdentifierForResourceBundle:
    (NSBundle *)resourceBundle;

/// Persists an allowlisted selection for both the app and login helper.
+ (BOOL)saveSelectedThemeIdentifier:(NSString *)themeIdentifier
                              error:(NSError * _Nullable * _Nullable)error;

/// Returns the saved registration size for a theme (50–200, default 100).
+ (NSInteger)sizePercentageForThemeIdentifier:(NSString *)themeIdentifier;

/// Returns the size used by the currently effective registration.
+ (NSInteger)effectiveSizePercentage;

/// Saves a per-theme size preference without changing live cursor state.
+ (BOOL)saveSizePercentage:(NSInteger)sizePercentage
        forThemeIdentifier:(NSString *)themeIdentifier
                     error:(NSError * _Nullable * _Nullable)error;

/// Removes a saved size using identifier syntax alone, so deletion cleanup
/// remains possible after an imported theme's manifest has been removed.
+ (BOOL)forgetSizePercentageForThemeIdentifier:(NSString *)themeIdentifier
                                          error:
    (NSError * _Nullable * _Nullable)error;

/// Rolls back an interrupted apply/restore transaction. Returns YES when no
/// transaction existed or when recovery completed and was verified.
- (BOOL)recoverInterruptedTransaction:(BOOL * _Nullable)didRecover
                                error:(NSError * _Nullable * _Nullable)error;

/// Transactionally applies Oreo. A stock snapshot is durably written before
/// the first cursor registration is changed.
- (BOOL)apply:(NSError * _Nullable * _Nullable)error;

/// Restores and verifies the pre-apply cursor registrations.
- (BOOL)restore:(NSError * _Nullable * _Nullable)error;

/// Verifies three sentinels. If another app or WindowServer replaced them,
/// re-applies the already validated theme without recapturing the snapshot.
- (BOOL)refreshIfNeeded:(NSError * _Nullable * _Nullable)error;

/// Read-only diagnostics suitable for CLI output.
- (NSDictionary<NSString *, id> *)diagnostics;

/// Decodes every curated Apple resource fallback without changing
/// registrations.
- (BOOL)validateSystemFallbackResources:
    (NSError * _Nullable * _Nullable)error;

@end

FOUNDATION_EXPORT NSString * const OreoCursorEnabledDefaultsKey;
FOUNDATION_EXPORT NSString * const OreoCursorEffectiveDefaultsKey;
FOUNDATION_EXPORT NSString * const OreoCursorLastStatusDefaultsKey;
FOUNDATION_EXPORT NSString * const OreoCursorLastStatusIsErrorDefaultsKey;
FOUNDATION_EXPORT NSString * const OreoCursorLastStatusSourceDefaultsKey;
FOUNDATION_EXPORT NSString * const OreoCursorThemeDefaultsKey;
FOUNDATION_EXPORT NSString * const OreoCursorStatusSourceCursor;
FOUNDATION_EXPORT NSString * const OreoCursorStatusSourceLogin;

/// Shared unsandboxed preferences domain used by the outer app and its
/// separately identified embedded login helper.
FOUNDATION_EXPORT NSUserDefaults *OreoCursorDefaults(void);

/// Persists a status message plus its severity/source across the app, CLI,
/// and resident login helper.
FOUNDATION_EXPORT BOOL OreoCursorSaveStatus(NSString *message,
                                            BOOL isError,
                                            NSString *source);

NS_ASSUME_NONNULL_END
