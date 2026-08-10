#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
build_dir="$script_dir/build/Release"
app_path="$build_dir/Oreo Cursor.app"
staging_path="$build_dir/.Oreo Cursor.app.staging.$$"
contents_path="$staging_path/Contents"
binary_path="$contents_path/MacOS/OreoCursor"
helper_path="$contents_path/Library/LoginItems/Oreo Cursor Login Helper.app"
helper_contents_path="$helper_path/Contents"
helper_binary_path="$helper_contents_path/MacOS/OreoCursorLoginHelper"
package_json_path="$script_dir/../../package.json"
sign_identity=${OREO_SIGN_IDENTITY:-}
sign_flags=(--force --options runtime --sign "$sign_identity")

if [[ "$app_path" != "$script_dir/build/Release/Oreo Cursor.app" ]]; then
    print -u2 "Refusing unexpected build path: $app_path"
    exit 1
fi
if [[ "$staging_path" != "$build_dir"/.Oreo\ Cursor.app.staging.<-> ]]; then
    print -u2 "Refusing unexpected staging path: $staging_path"
    exit 1
fi
if [[ -z "$sign_identity" || "$sign_identity" == "-" ]]; then
    print -u2 "Set OREO_SIGN_IDENTITY to a stable Apple signing identity."
    exit 1
fi
if [[ ! -f "$package_json_path" ]]; then
    print -u2 "Could not find the root package.json for version stamping."
    exit 1
fi
product_version=$(/usr/bin/plutil -extract version raw "$package_json_path")
if [[ "$product_version" != <->.<->.<-> ]]; then
    print -u2 "package.json must contain a numeric semantic version."
    exit 1
fi
# CFBundleShortVersionString identifies the release; CFBundleVersion must
# identify this exact build. A static build version lets macOS keep an older
# resident login helper alive after the .app is replaced. CI may supply its
# own monotonic numeric value, while local builds receive a UTC build stamp.
build_version=${CURSOR_ATELIER_BUILD_VERSION:-$(/bin/date -u +%Y%m%d%H%M%S)}
if [[ ! "$build_version" =~ '^[0-9]+([.][0-9]+){0,2}$' ||
      "$build_version" == "$product_version" ]]; then
    print -u2 \
        "CURSOR_ATELIER_BUILD_VERSION must be a unique numeric build identifier."
    exit 1
fi
if [[ "$sign_identity" == Developer\ ID\ Application:* ]]; then
    sign_flags+=(--timestamp)
else
    sign_flags+=(--timestamp=none)
fi

identity_details=$(/usr/bin/security find-identity -v -p codesigning)
if [[ "$identity_details" != *"$sign_identity"* ]]; then
    print -u2 "The requested signing identity is not available."
    exit 1
fi

themes_source_path="$script_dir/Resources/Themes"
catalog_path="$themes_source_path/catalog.json"
/usr/bin/python3 - "$catalog_path" "$themes_source_path" <<'PY'
import hashlib
import json
import plistlib
import sys
from pathlib import Path

catalog_path, themes_path = map(Path, sys.argv[1:])
catalog = json.loads(catalog_path.read_text())
themes = catalog.get("themes")
if catalog.get("schemaVersion") != 1 or not isinstance(themes, list) or not themes:
    raise SystemExit("The source Oreo catalog must contain schema-v1 themes.")
resources = {path.name for path in themes_path.glob("*.cursor")}
declared = {str(theme.get("resourceFile", "")) for theme in themes}
if resources != declared:
    raise SystemExit("The source Oreo catalog and cursor resources differ.")
identifiers = set()
default_theme_id = catalog.get("defaultThemeId")
for theme in themes:
    identifier = str(theme.get("nativeThemeId", ""))
    resource = themes_path / str(theme.get("resourceFile", ""))
    if not identifier or identifier in identifiers:
        raise SystemExit("The source Oreo catalog contains an invalid identifier.")
    identifiers.add(identifier)
    data = resource.read_bytes()
    cursor = plistlib.loads(data)
    if (
        hashlib.sha256(data).hexdigest() != theme.get("sha256")
        or cursor.get("Identifier") != identifier
        or cursor.get("ThemeName") != theme.get("plistName")
        or cursor.get("UUID") != theme.get("uuid")
    ):
        raise SystemExit(f"{identifier} differs from catalog.json.")
if default_theme_id not in identifiers:
    raise SystemExit("The source Oreo catalog defaultThemeId is invalid.")
