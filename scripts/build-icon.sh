#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
composer_source="$project_dir/assets/AppIcon.icon"
output_icns="$project_dir/assets/AppIcon.icns"
dock_light_png="$project_dir/assets/DockIconLight.png"
dock_light_2x_png="$project_dir/assets/DockIconLight@2x.png"
dock_dark_png="$project_dir/assets/DockIconDark.png"
dock_dark_2x_png="$project_dir/assets/DockIconDark@2x.png"
menu_source_svg="$project_dir/assets/MenuBarIcon.svg"
menu_output_png="$project_dir/assets/MenuBarIconTemplate.png"
menu_output_2x_png="$project_dir/assets/MenuBarIconTemplate@2x.png"

if [[ ! -d "$composer_source" || -L "$composer_source" ]]; then
    print -u2 "Missing Icon Composer source: $composer_source"
    exit 1
fi
for required_composer_file in \
    "$composer_source/icon.json" \
    "$composer_source/Assets/BrandMarkCursor.svg" \
    "$composer_source/Assets/BrandMarkRays.svg"; do
    if [[ ! -f "$required_composer_file" ]]; then
        print -u2 "Missing Icon Composer document file: $required_composer_file"
        exit 1
    fi
done
if [[ ! -f "$menu_source_svg" ]]; then
    print -u2 "Missing menu-bar icon source: $menu_source_svg"
    exit 1
fi
if ! actool_path=$(/usr/bin/xcrun --find actool 2>/dev/null); then
    print -u2 "Install Xcode 26 or newer to rebuild AppIcon.icns."
    exit 1
fi
if ! command -v rsvg-convert >/dev/null 2>&1; then
    print -u2 "Install librsvg (brew install librsvg) to rebuild the menu-bar icons."
    exit 1
fi
if ! node_path=$(command -v node); then
    print -u2 "Install Node.js to rebuild the application icon variants."
    exit 1
fi

temporary_dir=$(/usr/bin/mktemp -d -t cursor-atelier-icon)
temporary_dir=${temporary_dir:A}
if [[ -z "$temporary_dir" || ! -d "$temporary_dir" || -L "$temporary_dir" ||
      "$temporary_dir" != /private/*/cursor-atelier-icon.* ]]; then
    print -u2 "Could not create a safe temporary icon directory."
    exit 1
fi
cleanup() {
    if [[ -n "$temporary_dir" && -d "$temporary_dir" &&
          ! -L "$temporary_dir" &&
          "$temporary_dir" == /private/*/cursor-atelier-icon.* ]]; then
        /bin/rm -rf "$temporary_dir"
    fi
}
trap cleanup EXIT INT TERM
staged_composer_source="$temporary_dir/Icon.icon"
compiled_icon_dir="$temporary_dir/compiled"
/usr/bin/ditto "$composer_source" "$staged_composer_source"

compile_icon() {
    local source=$1
    local destination=$2
    /bin/mkdir -p "$destination"
    "$actool_path" "$source" \
        --compile "$destination" \
        --output-format human-readable-text \
        --notices \
        --warnings \
        --output-partial-info-plist "$destination/assetcatalog_generated_info.plist" \
        --app-icon Icon \
        --include-all-app-icons \
        --enable-on-demand-resources NO \
        --development-region en \
        --target-device mac \
        --minimum-deployment-target 13.0 \
        --platform macosx \
        --standalone-icon-behavior all
}

compile_icon "$staged_composer_source" "$compiled_icon_dir"
compiled_icns="$compiled_icon_dir/Icon.icns"
if [[ ! -f "$compiled_icns" ]]; then
    print -u2 "actool did not generate the legacy application icon."
    exit 1
fi
/bin/cp "$compiled_icns" "$output_icns"

light_iconset="$temporary_dir/Light.iconset"
/usr/bin/iconutil -c iconset "$compiled_icns" -o "$light_iconset"

dark_source_directory="$temporary_dir/dark-source"
dark_composer_source="$dark_source_directory/Icon.icon"
dark_compiled_icon_dir="$temporary_dir/dark-compiled"
dark_iconset="$temporary_dir/Dark.iconset"
/bin/mkdir -p "$dark_source_directory"
/usr/bin/ditto "$composer_source" "$dark_composer_source"
"$node_path" "$project_dir/scripts/promote-icon-dark-appearance.mjs" \
    "$dark_composer_source/icon.json"
compile_icon "$dark_composer_source" "$dark_compiled_icon_dir"
/usr/bin/iconutil -c iconset "$dark_compiled_icon_dir/Icon.icns" \
    -o "$dark_iconset"

for source in \
    "$light_iconset/icon_512x512.png" \
    "$light_iconset/icon_512x512@2x.png" \
    "$dark_iconset/icon_512x512.png" \
    "$dark_iconset/icon_512x512@2x.png"; do
    if [[ ! -f "$source" ]]; then
        print -u2 "actool did not generate a required Dock icon representation."
        exit 1
    fi
done
/bin/cp "$light_iconset/icon_512x512.png" "$dock_light_png"
/bin/cp "$light_iconset/icon_512x512@2x.png" "$dock_light_2x_png"
/bin/cp "$dark_iconset/icon_512x512.png" "$dock_dark_png"
/bin/cp "$dark_iconset/icon_512x512@2x.png" "$dock_dark_2x_png"
if /usr/bin/cmp -s "$dock_light_png" "$dock_dark_png" ||
   /usr/bin/cmp -s "$dock_light_2x_png" "$dock_dark_2x_png"; then
    print -u2 "The generated light and dark Dock icons must be distinct."
    exit 1
fi

rsvg-convert -w 18 -h 18 "$menu_source_svg" > "$menu_output_png"
rsvg-convert -w 36 -h 36 "$menu_source_svg" > "$menu_output_2x_png"
print -r -- "$output_icns"
print -r -- "$dock_light_png"
print -r -- "$dock_light_2x_png"
print -r -- "$dock_dark_png"
print -r -- "$dock_dark_2x_png"
print -r -- "$menu_output_png"
print -r -- "$menu_output_2x_png"
