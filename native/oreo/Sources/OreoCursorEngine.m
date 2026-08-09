#import "OreoCursorEngine.h"

#import <CommonCrypto/CommonDigest.h>
#import <ImageIO/ImageIO.h>
#import <dlfcn.h>
#import <dirent.h>
#import <errno.h>
#import <fcntl.h>
#import <limits.h>
#import <math.h>
#import <sys/file.h>
#import <sys/stat.h>
#import <sys/sysctl.h>
#import <unistd.h>

NSString * const OreoCursorEnabledDefaultsKey = @"CursorEnabled";
NSString * const OreoCursorEffectiveDefaultsKey = @"CursorEffective";
NSString * const OreoCursorLastStatusDefaultsKey = @"LastStatus";
NSString * const OreoCursorLastStatusIsErrorDefaultsKey = @"LastStatusIsError";
NSString * const OreoCursorLastStatusSourceDefaultsKey = @"LastStatusSource";
NSString * const OreoCursorThemeDefaultsKey = @"SelectedThemeIdentifier";
NSString * const OreoCursorStatusSourceCursor = @"cursor";
NSString * const OreoCursorStatusSourceLogin = @"login";

static NSString * const OreoCursorActiveBootDefaultsKey = @"ActiveBootSessionUUID";
static NSString * const OreoCursorThemeSizesDefaultsKey = @"ThemeSizePercentages";
static NSString * const OreoCursorEffectiveThemeSizeDefaultsKey =
    @"EffectiveThemeSizePercentage";
static NSString * const OreoCursorErrorDomain =
    @"com.cursoratelier.CursorAtelier.NativeCursor.Engine";
static const NSInteger OreoDefaultThemeSizePercentage = 100;
static const NSInteger OreoMinimumThemeSizePercentage = 50;
static const NSInteger OreoMaximumThemeSizePercentage = 200;
static const NSInteger OreoSnapshotSchemaVersion = 1;
static const NSUInteger OreoMaximumThemeFrames = 24;
static const NSUInteger OreoMaximumThemeRepresentations = 16;
static const double OreoMaximumThemeScale = 10;
// Apple's 4x Wait representation is a 240×7200 sprite sheet on Tahoe.
// The byte cap below remains the primary allocation bound.
static const NSUInteger OreoMaximumDecodedDimension = 8192;
static const NSUInteger OreoMaximumDecodedBytes = 64 * 1024 * 1024;
// A theme retains every decoded cursor representation for registration. Keep
// the aggregate allocation bounded independently of the per-cursor ceiling.
static const NSUInteger OreoMaximumDecodedThemeBytes = 128 * 1024 * 1024;
static const NSUInteger OreoMaximumImportedDirectoryEntries = 512;
static const NSUInteger OreoMaximumImportedPacks = 256;
static const NSUInteger OreoMaximumImportedThemes = 512;
static const NSUInteger OreoMaximumImportedThemesPerPack = 64;
static const NSUInteger OreoMaximumImportedManifestBytes = 16 * 1024 * 1024;
static const NSUInteger OreoMaximumImportedThemeBytes = 32 * 1024 * 1024;
static const NSUInteger OreoMaximumImportedPackThemeBytes = 128 * 1024 * 1024;
static const NSUInteger OreoMaximumImportedThemeBytesTotal = 512 * 1024 * 1024;
// Covers the complete built-in, build-generated, and imported catalogue while
// still bounding malformed preference data independently of import limits.
static const NSUInteger OreoMaximumThemeSizeEntries = 2048;

typedef NS_ENUM(NSUInteger, OreoSnapshotPreparationDisposition) {
    OreoSnapshotPreparationCreateFresh = 0,
    OreoSnapshotPreparationDiscardOrphan = 1,
    OreoSnapshotPreparationReuseOwned = 2,
    OreoSnapshotPreparationMissingOwned = 3,
};

typedef NS_ENUM(NSUInteger, OreoSnapshotRestoreDisposition) {
    OreoSnapshotRestoreInactive = 0,
    OreoSnapshotRestoreOwned = 1,
    OreoSnapshotRestoreMissingOwned = 2,
};

static OreoSnapshotPreparationDisposition
OreoSnapshotPreparationForState(BOOL snapshotExists, BOOL ownsSnapshot) {
    if (!ownsSnapshot) {
        return snapshotExists ? OreoSnapshotPreparationDiscardOrphan
                              : OreoSnapshotPreparationCreateFresh;
    }
    return snapshotExists ? OreoSnapshotPreparationReuseOwned
                          : OreoSnapshotPreparationMissingOwned;
}

static OreoSnapshotRestoreDisposition
OreoSnapshotRestoreForState(BOOL snapshotExists, BOOL ownsSnapshot) {
    if (!ownsSnapshot) {
        return OreoSnapshotRestoreInactive;
    }
    return snapshotExists ? OreoSnapshotRestoreOwned
                          : OreoSnapshotRestoreMissingOwned;
}

#if defined(OREO_CURSOR_ENGINE_TESTING)
NSUInteger OreoCursorTestingSnapshotPreparation(BOOL snapshotExists,
                                                 BOOL effective,
                                                 BOOL activeBootCurrent) {
    return OreoSnapshotPreparationForState(
        snapshotExists, effective || activeBootCurrent);
}

NSUInteger OreoCursorTestingSnapshotRestore(BOOL snapshotExists,
                                             BOOL effective,
                                             BOOL activeBootCurrent) {
    return OreoSnapshotRestoreForState(
        snapshotExists, effective || activeBootCurrent);
}
#endif

static NSString * const OreoThemeIdentifierSpecKey = @"Identifier";
static NSString * const OreoThemeDisplayNameSpecKey = @"DisplayName";
static NSString * const OreoThemeResourceSpecKey = @"Resource";
static NSString * const OreoThemeSHA256SpecKey = @"SHA256";
static NSString * const OreoThemeUUIDSpecKey = @"UUID";
static NSString * const OreoThemePlistNameSpecKey = @"ThemeName";
static NSString * const OreoThemeGroupSpecKey = @"Group";
static NSString * const OreoThemeSourceURLSpecKey = @"SourceURL";
static NSString * const OreoThemeSourceSpecKey = @"Source";
static NSString * const OreoThemeLicenseSpecKey = @"License";
static NSString * const OreoThemeLicenseURLSpecKey = @"LicenseURL";
static NSString * const OreoThemeAuthorSpecKey = @"Author";
static NSString * const OreoThemeImportedPackSpecKey =
    @"ImportedPackIdentifier";
static NSString * const OreoThemeManifestResourceName = @"manifest";
static NSString * const OreoDefaultThemeIdentifier = @"OreoWhite";
static NSString * const OreoImportedPacksDirectoryName = @"ImportedPacks";

NSUserDefaults *OreoCursorDefaults(void) {
    static NSUserDefaults *defaults;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        if ([NSBundle.mainBundle.bundleIdentifier
                isEqualToString:@"com.cursoratelier.CursorAtelier.NativeCursor"]) {
            defaults = NSUserDefaults.standardUserDefaults;
        } else {
            defaults = [[NSUserDefaults alloc]
                initWithSuiteName:
                    @"com.cursoratelier.CursorAtelier.NativeCursor"];
        }
    });
    return defaults;
}

static BOOL OreoReadThemeSizePercentage(id value, NSInteger *result) {
    if (![value isKindOfClass:[NSNumber class]] ||
        CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
        return NO;
    }
    double number = [value doubleValue];
    if (!isfinite(number) || floor(number) != number ||
        number < OreoMinimumThemeSizePercentage ||
        number > OreoMaximumThemeSizePercentage) {
        return NO;
    }
    if (result) {
        *result = (NSInteger)number;
    }
    return YES;
}

BOOL OreoCursorSaveStatus(NSString *message,
                          BOOL isError,
                          NSString *source) {
    if (message.length == 0 || source.length == 0) {
        return NO;
    }
    NSUserDefaults *defaults = OreoCursorDefaults();
    [defaults synchronize];
    BOOL priorIsError =
        [defaults boolForKey:OreoCursorLastStatusIsErrorDefaultsKey];
    NSString *priorSource =
        [defaults stringForKey:OreoCursorLastStatusSourceDefaultsKey];
    if (priorIsError && priorSource.length > 0 &&
        ![priorSource isEqualToString:source]) {
        return NO;
    }
    [defaults setObject:message forKey:OreoCursorLastStatusDefaultsKey];
    [defaults setBool:isError
               forKey:OreoCursorLastStatusIsErrorDefaultsKey];
    [defaults setObject:source
                 forKey:OreoCursorLastStatusSourceDefaultsKey];
    return [defaults synchronize];
}

static NSArray<NSDictionary<NSString *, NSString *> *> *
OreoThemeSpecifications(void) {
    static NSArray<NSDictionary<NSString *, NSString *> *> *themes;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        themes = @[
            @{
                OreoThemeIdentifierSpecKey: @"OreoWhite",
                OreoThemeDisplayNameSpecKey: @"White",
                OreoThemeResourceSpecKey: @"OreoWhite",
                OreoThemeSHA256SpecKey:
                    @"180b1e731716408f3d7ef1b19f7d0f5b37006c88b75084d4430c1a73e4c68743",
                OreoThemeUUIDSpecKey:
                    @"48D50EFD-389C-522F-8A4A-CD76DE8F4974",
                OreoThemePlistNameSpecKey: @"Oreo White",
                OreoThemeGroupSpecKey: @"Oreo",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoGrey",
                OreoThemeDisplayNameSpecKey: @"Gray",
                OreoThemeResourceSpecKey: @"OreoGrey",
                OreoThemeSHA256SpecKey:
                    @"d0c5ba48c7363d3230d224952459a9e924e548ccbe60ad9564ca7835c33d07f9",
                OreoThemeUUIDSpecKey:
                    @"11F977BD-EC71-5AA9-B6B9-DB6115775065",
                OreoThemePlistNameSpecKey: @"Oreo Grey",
                OreoThemeGroupSpecKey: @"Oreo",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoBlack",
                OreoThemeDisplayNameSpecKey: @"Black",
                OreoThemeResourceSpecKey: @"OreoBlack",
                OreoThemeSHA256SpecKey:
                    @"50d1159c930914256f01b1a9a36e77f3eb0420eaf5ced4238cff966e7466dc22",
                OreoThemeUUIDSpecKey:
                    @"0D069493-0412-56D4-8DAF-6300E1FEAFBF",
                OreoThemePlistNameSpecKey: @"Oreo Black",
                OreoThemeGroupSpecKey: @"Oreo",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoBlue",
                OreoThemeDisplayNameSpecKey: @"Blue",
                OreoThemeResourceSpecKey: @"OreoBlue",
                OreoThemeSHA256SpecKey:
                    @"6bdc1c499854afc215e813218aef6ea011e21d51b0c6e509a84c637937b48dee",
                OreoThemeUUIDSpecKey:
                    @"D74950B4-F227-5ABB-9C4B-AAEA08EDD436",
                OreoThemePlistNameSpecKey: @"Oreo Blue",
                OreoThemeGroupSpecKey: @"Oreo",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoPink",
                OreoThemeDisplayNameSpecKey: @"Pink",
                OreoThemeResourceSpecKey: @"OreoPink",
                OreoThemeSHA256SpecKey:
                    @"bc30fc11637d8710e17b2d339cbb044ddc39a2363fd67350449a91462576267c",
                OreoThemeUUIDSpecKey:
                    @"4E03A69E-C449-5FD6-BA9C-C50FD98D5542",
                OreoThemePlistNameSpecKey: @"Oreo Pink",
                OreoThemeGroupSpecKey: @"Oreo",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoPurple",
                OreoThemeDisplayNameSpecKey: @"Purple",
                OreoThemeResourceSpecKey: @"OreoPurple",
                OreoThemeSHA256SpecKey:
                    @"256080f6e08b786ae855aa7de1294248f99fe47b50b35ae1f2a7dfd1ff43d6fd",
                OreoThemeUUIDSpecKey:
                    @"24B632B3-A0F9-59B6-9012-7B4325C21983",
                OreoThemePlistNameSpecKey: @"Oreo Purple",
                OreoThemeGroupSpecKey: @"Oreo",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoRed",
                OreoThemeDisplayNameSpecKey: @"Red",
                OreoThemeResourceSpecKey: @"OreoRed",
                OreoThemeSHA256SpecKey:
                    @"80f43c65d37b1cb7d32c9e1ab7b58cdcfabd8a65aa4f803d289f75475c5d3fac",
                OreoThemeUUIDSpecKey:
                    @"09B5B421-2E0D-5517-81CF-32A8D611170A",
                OreoThemePlistNameSpecKey: @"Oreo Red",
                OreoThemeGroupSpecKey: @"Oreo",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoTeal",
                OreoThemeDisplayNameSpecKey: @"Teal",
                OreoThemeResourceSpecKey: @"OreoTeal",
                OreoThemeSHA256SpecKey:
                    @"cceb9e562a693366e5cbcb19ec75f6cd3a58f37853ea05420107df5fe279653e",
                OreoThemeUUIDSpecKey:
                    @"CBB17224-D639-5733-B55D-4A6DEA8690DF",
                OreoThemePlistNameSpecKey: @"Oreo Teal",
                OreoThemeGroupSpecKey: @"Oreo",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoSparkLite",
                OreoThemeDisplayNameSpecKey: @"Spark Light",
                OreoThemeResourceSpecKey: @"OreoSparkLite",
                OreoThemeSHA256SpecKey:
                    @"a311a3e8c37b1bed7946d5528ff132e4e3649f51a01523d5a2683e04aff43d44",
                OreoThemeUUIDSpecKey:
                    @"3B29AAB2-7D92-53A4-8C91-F995AFF57A90",
                OreoThemePlistNameSpecKey: @"Oreo Spark Lite",
                OreoThemeGroupSpecKey: @"Spark",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoSparkDark",
                OreoThemeDisplayNameSpecKey: @"Spark Dark",
                OreoThemeResourceSpecKey: @"OreoSparkDark",
                OreoThemeSHA256SpecKey:
                    @"991b039f66196bed3497be96d20ad4d700c79b6ca3cf3b48dac9bc859f752153",
                OreoThemeUUIDSpecKey:
                    @"CE6E0F75-15F5-5A21-8401-2A60920B3F11",
                OreoThemePlistNameSpecKey: @"Oreo Spark Dark",
                OreoThemeGroupSpecKey: @"Spark",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoSparkBlue",
                OreoThemeDisplayNameSpecKey: @"Spark Blue",
                OreoThemeResourceSpecKey: @"OreoSparkBlue",
                OreoThemeSHA256SpecKey:
                    @"6ad0ec4d078d6f5dd24b6e3918317f4131ea54a2ca0806953a1e308a39bf0b34",
                OreoThemeUUIDSpecKey:
                    @"8FB95895-6488-5A4D-B549-6C24EBEEF926",
                OreoThemePlistNameSpecKey: @"Oreo Spark Blue",
                OreoThemeGroupSpecKey: @"Spark",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoSparkGreen",
                OreoThemeDisplayNameSpecKey: @"Spark Green",
                OreoThemeResourceSpecKey: @"OreoSparkGreen",
                OreoThemeSHA256SpecKey:
                    @"4f20797b0947567da6128dd7389d54c09e46c368bae3a026e5b47608c3a17245",
                OreoThemeUUIDSpecKey:
                    @"6CD682D2-89F2-5C56-9F06-884112985481",
                OreoThemePlistNameSpecKey: @"Oreo Spark Green",
                OreoThemeGroupSpecKey: @"Spark",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoSparkLightPink",
                OreoThemeDisplayNameSpecKey: @"Spark Light Pink",
                OreoThemeResourceSpecKey: @"OreoSparkLightPink",
                OreoThemeSHA256SpecKey:
                    @"9d81d3382193a027d86da333abfa9a0c10823b1430c7059360ba7105ebe39e65",
                OreoThemeUUIDSpecKey:
                    @"FE78ED82-0917-56ED-A1DC-85C61FF0AA2A",
                OreoThemePlistNameSpecKey: @"Oreo Spark Light Pink",
                OreoThemeGroupSpecKey: @"Spark",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoSparkLime",
                OreoThemeDisplayNameSpecKey: @"Spark Lime",
                OreoThemeResourceSpecKey: @"OreoSparkLime",
                OreoThemeSHA256SpecKey:
                    @"3337f046ff2c6ee26dba54778fc2685cce526798c6b48f88b5ceafddcdffc2ac",
                OreoThemeUUIDSpecKey:
                    @"CEDDD804-2530-54D1-8B6B-FB7854EA7B8A",
                OreoThemePlistNameSpecKey: @"Oreo Spark Lime",
                OreoThemeGroupSpecKey: @"Spark",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoSparkOrange",
                OreoThemeDisplayNameSpecKey: @"Spark Orange",
                OreoThemeResourceSpecKey: @"OreoSparkOrange",
                OreoThemeSHA256SpecKey:
                    @"bbb72d7efa61615a96a38f7e766229dfb5d6409a4079c0fd9bff42e6a3c0410d",
                OreoThemeUUIDSpecKey:
                    @"8C3D6FA7-7782-52C8-9EA2-349AF7139CD7",
                OreoThemePlistNameSpecKey: @"Oreo Spark Orange",
                OreoThemeGroupSpecKey: @"Spark",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoSparkPink",
                OreoThemeDisplayNameSpecKey: @"Spark Pink",
                OreoThemeResourceSpecKey: @"OreoSparkPink",
                OreoThemeSHA256SpecKey:
                    @"af3a1c31d7b757107c4e10c014562bbf12ca4c93fd5e7e00a8ac1eea7ee4e625",
                OreoThemeUUIDSpecKey:
                    @"B3F427F6-0287-5C71-9295-022BC8ED7934",
                OreoThemePlistNameSpecKey: @"Oreo Spark Pink",
                OreoThemeGroupSpecKey: @"Spark",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoSparkPurple",
                OreoThemeDisplayNameSpecKey: @"Spark Purple",
                OreoThemeResourceSpecKey: @"OreoSparkPurple",
                OreoThemeSHA256SpecKey:
                    @"e93a24c7b913c3e3bf31c41bb7034a5565c3d9fda23b72cddcb28c817d631195",
                OreoThemeUUIDSpecKey:
                    @"5B53BF1D-6CD8-5382-B4FD-F2D505B2C504",
                OreoThemePlistNameSpecKey: @"Oreo Spark Purple",
                OreoThemeGroupSpecKey: @"Spark",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoSparkRed",
                OreoThemeDisplayNameSpecKey: @"Spark Red",
                OreoThemeResourceSpecKey: @"OreoSparkRed",
                OreoThemeSHA256SpecKey:
                    @"cad4e5e4f0f688bd05c8945424b8983e32f94e0a89930be2d6f9e0fe25ccafd5",
                OreoThemeUUIDSpecKey:
                    @"B73170A5-C405-5D65-9D2A-71C90F38CCFE",
                OreoThemePlistNameSpecKey: @"Oreo Spark Red",
                OreoThemeGroupSpecKey: @"Spark",
            },
            @{
                OreoThemeIdentifierSpecKey: @"OreoSparkViolet",
                OreoThemeDisplayNameSpecKey: @"Spark Violet",
                OreoThemeResourceSpecKey: @"OreoSparkViolet",
                OreoThemeSHA256SpecKey:
                    @"01ae809af1399594638962fa839788952faff493dcf14f43f1b4e16c94fd23fe",
                OreoThemeUUIDSpecKey:
                    @"933C2ACF-9AB9-5209-BFA9-A1CC77E64BC6",
                OreoThemePlistNameSpecKey: @"Oreo Spark Violet",
                OreoThemeGroupSpecKey: @"Spark",
            },
        ];
    });
    return themes;
}

static NSArray<NSDictionary<NSString *, NSString *> *> *
OreoThemeSpecificationsForBundle(NSBundle *bundle);
static NSArray<NSDictionary<NSString *, NSString *> *> *
OreoBundledThemeSpecificationsForBundle(NSBundle *bundle);
static NSArray<NSDictionary<NSString *, NSString *> *> *
OreoImportedThemeSpecifications(NSSet<NSString *> *reservedIdentifiers);
static NSDictionary<NSString *, NSDictionary *> * _Nullable
OreoDecodedThemeCursors(NSData *data,
                        NSDictionary<NSString *, NSString *> *specification,
                        NSError **error);

static NSDictionary<NSString *, NSString *> *
OreoThemeSpecificationForBundle(NSString *identifier, NSBundle *bundle) {
    NSArray<NSDictionary<NSString *, NSString *> *> *bundledThemes =
        OreoBundledThemeSpecificationsForBundle(bundle);
    for (NSDictionary<NSString *, NSString *> *theme in bundledThemes) {
        if ([theme[OreoThemeIdentifierSpecKey] isEqualToString:identifier]) {
            return theme;
        }
    }
    NSSet<NSString *> *bundledIdentifiers = [NSSet setWithArray:
        [bundledThemes valueForKey:OreoThemeIdentifierSpecKey]];
    for (NSDictionary<NSString *, NSString *> *theme in
             OreoImportedThemeSpecifications(bundledIdentifiers)) {
        if ([theme[OreoThemeIdentifierSpecKey] isEqualToString:identifier]) {
            return theme;
        }
    }
    return nil;
}

