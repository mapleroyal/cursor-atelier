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
generated_themes_path="$script_dir/../cursor-packs/generated"
staged_themes_path="$contents_path/Resources/Themes"
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

theme_count=$(find "$script_dir/Resources/Themes" \
    -maxdepth 1 -type f -name '*.cursor' | wc -l | tr -d ' ')
if [[ "$theme_count" != "19" ]]; then
    print -u2 "Expected exactly 19 built-in Oreo theme resources."
    exit 1
fi
(
    cd "$script_dir/Resources/Themes"
    /usr/bin/shasum -a 256 -c \
        "$script_dir/ArtworkSource/THEME-SHA256SUMS.txt"
)

engine_source="$script_dir/Sources/OreoCursorEngine.m"
# Each checked-in Oreo digest must still occur exactly once in the native
# source. Do not count the manifest parser's key references here; generated
# packs intentionally supply their own digests at build time.
while read -r expected_hash theme_filename; do
    engine_hash_count=$(
        /usr/bin/grep -Foc "$expected_hash" "$engine_source" || true
    )
    if [[ "$engine_hash_count" != "1" ]]; then
        print -u2 \
            "Theme hash is not synchronized with OreoCursorEngine.m: $theme_filename"
        exit 1
    fi
done < "$script_dir/ArtworkSource/THEME-SHA256SUMS.txt"

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
/usr/bin/ditto "$script_dir/Resources/Themes" \
    "$staged_themes_path"

# External packs are converted at build time into signed macOS .cursor
# property lists. The converter writes one machine-readable manifest beside
# those resources; copy both into the signed native bundle without mutating
# the checked-in Oreo resources. A manifest is required whenever generated
# resources are present so no cursor can be applied without an allowlisted
# metadata record and SHA-256 integrity entry.
if [[ -d "$generated_themes_path" ]]; then
    generated_manifest="$generated_themes_path/manifest.json"
    generated_cursor_count=$(find "$generated_themes_path" \
        -maxdepth 1 -type f -name '*.cursor' | wc -l | tr -d ' ')
    if [[ "$generated_cursor_count" != "0" && ! -f "$generated_manifest" ]]; then
        print -u2 "Generated cursor resources require manifest.json."
        exit 1
    fi
    if [[ -f "$generated_manifest" ]]; then
        if [[ "$generated_cursor_count" == "0" ]]; then
            print -u2 "Generated manifest.json has no .cursor resources."
            exit 1
        fi
        /usr/bin/ditto "$generated_manifest" \
            "$staged_themes_path/manifest.json"
        while IFS= read -r generated_resource; do
            generated_filename=${generated_resource:t}
            destination="$staged_themes_path/$generated_filename"
            if [[ -e "$destination" ]]; then
                print -u2 "Generated cursor collides with bundled resource: $generated_filename"
                exit 1
            fi
            /usr/bin/ditto "$generated_resource" "$destination"
        done < <(find "$generated_themes_path" -maxdepth 1 -type f \
            -name '*.cursor' -print | sort)
        if [[ -d "$generated_themes_path/previews" ]]; then
            /usr/bin/ditto "$generated_themes_path/previews" \
                "$staged_themes_path/previews"
        fi
    fi
fi
/usr/bin/ditto "$script_dir/Resources/Oreo-GPL-2.0.txt" \
    "$contents_path/Resources/Oreo-GPL-2.0.txt"
/usr/bin/ditto "$script_dir/Resources/Oreo-AUTHORS.txt" \
    "$contents_path/Resources/Oreo-AUTHORS.txt"
/usr/bin/ditto "$script_dir/LICENSE" \
    "$contents_path/Resources/LICENSE-CODE.txt"
/usr/bin/ditto "$script_dir/THIRD-PARTY-NOTICES.md" \
    "$contents_path/Resources/THIRD-PARTY-NOTICES.md"

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
