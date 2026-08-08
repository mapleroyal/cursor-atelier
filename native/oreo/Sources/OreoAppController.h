#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>

NS_ASSUME_NONNULL_BEGIN

/// Executes the app's small command-line surface. Returns -1 when normal GUI
/// launch should continue; otherwise returns the desired process exit status.
int OreoRunCommandLineIfRequested(
    int argc, const char * _Nonnull * _Nonnull argv);

FOUNDATION_EXPORT NSString * const OreoLoginHelperBundleIdentifier;
FOUNDATION_EXPORT NSString * const OreoSettingsChangedNotification;
FOUNDATION_EXPORT NSString * const OreoStatusChangedNotification;

/// The invisible embedded login helper service.
SMAppService *OreoLoginItemService(void);

/// Stable string representations used by GUI and JSON diagnostics.
NSString *OreoLoginItemStatusString(void);
NSString *OreoLegacyMainLoginItemStatusString(void);
BOOL OreoLoginItemDesired(void);
void OreoSetLoginItemDesired(BOOL desired);
BOOL OreoLoginItemRegistrationCurrent(void);

BOOL OreoRegisterLoginItem(NSError * _Nullable * _Nullable error);
BOOL OreoUnregisterLoginItem(NSError * _Nullable * _Nullable error);
/// Makes the registered helper match the current packaged build, or removes
/// obsolete registrations when Launch at Login is no longer desired.
BOOL OreoReconcileLoginItems(NSError * _Nullable * _Nullable error);
BOOL OreoUnregisterLegacyMainLoginItem(
    NSError * _Nullable * _Nullable error);
BOOL OreoMigrateLegacyLoginItemIfNeeded(
    NSError * _Nullable * _Nullable error);

/// Prompts the resident helper to reread shared preferences and refresh.
void OreoPostSettingsChangedNotification(void);

NS_ASSUME_NONNULL_END