typedef int CGSConnectionID;
typedef CGSConnectionID (*OreoCGSMainConnectionIDFn)(void);
typedef CGError (*OreoCGSRegisterCursorWithImagesFn)(
    CGSConnectionID, char *, bool, bool, CGSize, CGPoint, NSUInteger,
    CGFloat, CFArrayRef, int *);
typedef CGError (*OreoCGSSetRegisteredCursorFn)(CGSConnectionID, char *, int *);
typedef CGError (*OreoCGSCopyRegisteredCursorImagesFn)(
    CGSConnectionID, char *, CGSize *, CGPoint *, NSUInteger *, CGFloat *,
    CFArrayRef *);
typedef CGError (*OreoCGSGetRegisteredCursorDataSizeFn)(
    CGSConnectionID, char *, size_t *);
typedef CGError (*OreoCGSRemoveRegisteredCursorFn)(
    CGSConnectionID, char *, bool);
typedef CGError (*OreoCoreCursorCopyImagesFn)(
    CGSConnectionID, int, CFArrayRef *, CGSize *, CGPoint *, NSUInteger *,
    CGFloat *);
typedef CGError (*OreoCoreCursorUnregisterAllFn)(CGSConnectionID);
typedef CGError (*OreoCoreCursorSetFn)(CGSConnectionID, int);
typedef CGError (*OreoCGSSetSystemDefinedCursorFn)(CGSConnectionID, int);
typedef void (*OreoCGSSetDockCursorOverrideFn)(CGSConnectionID, bool);

typedef struct {
    OreoCGSMainConnectionIDFn mainConnectionID;
    OreoCGSRegisterCursorWithImagesFn registerCursor;
    OreoCGSSetRegisteredCursorFn activateCursor;
    OreoCGSCopyRegisteredCursorImagesFn copyRegisteredCursor;
    OreoCGSGetRegisteredCursorDataSizeFn registeredCursorDataSize;
    OreoCGSRemoveRegisteredCursorFn removeRegisteredCursor;
    OreoCoreCursorCopyImagesFn copyCoreCursor;
    OreoCoreCursorUnregisterAllFn unregisterAllCoreCursors;
    OreoCoreCursorSetFn setCoreCursor;
    OreoCGSSetSystemDefinedCursorFn setSystemCursor;
    OreoCGSSetDockCursorOverrideFn setDockOverride;
} OreoPrivateCursorAPI;