PY

cleanup() {
    /bin/rm -rf "$staging_path"
}
trap cleanup EXIT INT TERM

/bin/rm -rf "$staging_path"
/bin/mkdir -p \
    "$contents_path/MacOS" \
    "$contents_path/Resources" \
    "$contents_path/Library/LoginItems" \
    "$helper_contents_path/MacOS"

sdk_path=$(/usr/bin/xcrun --sdk macosx --show-sdk-path)
common_flags=(
    -isysroot "$sdk_path"
    -mmacosx-version-min=13.0
    -arch arm64
    -arch x86_64
    -fobjc-arc
    -fblocks
    -fmodules
    -Wall
    -Wextra
)

/usr/bin/xcrun --sdk macosx clang \
    "${common_flags[@]}" \
    "$script_dir/Sources/OreoCursorEngine.m" \
    "$script_dir/Sources/OreoAppController.m" \
    "$script_dir/Sources/OreoAppDelegate.m" \
    "$script_dir/Sources/main.m" \
    -framework Cocoa \
    -framework ServiceManagement \
    -framework ImageIO \
    -o "$binary_path"

/usr/bin/xcrun --sdk macosx clang \
    "${common_flags[@]}" \
    -I "$script_dir/Sources" \
    "$script_dir/Sources/OreoCursorEngine.m" \
    "$script_dir/HelperSources/OreoLoginHelperMain.m" \
    -framework Cocoa \
    -framework ImageIO \
    -o "$helper_binary_path"

/usr/bin/ditto "$script_dir/Info.plist" "$contents_path/Info.plist"
/usr/bin/ditto "$script_dir/LoginHelper-Info.plist" \
    "$helper_contents_path/Info.plist"
/usr/libexec/PlistBuddy -c \
    "Set :CFBundleShortVersionString $product_version" \
    "$contents_path/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_version" \
    "$contents_path/Info.plist"
/usr/libexec/PlistBuddy -c \
    "Set :CFBundleShortVersionString $product_version" \
    "$helper_contents_path/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_version" \
    "$helper_contents_path/Info.plist"

# The checked-in resources above remain the source-of-truth for curated
# on-demand assets, but the installed native bridge starts with no cursor
# payload. Imported packs live in the private Application Support store and
# are discovered independently of a bundled catalog.
/usr/bin/ditto "$script_dir/Resources/Oreo-GPL-2.0.txt" \
    "$contents_path/Resources/Oreo-GPL-2.0.txt"
/usr/bin/ditto "$script_dir/Resources/Oreo-AUTHORS.txt" \
    "$contents_path/Resources/Oreo-AUTHORS.txt"
/usr/bin/ditto "$script_dir/../../assets/BrandMark.svg" \
    "$contents_path/Resources/BrandMark.svg"
/usr/bin/ditto "$script_dir/LICENSE" \
    "$contents_path/Resources/LICENSE-CODE.txt"
/usr/bin/ditto "$script_dir/THIRD-PARTY-NOTICES.md" \
    "$contents_path/Resources/THIRD-PARTY-NOTICES.md"

if [[ -d "$contents_path/Resources/Themes" ]] ||
   [[ -n "$(find "$staging_path" -type f -name '*.cursor' -print -quit)" ]]; then
    print -u2 "The native app must not stage bundled cursor payloads."
    exit 1
fi

/usr/bin/codesign "${sign_flags[@]}" "$helper_path"
/usr/bin/codesign --verify --strict --verbose=2 "$helper_path"
helper_signature=$(/usr/bin/codesign -dvv "$helper_path" 2>&1)
if [[ "$helper_signature" != *"TeamIdentifier="* ||
      "$helper_signature" == *"TeamIdentifier=not set"* ]]; then
    print -u2 "Refusing a helper signature without a stable TeamIdentifier."
    exit 1
fi

/usr/bin/codesign "${sign_flags[@]}" "$staging_path"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$staging_path"
signature_details=$(/usr/bin/codesign -dvv "$staging_path" 2>&1)
if [[ "$signature_details" != *"TeamIdentifier="* ||
      "$signature_details" == *"TeamIdentifier=not set"* ]]; then
    print -u2 "Refusing an app signature without a stable TeamIdentifier."
    exit 1
fi

/bin/rm -rf "$app_path"
/bin/mv "$staging_path" "$app_path"
trap - EXIT INT TERM
print -r -- "Native build version: $build_version"
print -r -- "$app_path"