static NSError *OreoError(NSInteger code, NSString *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    NSString *message = [[NSString alloc] initWithFormat:format
                                               arguments:arguments];
    va_end(arguments);
    return [NSError errorWithDomain:OreoCursorErrorDomain
                               code:code
                           userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSString *OreoSHA256(NSData *data) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *result =
        [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
        [result appendFormat:@"%02x", digest[index]];
    }
    return result;
}

static BOOL OreoIsSHA256String(id object) {
    if (![object isKindOfClass:[NSString class]] ||
        [(NSString *)object length] != CC_SHA256_DIGEST_LENGTH * 2) {
        return NO;
    }
    NSCharacterSet *nonHex = [[NSCharacterSet
        characterSetWithCharactersInString:@"0123456789abcdef"]
        invertedSet];
    return [(NSString *)object rangeOfCharacterFromSet:nonHex].location ==
           NSNotFound;
}

/// Theme identifiers are persisted in an unsandboxed shared preferences
/// domain. Keep the parser deliberately narrower than a filesystem path so a
/// malformed or tampered manifest can never become one.
static BOOL OreoIsSafeThemeIdentifier(id object) {
    if (![object isKindOfClass:[NSString class]]) {
        return NO;
    }
    NSString *identifier = (NSString *)object;
    if (identifier.length == 0 || identifier.length > 128) {
        return NO;
    }
    NSCharacterSet *allowed =
        [NSCharacterSet characterSetWithCharactersInString:
                               @"abcdefghijklmnopqrstuvwxyz"
                                @"ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                                @"0123456789._-"];
    return [identifier rangeOfCharacterFromSet:[allowed invertedSet]].location ==
           NSNotFound;
}

static NSString * _Nullable OreoCanonicalThemeIdentifier(id object) {
    return OreoIsSafeThemeIdentifier(object)
        ? [(NSString *)object lowercaseString]
        : nil;
}

static BOOL OreoIsSafeImportedPackIdentifier(id object) {
    if (!OreoIsSafeThemeIdentifier(object)) {
        return NO;
    }
    unichar first = [(NSString *)object characterAtIndex:0];
    return [[NSCharacterSet alphanumericCharacterSet]
        characterIsMember:first];
}

// Keep this byte-for-byte equivalent to the importer's private transaction
// entry grammar: /^\.(?:import|metadata|delete)-[A-Za-z0-9]{6}$/.
static BOOL OreoIsImportedStoreTransactionEntry(const char *name) {
    const char *suffix = NULL;
    if (strncmp(name, ".import-", 8) == 0 ||
        strncmp(name, ".delete-", 8) == 0) {
        suffix = name + 8;
    } else if (strncmp(name, ".metadata-", 10) == 0) {
        suffix = name + 10;
    } else {
        return NO;
    }
    if (strlen(suffix) != 6) {
        return NO;
    }
    for (NSUInteger index = 0; index < 6; index++) {
        unsigned char character = (unsigned char)suffix[index];
        if (!((character >= 'A' && character <= 'Z') ||
              (character >= 'a' && character <= 'z') ||
              (character >= '0' && character <= '9'))) {
            return NO;
        }
    }
    return YES;
}

static BOOL OreoIsSafeThemeResourceName(id object) {
    if (![object isKindOfClass:[NSString class]]) {
        return NO;
    }
    NSString *resource = (NSString *)object;
    if (resource.length < 7 || resource.length > 192 ||
        ![resource.pathExtension.lowercaseString isEqualToString:@"cursor"] ||
        ![resource.lastPathComponent isEqualToString:resource]) {
        return NO;
    }
    NSCharacterSet *allowed =
        [NSCharacterSet characterSetWithCharactersInString:
                               @"abcdefghijklmnopqrstuvwxyz"
                                @"ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                                @"0123456789._-"];
    return [resource rangeOfCharacterFromSet:[allowed invertedSet]].location ==
           NSNotFound;
}

static NSString * _Nullable OreoManifestString(NSDictionary *entry,
                                                 NSString *key,
                                                 BOOL required) {
    id value = entry[key];
    if (![value isKindOfClass:[NSString class]] ||
        (required && [(NSString *)value length] == 0)) {
        return nil;
    }
    return [(NSString *)value copy];
}

static BOOL OreoIsBoundedManifestText(NSString *value,
                                      NSUInteger maximumLength) {
    return value.length > 0 && value.length <= maximumLength &&
        [value rangeOfCharacterFromSet:
                   [NSCharacterSet controlCharacterSet]].location == NSNotFound;
}

static NSDictionary<NSString *, NSString *> * _Nullable
OreoValidatedThemeSpecification(id object) {
    if (![object isKindOfClass:[NSDictionary class]]) {
        return nil;
    }
    NSDictionary *entry = object;
    NSString *identifier = OreoManifestString(
        entry, OreoThemeIdentifierSpecKey, YES);
    NSString *displayName = OreoManifestString(
        entry, OreoThemeDisplayNameSpecKey, YES);
    NSString *resource = OreoManifestString(
        entry, OreoThemeResourceSpecKey, YES);
    NSString *sha256 = OreoManifestString(
        entry, OreoThemeSHA256SpecKey, YES).lowercaseString;
    NSString *uuid = OreoManifestString(entry, OreoThemeUUIDSpecKey, YES);
    NSString *themeName = OreoManifestString(
        entry, OreoThemePlistNameSpecKey, YES);
    NSString *group = OreoManifestString(entry, OreoThemeGroupSpecKey, YES);
    if (!OreoIsSafeThemeIdentifier(identifier) ||
        !OreoIsBoundedManifestText(displayName, 256) ||
        !OreoIsSafeThemeResourceName(resource) ||
        !OreoIsSHA256String(sha256) ||
        ![[NSUUID alloc] initWithUUIDString:uuid] ||
        !OreoIsBoundedManifestText(themeName, 256) ||
        !OreoIsBoundedManifestText(group, 128)) {
        return nil;
    }

    NSMutableDictionary<NSString *, NSString *> *validated =
        [NSMutableDictionary dictionaryWithDictionary:@{
            OreoThemeIdentifierSpecKey: identifier,
            OreoThemeDisplayNameSpecKey: displayName,
            OreoThemeResourceSpecKey: resource,
            OreoThemeSHA256SpecKey: sha256,
            OreoThemeUUIDSpecKey: uuid,
            OreoThemePlistNameSpecKey: themeName,
            OreoThemeGroupSpecKey: group,
        }];
    for (NSString *optionalKey in @[
             OreoThemeSourceURLSpecKey, OreoThemeSourceSpecKey,
             OreoThemeLicenseSpecKey, OreoThemeLicenseURLSpecKey,
             OreoThemeAuthorSpecKey]) {
        NSString *value = OreoManifestString(entry, optionalKey, NO);
        if (OreoIsBoundedManifestText(value, 2048)) {
            validated[optionalKey] = value;
        }
    }
    return [validated copy];
}

static NSURL *OreoApplicationDataDirectoryURL(void) {
    NSURL *applicationSupport = [[[NSFileManager defaultManager]
        URLsForDirectory:NSApplicationSupportDirectory
               inDomains:NSUserDomainMask] firstObject];
    return [applicationSupport URLByAppendingPathComponent:@"Cursor Atelier"
                                               isDirectory:YES];
}

static BOOL OreoStatusIsPrivateOwnedDirectory(const struct stat *status) {
    return status && S_ISDIR(status->st_mode) && status->st_uid == geteuid() &&
        (status->st_mode & (S_IRWXG | S_IRWXO)) == 0;
}

static BOOL OreoStatusIsOwnedNonWritableDirectory(const struct stat *status) {
    return status && S_ISDIR(status->st_mode) && status->st_uid == geteuid() &&
        (status->st_mode & (S_IWGRP | S_IWOTH)) == 0;
}

static BOOL OreoFileDescriptorIsPrivateOwnedDirectory(int descriptor) {
    struct stat status;
    return fstat(descriptor, &status) == 0 &&
        OreoStatusIsPrivateOwnedDirectory(&status);
}

static BOOL OreoFileDescriptorIsOwnedNonWritableDirectory(int descriptor) {
    struct stat status;
    return fstat(descriptor, &status) == 0 &&
        OreoStatusIsOwnedNonWritableDirectory(&status);
}

static BOOL OreoStatusIsPrivateOwnedRegularFile(const struct stat *status,
                                                NSUInteger maximumBytes) {
    return status && S_ISREG(status->st_mode) && status->st_uid == geteuid() &&
        (status->st_mode & (S_IRWXG | S_IRWXO)) == 0 &&
        status->st_nlink == 1 && status->st_size > 0 &&
        (uint64_t)status->st_size <= maximumBytes;
}

static BOOL OreoFileDescriptorIsWithinDirectory(int childFD,
                                                int directoryFD) {
    char childPath[PATH_MAX];
    char directoryPath[PATH_MAX];
    if (fcntl(childFD, F_GETPATH, childPath) != 0 ||
        fcntl(directoryFD, F_GETPATH, directoryPath) != 0) {
        return NO;
    }
    size_t directoryLength = strlen(directoryPath);
    return directoryLength > 0 &&
        strncmp(childPath, directoryPath, directoryLength) == 0 &&
        childPath[directoryLength] == '/';
}

static int OreoOpenImportedPacksDirectory(void) {
    NSURL *dataDirectoryURL = OreoApplicationDataDirectoryURL();
    int dataFD = open(dataDirectoryURL.fileSystemRepresentation,
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (dataFD < 0 ||
        !OreoFileDescriptorIsOwnedNonWritableDirectory(dataFD)) {
        if (dataFD >= 0) {
            close(dataFD);
        }
        return -1;
    }
    int importedFD = openat(dataFD,
                            OreoImportedPacksDirectoryName.UTF8String,
                            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (importedFD < 0 ||
        !OreoFileDescriptorIsPrivateOwnedDirectory(importedFD) ||
        !OreoFileDescriptorIsWithinDirectory(importedFD, dataFD)) {
        if (importedFD >= 0) {
            close(importedFD);
        }
        close(dataFD);
        return -1;
    }
    close(dataFD);
    return importedFD;
}

static NSData * _Nullable OreoReadBoundedRegularFileAtDirectoryFD(
    int directoryFD, NSString *name, NSUInteger maximumBytes,
    NSError **error) {
    struct stat pathStatus;
    if (fstatat(directoryFD, name.fileSystemRepresentation, &pathStatus,
                AT_SYMLINK_NOFOLLOW) != 0 ||
        !OreoStatusIsPrivateOwnedRegularFile(&pathStatus, maximumBytes)) {
        if (error) {
            *error = OreoError(181,
                @"The imported cursor file %@ is not a bounded regular file.",
                name);
        }
        return nil;
    }
    int fileFD = openat(directoryFD, name.fileSystemRepresentation,
                        O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (fileFD < 0 ||
        !OreoFileDescriptorIsWithinDirectory(fileFD, directoryFD)) {
        if (fileFD >= 0) {
            close(fileFD);
        }
        if (error) {
            *error = OreoError(180, @"The imported cursor file %@ is unreadable.",
                               name);
        }
        return nil;
    }
    struct stat initialStatus;
    if (fstat(fileFD, &initialStatus) != 0 ||
        !OreoStatusIsPrivateOwnedRegularFile(&initialStatus, maximumBytes) ||
        initialStatus.st_dev != pathStatus.st_dev ||
        initialStatus.st_ino != pathStatus.st_ino ||
        initialStatus.st_ctimespec.tv_sec != pathStatus.st_ctimespec.tv_sec ||
        initialStatus.st_ctimespec.tv_nsec != pathStatus.st_ctimespec.tv_nsec) {
        close(fileFD);
        if (error) {
            *error = OreoError(181,
                @"The imported cursor file %@ is not a bounded regular file.",
                name);
        }
        return nil;
    }

    NSUInteger length = (NSUInteger)initialStatus.st_size;
    NSMutableData *data = [NSMutableData dataWithLength:length];
    NSUInteger offset = 0;
    while (offset < length) {
        ssize_t result = pread(fileFD,
                               (uint8_t *)data.mutableBytes + offset,
                               length - offset, (off_t)offset);
        if (result < 0 && errno == EINTR) {
            continue;
        }
        if (result <= 0) {
            close(fileFD);
            if (error) {
                *error = OreoError(182,
                    @"The imported cursor file %@ changed while being read.",
                    name);
            }
            return nil;
        }
        offset += (NSUInteger)result;
    }
    struct stat finalStatus;
    BOOL unchanged = fstat(fileFD, &finalStatus) == 0 &&
        OreoStatusIsPrivateOwnedRegularFile(&finalStatus, maximumBytes) &&
        initialStatus.st_dev == finalStatus.st_dev &&
        initialStatus.st_ino == finalStatus.st_ino &&
        initialStatus.st_size == finalStatus.st_size &&
        initialStatus.st_mode == finalStatus.st_mode &&
        initialStatus.st_uid == finalStatus.st_uid &&
        initialStatus.st_nlink == finalStatus.st_nlink &&
        initialStatus.st_mtimespec.tv_sec == finalStatus.st_mtimespec.tv_sec &&
        initialStatus.st_mtimespec.tv_nsec == finalStatus.st_mtimespec.tv_nsec &&
        initialStatus.st_ctimespec.tv_sec == finalStatus.st_ctimespec.tv_sec &&
        initialStatus.st_ctimespec.tv_nsec == finalStatus.st_ctimespec.tv_nsec;
    close(fileFD);
    if (!unchanged) {
        if (error) {
            *error = OreoError(183,
                @"The imported cursor file %@ changed while being read.", name);
        }
        return nil;
    }
    return [data copy];
}

/// Reads build-time generated theme metadata. The converter emits
/// `Resources/Themes/manifest.json` with a top-level `themes` array; accepting
/// a top-level array and a capitalized `Themes` key makes the native reader
/// tolerant of plist/JSON tooling without weakening the field validation.
///
/// Invalid entries are ignored as unavailable. A selected invalid entry still
/// fails engine initialization, so callers never apply unvalidated artwork.
static NSArray<NSDictionary<NSString *, NSString *> *> *
OreoGeneratedThemeSpecifications(NSBundle *bundle) {
    if (!bundle) {
        return @[];
    }
    NSURL *manifestURL = [bundle URLForResource:OreoThemeManifestResourceName
                                  withExtension:@"json"
                                   subdirectory:@"Themes"];
    if (!manifestURL) {
        return @[];
    }
    NSData *manifestData = [NSData dataWithContentsOfURL:manifestURL
                                                  options:NSDataReadingMappedIfSafe
                                                    error:NULL];
    if (!manifestData || manifestData.length == 0) {
        NSLog(@"Cursor Atelier: generated theme manifest is unreadable.");
        return @[];
    }
    id root = [NSJSONSerialization JSONObjectWithData:manifestData
                                               options:0
                                                 error:NULL];
    NSArray *entries = nil;
    if ([root isKindOfClass:[NSArray class]]) {
        entries = root;
    } else if ([root isKindOfClass:[NSDictionary class]]) {
        id schemaVersion = root[@"schemaVersion"] ?: root[@"SchemaVersion"];
        if (schemaVersion &&
            (![schemaVersion isKindOfClass:[NSNumber class]] ||
             CFGetTypeID((__bridge CFTypeRef)schemaVersion) ==
                 CFBooleanGetTypeID() ||
             ([schemaVersion integerValue] != 1 &&
              [schemaVersion integerValue] != 2))) {
            NSLog(@"Cursor Atelier: unsupported generated theme manifest schema.");
            return @[];
        }
        id candidate = root[@"themes"] ?: root[@"Themes"];
        if ([candidate isKindOfClass:[NSArray class]]) {
            entries = candidate;
        }
    }
    if (entries.count == 0) {
        NSLog(@"Cursor Atelier: generated theme manifest has no themes array.");
        return @[];
    }

    NSMutableSet<NSString *> *identifiers = [NSMutableSet set];
    for (NSString *identifier in
             [OreoThemeSpecifications() valueForKey:OreoThemeIdentifierSpecKey]) {
        NSString *canonicalIdentifier =
            OreoCanonicalThemeIdentifier(identifier);
        if (canonicalIdentifier) {
            [identifiers addObject:canonicalIdentifier];
        }
    }
    NSMutableSet *resources = [NSMutableSet set];
    NSMutableArray<NSDictionary<NSString *, NSString *> *> *themes =
        [NSMutableArray arrayWithCapacity:entries.count];
    NSURL *themesURL = [[bundle resourceURL]
        URLByAppendingPathComponent:@"Themes" isDirectory:YES];

    for (id object in entries) {
        NSDictionary<NSString *, NSString *> *validated =
            OreoValidatedThemeSpecification(object);
        NSString *identifier = validated[OreoThemeIdentifierSpecKey];
        NSString *canonicalIdentifier =
            OreoCanonicalThemeIdentifier(identifier);
        NSString *resource = validated[OreoThemeResourceSpecKey];
        if (!validated || [identifiers containsObject:canonicalIdentifier] ||
            [resources containsObject:resource]) {
            continue;
        }
        NSURL *resourceURL = [themesURL URLByAppendingPathComponent:resource
                                                          isDirectory:NO];
        BOOL isRegularFile = NO;
        NSDictionary *attributes = [[NSFileManager defaultManager]
            attributesOfItemAtPath:resourceURL.path error:NULL];
        isRegularFile = [attributes[NSFileType] isEqualToString:NSFileTypeRegular];
        if (!isRegularFile) {
            NSLog(@"Cursor Atelier: generated theme %@ is missing %@.",
                  identifier, resource);
            continue;
        }
        [identifiers addObject:canonicalIdentifier];
        [resources addObject:resource];
        [themes addObject:validated];
    }
    return [themes copy];
}

static NSData * _Nullable OreoReadImportedPackFile(
    NSString *packIdentifier, NSString *name, NSUInteger maximumBytes,
    NSError **error) {
    if (!OreoIsSafeImportedPackIdentifier(packIdentifier)) {
        if (error) {
            *error = OreoError(184, @"The imported cursor pack name is invalid.");
        }
        return nil;
    }
    int rootFD = OreoOpenImportedPacksDirectory();
    if (rootFD < 0) {
        if (error) {
            *error = OreoError(185,
                @"The imported cursor pack directory is unavailable.");
        }
        return nil;
    }
    int packFD = openat(rootFD, packIdentifier.fileSystemRepresentation,
                        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (packFD < 0 ||
        !OreoFileDescriptorIsPrivateOwnedDirectory(packFD) ||
        !OreoFileDescriptorIsWithinDirectory(packFD, rootFD)) {
        if (packFD >= 0) {
            close(packFD);
        }
        close(rootFD);
        if (error) {
            *error = OreoError(186,
                @"The imported cursor pack %@ is unavailable.", packIdentifier);
        }
        return nil;
    }
    NSData *data = OreoReadBoundedRegularFileAtDirectoryFD(
        packFD, name, maximumBytes, error);
    close(packFD);
    close(rootFD);
    return data;
}

static NSArray<NSDictionary<NSString *, NSString *> *> *
OreoImportedThemeSpecifications(NSSet<NSString *> *reservedIdentifiers) {
    int rootFD = OreoOpenImportedPacksDirectory();
    if (rootFD < 0) {
        return @[];
    }
    int enumerationFD = dup(rootFD);
    DIR *directory = enumerationFD >= 0 ? fdopendir(enumerationFD) : NULL;
    if (!directory) {
        if (enumerationFD >= 0) {
            close(enumerationFD);
        }
        close(rootFD);
        return @[];
    }

    NSMutableArray<NSString *> *packIdentifiers = [NSMutableArray array];
    NSUInteger directoryEntryCount = 0;
    struct dirent *entry = NULL;
    while ((entry = readdir(directory))) {
        if (strcmp(entry->d_name, ".") == 0 ||
            strcmp(entry->d_name, "..") == 0) {
            continue;
        }
        if (OreoIsImportedStoreTransactionEntry(entry->d_name)) {
            continue;
        }
        directoryEntryCount++;
        if (directoryEntryCount > OreoMaximumImportedDirectoryEntries) {
            NSLog(@"Cursor Atelier: imported pack directory exceeds its entry limit.");
            closedir(directory);
            close(rootFD);
            return @[];
        }
        NSString *name = [[NSFileManager defaultManager]
            stringWithFileSystemRepresentation:entry->d_name
                                         length:strlen(entry->d_name)];
        if (OreoIsSafeImportedPackIdentifier(name)) {
            [packIdentifiers addObject:name];
        }
    }
    closedir(directory);
    [packIdentifiers sortUsingSelector:@selector(compare:)];

    NSMutableSet<NSString *> *identifiers = [NSMutableSet set];
    for (NSString *identifier in reservedIdentifiers) {
        NSString *canonicalIdentifier =
            OreoCanonicalThemeIdentifier(identifier);
        if (canonicalIdentifier) {
            [identifiers addObject:canonicalIdentifier];
        }
    }
    NSMutableArray<NSDictionary<NSString *, NSString *> *> *themes =
        [NSMutableArray array];
    NSUInteger importedPackCount = 0;
    NSUInteger importedThemeBytes = 0;
    for (NSString *packIdentifier in packIdentifiers) {
        int packFD = openat(rootFD, packIdentifier.fileSystemRepresentation,
                            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        if (packFD < 0 ||
            !OreoFileDescriptorIsPrivateOwnedDirectory(packFD) ||
            !OreoFileDescriptorIsWithinDirectory(packFD, rootFD)) {
            if (packFD >= 0) {
                close(packFD);
            }
            continue;
        }
        importedPackCount++;
        if (importedPackCount > OreoMaximumImportedPacks) {
            NSLog(@"Cursor Atelier: imported pack count exceeds its limit.");
            close(packFD);
            break;
        }

        NSData *manifestData = OreoReadBoundedRegularFileAtDirectoryFD(
            packFD, @"manifest.json", OreoMaximumImportedManifestBytes, NULL);
        id root = manifestData ?
            [NSJSONSerialization JSONObjectWithData:manifestData
                                            options:0 error:NULL] : nil;
        id schemaVersion = [root isKindOfClass:[NSDictionary class]]
            ? root[@"schemaVersion"] : nil;
        id candidate = [root isKindOfClass:[NSDictionary class]]
            ? root[@"themes"] : nil;
        if (![schemaVersion isKindOfClass:[NSNumber class]] ||
            CFGetTypeID((__bridge CFTypeRef)schemaVersion) ==
                CFBooleanGetTypeID() ||
            ![(NSNumber *)schemaVersion isEqualToNumber:@2] ||
            ![candidate isKindOfClass:[NSArray class]] ||
            [(NSArray *)candidate count] == 0 ||
            [(NSArray *)candidate count] > OreoMaximumImportedThemesPerPack) {
            NSLog(@"Cursor Atelier: imported pack %@ has an invalid schema-v2 manifest.",
                  packIdentifier);
            close(packFD);
            continue;
        }

        NSMutableSet<NSString *> *packThemeIdentifiers = [NSMutableSet set];
        NSMutableSet<NSString *> *packResources = [NSMutableSet set];
        NSMutableArray<NSDictionary<NSString *, NSString *> *> *packThemes =
            [NSMutableArray arrayWithCapacity:[(NSArray *)candidate count]];
        NSUInteger packThemeBytes = 0;
        BOOL packValid = YES;
        for (id object in (NSArray *)candidate) {
            NSDictionary<NSString *, NSString *> *validated =
                OreoValidatedThemeSpecification(object);
            NSString *identifier = validated[OreoThemeIdentifierSpecKey];
            NSString *canonicalIdentifier =
                OreoCanonicalThemeIdentifier(identifier);
            NSString *resource = validated[OreoThemeResourceSpecKey];
            if (!validated ||
                [identifiers containsObject:canonicalIdentifier] ||
                [packThemeIdentifiers containsObject:canonicalIdentifier] ||
                [packResources containsObject:resource]) {
                packValid = NO;
                break;
            }
            NSData *themeData = OreoReadBoundedRegularFileAtDirectoryFD(
                packFD, resource, OreoMaximumImportedThemeBytes, NULL);
            BOOL integrityValid = themeData &&
                [OreoSHA256(themeData)
                    isEqualToString:validated[OreoThemeSHA256SpecKey]];
            BOOL structurallyValid = NO;
            if (integrityValid) {
                @autoreleasepool {
                    structurallyValid = OreoDecodedThemeCursors(
                        themeData, validated, NULL) != nil;
                }
            }
            if (!integrityValid || !structurallyValid ||
                packThemeBytes >
                    OreoMaximumImportedPackThemeBytes - themeData.length) {
                packValid = NO;
                break;
            }
            packThemeBytes += themeData.length;
            NSMutableDictionary<NSString *, NSString *> *installed =
                [validated mutableCopy];
            installed[OreoThemeImportedPackSpecKey] = packIdentifier;
            [packThemeIdentifiers addObject:canonicalIdentifier];
            [packResources addObject:resource];
            [packThemes addObject:[installed copy]];
        }
        close(packFD);
        if (!packValid ||
            importedThemeBytes >
                OreoMaximumImportedThemeBytesTotal - packThemeBytes ||
            themes.count > OreoMaximumImportedThemes - packThemes.count) {
            NSLog(@"Cursor Atelier: imported pack %@ failed validation.",
                  packIdentifier);
            continue;
        }
        importedThemeBytes += packThemeBytes;
        [identifiers unionSet:packThemeIdentifiers];
        [themes addObjectsFromArray:packThemes];
    }
    close(rootFD);
    return [themes copy];
}

static NSArray<NSDictionary<NSString *, NSString *> *> *
OreoBundledThemeSpecificationsForBundle(NSBundle *bundle) {
    NSMutableArray<NSDictionary<NSString *, NSString *> *> *themes =
        [OreoThemeSpecifications() mutableCopy];
    [themes addObjectsFromArray:OreoGeneratedThemeSpecifications(bundle)];
    return [themes copy];
}

static NSArray<NSDictionary<NSString *, NSString *> *> *
OreoThemeSpecificationsForBundle(NSBundle *bundle) {
    NSMutableArray<NSDictionary<NSString *, NSString *> *> *themes =
        [OreoBundledThemeSpecificationsForBundle(bundle) mutableCopy];
    NSSet<NSString *> *bundledIdentifiers = [NSSet setWithArray:
        [themes valueForKey:OreoThemeIdentifierSpecKey]];
    [themes addObjectsFromArray:
        OreoImportedThemeSpecifications(bundledIdentifiers)];
    return [themes copy];
}

static NSData * _Nullable OreoThemeResourceData(
    NSDictionary<NSString *, NSString *> *specification, NSBundle *bundle,
    NSError **error) {
    NSString *resource = specification[OreoThemeResourceSpecKey];
    NSString *packIdentifier =
        specification[OreoThemeImportedPackSpecKey];
    NSData *data = nil;
    if (packIdentifier.length > 0) {
        data = OreoReadImportedPackFile(packIdentifier, resource,
                                        OreoMaximumImportedThemeBytes, error);
    } else {
        NSString *resourceBaseName = resource.pathExtension.length > 0
            ? resource.stringByDeletingPathExtension : resource;
        NSString *resourceExtension = resource.pathExtension.length > 0
            ? resource.pathExtension : @"cursor";
        NSURL *themeURL = [bundle URLForResource:resourceBaseName
                                   withExtension:resourceExtension
                                    subdirectory:@"Themes"];
        if (!themeURL) {
            if (error) {
                *error = OreoError(200, @"The %@ cursor theme is missing.",
                                   specification[OreoThemeDisplayNameSpecKey]);
            }
            return nil;
        }
        data = [NSData dataWithContentsOfURL:themeURL
                                     options:NSDataReadingMappedIfSafe
                                       error:error];
        if (data.length == 0 || data.length > OreoMaximumDecodedBytes) {
            if (error) {
                *error = OreoError(201,
                    @"The %@ cursor theme has an invalid file size.",
                    specification[OreoThemeDisplayNameSpecKey]);
            }
            return nil;
        }
    }
    if (!data) {
        return nil;
    }
    if (![OreoSHA256(data)
            isEqualToString:specification[OreoThemeSHA256SpecKey]]) {
        if (error) {
            *error = OreoError(202,
                @"The %@ cursor theme failed its integrity check. Nothing was changed.",
                specification[OreoThemeDisplayNameSpecKey]);
        }
        return nil;
    }
    return data;
}

static NSString *OreoSysctlString(const char *name) {
    size_t length = 0;
    if (sysctlbyname(name, NULL, &length, NULL, 0) != 0 || length < 2 ||
        length > 4096) {
        return @"unknown";
    }
    NSMutableData *data = [NSMutableData dataWithLength:length];
    if (sysctlbyname(name, data.mutableBytes, &length, NULL, 0) != 0) {
        return @"unknown";
    }
    NSString *value = [[NSString alloc] initWithBytes:data.bytes
                                               length:strnlen(data.bytes, length)
                                             encoding:NSUTF8StringEncoding];
    return value.length > 0 ? value : @"unknown";
}

static BOOL OreoIsFiniteNumber(id object, double minimum, double maximum,
                               double *value) {
    if (![object isKindOfClass:[NSNumber class]] ||
        CFGetTypeID((__bridge CFTypeRef)object) == CFBooleanGetTypeID()) {
        return NO;
    }
    double candidate = [object doubleValue];
    if (!isfinite(candidate) || candidate < minimum || candidate > maximum) {
        return NO;
    }
    if (value) {
        *value = candidate;
    }
    return YES;
}

static NSSet<NSString *> *OreoExplicitThemeIdentifiers(void) {
    static NSSet<NSString *> *identifiers;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        identifiers = [NSSet setWithArray:@[
            @"com.apple.coregraphics.Alias",
            @"com.apple.coregraphics.Arrow",
            @"com.apple.coregraphics.ArrowCtx",
            @"com.apple.coregraphics.ArrowS",
            @"com.apple.coregraphics.Copy",
            @"com.apple.coregraphics.Empty",
            @"com.apple.coregraphics.IBeam",
            @"com.apple.coregraphics.IBeamS",
            @"com.apple.coregraphics.IBeamXOR",
            @"com.apple.coregraphics.Move",
            @"com.apple.coregraphics.Wait",
            @"com.apple.cursor.2",
            @"com.apple.cursor.3",
            @"com.apple.cursor.4",
            @"com.apple.cursor.5",
            @"com.apple.cursor.7",
            @"com.apple.cursor.8",
            @"com.apple.cursor.11",
            @"com.apple.cursor.12",
            @"com.apple.cursor.13",
            @"com.apple.cursor.17",
            @"com.apple.cursor.18",
            @"com.apple.cursor.19",
            @"com.apple.cursor.20",
            @"com.apple.cursor.21",
            @"com.apple.cursor.22",
            @"com.apple.cursor.23",
            @"com.apple.cursor.24",
            @"com.apple.cursor.25",
            @"com.apple.cursor.26",
            @"com.apple.cursor.27",
            @"com.apple.cursor.28",
            @"com.apple.cursor.29",
            @"com.apple.cursor.30",
            @"com.apple.cursor.31",
            @"com.apple.cursor.32",
            @"com.apple.cursor.33",
            @"com.apple.cursor.34",
            @"com.apple.cursor.35",
            @"com.apple.cursor.36",
            @"com.apple.cursor.37",
            @"com.apple.cursor.38",
            @"com.apple.cursor.39",
            @"com.apple.cursor.40",
            @"com.apple.cursor.41",
            @"com.apple.cursor.42",
            @"com.apple.cursor.43",
        ]];
    });
    return identifiers;
}

/// Supplemental identifiers used by browsers and AppKit. Each alias maps to
/// an explicit Oreo source with the same semantic role. Deliberately omitted:
/// Alias/Link, Crosshair/Cell, Screenshot cursors, and Counting Hand cursors.
static NSDictionary<NSString *, NSString *> *OreoSupplementalAliasMap(void) {
    static NSDictionary<NSString *, NSString *> *aliases;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        aliases = @{
            @"com.apple.cursor.0": @"com.apple.coregraphics.Arrow",
            @"com.apple.cursor.1": @"com.apple.coregraphics.IBeam",
            @"com.apple.coregraphics.NotAllowed": @"com.apple.cursor.3",
            @"com.apple.coregraphics.ClosedHand": @"com.apple.cursor.11",
            @"com.apple.coregraphics.OpenHand": @"com.apple.cursor.12",
            @"com.apple.coregraphics.PointingHand": @"com.apple.cursor.13",
            @"com.apple.coregraphics.ResizeLeft": @"com.apple.cursor.17",
            @"com.apple.coregraphics.ResizeRight": @"com.apple.cursor.18",
            @"com.apple.coregraphics.ResizeLeftRight": @"com.apple.cursor.19",
            @"com.apple.coregraphics.ResizeUp": @"com.apple.cursor.21",
            @"com.apple.coregraphics.ResizeDown": @"com.apple.cursor.22",
            @"com.apple.coregraphics.ResizeUpDown": @"com.apple.cursor.23",
            @"com.apple.coregraphics.Poof": @"com.apple.cursor.25",
            @"com.apple.coregraphics.IBeamH": @"com.apple.cursor.26",
            @"com.apple.coregraphics.WindowResizeEast": @"com.apple.cursor.27",
            @"com.apple.coregraphics.WindowResizeEastWest": @"com.apple.cursor.28",
            @"com.apple.coregraphics.WindowResizeNortheast": @"com.apple.cursor.29",
            @"com.apple.coregraphics.WindowResizeNortheastSouthwest":
                @"com.apple.cursor.30",
            @"com.apple.coregraphics.WindowResizeNorth": @"com.apple.cursor.31",
            @"com.apple.coregraphics.WindowResizeNorthSouth":
                @"com.apple.cursor.32",
            @"com.apple.coregraphics.WindowResizeNorthwest":
                @"com.apple.cursor.33",
            @"com.apple.coregraphics.WindowResizeNorthwestSoutheast":
                @"com.apple.cursor.34",
            @"com.apple.coregraphics.WindowResizeSoutheast":
                @"com.apple.cursor.35",
            @"com.apple.coregraphics.WindowResizeSouth": @"com.apple.cursor.36",
            @"com.apple.coregraphics.WindowResizeSouthwest":
                @"com.apple.cursor.37",
            @"com.apple.coregraphics.WindowResizeWest": @"com.apple.cursor.38",
            @"com.apple.coregraphics.Help": @"com.apple.cursor.40",
            @"com.apple.coregraphics.Cell": @"com.apple.cursor.41",
            @"com.apple.coregraphics.ZoomIn": @"com.apple.cursor.42",
            @"com.apple.coregraphics.ZoomOut": @"com.apple.cursor.43",
        };
    });
    return aliases;
}

static NSDictionary<NSString *, NSString *> *OreoSystemCursorFolderMap(void) {
    static NSDictionary<NSString *, NSString *> *folders;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        folders = @{
            @"com.apple.coregraphics.Alias": @"makealias",
            @"com.apple.coregraphics.Copy": @"copy",
            @"com.apple.coregraphics.ArrowCtx": @"contextualmenu",
            @"com.apple.coregraphics.Move": @"move",
            @"com.apple.coregraphics.IBeam": @"ibeamhorizontal",
            @"com.apple.coregraphics.IBeamS": @"ibeamhorizontal",
            @"com.apple.coregraphics.IBeamXOR": @"ibeamhorizontal",
            @"com.apple.coregraphics.Wait": @"busybutclickable",
            @"com.apple.coregraphics.NotAllowed": @"notallowed",
            @"com.apple.coregraphics.ClosedHand": @"closedhand",
            @"com.apple.coregraphics.OpenHand": @"openhand",
            @"com.apple.coregraphics.PointingHand": @"pointinghand",
            @"com.apple.coregraphics.ResizeLeft": @"resizeleft",
            @"com.apple.coregraphics.ResizeRight": @"resizeright",
            @"com.apple.coregraphics.ResizeLeftRight": @"resizeleftright",
            @"com.apple.coregraphics.ResizeUp": @"resizeup",
            @"com.apple.coregraphics.ResizeDown": @"resizedown",
            @"com.apple.coregraphics.ResizeUpDown": @"resizeupdown",
            @"com.apple.coregraphics.Poof": @"poof",
            @"com.apple.coregraphics.IBeamH": @"ibeamvertical",
            @"com.apple.coregraphics.WindowResizeEast": @"resizeeast",
            @"com.apple.coregraphics.WindowResizeEastWest": @"resizeeastwest",
            @"com.apple.coregraphics.WindowResizeNortheast": @"resizenortheast",
            @"com.apple.coregraphics.WindowResizeNortheastSouthwest":
                @"resizenortheastsouthwest",
            @"com.apple.coregraphics.WindowResizeNorth": @"resizenorth",
            @"com.apple.coregraphics.WindowResizeNorthSouth":
                @"resizenorthsouth",
            @"com.apple.coregraphics.WindowResizeNorthwest": @"resizenorthwest",
            @"com.apple.coregraphics.WindowResizeNorthwestSoutheast":
                @"resizenorthwestsoutheast",
            @"com.apple.coregraphics.WindowResizeSoutheast": @"resizesoutheast",
            @"com.apple.coregraphics.WindowResizeSouth": @"resizesouth",
            @"com.apple.coregraphics.WindowResizeSouthwest": @"resizesouthwest",
            @"com.apple.coregraphics.WindowResizeWest": @"resizewest",
            @"com.apple.coregraphics.Help": @"help",
            @"com.apple.coregraphics.Cell": @"cell",
            @"com.apple.coregraphics.ZoomIn": @"zoomin",
            @"com.apple.coregraphics.ZoomOut": @"zoomout",
            @"com.apple.cursor.2": @"pointinghand",
            @"com.apple.cursor.3": @"notallowed",
            @"com.apple.cursor.4": @"busybutclickable",
            @"com.apple.cursor.5": @"copy",
            @"com.apple.cursor.7": @"cross",
            @"com.apple.cursor.8": @"cross",
            @"com.apple.cursor.11": @"closedhand",
            @"com.apple.cursor.12": @"openhand",
            @"com.apple.cursor.13": @"pointinghand",
            @"com.apple.cursor.17": @"resizeleft",
            @"com.apple.cursor.18": @"resizeright",
            @"com.apple.cursor.19": @"resizeleftright",
            @"com.apple.cursor.20": @"cross",
            @"com.apple.cursor.21": @"resizeup",
            @"com.apple.cursor.22": @"resizedown",
            @"com.apple.cursor.23": @"resizeupdown",
            @"com.apple.cursor.24": @"contextualmenu",
            @"com.apple.cursor.25": @"poof",
            @"com.apple.cursor.26": @"ibeamvertical",
            @"com.apple.cursor.27": @"resizeeast",
            @"com.apple.cursor.28": @"resizeeastwest",
            @"com.apple.cursor.29": @"resizenortheast",
            @"com.apple.cursor.30": @"resizenortheastsouthwest",
            @"com.apple.cursor.31": @"resizenorth",
            @"com.apple.cursor.32": @"resizenorthsouth",
            @"com.apple.cursor.33": @"resizenorthwest",
            @"com.apple.cursor.34": @"resizenorthwestsoutheast",
            @"com.apple.cursor.35": @"resizesoutheast",
            @"com.apple.cursor.36": @"resizesouth",
            @"com.apple.cursor.37": @"resizesouthwest",
            @"com.apple.cursor.38": @"resizewest",
            @"com.apple.cursor.39": @"move",
            @"com.apple.cursor.40": @"help",
            @"com.apple.cursor.41": @"cell",
            @"com.apple.cursor.42": @"zoomin",
            @"com.apple.cursor.43": @"zoomout",
        };
    });
    return folders;
}

// Several named stock cursors intentionally read back as opaque red 8×8
// placeholders. These core IDs expose the native cursor representation,
// including Apple's scale-specific rendering and shadows, on macOS 26.
static NSDictionary<NSString *, NSNumber *> *OreoPlaceholderCoreIDMap(void) {
    static NSDictionary<NSString *, NSNumber *> *coreIDs;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        coreIDs = @{
            @"com.apple.coregraphics.Alias": @2,
            @"com.apple.coregraphics.ArrowCtx": @24,
            @"com.apple.coregraphics.Copy": @5,
            @"com.apple.coregraphics.IBeamXOR": @1,
        };
    });
    return coreIDs;
}

static NSSet<NSString *> *OreoAllTargetIdentifiers(void) {
    static NSSet<NSString *> *identifiers;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSMutableSet *targets = [OreoExplicitThemeIdentifiers() mutableCopy];
        [targets addObjectsFromArray:OreoSupplementalAliasMap().allKeys];
        identifiers = [targets copy];
    });
    return identifiers;
}

static NSArray<NSString *> *OreoSortedTargetIdentifiers(void) {
    return [OreoAllTargetIdentifiers().allObjects
        sortedArrayUsingSelector:@selector(compare:)];
}

static CGImageRef _Nullable OreoCreateImageFromPNG(NSData *data) {
    if (![data isKindOfClass:[NSData class]] || data.length < 16) {
        return NULL;
    }
    const uint8_t *bytes = data.bytes;
    static const uint8_t pngSignature[8] =
        {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
    if (memcmp(bytes, pngSignature, sizeof(pngSignature)) != 0) {
        return NULL;
    }
    CGImageSourceRef source = CGImageSourceCreateWithData(
        (__bridge CFDataRef)data, NULL);
    if (!source || CGImageSourceGetCount(source) != 1) {
        if (source) {
            CFRelease(source);
        }
        return NULL;
    }
    NSDictionary *properties = CFBridgingRelease(
        CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
    NSNumber *widthValue = properties[(__bridge NSString *)kCGImagePropertyPixelWidth];
    NSNumber *heightValue = properties[(__bridge NSString *)kCGImagePropertyPixelHeight];
    NSUInteger width = widthValue.unsignedIntegerValue;
    NSUInteger height = heightValue.unsignedIntegerValue;
    if (width == 0 || height == 0 ||
        width > OreoMaximumDecodedDimension ||
        height > OreoMaximumDecodedDimension ||
        width > SIZE_MAX / 4 ||
        height > SIZE_MAX / (width * 4) ||
        width * height * 4 > OreoMaximumDecodedBytes) {
        CFRelease(source);
        return NULL;
    }
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    return image;
}

static NSData * _Nullable OreoPNGDataForImage(CGImageRef image) {
    if (!image) {
        return nil;
    }
    CFMutableDataRef mutableData = CFDataCreateMutable(kCFAllocatorDefault, 0);
    if (!mutableData) {
        return nil;
    }
    CGImageDestinationRef destination = CGImageDestinationCreateWithData(
        mutableData, CFSTR("public.png"), 1, NULL);
    if (!destination) {
        CFRelease(mutableData);
        return nil;
    }
    CGImageDestinationAddImage(destination, image, NULL);
    BOOL finalized = CGImageDestinationFinalize(destination);
    CFRelease(destination);
    if (!finalized) {
        CFRelease(mutableData);
        return nil;
    }
    return CFBridgingRelease(mutableData);
}

static NSString * _Nullable OreoPixelHash(CGImageRef image) {
    if (!image) {
        return nil;
    }
    size_t width = CGImageGetWidth(image);
    size_t height = CGImageGetHeight(image);
    if (width == 0 || height == 0 || width > OreoMaximumDecodedDimension ||
        height > OreoMaximumDecodedDimension ||
        width > SIZE_MAX / 4 ||
        height > SIZE_MAX / (width * 4)) {
        return nil;
    }
    size_t byteCount = width * height * 4;
    if (byteCount > OreoMaximumDecodedBytes) {
        return nil;
    }
    NSMutableData *pixels = [NSMutableData dataWithLength:byteCount];
    CGColorSpaceRef colorSpace =
        CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    if (!colorSpace) {
        return nil;
    }
    CGContextRef context = CGBitmapContextCreate(
        pixels.mutableBytes, width, height, 8, width * 4, colorSpace,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(colorSpace);
    if (!context) {
        return nil;
    }
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGContextRelease(context);

    NSMutableData *hashInput = [NSMutableData dataWithCapacity:byteCount + 16];
    uint64_t dimensions[2] = {(uint64_t)width, (uint64_t)height};
    [hashInput appendBytes:dimensions length:sizeof(dimensions)];
    [hashInput appendData:pixels];
    return OreoSHA256(hashInput);
}

static BOOL OreoImageIsRedPlaceholder(CGImageRef image) {
    if (!image) {
        return YES;
    }
    size_t width = CGImageGetWidth(image);
    size_t height = CGImageGetHeight(image);
    if (width == 0 || height == 0 || width > 32 || height > 32) {
        return NO;
    }
    NSMutableData *pixels = [NSMutableData dataWithLength:width * height * 4];
    CGColorSpaceRef colorSpace =
        CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    if (!colorSpace) {
        return YES;
    }
    CGContextRef context = CGBitmapContextCreate(
        pixels.mutableBytes, width, height, 8, width * 4, colorSpace,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(colorSpace);
    if (!context) {
        return YES;
    }
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGContextRelease(context);

    const uint8_t *bytes = pixels.bytes;
    for (size_t index = 0; index < width * height; index++) {
        const uint8_t *pixel = bytes + index * 4;
        if (pixel[0] != 255 || pixel[1] != 0 ||
            pixel[2] != 0 || pixel[3] != 255) {
            return NO;
        }
    }
    return YES;
}

static BOOL OreoNearlyEqual(double lhs, double rhs) {
    return fabs(lhs - rhs) <= 0.01;
}

static NSDictionary<NSString *, NSDictionary *> * _Nullable
OreoThemeCursorsByScalingGeometry(
    NSDictionary<NSString *, NSDictionary *> *cursors,
    NSInteger sizePercentage,
    NSError **error) {
    if (sizePercentage == OreoDefaultThemeSizePercentage) {
        return cursors;
    }
    double factor = sizePercentage / 100.0;
    NSMutableDictionary<NSString *, NSDictionary *> *scaled =
        [NSMutableDictionary dictionaryWithCapacity:cursors.count];
    for (NSString *identifier in cursors) {
        NSDictionary *record = cursors[identifier];
        double width = [record[@"PointsWide"] doubleValue] * factor;
        double height = [record[@"PointsHigh"] doubleValue] * factor;
        double hotX = [record[@"HotSpotX"] doubleValue] * factor;
        double hotY = [record[@"HotSpotY"] doubleValue] * factor;
        if (!isfinite(width) || !isfinite(height) || !isfinite(hotX) ||
            !isfinite(hotY) || width <= 0 || height <= 0 || width > 256 ||
            height > 256 || hotX < 0 || hotY < 0 || hotX >= width ||
            hotY >= height) {
            if (error) {
                *error = OreoError(
                    372, @"Cursor %@ cannot be registered at %ld%%.",
                    identifier, (long)sizePercentage);
            }
            return nil;
        }
        NSMutableDictionary *scaledRecord = [record mutableCopy];
        scaledRecord[@"PointsWide"] = @(width);
        scaledRecord[@"PointsHigh"] = @(height);
        scaledRecord[@"HotSpotX"] = @(hotX);
        scaledRecord[@"HotSpotY"] = @(hotY);
        // Images, hashes, frame count, duration, and representation order stay
        // byte-for-byte identical. WindowServer scales those source rasters to
        // the registration geometry, avoiding a second baked resampling pass.
        scaled[identifier] = [scaledRecord copy];
    }
    return [scaled copy];
}

@interface OreoCursorEngine () {
    OreoPrivateCursorAPI _api;
    NSDictionary<NSString *, NSDictionary *> *_themeCursors;
    NSURL *_dataDirectoryURL;
    NSURL *_snapshotURL;
    NSURL *_transactionURL;
    NSURL *_operationLockURL;
    NSBundle *_themeResourceBundle;
    NSDictionary<NSString *, NSString *> *_themeSpecification;
    NSDictionary *_validatedSnapshot;
    NSString *_validatedSnapshotIdentity;
}

@property (nonatomic, readwrite) BOOL supported;
@property (nonatomic, readwrite) BOOL themeValid;
@property (nonatomic, readwrite, copy) NSString *bootSessionUUID;
@property (nonatomic, readwrite, copy) NSString *osBuild;
@property (nonatomic, readwrite, copy, nullable) NSString *lastErrorMessage;
@property (nonatomic, readwrite, copy) NSString *themeSHA256;
@property (nonatomic, readwrite, copy) NSString *themeIdentifier;
@property (nonatomic, readwrite, copy) NSString *themeDisplayName;
@property (nonatomic, readwrite) NSInteger themeSizePercentage;

+ (NSInteger)resolvedSizePercentageForThemeIdentifier:
    (NSString *)themeIdentifier;

@end

@implementation OreoCursorEngine

- (instancetype)init {
    return [self initWithError:NULL];
}

+ (NSArray<NSDictionary<NSString *, id> *> *)availableThemes {
    NSMutableArray<NSDictionary<NSString *, id> *> *themes =
        [NSMutableArray array];
    for (NSDictionary<NSString *, NSString *> *specification in
             OreoThemeSpecificationsForBundle(NSBundle.mainBundle)) {
        NSMutableDictionary<NSString *, id> *theme =
            [specification mutableCopy];
        NSString *identifier = specification[OreoThemeIdentifierSpecKey];
        theme[@"SizePercentage"] =
            @([self sizePercentageForThemeIdentifier:identifier]);
        [themes addObject:[theme copy]];
    }
    return [themes copy];
}

+ (NSData *)themeResourceDataForIdentifier:(NSString *)identifier
                                      error:(NSError **)error {
    NSDictionary<NSString *, NSString *> *specification =
        OreoThemeSpecificationForBundle(identifier, NSBundle.mainBundle);
    if (!specification) {
        if (error) {
            *error = OreoError(86, @"Unknown cursor theme: %@.", identifier);
        }
        return nil;
    }
    return OreoThemeResourceData(specification, NSBundle.mainBundle, error);
}

+ (NSString *)selectedThemeIdentifier {
    NSString *saved =
        [OreoCursorDefaults() stringForKey:OreoCursorThemeDefaultsKey];
    // The login helper reads shared preferences before it has validated the
    // outer app bundle. Preserve a syntactically safe generated identifier so
    // initWithThemeIdentifier:resourceBundle: can validate it against that
    // outer bundle instead of silently reverting to Oreo White.
    return OreoIsSafeThemeIdentifier(saved) ? saved : OreoDefaultThemeIdentifier;
}

+ (BOOL)saveSelectedThemeIdentifier:(NSString *)themeIdentifier
                              error:(NSError **)error {
    if (!OreoThemeSpecificationForBundle(themeIdentifier,
                                         NSBundle.mainBundle)) {
        if (error) {
            *error = OreoError(87, @"Unknown cursor theme: %@.",
                               themeIdentifier);
        }
        return NO;
    }
    NSUserDefaults *defaults = OreoCursorDefaults();
    id previous = [defaults objectForKey:OreoCursorThemeDefaultsKey];
    [defaults setObject:themeIdentifier forKey:OreoCursorThemeDefaultsKey];
    if (![defaults synchronize]) {
        if (previous) {
            [defaults setObject:previous forKey:OreoCursorThemeDefaultsKey];
        } else {
            [defaults removeObjectForKey:OreoCursorThemeDefaultsKey];
        }
        [defaults synchronize];
        if (error) {
            *error = OreoError(
                88, @"Could not save the selected cursor theme.");
        }
        return NO;
    }
    return YES;
}

+ (NSInteger)sizePercentageForThemeIdentifier:(NSString *)themeIdentifier {
    if (!OreoIsSafeThemeIdentifier(themeIdentifier)) {
        return OreoDefaultThemeSizePercentage;
    }
    NSDictionary *saved =
        [OreoCursorDefaults() dictionaryForKey:OreoCursorThemeSizesDefaultsKey];
    NSInteger result = OreoDefaultThemeSizePercentage;
    return OreoReadThemeSizePercentage(saved[themeIdentifier], &result)
        ? result
        : OreoDefaultThemeSizePercentage;
}

+ (NSInteger)effectiveSizePercentage {
    NSInteger result = OreoDefaultThemeSizePercentage;
    return OreoReadThemeSizePercentage(
        [OreoCursorDefaults()
            objectForKey:OreoCursorEffectiveThemeSizeDefaultsKey],
        &result)
        ? result
        : OreoDefaultThemeSizePercentage;
}

+ (BOOL)saveSizePercentage:(NSInteger)sizePercentage
        forThemeIdentifier:(NSString *)themeIdentifier
                     error:(NSError **)error {
    if (sizePercentage < OreoMinimumThemeSizePercentage ||
        sizePercentage > OreoMaximumThemeSizePercentage) {
        if (error) {
            *error = OreoError(
                370, @"Cursor size must be between 50%% and 200%%.");
        }
        return NO;
    }
    if (!OreoThemeSpecificationForBundle(themeIdentifier,
                                         NSBundle.mainBundle)) {
        if (error) {
            *error = OreoError(87, @"Unknown cursor theme: %@.",
                               themeIdentifier);
        }
        return NO;
    }

    NSUserDefaults *defaults = OreoCursorDefaults();
    id previous = [defaults objectForKey:OreoCursorThemeSizesDefaultsKey];
    NSDictionary *stored = [previous isKindOfClass:[NSDictionary class]]
        ? previous
        : @{};
    NSMutableDictionary<NSString *, NSNumber *> *sizes =
        [NSMutableDictionary dictionary];
    NSSet<NSString *> *availableIdentifiers = [NSSet setWithArray:
        [OreoThemeSpecificationsForBundle(NSBundle.mainBundle)
            valueForKey:OreoThemeIdentifierSpecKey]];
    NSMutableArray<NSString *> *storedIdentifiers = [NSMutableArray array];
    for (id identifier in stored) {
        if ([identifier isKindOfClass:[NSString class]]) {
            [storedIdentifiers addObject:identifier];
        }
    }
    [storedIdentifiers sortUsingSelector:@selector(compare:)];
    NSUInteger retainedLimit = sizePercentage == OreoDefaultThemeSizePercentage
        ? OreoMaximumThemeSizeEntries
        : OreoMaximumThemeSizeEntries - 1;
    for (NSString *identifier in storedIdentifiers) {
        NSInteger savedSize = 0;
        if (sizes.count >= retainedLimit ||
            [identifier isEqualToString:themeIdentifier] ||
            ![availableIdentifiers containsObject:identifier] ||
            !OreoIsSafeThemeIdentifier(identifier) ||
            !OreoReadThemeSizePercentage(stored[identifier], &savedSize)) {
            continue;
        }
        sizes[identifier] = @(savedSize);
    }
    if (sizePercentage == OreoDefaultThemeSizePercentage) {
        [sizes removeObjectForKey:themeIdentifier];
    } else {
        sizes[themeIdentifier] = @(sizePercentage);
    }
    if (sizes.count > 0) {
        [defaults setObject:[sizes copy]
                     forKey:OreoCursorThemeSizesDefaultsKey];
    } else {
        [defaults removeObjectForKey:OreoCursorThemeSizesDefaultsKey];
    }
    if (![defaults synchronize]) {
        if (previous) {
            [defaults setObject:previous
                         forKey:OreoCursorThemeSizesDefaultsKey];
        } else {
            [defaults removeObjectForKey:OreoCursorThemeSizesDefaultsKey];
        }
        [defaults synchronize];
        if (error) {
            *error = OreoError(371, @"Could not save the cursor size.");
        }
        return NO;
    }
    return YES;
}

+ (BOOL)forgetSizePercentageForThemeIdentifier:(NSString *)themeIdentifier
                                          error:(NSError **)error {
    if (!OreoIsSafeThemeIdentifier(themeIdentifier)) {
        if (error) {
            *error = OreoError(373, @"Invalid cursor theme identifier.");
        }
        return NO;
    }

    NSUserDefaults *defaults = OreoCursorDefaults();
    [defaults synchronize];
    id previous = [defaults objectForKey:OreoCursorThemeSizesDefaultsKey];
    NSDictionary *stored = [previous isKindOfClass:[NSDictionary class]]
        ? previous
        : nil;
    if (!stored[themeIdentifier]) {
        return YES;
    }
    NSMutableDictionary *sizes = [stored mutableCopy];
    [sizes removeObjectForKey:themeIdentifier];
    if (sizes.count > 0) {
        [defaults setObject:[sizes copy]
                     forKey:OreoCursorThemeSizesDefaultsKey];
    } else {
        [defaults removeObjectForKey:OreoCursorThemeSizesDefaultsKey];
    }
    if (![defaults synchronize]) {
        [defaults setObject:previous forKey:OreoCursorThemeSizesDefaultsKey];
        [defaults synchronize];
        if (error) {
            *error = OreoError(
                374, @"Could not forget the deleted cursor's size.");
        }
        return NO;
    }
    return YES;
}

- (instancetype)initWithError:(NSError **)error {
    return [self initWithThemeIdentifier:
                     [OreoCursorEngine selectedThemeIdentifier]
                            resourceBundle:NSBundle.mainBundle
                            sizePercentage:[OreoCursorEngine
                                resolvedSizePercentageForThemeIdentifier:
                                    [OreoCursorEngine selectedThemeIdentifier]]
                                     error:error];
}

- (instancetype)initWithThemeIdentifier:(NSString *)themeIdentifier
                          resourceBundle:(NSBundle *)resourceBundle
                                   error:(NSError **)error {
    return [self initWithThemeIdentifier:themeIdentifier
                           resourceBundle:resourceBundle
                           sizePercentage:[OreoCursorEngine
                               resolvedSizePercentageForThemeIdentifier:
                                   themeIdentifier]
                                    error:error];
}

+ (NSInteger)resolvedSizePercentageForThemeIdentifier:
    (NSString *)themeIdentifier {
    NSUserDefaults *defaults = OreoCursorDefaults();
    if ([defaults boolForKey:OreoCursorEffectiveDefaultsKey] &&
        [themeIdentifier isEqualToString:[self selectedThemeIdentifier]]) {
        return [self effectiveSizePercentage];
    }
    return [self sizePercentageForThemeIdentifier:themeIdentifier];
}

- (instancetype)initWithThemeIdentifier:(NSString *)themeIdentifier
                          resourceBundle:(NSBundle *)resourceBundle
                          sizePercentage:(NSInteger)sizePercentage
                                   error:(NSError **)error {
    self = [super init];
    if (!self) {
        return nil;
    }
    NSAssert([NSThread isMainThread], @"Cursor engine requires the main thread");

    _themeSpecification = OreoThemeSpecificationForBundle(themeIdentifier,
                                                          resourceBundle);
    _themeResourceBundle = resourceBundle;
    self.themeIdentifier = themeIdentifier ?: @"";
    self.themeDisplayName =
        _themeSpecification[OreoThemeDisplayNameSpecKey] ?: @"Unknown";
    self.themeSizePercentage = sizePercentage;
    self.bootSessionUUID = OreoSysctlString("kern.bootsessionuuid");
    self.osBuild = OreoSysctlString("kern.osversion");
    self.themeSHA256 = @"";
    if ([self.bootSessionUUID isEqual:@"unknown"] ||
        [self.osBuild isEqual:@"unknown"]) {
        NSError *identityError = OreoError(
            89, @"Cursor Atelier could not establish a safe boot-session "
                 "identity. Nothing was changed.");
        self.supported = NO;
        self.themeValid = NO;
        [self failWithError:identityError];
        if (error) {
            *error = identityError;
        }
        return self;
    }

    _dataDirectoryURL = OreoApplicationDataDirectoryURL();
    _snapshotURL =
        [_dataDirectoryURL URLByAppendingPathComponent:@"StockSnapshot.plist"];
    _transactionURL =
        [_dataDirectoryURL URLByAppendingPathComponent:@"Transaction.plist"];
    _operationLockURL =
        [_dataDirectoryURL URLByAppendingPathComponent:@"Operation.lock"];

    NSError *directoryError = nil;
    if (![[NSFileManager defaultManager]
            createDirectoryAtURL:_dataDirectoryURL
     withIntermediateDirectories:YES
                      attributes:@{NSFilePosixPermissions: @0700}
                           error:&directoryError]) {
        [self failWithError:directoryError];
        if (error) {
            *error = directoryError;
        }
        return self;
    }

    NSError *apiError = nil;
    self.supported = [self loadPrivateAPI:&apiError];
    if (!self.supported) {
        [self failWithError:apiError];
        if (error) {
            *error = apiError;
        }
        return self;
    }

    if (!_themeSpecification || !_themeResourceBundle) {
        NSError *themeSelectionError = OreoError(
            86, @"The selected cursor theme is not allowlisted.");
        self.themeValid = NO;
        [self failWithError:themeSelectionError];
        if (error) {
            *error = themeSelectionError;
        }
        return self;
    }
    if (sizePercentage < OreoMinimumThemeSizePercentage ||
        sizePercentage > OreoMaximumThemeSizePercentage) {
        NSError *themeSizeError = OreoError(
            370, @"Cursor size must be between 50%% and 200%%.");
        self.themeValid = NO;
        [self failWithError:themeSizeError];
        if (error) {
            *error = themeSizeError;
        }
        return self;
    }

    NSError *themeError = nil;
    self.themeValid = [self loadAndValidateTheme:&themeError];
    if (!self.themeValid) {
        [self failWithError:themeError];
        if (error) {
            *error = themeError;
        }
        return self;
    }

    return self;
}

- (void)failWithError:(NSError *)error {
    self.lastErrorMessage = error.localizedDescription ?: @"Unknown error";
    if (error) {
        NSLog(@"Cursor Atelier: %@", error.localizedDescription);
    }
}

- (NSError *)reportedError:(NSError **)error
                  fallback:(NSError *)fallback {
    NSError *reported = error && *error ? *error : fallback;
    if (error && !*error) {
        *error = reported;
    }
    [self failWithError:reported];
    return reported;
}

- (int)acquireOperationLock:(NSError **)error {
    int descriptor = open(_operationLockURL.fileSystemRepresentation,
                          O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    if (descriptor < 0) {
        if (error) {
            *error = OreoError(
                90, @"Could not open the cursor operation lock: %s.",
                strerror(errno));
        }
        return -1;
    }
    fchmod(descriptor, 0600);
    if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) {
        int lockError = errno;
        close(descriptor);
        if (error) {
            *error = OreoError(
                91, lockError == EWOULDBLOCK
                    ? @"Another Cursor Atelier process is already changing "
                       "cursor state. Try again in a moment."
                    : [NSString stringWithFormat:
                        @"Could not lock cursor state: %s.",
                        strerror(lockError)]);
        }
        return -1;
    }
    return descriptor;
}

- (void)releaseOperationLock:(int)descriptor {
    if (descriptor >= 0) {
        flock(descriptor, LOCK_UN);
        close(descriptor);
    }
}

- (void)invalidateSnapshotCache {
    _validatedSnapshot = nil;
    _validatedSnapshotIdentity = nil;
}

- (NSString * _Nullable)snapshotFileIdentity:(NSError **)error {
    struct stat state;
    if (lstat(_snapshotURL.fileSystemRepresentation, &state) != 0) {
        if (error) {
            *error = OreoError(
                93, @"Could not inspect the stock snapshot: %s.",
                strerror(errno));
        }
        return nil;
    }
    if (!S_ISREG(state.st_mode) || state.st_uid != geteuid() ||
        state.st_nlink != 1 || (state.st_mode & 0077) != 0) {
        if (error) {
            *error = OreoError(
                94, @"The stock snapshot is not a private regular file.");
        }
        return nil;
    }
    return [NSString stringWithFormat:
        @"%llu:%llu:%lld:%lld:%ld:%lld:%ld",
        (unsigned long long)state.st_dev,
        (unsigned long long)state.st_ino,
        (long long)state.st_size,
        (long long)state.st_mtimespec.tv_sec,
        (long)state.st_mtimespec.tv_nsec,
        (long long)state.st_ctimespec.tv_sec,
        (long)state.st_ctimespec.tv_nsec];
}

- (BOOL)persistDesiredState:(BOOL)desired
             effectiveState:(BOOL)effective
             activeSnapshot:(BOOL)activeSnapshot
                       error:(NSError **)error {
    NSUserDefaults *defaults = OreoCursorDefaults();
    [defaults setBool:desired forKey:OreoCursorEnabledDefaultsKey];
    [defaults setBool:effective forKey:OreoCursorEffectiveDefaultsKey];
    if (activeSnapshot) {
        [defaults setObject:self.bootSessionUUID
                     forKey:OreoCursorActiveBootDefaultsKey];
    } else {
        [defaults removeObjectForKey:OreoCursorActiveBootDefaultsKey];
    }
    if (![defaults synchronize]) {
        if (error) {
            *error = OreoError(
                92, @"Could not durably save Cursor Atelier's state.");
        }
        return NO;
    }
    return YES;
}

- (BOOL)persistAppliedState:(NSError **)error {
    NSUserDefaults *defaults = OreoCursorDefaults();
    id previousSize =
        [defaults objectForKey:OreoCursorEffectiveThemeSizeDefaultsKey];
    [defaults setInteger:self.themeSizePercentage
                  forKey:OreoCursorEffectiveThemeSizeDefaultsKey];
    if ([self persistDesiredState:YES
                  effectiveState:YES
                  activeSnapshot:YES
                            error:error]) {
        return YES;
    }
    if (previousSize) {
        [defaults setObject:previousSize
                     forKey:OreoCursorEffectiveThemeSizeDefaultsKey];
    } else {
        [defaults removeObjectForKey:OreoCursorEffectiveThemeSizeDefaultsKey];
    }
    [defaults synchronize];
    return NO;
}

- (BOOL)loadPrivateAPI:(NSError **)error {
    dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
           RTLD_LAZY | RTLD_GLOBAL);
    dlopen("/System/Library/Frameworks/AppKit.framework/AppKit",
           RTLD_LAZY | RTLD_GLOBAL);

#define OREO_RESOLVE(field, type, symbol) \
    _api.field = (type)dlsym(RTLD_DEFAULT, symbol)
    OREO_RESOLVE(mainConnectionID, OreoCGSMainConnectionIDFn,
                 "CGSMainConnectionID");
    OREO_RESOLVE(registerCursor, OreoCGSRegisterCursorWithImagesFn,
                 "CGSRegisterCursorWithImages");
    OREO_RESOLVE(activateCursor, OreoCGSSetRegisteredCursorFn,
                 "CGSSetRegisteredCursor");
    OREO_RESOLVE(copyRegisteredCursor, OreoCGSCopyRegisteredCursorImagesFn,
                 "CGSCopyRegisteredCursorImages");
    OREO_RESOLVE(registeredCursorDataSize,
                 OreoCGSGetRegisteredCursorDataSizeFn,
                 "CGSGetRegisteredCursorDataSize");
    OREO_RESOLVE(removeRegisteredCursor, OreoCGSRemoveRegisteredCursorFn,
                 "CGSRemoveRegisteredCursor");
    OREO_RESOLVE(copyCoreCursor, OreoCoreCursorCopyImagesFn,
                 "CoreCursorCopyImages");
    OREO_RESOLVE(unregisterAllCoreCursors, OreoCoreCursorUnregisterAllFn,
                 "CoreCursorUnregisterAll");
    OREO_RESOLVE(setCoreCursor, OreoCoreCursorSetFn, "CoreCursorSet");
    OREO_RESOLVE(setSystemCursor, OreoCGSSetSystemDefinedCursorFn,
                 "CGSSetSystemDefinedCursor");
    OREO_RESOLVE(setDockOverride, OreoCGSSetDockCursorOverrideFn,
                 "CGSSetDockCursorOverride");
#undef OREO_RESOLVE

    if (!_api.mainConnectionID || !_api.registerCursor ||
        !_api.activateCursor || !_api.copyRegisteredCursor ||
        !_api.registeredCursorDataSize || !_api.removeRegisteredCursor ||
        !_api.copyCoreCursor || !_api.unregisterAllCoreCursors ||
        !_api.setCoreCursor ||
        !_api.setSystemCursor || !_api.setDockOverride) {
        if (error) {
            *error = OreoError(
                100, @"This macOS version does not expose the cursor APIs "
                      @"required by Cursor Atelier. Nothing was changed.");
        }
        return NO;
    }

    CGSConnectionID connection = _api.mainConnectionID();
    if (connection == 0) {
        if (error) {
            *error = OreoError(
                101, @"Cursor Atelier could not connect to the current graphical "
                      @"login session.");
        }
        return NO;
    }
    return YES;
}

- (BOOL)loadAndValidateTheme:(NSError **)error {
    NSData *data = OreoThemeResourceData(_themeSpecification,
                                         _themeResourceBundle, error);
    if (!data) {
        return NO;
    }
    self.themeSHA256 = OreoSHA256(data);
    NSDictionary<NSString *, NSDictionary *> *decoded =
        OreoDecodedThemeCursors(data, _themeSpecification, error);
    if (!decoded) {
        return NO;
    }
    _themeCursors = OreoThemeCursorsByScalingGeometry(
        decoded, self.themeSizePercentage, error);
    if (!_themeCursors) {
        return NO;
    }
    return YES;
}

static NSDictionary * _Nullable OreoValidatedThemeCursor(
    id object,
    NSString *identifier,
    NSUInteger *decodedByteCount,
    NSError **error) {
    if (![object isKindOfClass:[NSDictionary class]]) {
        if (error) {
            *error = OreoError(210, @"Cursor %@ is not a dictionary.", identifier);
        }
        return nil;
    }
    NSDictionary *cursor = object;
    double frameValue = 0, duration = 0, width = 0, height = 0;
    double hotX = 0, hotY = 0;
    if (!OreoIsFiniteNumber(cursor[@"FrameCount"], 1,
                            OreoMaximumThemeFrames, &frameValue) ||
        floor(frameValue) != frameValue ||
        !OreoIsFiniteNumber(cursor[@"FrameDuration"], 0.001, 10, &duration) ||
        !OreoIsFiniteNumber(cursor[@"PointsWide"], 1, 256, &width) ||
        !OreoIsFiniteNumber(cursor[@"PointsHigh"], 1, 256, &height) ||
        !OreoIsFiniteNumber(cursor[@"HotSpotX"], 0, width - 0.000001, &hotX) ||
        !OreoIsFiniteNumber(cursor[@"HotSpotY"], 0, height - 0.000001, &hotY)) {
        if (error) {
            *error = OreoError(211, @"Cursor %@ has invalid geometry or timing.",
                               identifier);
        }
        return nil;
    }

    NSArray *representations = cursor[@"Representations"];
    if (![representations isKindOfClass:[NSArray class]] ||
        representations.count < 3 ||
        representations.count > OreoMaximumThemeRepresentations) {
        if (error) {
            *error = OreoError(
                212, @"Cursor %@ must have ordered 1x, 2x, and 3x PNGs and "
                     @"at most 16 total scale representations.", identifier);
        }
        return nil;
    }

    NSUInteger frameCount = (NSUInteger)frameValue;
    NSMutableArray *images =
        [NSMutableArray arrayWithCapacity:representations.count];
    NSMutableArray *hashes =
        [NSMutableArray arrayWithCapacity:representations.count];
    NSUInteger encodedBytes = 0;
    NSUInteger decodedBytes = 0;
    double previousScale = 0;
    BOOL hasOneX = NO;
    BOOL hasTwoX = NO;
    BOOL hasThreeX = NO;

    for (NSData *pngData in representations) {
        if (![pngData isKindOfClass:[NSData class]] ||
            pngData.length > 16 * 1024 * 1024 ||
            encodedBytes > 16 * 1024 * 1024 - pngData.length) {
            if (error) {
                *error = OreoError(213, @"Cursor %@ has an invalid PNG payload.",
                                   identifier);
            }
            return nil;
        }
        encodedBytes += pngData.length;
        CGImageRef image = OreoCreateImageFromPNG(pngData);
        if (!image) {
            if (error) {
                *error = OreoError(214, @"Cursor %@ contains an undecodable PNG.",
                                   identifier);
            }
            return nil;
        }
        size_t pixelWidth = CGImageGetWidth(image);
        size_t pixelHeight = CGImageGetHeight(image);
        double scaleValue = pixelWidth / width;
        double heightScale = pixelHeight / (height * frameCount);
        BOOL dimensionsValid =
            scaleValue >= 1 && scaleValue <= OreoMaximumThemeScale &&
            scaleValue > previousScale &&
            OreoNearlyEqual(scaleValue, heightScale);
        BOOL pixelSizeValid =
            pixelWidth > 0 && pixelHeight > 0 &&
            pixelWidth <= OreoMaximumDecodedDimension &&
            pixelHeight <= OreoMaximumDecodedDimension &&
            pixelWidth <= SIZE_MAX / 4 &&
            pixelHeight <= SIZE_MAX / (pixelWidth * 4);
        NSUInteger imageBytes =
            pixelSizeValid ? pixelWidth * pixelHeight * 4 : 0;
        BOOL decodedSizeValid =
            pixelSizeValid && decodedBytes <= OreoMaximumDecodedBytes &&
            imageBytes <= OreoMaximumDecodedBytes - decodedBytes;
        NSString *hash = dimensionsValid && decodedSizeValid
            ? OreoPixelHash(image)
            : nil;
        if (!dimensionsValid || !decodedSizeValid || !hash) {
            CGImageRelease(image);
            if (error) {
                *error = OreoError(
                    215, @"Cursor %@ has invalid sprite-sheet dimensions.",
                    identifier);
            }
            return nil;
        }
        previousScale = scaleValue;
        decodedBytes += imageBytes;
        hasOneX = hasOneX || scaleValue == 1;
        hasTwoX = hasTwoX || scaleValue == 2;
        hasThreeX = hasThreeX || scaleValue == 3;
        [hashes addObject:hash];
        [images addObject:CFBridgingRelease(image)];
    }

    if (!hasOneX || !hasTwoX || !hasThreeX) {
        if (error) {
            *error = OreoError(
                216, @"Cursor %@ is missing a 1x, 2x, or 3x image.", identifier);
        }
        return nil;
    }

    if (decodedByteCount) {
        *decodedByteCount = decodedBytes;
    }

    return @{
        @"WasRegistered": @YES,
        @"FrameCount": @(frameCount),
        @"FrameDuration": @(duration),
        @"HotSpotX": @(hotX),
        @"HotSpotY": @(hotY),
        @"PointsWide": @(width),
        @"PointsHigh": @(height),
        @"Images": images,
        @"Hashes": hashes,
    };
}

- (NSDictionary *)validatedThemeCursor:(id)object
                              identifier:(NSString *)identifier
                                   error:(NSError **)error {
    return OreoValidatedThemeCursor(object, identifier, NULL, error);
}

static NSDictionary<NSString *, NSDictionary *> * _Nullable
OreoDecodedThemeCursors(NSData *data,
                        NSDictionary<NSString *, NSString *> *specification,
                        NSError **error) {
    NSError *plistError = nil;
    id root = [NSPropertyListSerialization propertyListWithData:data
                                                        options:NSPropertyListImmutable
                                                         format:NULL
                                                          error:&plistError];
    if (![root isKindOfClass:[NSDictionary class]]) {
        if (error) {
            *error = plistError ?:
                OreoError(202, @"The cursor theme is not a property list.");
        }
        return nil;
    }
    NSDictionary *rootDictionary = root;
    if (![rootDictionary[@"Identifier"]
            isEqual:specification[OreoThemeIdentifierSpecKey]] ||
        ![rootDictionary[@"UUID"]
            isEqual:specification[OreoThemeUUIDSpecKey]] ||
        ![rootDictionary[@"ThemeName"]
            isEqual:specification[OreoThemePlistNameSpecKey]]) {
        if (error) {
            *error = OreoError(203, @"The cursor theme metadata is unexpected.");
        }
        return nil;
    }
    NSDictionary *cursors = rootDictionary[@"Cursors"];
    if (![cursors isKindOfClass:[NSDictionary class]] ||
        cursors.count != OreoExplicitThemeIdentifiers().count ||
        ![[NSSet setWithArray:cursors.allKeys]
            isEqualToSet:OreoExplicitThemeIdentifiers()]) {
        if (error) {
            *error = OreoError(
                204, @"The cursor theme does not contain the exact validated "
                      @"cursor identifier set.");
        }
        return nil;
    }

    NSMutableDictionary *validated =
        [NSMutableDictionary dictionaryWithCapacity:
            OreoAllTargetIdentifiers().count];
    NSUInteger totalDecodedBytes = 0;
    for (NSString *identifier in
             [cursors.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
        NSUInteger cursorDecodedBytes = 0;
        NSDictionary *decoded = OreoValidatedThemeCursor(
            cursors[identifier], identifier, &cursorDecodedBytes, error);
        if (!decoded) {
            return nil;
        }
        if (totalDecodedBytes > OreoMaximumDecodedThemeBytes ||
            cursorDecodedBytes >
                OreoMaximumDecodedThemeBytes - totalDecodedBytes) {
            if (error) {
                *error = OreoError(
                    217, @"The cursor theme exceeds the decoded image budget.");
            }
            return nil;
        }
        totalDecodedBytes += cursorDecodedBytes;
        validated[identifier] = decoded;
    }

    // Curated aliases used by browsers and AppKit. No broad alias inference
    // is used: Link/Alias and Crosshair/Cell remain distinct Oreo artwork.
    [OreoSupplementalAliasMap()
        enumerateKeysAndObjectsUsingBlock:
            ^(NSString *alias, NSString *source, BOOL *stop) {
        (void)stop;
        validated[alias] = validated[source];
    }];

    if (![[NSSet setWithArray:validated.allKeys]
            isEqualToSet:OreoAllTargetIdentifiers()]) {
        if (error) {
            *error = OreoError(205, @"Internal cursor mapping mismatch.");
        }
        return nil;
    }
    return [validated copy];
}

- (BOOL)writePropertyList:(NSDictionary *)propertyList
                    toURL:(NSURL *)url
                    error:(NSError **)error {
    BOOL writesSnapshot = [url.path isEqualToString:_snapshotURL.path];
    if (writesSnapshot) {
        [self invalidateSnapshotCache];
    }
    NSData *data =
        [NSPropertyListSerialization dataWithPropertyList:propertyList
                                                   format:NSPropertyListBinaryFormat_v1_0
                                                  options:0
                                                    error:error];
    if (!data || ![data writeToURL:url options:NSDataWritingAtomic error:error]) {
        return NO;
    }
    [[NSFileManager defaultManager]
        setAttributes:@{NSFilePosixPermissions: @0600}
         ofItemAtPath:url.path
                error:NULL];
    return YES;
}

- (BOOL)beginTransaction:(NSString *)operation error:(NSError **)error {
    if ([[NSFileManager defaultManager]
            fileExistsAtPath:_transactionURL.path]) {
        if (error) {
            *error = OreoError(
                299, @"A prior cursor transaction still needs recovery.");
        }
        return NO;
    }
    NSDictionary *transaction = @{
        @"SchemaVersion": @(OreoSnapshotSchemaVersion),
        @"Operation": operation,
        @"BootSessionUUID": self.bootSessionUUID,
        @"OSBuild": self.osBuild,
        @"CreatedAt": [NSDate date],
    };
    return [self writePropertyList:transaction
                            toURL:_transactionURL
                            error:error];
}

- (BOOL)removeItemIfPresentAtURL:(NSURL *)url error:(NSError **)error {
    if ([url.path isEqualToString:_snapshotURL.path]) {
        [self invalidateSnapshotCache];
    }
    if (![[NSFileManager defaultManager] fileExistsAtPath:url.path]) {
        return YES;
    }
    return [[NSFileManager defaultManager] removeItemAtURL:url error:error];
}

- (BOOL)clearTransaction:(NSError **)error {
    return [self removeItemIfPresentAtURL:_transactionURL error:error];
}

- (NSDictionary * _Nullable)readPropertyListAtURL:(NSURL *)url
                                             error:(NSError **)error {
    NSDictionary *attributes = [[NSFileManager defaultManager]
        attributesOfItemAtPath:url.path error:error];
    if (!attributes) {
        return nil;
    }
    unsigned long long fileSize =
        [attributes[NSFileSize] unsignedLongLongValue];
    if (fileSize == 0 || fileSize > 128ULL * 1024ULL * 1024ULL) {
        if (error) {
            *error = OreoError(
                300, @"%@ has an invalid file size.", url.lastPathComponent);
        }
        return nil;
    }
    NSData *data = [NSData dataWithContentsOfURL:url options:0 error:error];
    if (!data) {
        return nil;
    }
    id root = [NSPropertyListSerialization propertyListWithData:data
                                                        options:NSPropertyListImmutable
                                                         format:NULL
                                                          error:error];
    if (![root isKindOfClass:[NSDictionary class]]) {
        if (error && !*error) {
            *error = OreoError(301, @"%@ is not a valid dictionary.",
                               url.lastPathComponent);
        }
        return nil;
    }
    return root;
}

- (NSDictionary * _Nullable)recordForImages:(NSArray *)images
                                  frameCount:(NSUInteger)frameCount
                               frameDuration:(CGFloat)frameDuration
                                        size:(CGSize)size
                                     hotSpot:(CGPoint)hotSpot
                                       error:(NSError **)error {
    if (frameCount < 1 || frameCount > 128 ||
        !isfinite(frameDuration) ||
        frameDuration < 0 || frameDuration > 10 ||
        !isfinite(size.width) || !isfinite(size.height) ||
        size.width <= 0 || size.height <= 0 ||
        size.width > 512 || size.height > 512 ||
        !isfinite(hotSpot.x) || !isfinite(hotSpot.y) ||
        images.count < 1 || images.count > 16) {
        if (error) {
            *error = OreoError(301, @"A stock cursor returned invalid metadata.");
        }
        return nil;
    }

    NSMutableArray<NSDictionary *> *encoded =
        [NSMutableArray arrayWithCapacity:images.count];
    NSUInteger totalBytes = 0;
    for (id object in images) {
        if (CFGetTypeID((__bridge CFTypeRef)object) != CGImageGetTypeID()) {
            if (error) {
                *error = OreoError(302, @"A stock cursor returned a non-image.");
            }
            return nil;
        }
        CGImageRef image = (__bridge CGImageRef)object;
        NSData *png = OreoPNGDataForImage(image);
        NSString *hash = OreoPixelHash(image);
        if (!png || !hash || png.length > 16 * 1024 * 1024 ||
            totalBytes > 32 * 1024 * 1024 - png.length) {
            if (error) {
                *error = OreoError(303, @"A stock cursor image was too large or invalid.");
            }
            return nil;
        }
        totalBytes += png.length;
        [encoded addObject:@{
            @"PNG": png,
            @"Hash": hash,
            @"PixelWidth": @(CGImageGetWidth(image)),
            @"PixelHeight": @(CGImageGetHeight(image)),
        }];
    }
    [encoded sortUsingComparator:
        ^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
        NSComparisonResult widthResult =
            [left[@"PixelWidth"] compare:right[@"PixelWidth"]];
        if (widthResult != NSOrderedSame) {
            return widthResult;
        }
        NSComparisonResult heightResult =
            [left[@"PixelHeight"] compare:right[@"PixelHeight"]];
        if (heightResult != NSOrderedSame) {
            return heightResult;
        }
        return [left[@"Hash"] compare:right[@"Hash"]];
    }];

    NSArray *pngs = [encoded valueForKey:@"PNG"];
    NSArray *hashes = [encoded valueForKey:@"Hash"];
    NSArray *pixelWidths = [encoded valueForKey:@"PixelWidth"];
    NSArray *pixelHeights = [encoded valueForKey:@"PixelHeight"];
    return @{
        @"WasRegistered": @YES,
        @"FrameCount": @(frameCount),
        @"FrameDuration": @(frameDuration),
        @"HotSpotX": @(hotSpot.x),
        @"HotSpotY": @(hotSpot.y),
        @"PointsWide": @(size.width),
        @"PointsHigh": @(size.height),
        @"Representations": pngs,
        @"Hashes": hashes,
        @"PixelWidths": pixelWidths,
        @"PixelHeights": pixelHeights,
    };
}

- (NSDictionary * _Nullable)systemFallbackRecordForIdentifier:
                                      (NSString *)identifier
                                                        error:(NSError **)error {
    NSNumber *coreID = OreoPlaceholderCoreIDMap()[identifier];
    if (coreID) {
        CFArrayRef representations = NULL;
        CGSize size = CGSizeZero;
        CGPoint hotSpot = CGPointZero;
        NSUInteger frameCount = 0;
        CGFloat frameDuration = 0;
        CGError coreResult = _api.copyCoreCursor(
            _api.mainConnectionID(), coreID.intValue, &representations, &size,
            &hotSpot, &frameCount, &frameDuration);
        if (coreResult == kCGErrorSuccess && representations &&
            CFArrayGetCount(representations) > 0) {
            NSArray *images = CFBridgingRelease(representations);
            NSError *nativeError = nil;
            NSDictionary *nativeRecord =
                [self recordForImages:images
                           frameCount:frameCount
                        frameDuration:frameDuration
                                 size:size
                              hotSpot:hotSpot
                                error:&nativeError];
            if (nativeRecord) {
                NSLog(@"Cursor Atelier: using Apple core fallback %d for %@",
                      coreID.intValue, identifier);
                return nativeRecord;
            }
            NSLog(@"Cursor Atelier: Apple core fallback warning for %@: %@",
                  identifier, nativeError.localizedDescription);
        } else if (representations) {
            CFRelease(representations);
        }
    }

    return [self systemResourceFallbackRecordForIdentifier:identifier
                                                      error:error];
}

- (NSDictionary * _Nullable)systemResourceFallbackRecordForIdentifier:
                                      (NSString *)identifier
                                                        error:(NSError **)error {

    NSString *folderName = OreoSystemCursorFolderMap()[identifier];
    if (folderName.length == 0) {
        if (error) {
            *error = OreoError(
                304, @"The existing cursor %@ returned a placeholder and "
                      @"has no verified Apple resource fallback.", identifier);
        }
        return nil;
    }

    NSString *basePath =
        @"/System/Library/Frameworks/ApplicationServices.framework/"
         "Versions/A/Frameworks/HIServices.framework/Versions/A/Resources/"
         "cursors";
    NSString *cursorDirectory =
        [basePath stringByAppendingPathComponent:folderName];
    NSString *infoPath =
        [cursorDirectory stringByAppendingPathComponent:@"info.plist"];
    NSString *pdfPath =
        [cursorDirectory stringByAppendingPathComponent:@"cursor.pdf"];
    NSData *infoData = [NSData dataWithContentsOfFile:infoPath];
    NSData *pdfData = [NSData dataWithContentsOfFile:pdfPath];
    if (!infoData || !pdfData) {
        if (error) {
            *error = OreoError(
                305, @"Apple's fallback resource for %@ is unavailable.",
                identifier);
        }
        return nil;
    }
    NSDictionary *info =
        [NSPropertyListSerialization propertyListWithData:infoData
                                                  options:NSPropertyListImmutable
                                                   format:NULL
                                                    error:error];
    if (![info isKindOfClass:[NSDictionary class]]) {
        return nil;
    }
    double frameValue = 0, delay = 0, hotX = 0, hotY = 0;
    BOOL hasFrames = info[@"frames"] != nil;
    BOOL hasDelay = info[@"delay"] != nil;
    BOOL validAnimation = hasFrames == hasDelay;
    if (validAnimation && !hasFrames) {
        // Apple's static cursor schema permits both animation keys to be
        // absent. Treat only that complete omission as the canonical
        // one-frame, zero-delay form; a partial declaration remains fatal.
        frameValue = 1;
        delay = 0;
    } else if (validAnimation) {
        validAnimation =
            OreoIsFiniteNumber(info[@"frames"], 1, 24, &frameValue) &&
            floor(frameValue) == frameValue &&
            OreoIsFiniteNumber(info[@"delay"], 0, 10, &delay);
    }
    if (!validAnimation ||
        !OreoIsFiniteNumber(info[@"hotx"], -512, 512, &hotX) ||
        !OreoIsFiniteNumber(info[@"hoty"], -512, 512, &hotY)) {
        if (error) {
            *error = OreoError(
                306, @"Apple's fallback metadata for %@ is invalid.",
                identifier);
        }
        return nil;
    }

    CGDataProviderRef provider = CGDataProviderCreateWithCFData(
        (__bridge CFDataRef)pdfData);
    CGPDFDocumentRef document =
        provider ? CGPDFDocumentCreateWithProvider(provider) : NULL;
    if (provider) {
        CGDataProviderRelease(provider);
    }
    if (!document || CGPDFDocumentGetNumberOfPages(document) == 0) {
        if (document) {
            CGPDFDocumentRelease(document);
        }
        if (error) {
            *error = OreoError(
                307, @"Apple's fallback PDF for %@ is invalid.", identifier);
        }
        return nil;
    }

    NSUInteger frameCount = (NSUInteger)frameValue;
    size_t pageCount = CGPDFDocumentGetNumberOfPages(document);
    CGPDFPageRef firstPage = CGPDFDocumentGetPage(document, 1);
    if (!firstPage || (pageCount != 1 && pageCount != frameCount)) {
        CGPDFDocumentRelease(document);
        if (error) {
            *error = OreoError(
                308, @"Apple's fallback geometry for %@ is invalid.",
                identifier);
        }
        return nil;
    }

    CGRect mediaBox = CGPDFPageGetBoxRect(firstPage, kCGPDFMediaBox);
    CGFloat pointsWide = mediaBox.size.width;
    CGFloat pointsHigh = mediaBox.size.height;
    if (frameCount > 1 && pageCount == 1) {
        pointsHigh /= frameCount;
    }
    if (!isfinite(pointsWide) || !isfinite(pointsHigh) ||
        pointsWide <= 0 || pointsHigh <= 0 ||
        pointsWide > 512 || pointsHigh > 512 ||
        hotX < 0 || hotY < 0 || hotX >= pointsWide || hotY >= pointsHigh) {
        CGPDFDocumentRelease(document);
        if (error) {
            *error = OreoError(
                308, @"Apple's fallback geometry for %@ is invalid.",
                identifier);
        }
        return nil;
    }

    for (size_t pageIndex = 1; pageIndex <= pageCount; pageIndex++) {
        CGPDFPageRef page = CGPDFDocumentGetPage(document, pageIndex);
        CGRect pageMediaBox = page
            ? CGPDFPageGetBoxRect(page, kCGPDFMediaBox)
            : CGRectZero;
        if (!page || CGPDFPageGetRotationAngle(page) != 0 ||
            !OreoNearlyEqual(pageMediaBox.size.width, mediaBox.size.width) ||
            !OreoNearlyEqual(pageMediaBox.size.height,
                             pageCount == 1 ? mediaBox.size.height
                                            : pointsHigh)) {
            CGPDFDocumentRelease(document);
            if (error) {
                *error = OreoError(
                    308, @"Apple's fallback geometry for %@ is invalid.",
                    identifier);
            }
            return nil;
        }
    }

    NSMutableArray *images = [NSMutableArray arrayWithCapacity:2];
    for (NSUInteger scale = 1; scale <= 2; scale++) {
        size_t pixelWidth = (size_t)llround(pointsWide * scale);
        size_t pixelHeight = frameCount > 1 && pageCount == 1
            ? (size_t)llround(mediaBox.size.height * scale)
            : (size_t)llround(pointsHigh * scale * frameCount);
        if (pixelWidth == 0 || pixelHeight == 0 ||
            pixelWidth > OreoMaximumDecodedDimension ||
            pixelHeight > OreoMaximumDecodedDimension ||
            pixelHeight > SIZE_MAX / (pixelWidth * 4) ||
            pixelWidth * pixelHeight * 4 > OreoMaximumDecodedBytes) {
            CGPDFDocumentRelease(document);
            if (error) {
                *error = OreoError(
                    309, @"Apple's fallback image for %@ is too large.",
                    identifier);
            }
            return nil;
        }

        CGColorSpaceRef colorSpace =
            CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGContextRef context = colorSpace ? CGBitmapContextCreate(
            NULL, pixelWidth, pixelHeight, 8, pixelWidth * 4, colorSpace,
            kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big) : NULL;
        if (colorSpace) {
            CGColorSpaceRelease(colorSpace);
        }
        if (!context) {
            CGPDFDocumentRelease(document);
            if (error) {
                *error = OreoError(
                    310, @"Could not render Apple's fallback for %@.",
                    identifier);
            }
            return nil;
        }
        CGContextClearRect(
            context, CGRectMake(0, 0, pixelWidth, pixelHeight));

        if (frameCount > 1 && pageCount == frameCount) {
            for (NSUInteger frame = 0; frame < frameCount; frame++) {
                CGPDFPageRef page =
                    CGPDFDocumentGetPage(document, frame + 1);
                if (!page) {
                    continue;
                }
                CGContextSaveGState(context);
                CGFloat yOffset =
                    (frameCount - 1 - frame) * pointsHigh * scale;
                CGContextTranslateCTM(context, 0, yOffset);
                CGContextScaleCTM(context, scale, scale);
                CGContextDrawPDFPage(context, page);
                CGContextRestoreGState(context);
            }
        } else {
            CGContextScaleCTM(context, scale, scale);
            CGContextDrawPDFPage(context, firstPage);
        }

        CGImageRef rendered = CGBitmapContextCreateImage(context);
        CGContextRelease(context);
        if (!rendered) {
            CGPDFDocumentRelease(document);
            if (error) {
                *error = OreoError(
                    311, @"Could not finish Apple's fallback for %@.",
                    identifier);
            }
            return nil;
        }
        [images addObject:CFBridgingRelease(rendered)];
    }
    CGPDFDocumentRelease(document);

    NSLog(@"Cursor Atelier: using Apple resource fallback for %@", identifier);
    return [self recordForImages:images
                     frameCount:frameCount
                  frameDuration:delay
                           size:CGSizeMake(pointsWide, pointsHigh)
                        hotSpot:CGPointMake(hotX, hotY)
                          error:error];
}

- (NSDictionary * _Nullable)downsampledRecordForImages:(NSArray *)images
                                         originalFrames:(NSUInteger)originalFrames
                                         frameDuration:(CGFloat)frameDuration
                                                   size:(CGSize)size
                                                hotSpot:(CGPoint)hotSpot
                                                   error:(NSError **)error {
    const NSUInteger targetFrames = OreoMaximumThemeFrames;
    if (originalFrames <= targetFrames || originalFrames > 128 ||
        images.count == 0 || images.count > 16) {
        if (error) {
            *error = OreoError(312, @"The stock animation cannot be downsampled.");
        }
        return nil;
    }

    NSMutableArray *rebuiltImages =
        [NSMutableArray arrayWithCapacity:images.count];
    for (id object in images) {
        if (CFGetTypeID((__bridge CFTypeRef)object) != CGImageGetTypeID()) {
            if (error) {
                *error = OreoError(
                    313, @"The stock animation contains a non-image.");
            }
            return nil;
        }
        CGImageRef source = (__bridge CGImageRef)object;
        size_t width = CGImageGetWidth(source);
        size_t sourceHeight = CGImageGetHeight(source);
        if (width == 0 || sourceHeight == 0 ||
            sourceHeight % originalFrames != 0) {
            if (error) {
                *error = OreoError(
                    314, @"The stock animation is not a valid sprite sheet.");
            }
            return nil;
        }
        size_t frameHeight = sourceHeight / originalFrames;
        size_t targetHeight = frameHeight * targetFrames;
        if (width > OreoMaximumDecodedDimension ||
            targetHeight > OreoMaximumDecodedDimension ||
            targetHeight > SIZE_MAX / (width * 4) ||
            width * targetHeight * 4 > OreoMaximumDecodedBytes) {
            if (error) {
                *error = OreoError(
                    315, @"The stock animation is too large to downsample "
                         @"(%zux%zu → %zux%zu pixels, %lu frames).",
                    width, sourceHeight, width, targetHeight,
                    (unsigned long)originalFrames);
            }
            return nil;
        }

        CGColorSpaceRef colorSpace =
            CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGContextRef context = colorSpace ? CGBitmapContextCreate(
            NULL, width, targetHeight, 8, width * 4, colorSpace,
            kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big) : NULL;
        if (colorSpace) {
            CGColorSpaceRelease(colorSpace);
        }
        if (!context) {
            if (error) {
                *error = OreoError(
                    316, @"Could not allocate the stock animation.");
            }
            return nil;
        }
        CGContextClearRect(context, CGRectMake(0, 0, width, targetHeight));
        BOOL complete = YES;
        for (NSUInteger frame = 0; frame < targetFrames; frame++) {
            NSUInteger sourceFrame =
                (frame * originalFrames) / targetFrames;
            CGImageRef cropped = CGImageCreateWithImageInRect(
                source, CGRectMake(0, sourceFrame * frameHeight,
                                   width, frameHeight));
            if (!cropped) {
                complete = NO;
                break;
            }
            CGContextDrawImage(
                context,
                CGRectMake(0, (targetFrames - 1 - frame) * frameHeight,
                           width, frameHeight),
                cropped);
            CGImageRelease(cropped);
        }
        CGImageRef rebuilt =
            complete ? CGBitmapContextCreateImage(context) : NULL;
        CGContextRelease(context);
        if (!rebuilt) {
            if (error) {
                *error = OreoError(
                    317, @"Could not finish the stock animation.");
            }
            return nil;
        }
        [rebuiltImages addObject:CFBridgingRelease(rebuilt)];
    }

    CGFloat adjustedDuration =
        frameDuration * originalFrames / targetFrames;
    NSDictionary *record = [self recordForImages:rebuiltImages
                                      frameCount:targetFrames
                                   frameDuration:adjustedDuration
                                            size:size
                                         hotSpot:hotSpot
                                           error:error];
    if (!record) {
        return nil;
    }
    NSMutableDictionary *annotated = [record mutableCopy];
    annotated[@"DownsampledFromFrameCount"] = @(originalFrames);
    return annotated;
}

- (NSDictionary * _Nullable)captureOriginalCursor:(NSString *)identifier
                                             error:(NSError **)error {
    CGSConnectionID connection = _api.mainConnectionID();
    size_t registeredDataSize = 0;
    CGError sizeResult = _api.registeredCursorDataSize(
        connection, (char *)identifier.UTF8String, &registeredDataSize);
    if (sizeResult == kCGErrorRangeCheck ||
        (sizeResult == kCGErrorSuccess && registeredDataSize == 0)) {
        // Preserve native registration semantics. In particular, cursor.0 and
        // cursor.1 normally have core images but no named registration.
        return @{@"WasRegistered": @NO};
    }
    if (sizeResult != kCGErrorSuccess) {
        if (error) {
            *error = OreoError(
                312, @"Could not determine whether %@ is registered "
                      @"(error %d).", identifier, sizeResult);
        }
        return nil;
    }

    CGSize size = CGSizeZero;
    CGPoint hotSpot = CGPointZero;
    NSUInteger frameCount = 0;
    CGFloat frameDuration = 0;
    CFArrayRef representations = NULL;
    CGError result = _api.copyRegisteredCursor(
        connection, (char *)identifier.UTF8String, &size, &hotSpot,
        &frameCount, &frameDuration, &representations);

    if (result != kCGErrorSuccess || !representations ||
        CFArrayGetCount(representations) == 0) {
        if (representations) {
            CFRelease(representations);
        }
        if (error) {
            *error = OreoError(
                312, @"Could not capture the existing cursor %@ (error %d).",
                identifier, result);
        }
        return nil;
    }

    NSArray *images = CFBridgingRelease(representations);
    for (id object in images) {
        if (CFGetTypeID((__bridge CFTypeRef)object) == CGImageGetTypeID() &&
            OreoImageIsRedPlaceholder((__bridge CGImageRef)object)) {
            return [self systemFallbackRecordForIdentifier:identifier
                                                      error:error];
        }
    }
    if (frameCount > OreoMaximumThemeFrames) {
        return [self downsampledRecordForImages:images
                                 originalFrames:frameCount
                                 frameDuration:frameDuration
                                           size:size
                                        hotSpot:hotSpot
                                           error:error];
    }
    return [self recordForImages:images
                     frameCount:frameCount
                  frameDuration:frameDuration
                           size:size
                        hotSpot:hotSpot
                          error:error];
}

- (NSDictionary * _Nullable)captureRegisteredCursor:(NSString *)identifier
                                               error:(NSError **)error {
    CGSConnectionID connection = _api.mainConnectionID();
    CGSize size = CGSizeZero;
    CGPoint hotSpot = CGPointZero;
    NSUInteger frameCount = 0;
    CGFloat frameDuration = 0;
    CFArrayRef representations = NULL;
    CGError result = _api.copyRegisteredCursor(
        connection, (char *)identifier.UTF8String, &size, &hotSpot,
        &frameCount, &frameDuration, &representations);
    if (result != kCGErrorSuccess || !representations ||
        CFArrayGetCount(representations) == 0) {
        if (representations) {
            CFRelease(representations);
        }
        size_t dataSize = 0;
        CGError sizeResult = _api.registeredCursorDataSize(
            connection, (char *)identifier.UTF8String, &dataSize);
        if (sizeResult == kCGErrorRangeCheck ||
            (sizeResult == kCGErrorSuccess && dataSize == 0)) {
            return @{@"WasRegistered": @NO};
        }
        if (sizeResult != kCGErrorSuccess) {
            if (error) {
                *error = OreoError(
                    313, @"Could not determine whether %@ is registered "
                          @"(error %d).", identifier, sizeResult);
            }
            return nil;
        }
        if (error) {
            *error = OreoError(
                306, @"Could not read back cursor %@ (error %d).",
                identifier, result);
        }
        return nil;
    }
    NSArray *images = CFBridgingRelease(representations);
    return [self recordForImages:images
                     frameCount:frameCount
                  frameDuration:frameDuration
                           size:size
                        hotSpot:hotSpot
                          error:error];
}

- (BOOL)createSnapshot:(NSError **)error {
    NSMutableDictionary *targets =
        [NSMutableDictionary dictionaryWithCapacity:
            OreoAllTargetIdentifiers().count];
    for (NSString *identifier in OreoSortedTargetIdentifiers()) {
        NSDictionary *record =
            [self captureOriginalCursor:identifier error:error];
        if (!record) {
            return NO;
        }
        targets[identifier] = record;
    }
    NSDictionary *snapshot = @{
        @"SchemaVersion": @(OreoSnapshotSchemaVersion),
        @"BootSessionUUID": self.bootSessionUUID,
        @"OSBuild": self.osBuild,
        @"ThemeSHA256": self.themeSHA256,
        @"TargetIdentifiers": OreoSortedTargetIdentifiers(),
        @"Targets": targets,
        @"CreatedAt": [NSDate date],
    };
    if (![self writePropertyList:snapshot toURL:_snapshotURL error:error]) {
        return NO;
    }
    // Refuse to mutate cursor state unless the durable file can be read back
    // and every image still passes its hash checks.
    return [self loadValidSnapshot:error] != nil;
}

- (NSArray * _Nullable)decodedImagesFromRecord:(NSDictionary *)record
                                          error:(NSError **)error {
    NSArray *pngs = record[@"Representations"];
    NSArray *hashes = record[@"Hashes"];
    NSArray *pixelWidths = record[@"PixelWidths"];
    NSArray *pixelHeights = record[@"PixelHeights"];
    if (![pngs isKindOfClass:[NSArray class]] ||
        ![hashes isKindOfClass:[NSArray class]] ||
        ![pixelWidths isKindOfClass:[NSArray class]] ||
        ![pixelHeights isKindOfClass:[NSArray class]] ||
        pngs.count < 1 || pngs.count > 16 ||
        hashes.count != pngs.count ||
        pixelWidths.count != pngs.count ||
        pixelHeights.count != pngs.count) {
        if (error) {
            *error = OreoError(310, @"The stock snapshot has invalid images.");
        }
        return nil;
    }
    NSMutableArray *images = [NSMutableArray arrayWithCapacity:pngs.count];
    NSUInteger totalBytes = 0;
    for (NSUInteger index = 0; index < pngs.count; index++) {
        NSData *png = pngs[index];
        NSString *savedHash = hashes[index];
        NSNumber *savedWidth = pixelWidths[index];
        NSNumber *savedHeight = pixelHeights[index];
        if (![png isKindOfClass:[NSData class]] ||
            ![savedHash isKindOfClass:[NSString class]] ||
            ![savedWidth isKindOfClass:[NSNumber class]] ||
            ![savedHeight isKindOfClass:[NSNumber class]] ||
            png.length > 16 * 1024 * 1024 ||
            totalBytes > 32 * 1024 * 1024 - png.length) {
            if (error) {
                *error = OreoError(
                    311, @"The stock snapshot image metadata is invalid.");
            }
            return nil;
        }
        totalBytes += png.length;
        CGImageRef image = OreoCreateImageFromPNG(png);
        NSString *hash = image ? OreoPixelHash(image) : nil;
        if (!image || !hash ||
            CGImageGetWidth(image) != savedWidth.unsignedIntegerValue ||
            CGImageGetHeight(image) != savedHeight.unsignedIntegerValue ||
            ![hash isEqualToString:savedHash]) {
            if (image) {
                CGImageRelease(image);
            }
            if (error) {
                *error = OreoError(
                    312, @"The stock snapshot failed its image integrity check.");
            }
            return nil;
        }
        [images addObject:CFBridgingRelease(image)];
    }
    return images;
}

- (NSDictionary * _Nullable)loadValidSnapshot:(NSError **)error {
    NSError *identityError = nil;
    NSString *identityBefore = [self snapshotFileIdentity:&identityError];
    if (!identityBefore) {
        [self invalidateSnapshotCache];
        if (error) {
            *error = identityError;
        }
        return nil;
    }
    if (_validatedSnapshot &&
        [_validatedSnapshotIdentity isEqualToString:identityBefore]) {
        return _validatedSnapshot;
    }
    [self invalidateSnapshotCache];

    NSDictionary *snapshot =
        [self readPropertyListAtURL:_snapshotURL error:error];
    if (!snapshot) {
        return nil;
    }
    NSNumber *schema = snapshot[@"SchemaVersion"];
    NSString *boot = snapshot[@"BootSessionUUID"];
    NSString *build = snapshot[@"OSBuild"];
    NSString *themeHash = snapshot[@"ThemeSHA256"];
    NSArray *targetIdentifiers = snapshot[@"TargetIdentifiers"];
    if (![schema isKindOfClass:[NSNumber class]] ||
        CFGetTypeID((__bridge CFTypeRef)schema) == CFBooleanGetTypeID() ||
        ![boot isKindOfClass:[NSString class]] ||
        ![build isKindOfClass:[NSString class]] ||
        !OreoIsSHA256String(themeHash) ||
        ![targetIdentifiers isKindOfClass:[NSArray class]] ||
        schema.integerValue != OreoSnapshotSchemaVersion ||
        ![boot isEqual:self.bootSessionUUID] ||
        ![build isEqual:self.osBuild] ||
        ![targetIdentifiers isEqual:OreoSortedTargetIdentifiers()]) {
        if (error) {
            *error = OreoError(
                312, @"The stock snapshot belongs to a different boot, macOS "
                      @"build, or cursor theme.");
        }
        return nil;
    }
    NSDictionary *targets = snapshot[@"Targets"];
    if (![targets isKindOfClass:[NSDictionary class]] ||
        ![[NSSet setWithArray:targets.allKeys]
            isEqualToSet:OreoAllTargetIdentifiers()]) {
        if (error) {
            *error = OreoError(313, @"The stock snapshot target set is invalid.");
        }
        return nil;
    }
    for (NSString *identifier in OreoSortedTargetIdentifiers()) {
        NSDictionary *record = targets[identifier];
        if (![record isKindOfClass:[NSDictionary class]] ||
            ![record[@"WasRegistered"] isKindOfClass:[NSNumber class]]) {
            if (error) {
                *error = OreoError(314, @"The stock snapshot is malformed.");
            }
            return nil;
        }
        if (![record[@"WasRegistered"] boolValue]) {
            continue;
        }
        double frameCount = 0, duration = 0, width = 0, height = 0;
        double hotX = 0, hotY = 0;
        if (!OreoIsFiniteNumber(record[@"FrameCount"], 1,
                                OreoMaximumThemeFrames, &frameCount) ||
            floor(frameCount) != frameCount ||
            !OreoIsFiniteNumber(record[@"FrameDuration"], 0, 10, &duration) ||
            !OreoIsFiniteNumber(record[@"PointsWide"], 1, 512, &width) ||
            !OreoIsFiniteNumber(record[@"PointsHigh"], 1, 512, &height) ||
            !OreoIsFiniteNumber(record[@"HotSpotX"], -512, 512, &hotX) ||
            !OreoIsFiniteNumber(record[@"HotSpotY"], -512, 512, &hotY) ||
            ![self decodedImagesFromRecord:record error:error]) {
            return nil;
        }
    }
    NSString *identityAfter = [self snapshotFileIdentity:&identityError];
    if (!identityAfter || ![identityAfter isEqualToString:identityBefore]) {
        if (error) {
            *error = identityError ?: OreoError(
                315, @"The stock snapshot changed while it was being checked.");
        }
        return nil;
    }
    _validatedSnapshot = snapshot;
    _validatedSnapshotIdentity = identityAfter;
    return _validatedSnapshot;
}

- (BOOL)hasDurableSnapshotOwnershipInDefaults:(NSUserDefaults *)defaults {
    NSString *activeBoot =
        [defaults stringForKey:OreoCursorActiveBootDefaultsKey];
    return [defaults boolForKey:OreoCursorEffectiveDefaultsKey] ||
        [activeBoot isEqualToString:self.bootSessionUUID];
}

- (BOOL)ensureSnapshot:(NSError **)error {
    NSUserDefaults *defaults = OreoCursorDefaults();
    BOOL ownsSnapshot =
        [self hasDurableSnapshotOwnershipInDefaults:defaults];
    BOOL snapshotExists =
        [[NSFileManager defaultManager] fileExistsAtPath:_snapshotURL.path];
    OreoSnapshotPreparationDisposition preparation =
        OreoSnapshotPreparationForState(snapshotExists, ownsSnapshot);
    if (preparation == OreoSnapshotPreparationDiscardOrphan) {
        // A completed restore can leave its cleanup file behind. Once durable
        // state says no cursor registration is active, that file no longer
        // describes state owned by Cursor Atelier and must never be reused.
        if (![self removeItemIfPresentAtURL:_snapshotURL error:error]) {
            return NO;
        }
        snapshotExists = NO;
    }
    if (snapshotExists) {
        NSError *snapshotError = nil;
        if ([self loadValidSnapshot:&snapshotError]) {
            return YES;
        }

        NSDictionary *rawSnapshot =
            [self readPropertyListAtURL:_snapshotURL error:NULL];
        NSNumber *rawSchema = rawSnapshot[@"SchemaVersion"];
        NSString *rawBoot = rawSnapshot[@"BootSessionUUID"];
        NSString *rawBuild = rawSnapshot[@"OSBuild"];
        BOOL hasFreshnessProof =
            [rawSchema isKindOfClass:[NSNumber class]] &&
            CFGetTypeID((__bridge CFTypeRef)rawSchema) !=
                CFBooleanGetTypeID() &&
            rawSchema.integerValue == OreoSnapshotSchemaVersion &&
            [rawBoot isKindOfClass:[NSString class]] &&
            [rawBuild isKindOfClass:[NSString class]];
        BOOL staleBoot =
            hasFreshnessProof &&
            (![rawBoot isEqual:self.bootSessionUUID] ||
             ![rawBuild isEqual:self.osBuild]);
        if (staleBoot) {
            NSError *cleanupError = nil;
            if (![self removeItemIfPresentAtURL:_snapshotURL
                                          error:&cleanupError]) {
                if (error) {
                    *error = cleanupError;
                }
                return NO;
            }
            if (![self persistDesiredState:
                           [defaults boolForKey:OreoCursorEnabledDefaultsKey]
                              effectiveState:NO
                              activeSnapshot:NO
                                        error:error]) {
                return NO;
            }
        } else {
            if (error) {
                *error = snapshotError ?: OreoError(
                    315, @"The same-session stock snapshot is unavailable. "
                          @"Log out or restart before trying again.");
            }
            return NO;
        }
    }

    BOOL stillOwnsSnapshot =
        [self hasDurableSnapshotOwnershipInDefaults:defaults];
    if (OreoSnapshotPreparationForState(NO, stillOwnsSnapshot) ==
        OreoSnapshotPreparationMissingOwned) {
        if (error) {
            *error = OreoError(
                316, @"The cursor theme may still be active, but its same-session "
                     "recovery "
                      @"snapshot is missing. Log out or restart to recover.");
        }
        return NO;
    }
    return [self createSnapshot:error];
}

- (BOOL)registerRecord:(NSDictionary *)record
             identifier:(NSString *)identifier
                  error:(NSError **)error {
    NSArray *images = record[@"Images"];
    if (!images) {
        images = [self decodedImagesFromRecord:record error:error];
    }
    if (!images) {
        return NO;
    }
    NSUInteger frameCount = [record[@"FrameCount"] unsignedIntegerValue];
    if (frameCount < 1 || frameCount > OreoMaximumThemeFrames) {
        if (error) {
            *error = OreoError(
                319, @"Cursor %@ requires native reset and cannot be "
                      @"registered from a snapshot.", identifier);
        }
        return NO;
    }
    CGFloat frameDuration = [record[@"FrameDuration"] doubleValue];
    CGSize size = CGSizeMake([record[@"PointsWide"] doubleValue],
                             [record[@"PointsHigh"] doubleValue]);
    CGPoint hotSpot = CGPointMake([record[@"HotSpotX"] doubleValue],
                                  [record[@"HotSpotY"] doubleValue]);
    CGSConnectionID connection = _api.mainConnectionID();
    int seed = 0;
    CGError result = _api.registerCursor(
        connection, (char *)identifier.UTF8String, true, true, size, hotSpot,
        frameCount, frameDuration, (__bridge CFArrayRef)images, &seed);
    if (result != kCGErrorSuccess) {
        if (error) {
            *error = OreoError(320, @"Failed to register %@ (error %d).",
                               identifier, result);
        }
        return NO;
    }
    int activationSeed = 0;
    result = _api.activateCursor(
        connection, (char *)identifier.UTF8String, &activationSeed);
    if (result != kCGErrorSuccess) {
        if (error) {
            *error = OreoError(321, @"Failed to activate %@ (error %d).",
                               identifier, result);
        }
        return NO;
    }
    return YES;
}

- (BOOL)recordsMatch:(NSDictionary *)expected actual:(NSDictionary *)actual {
    if ([expected[@"WasRegistered"] boolValue] !=
        [actual[@"WasRegistered"] boolValue]) {
        return NO;
    }
    if (![expected[@"WasRegistered"] boolValue]) {
        return YES;
    }
    if ([expected[@"FrameCount"] unsignedIntegerValue] !=
        [actual[@"FrameCount"] unsignedIntegerValue]) {
        return NO;
    }
    NSArray *numericKeys = @[
        @"FrameDuration", @"HotSpotX", @"HotSpotY", @"PointsWide",
        @"PointsHigh"
    ];
    for (NSString *key in numericKeys) {
        if (!OreoNearlyEqual([expected[key] doubleValue],
                             [actual[key] doubleValue])) {
            return NO;
        }
    }
    return [expected[@"Hashes"] isEqual:actual[@"Hashes"]];
}

- (NSDictionary<NSString *, NSDictionary *> * _Nullable)
    preparedSystemFallbacksForSnapshot:(NSDictionary *)snapshot
                                  error:(NSError **)error {
    NSDictionary *targets = snapshot[@"Targets"];
    NSMutableDictionary<NSString *, NSDictionary *> *fallbacks =
        [NSMutableDictionary dictionary];
    for (NSString *identifier in OreoSortedTargetIdentifiers()) {
        NSDictionary *record = targets[identifier];
        if ([record[@"WasRegistered"] boolValue] ||
            OreoSupplementalAliasMap()[identifier].length == 0 ||
            OreoSystemCursorFolderMap()[identifier].length == 0) {
            continue;
        }
        NSDictionary *fallback =
            [self systemResourceFallbackRecordForIdentifier:identifier
                                                       error:error];
        if (!fallback) {
            return nil;
        }
        fallbacks[identifier] = fallback;
    }
    return [fallbacks copy];
}

- (BOOL)nativeAliasForIdentifier:(NSString *)identifier
             matchesActualRecord:(NSDictionary *)actual
                        snapshot:(NSDictionary *)snapshot
                 systemFallbacks:
                     (NSDictionary<NSString *, NSDictionary *> *)fallbacks {
    NSString *sourceIdentifier = OreoSupplementalAliasMap()[identifier];
    if (sourceIdentifier.length == 0) {
        return NO;
    }
    NSDictionary *sourceRecord =
        snapshot[@"Targets"][sourceIdentifier];
    if ([sourceRecord[@"WasRegistered"] boolValue] &&
        [self recordsMatch:sourceRecord actual:actual]) {
        return YES;
    }

    // WindowServer can materialize a distinct native named alias (for
    // example, Cell) independently of whether its numeric source had a named
    // registration in the saved session. Accept that normalization only when
    // the read-back record exactly matches the curated Apple resource for this
    // supplemental identifier. Never accept an arbitrary registration merely
    // because it uses a known alias name.
    if (OreoSystemCursorFolderMap()[identifier].length == 0) {
        return NO;
    }
    NSDictionary *nativeRecord = fallbacks[identifier];
    return nativeRecord && [self recordsMatch:nativeRecord actual:actual];
}

- (BOOL)restoreSystemAliasForIdentifier:(NSString *)identifier
                        systemFallbacks:
                            (NSDictionary<NSString *, NSDictionary *> *)fallbacks
                                  error:(NSError **)error {
    if (OreoSupplementalAliasMap()[identifier].length == 0 ||
        OreoSystemCursorFolderMap()[identifier].length == 0) {
        return NO;
    }

    NSDictionary *nativeRecord = fallbacks[identifier];
    if (!nativeRecord ||
        ![self registerRecord:nativeRecord identifier:identifier error:error]) {
        return NO;
    }

    NSError *captureError = nil;
    NSDictionary *actual =
        [self captureRegisteredCursor:identifier error:&captureError];
    if (!actual || ![self recordsMatch:nativeRecord actual:actual]) {
        if (error) {
            *error = captureError ?: OreoError(
                327, @"Apple's fallback for cursor %@ did not match after "
                     @"registration.", identifier);
        }
        return NO;
    }
    return YES;
}

- (BOOL)verifyThemeIdentifiers:(NSArray<NSString *> *)identifiers
                         error:(NSError **)error {
    for (NSString *identifier in identifiers) {
        NSError *captureError = nil;
        NSDictionary *actual =
            [self captureRegisteredCursor:identifier error:&captureError];
        if (!actual ||
            ![self recordsMatch:_themeCursors[identifier] actual:actual]) {
            if (error) {
                *error = captureError ?: OreoError(
                    322, @"Cursor %@ did not match the selected theme after "
                         "registration.",
                    identifier);
            }
            return NO;
        }
    }
    return YES;
}

- (BOOL)verifySnapshot:(NSDictionary *)snapshot
       systemFallbacks:
           (NSDictionary<NSString *, NSDictionary *> *)fallbacks
                  error:(NSError **)error {
    NSDictionary *targets = snapshot[@"Targets"];
    for (NSString *identifier in OreoSortedTargetIdentifiers()) {
        NSDictionary *expected = targets[identifier];
        NSError *captureError = nil;
        NSDictionary *actual =
            [self captureRegisteredCursor:identifier error:&captureError];
        BOOL matches = actual &&
            [self recordsMatch:expected actual:actual];
        if (!matches && actual &&
            ![expected[@"WasRegistered"] boolValue]) {
            // Re-registering a native numeric/name source can materialize an
            // equivalent AppKit alias that was lazily absent in the original
            // session. Treat only an exact pixel/metadata match to the saved
            // source as restored.
            matches = [self nativeAliasForIdentifier:identifier
                                 matchesActualRecord:actual
                                            snapshot:snapshot
                                     systemFallbacks:fallbacks];
        }
        if (!matches) {
            if (error) {
                *error = captureError ?: OreoError(
                    323, @"Cursor %@ did not return to its saved Apple state.",
                    identifier);
            }
            return NO;
        }
    }
    return YES;
}

- (BOOL)restoreSnapshot:(NSDictionary *)snapshot error:(NSError **)error {
    // Decode every Apple resource that might be needed to repair a stubborn
    // native alias before changing a single registration. A malformed or
    // unavailable system resource must fail with the original cursor state
    // untouched, rather than stopping halfway through restoration.
    NSDictionary<NSString *, NSDictionary *> *systemFallbacks =
        [self preparedSystemFallbacksForSnapshot:snapshot error:error];
    if (!systemFallbacks) {
        return NO;
    }

    CGSConnectionID connection = _api.mainConnectionID();
    _api.setDockOverride(connection, false);
    CGError resetResult = _api.unregisterAllCoreCursors(connection);
    if (resetResult != kCGErrorSuccess) {
        if (error) {
            *error = OreoError(
                323, @"Could not reset custom cursor registrations "
                      @"(error %d).", resetResult);
        }
        return NO;
    }

    // These five Apple-only roles are deliberately not replaced by Oreo and
    // therefore are not in the theme snapshot. Recreate only these core
    // defaults. Recreating every core ID also materializes supplemental named
    // aliases that were originally absent and makes exact restoration
    // impossible.
    const int appleOnlyCursorIDs[] = {9, 10, 14, 15, 16};
    for (NSUInteger index = 0;
         index < sizeof(appleOnlyCursorIDs) / sizeof(appleOnlyCursorIDs[0]);
         index++) {
        int cursorID = appleOnlyCursorIDs[index];
        CGError coreResult = _api.setCoreCursor(connection, cursorID);
        if (coreResult != kCGErrorSuccess) {
            if (error) {
                *error = OreoError(
                    324, @"Could not restore Apple core cursor %d "
                          @"(error %d).", cursorID, coreResult);
            }
            return NO;
        }
    }
    NSDictionary *targets = snapshot[@"Targets"];

    // Recreate saved registrations first. Any identifiers that were absent in
    // the stock session are removed in a second pass so registration side
    // effects cannot resurrect them after they have been checked.
    for (NSString *identifier in OreoSortedTargetIdentifiers()) {
        NSDictionary *record = targets[identifier];
        if ([record[@"WasRegistered"] boolValue]) {
            if (![self registerRecord:record identifier:identifier error:error]) {
                return NO;
            }
        }
    }
    for (NSString *identifier in OreoSortedTargetIdentifiers()) {
        NSDictionary *record = targets[identifier];
        if (![record[@"WasRegistered"] boolValue]) {
            CGError removeResult = _api.removeRegisteredCursor(
                connection, (char *)identifier.UTF8String, false);

            // WindowServer can reject explicit removal of a native alias.
            // Treat removal as a request: accept verified absence or an exact
            // Apple alias, and replace only a stale supplemental alias with its
            // trusted system artwork before verifying it again.
            size_t dataSize = 0;
            CGError sizeResult = _api.registeredCursorDataSize(
                connection, (char *)identifier.UTF8String, &dataSize);
            BOOL isAbsent =
                sizeResult == kCGErrorRangeCheck ||
                (sizeResult == kCGErrorSuccess && dataSize == 0);
            if (isAbsent) {
                continue;
            }

            NSError *captureError = nil;
            NSDictionary *actual =
                [self captureRegisteredCursor:identifier
                                         error:&captureError];
            if (actual &&
                [self nativeAliasForIdentifier:identifier
                           matchesActualRecord:actual
                                      snapshot:snapshot
                               systemFallbacks:systemFallbacks]) {
                continue;
            }
            NSError *aliasRestoreError = nil;
            if ([self restoreSystemAliasForIdentifier:identifier
                                      systemFallbacks:systemFallbacks
                                                error:&aliasRestoreError]) {
                continue;
            }
            if (error) {
                *error = aliasRestoreError ?: captureError ?: OreoError(
                    325, @"Failed to remove cursor %@ "
                         @"(remove %d, query %d).",
                    identifier, removeResult, sizeResult);
            }
            return NO;
        }
    }

    CGError arrowResult = _api.setSystemCursor(connection, 0);
    if (arrowResult != kCGErrorSuccess) {
        if (error) {
            *error = OreoError(
                326, @"Apple cursors were restored, but the Arrow refresh "
                      @"failed (error %d).", arrowResult);
        }
        return NO;
    }
    return [self verifySnapshot:snapshot
                systemFallbacks:systemFallbacks
                           error:error];
}

- (void)bestEffortSystemReset {
    CGSConnectionID connection = _api.mainConnectionID();
    _api.setDockOverride(connection, false);
    _api.unregisterAllCoreCursors(connection);
    for (int coreID = 0; coreID <= 43; coreID++) {
        if (coreID == 6) {
            continue;
        }
        _api.setCoreCursor(connection, coreID);
    }
    _api.setSystemCursor(connection, 0);
}

- (BOOL)recoverInterruptedTransaction:(BOOL *)didRecover
                                error:(NSError **)error {
    NSAssert([NSThread isMainThread], @"Cursor engine requires the main thread");
    self.lastErrorMessage = nil;
    if (didRecover) {
        *didRecover = NO;
    }
    if (!self.supported) {
        NSError *unsupportedError = OreoError(
            328, @"This macOS version cannot safely recover cursor "
                 "registrations. Log out or restart instead.");
        [self reportedError:error fallback:unsupportedError];
        return NO;
    }
    NSError *localError = nil;
    int lockDescriptor = [self acquireOperationLock:&localError];
    if (lockDescriptor < 0) {
        [self reportedError:error
                   fallback:localError ?: OreoError(329, @"Recovery is busy.")];
        return NO;
    }
    BOOL result = NO;
    @try {
        result = [self recoverInterruptedTransactionLocked:didRecover
                                                     error:&localError];
    } @finally {
        [self releaseOperationLock:lockDescriptor];
    }
    if (!result) {
        [self reportedError:error
                   fallback:localError ?: OreoError(
                       330, @"An interrupted cursor change could not be "
                            @"recovered. Log out or restart.")];
    }
    return result;
}

- (BOOL)recoverInterruptedTransactionLocked:(BOOL *)didRecover
                                       error:(NSError **)error {
    if (![[NSFileManager defaultManager]
            fileExistsAtPath:_transactionURL.path]) {
        return YES;
    }
    if (didRecover) {
        *didRecover = YES;
    }

    NSDictionary *transaction =
        [self readPropertyListAtURL:_transactionURL error:error];
    NSNumber *schema = transaction[@"SchemaVersion"];
    NSString *operation = transaction[@"Operation"];
    NSString *boot = transaction[@"BootSessionUUID"];
    NSString *build = transaction[@"OSBuild"];
    BOOL validTransaction =
        transaction &&
        [schema isKindOfClass:[NSNumber class]] &&
        CFGetTypeID((__bridge CFTypeRef)schema) != CFBooleanGetTypeID() &&
        schema.integerValue == OreoSnapshotSchemaVersion &&
        [operation isKindOfClass:[NSString class]] &&
        ([operation isEqual:@"apply"] || [operation isEqual:@"restore"]) &&
        [boot isKindOfClass:[NSString class]] &&
        [build isKindOfClass:[NSString class]];
    if (!validTransaction) {
        if (error && !*error) {
            *error = OreoError(
                331, @"The cursor transaction journal is malformed. Recovery "
                      @"files were preserved; log out or restart.");
        }
        return NO;
    }

    BOOL staleSession =
        ![boot isEqual:self.bootSessionUUID] || ![build isEqual:self.osBuild];
    if (staleSession) {
        if (![self persistDesiredState:NO
                        effectiveState:NO
                        activeSnapshot:NO
                                  error:error] ||
            ![self clearTransaction:error]) {
            return NO;
        }
        if (![self removeItemIfPresentAtURL:_snapshotURL error:error]) {
            return NO;
        }
        return YES;
    }

    NSDictionary *snapshot = [self loadValidSnapshot:error];
    if (!snapshot || ![self restoreSnapshot:snapshot error:error]) {
        return NO;
    }
    if (![self persistDesiredState:NO
                    effectiveState:NO
                    activeSnapshot:NO
                              error:error] ||
        ![self clearTransaction:error]) {
        return NO;
    }
    // A leftover verified stock snapshot is safe and reusable; cleanup failure
    // must not turn a successfully restored cursor into false failure.
    NSError *cleanupError = nil;
    if (![self removeItemIfPresentAtURL:_snapshotURL error:&cleanupError]) {
        NSLog(@"Cursor Atelier: snapshot cleanup warning: %@",
              cleanupError.localizedDescription);
    }
    return YES;
}

- (BOOL)apply:(NSError **)error {
    NSAssert([NSThread isMainThread], @"Cursor engine requires the main thread");
    self.lastErrorMessage = nil;
    NSError *localError = nil;
    int lockDescriptor = [self acquireOperationLock:&localError];
    if (lockDescriptor < 0) {
        [self reportedError:error
                   fallback:localError ?: OreoError(339, @"Apply is busy.")];
        return NO;
    }
    BOOL result = NO;
    @try {
        result = [self applyLocked:&localError];
    } @finally {
        [self releaseOperationLock:lockDescriptor];
    }
    if (!result) {
        [self reportedError:error
                   fallback:localError ?: OreoError(
                       340, @"The cursor theme could not be applied.")];
    }
    return result;
}

- (BOOL)applyLocked:(NSError **)error {
    if (!self.supported || !self.themeValid) {
        if (error) {
            *error = OreoError(
                341, @"Cursor Atelier is unavailable on this system.");
        }
        return NO;
    }
    NSUserDefaults *defaults = OreoCursorDefaults();
    BOOL previouslyDesired =
        [defaults boolForKey:OreoCursorEnabledDefaultsKey];
    BOOL alreadyActive = [[[defaults
        stringForKey:OreoCursorActiveBootDefaultsKey]
        description] isEqual:self.bootSessionUUID];
    BOOL alreadyEffective =
        [defaults boolForKey:OreoCursorEffectiveDefaultsKey];
    NSError *prepareError = nil;
    if (![self persistDesiredState:YES
                    effectiveState:alreadyEffective
                    activeSnapshot:alreadyActive
                              error:&prepareError]) {
        NSError *stateError = nil;
        [self persistDesiredState:previouslyDesired
                   effectiveState:alreadyEffective
                   activeSnapshot:alreadyActive
                             error:&stateError];
        if (error) {
            *error = stateError
                ? OreoError(345, @"%@ The prior desired state also could not "
                                 "be restored: %@",
                            prepareError.localizedDescription,
                            stateError.localizedDescription)
                : prepareError;
        }
        return NO;
    }
    if (![self ensureSnapshot:&prepareError] ||
        ![self beginTransaction:@"apply" error:&prepareError]) {
        NSError *stateError = nil;
        BOOL stateRestored =
            [self persistDesiredState:previouslyDesired
                       effectiveState:alreadyEffective
                       activeSnapshot:alreadyActive
                                 error:&stateError];
        if (error) {
            *error = stateRestored
                ? prepareError
                : OreoError(345, @"%@ The prior desired state also could not "
                                 "be restored: %@",
                            prepareError.localizedDescription,
                            stateError.localizedDescription);
        }
        return NO;
    }

    NSError *applyError = nil;
    for (NSString *identifier in OreoSortedTargetIdentifiers()) {
        if (![self registerRecord:_themeCursors[identifier]
                       identifier:identifier
                            error:&applyError]) {
            break;
        }
    }
    CGSConnectionID connection = _api.mainConnectionID();
    if (!applyError) {
        _api.setDockOverride(connection, true);
        CGError result = _api.setSystemCursor(connection, 0);
        if (result != kCGErrorSuccess) {
            applyError = OreoError(
                342, @"The cursor theme was registered, but the Arrow refresh failed "
                      @"(error %d).", result);
        }
    }
    if (!applyError) {
        [self verifyThemeIdentifiers:OreoSortedTargetIdentifiers()
                               error:&applyError];
    }
    if (!applyError && ![self persistAppliedState:&applyError]) {
        // The journal intentionally remains until state is durable.
    }
    if (!applyError && ![self clearTransaction:&applyError]) {
        // A non-removable journal would undo this apply next launch, so roll
        // back now instead of reporting success.
    }
    if (!applyError) {
        return YES;
    }

    NSError *rollbackError = nil;
    NSDictionary *snapshot = [self loadValidSnapshot:&rollbackError];
    BOOL cursorRolledBack =
        snapshot && [self restoreSnapshot:snapshot error:&rollbackError];
    BOOL rollbackCommitted =
        cursorRolledBack &&
        [self persistDesiredState:previouslyDesired
                   effectiveState:NO
                   activeSnapshot:NO
                             error:&rollbackError] &&
        [self clearTransaction:&rollbackError];
    if (rollbackCommitted) {
        NSError *cleanupError = nil;
        if (![self removeItemIfPresentAtURL:_snapshotURL
                                      error:&cleanupError]) {
            NSLog(@"Cursor Atelier: snapshot cleanup warning: %@",
                  cleanupError.localizedDescription);
        }
    }
    if (error) {
        *error = rollbackCommitted
            ? OreoError(343, @"The cursor theme could not be applied; Apple "
                             "cursors were "
                             @"restored. %@", applyError.localizedDescription)
            : OreoError(344, @"Cursor-theme apply failed and rollback could not be "
                             @"committed (%@). Log out or restart. Original "
                             @"error: %@",
                             rollbackError.localizedDescription ?: @"unknown",
                             applyError.localizedDescription);
    }
    return NO;
}

- (BOOL)restore:(NSError **)error {
    NSAssert([NSThread isMainThread], @"Cursor engine requires the main thread");
    self.lastErrorMessage = nil;
    if (!self.supported) {
        NSError *unsupportedError = OreoError(
            348, @"This macOS version cannot safely restore cursor "
                 "registrations. Log out or restart instead.");
        [self reportedError:error fallback:unsupportedError];
        return NO;
    }
    NSError *localError = nil;
    int lockDescriptor = [self acquireOperationLock:&localError];
    if (lockDescriptor < 0) {
        [self reportedError:error
                   fallback:localError ?: OreoError(349, @"Restore is busy.")];
        return NO;
    }
    BOOL result = NO;
    @try {
        result = [self restoreLocked:&localError];
    } @finally {
        [self releaseOperationLock:lockDescriptor];
    }
    if (!result) {
        [self reportedError:error
                   fallback:localError ?: OreoError(
                       350, @"Apple cursors could not be restored.")];
    }
    return result;
}

- (BOOL)restoreLocked:(NSError **)error {
    NSUserDefaults *defaults = OreoCursorDefaults();
    BOOL snapshotExists =
        [[NSFileManager defaultManager] fileExistsAtPath:_snapshotURL.path];
    NSString *activeBoot =
        [defaults stringForKey:OreoCursorActiveBootDefaultsKey];
    BOOL currentlyEffective =
        [defaults boolForKey:OreoCursorEffectiveDefaultsKey];
    BOOL hasActiveSnapshot = [activeBoot isEqual:self.bootSessionUUID];
    BOOL ownsSnapshot = currentlyEffective || hasActiveSnapshot;
    OreoSnapshotRestoreDisposition disposition =
        OreoSnapshotRestoreForState(snapshotExists, ownsSnapshot);

    // Record the user's disable intent before any fallible snapshot or journal
    // operation. A launch-time retry must never reapply Oreo after the user has
    // asked to turn it off, even if exact restoration needs attention.
    if (![self persistDesiredState:NO
                    effectiveState:currentlyEffective
                    activeSnapshot:hasActiveSnapshot
                              error:error]) {
        return NO;
    }

    if (disposition == OreoSnapshotRestoreInactive) {
        // Snapshot presence alone is not ownership. Never restore or reset
        // cursor registrations after durable state says this app is inactive.
        NSError *cleanupError = nil;
        if (snapshotExists &&
            ![self removeItemIfPresentAtURL:_snapshotURL
                                      error:&cleanupError]) {
            NSLog(@"Cursor Atelier: inactive snapshot cleanup warning: %@",
                  cleanupError.localizedDescription);
        }
        return YES;
    }

    if (disposition == OreoSnapshotRestoreMissingOwned) {
        [self bestEffortSystemReset];
        if (error) {
            *error = OreoError(
                351, @"The recovery snapshot is missing. A best-effort Apple "
                     @"reset ran, but log out or restart to guarantee a full "
                     @"restore.");
        }
        return NO;
    }

    NSDictionary *snapshot = [self loadValidSnapshot:error];
    if (!snapshot) {
        [self bestEffortSystemReset];
        return NO;
    }
    if (![self beginTransaction:@"restore" error:error]) {
        return NO;
    }
    if (![self persistDesiredState:NO
                    effectiveState:currentlyEffective
                    activeSnapshot:YES
                              error:error] ||
        ![self restoreSnapshot:snapshot error:error] ||
        ![self persistDesiredState:NO
                    effectiveState:NO
                    activeSnapshot:NO
                              error:error] ||
        ![self clearTransaction:error]) {
        return NO;
    }

    NSError *cleanupError = nil;
    if (![self removeItemIfPresentAtURL:_snapshotURL error:&cleanupError]) {
        NSLog(@"Cursor Atelier: snapshot cleanup warning: %@",
              cleanupError.localizedDescription);
    }
    return YES;
}

- (BOOL)refreshIfNeeded:(NSError **)error {
    NSAssert([NSThread isMainThread], @"Cursor engine requires the main thread");
    self.lastErrorMessage = nil;
    NSError *localError = nil;
    int lockDescriptor = [self acquireOperationLock:&localError];
    if (lockDescriptor < 0) {
        [self reportedError:error
                   fallback:localError ?: OreoError(359, @"Refresh is busy.")];
        return NO;
    }
    BOOL result = NO;
    @try {
        result = [self refreshIfNeededLocked:&localError];
    } @finally {
        [self releaseOperationLock:lockDescriptor];
    }
    if (!result) {
        [self reportedError:error
                   fallback:localError ?: OreoError(
                       360, @"The cursor theme could not be refreshed.")];
    }
    return result;
}

- (BOOL)refreshIfNeededLocked:(NSError **)error {
    if ([[NSFileManager defaultManager]
            fileExistsAtPath:_transactionURL.path]) {
        if (error) {
            *error = OreoError(
                361, @"A cursor recovery transaction is pending; the theme was "
                     @"not refreshed.");
        }
        return NO;
    }
    NSUserDefaults *defaults = OreoCursorDefaults();
    NSString *activeBoot =
        [defaults stringForKey:OreoCursorActiveBootDefaultsKey];
    if (![defaults boolForKey:OreoCursorEnabledDefaultsKey] ||
        ![defaults boolForKey:OreoCursorEffectiveDefaultsKey] ||
        ![activeBoot isEqual:self.bootSessionUUID]) {
        if (error) {
            *error = OreoError(
                362, @"The cursor theme is not durably marked active for this "
                     "login "
                     @"session, so it was not refreshed.");
        }
        return NO;
    }
    NSArray *sentinels = @[
        @"com.apple.coregraphics.Arrow",
        @"com.apple.coregraphics.IBeam",
        @"com.apple.cursor.13",
    ];
    NSError *verificationError = nil;
    if ([self verifyThemeIdentifiers:sentinels error:&verificationError]) {
        // Check the inexpensive live state first. The snapshot loader caches a
        // complete validation only while its inode, size, mtime, and ctime are
        // unchanged, so routine activations avoid decoding every saved image.
        if (![self loadValidSnapshot:error]) {
            return NO;
        }
        // Reassert only while the persisted state says Oreo is active.
        // No scale mutation or unconditional restore-side override occurs.
        CGSConnectionID connection = _api.mainConnectionID();
        _api.setDockOverride(connection, true);
        CGError result = _api.setSystemCursor(connection, 0);
        if (result != kCGErrorSuccess) {
            if (error) {
                *error = OreoError(
                    360, @"Could not refresh the themed Arrow (error %d).",
                    result);
            }
            return NO;
        }
        return YES;
    }
    // Never reapply an active cursor set unless its exact pre-apply recovery
    // snapshot still exists and passes every integrity check.
    if (![self loadValidSnapshot:error]) {
        return NO;
    }
    // Content was replaced or disappeared; reapply from the trusted,
    // already-decoded theme while retaining the original stock snapshot.
    return [self applyLocked:error];
}

- (BOOL)validateSystemFallbackResources:(NSError **)error {
    NSAssert([NSThread isMainThread], @"Cursor engine requires the main thread");
    if (!self.supported) {
        if (error) {
            *error = OreoError(
                363, @"Apple cursor fallback validation is unavailable on "
                     "this system.");
        }
        return NO;
    }
    NSArray<NSString *> *identifiers =
        [OreoSystemCursorFolderMap().allKeys
            sortedArrayUsingSelector:@selector(compare:)];
    for (NSString *identifier in identifiers) {
        NSError *fallbackError = nil;
        NSDictionary *record =
            [self systemResourceFallbackRecordForIdentifier:identifier
                                                       error:&fallbackError];
        if (!record || ![record[@"WasRegistered"] boolValue]) {
            if (error) {
                *error = fallbackError ?: OreoError(
                    364, @"Apple's fallback for cursor %@ did not decode.",
                    identifier);
            }
            return NO;
        }
    }
    return YES;
}

- (NSDictionary<NSString *, id> *)diagnostics {
    BOOL snapshotExists =
        [[NSFileManager defaultManager] fileExistsAtPath:_snapshotURL.path];
    BOOL transactionExists =
        [[NSFileManager defaultManager] fileExistsAtPath:_transactionURL.path];
    BOOL currentApplied = NO;
    if (self.supported && self.themeValid) {
        currentApplied =
            [self verifyThemeIdentifiers:@[
                @"com.apple.coregraphics.Arrow",
                @"com.apple.coregraphics.IBeam",
                @"com.apple.cursor.13",
            ] error:NULL];
    }
    return @{
        @"supported": @(self.supported),
        @"themeValid": @(self.themeValid),
        @"themeIdentifier": self.themeIdentifier ?: @"",
        @"themeDisplayName": self.themeDisplayName ?: @"",
        @"themeSizePercentage": @(self.themeSizePercentage),
        @"themeSHA256": self.themeSHA256 ?: @"",
        @"bootSessionUUID": self.bootSessionUUID ?: @"unknown",
        @"osBuild": self.osBuild ?: @"unknown",
        @"snapshotExists": @(snapshotExists),
        @"transactionPending": @(transactionExists),
        @"currentSentinelsMatchTheme": @(currentApplied),
        @"desiredEnabled": @([OreoCursorDefaults()
            boolForKey:OreoCursorEnabledDefaultsKey]),
        @"effectiveApplied": @([OreoCursorDefaults()
            boolForKey:OreoCursorEffectiveDefaultsKey]),
        @"lastError": self.lastErrorMessage ?: [NSNull null],
    };
}

@end
