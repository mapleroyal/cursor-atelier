#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
source_svg="$project_dir/assets/AppIcon.svg"
output_icns="$project_dir/assets/AppIcon.icns"
menu_source_svg="$project_dir/assets/MenuBarIcon.svg"
menu_output_png="$project_dir/assets/MenuBarIconTemplate.png"
menu_output_2x_png="$project_dir/assets/MenuBarIconTemplate@2x.png"

for required_source in "$source_svg" "$menu_source_svg"; do
    if [[ ! -f "$required_source" ]]; then
        print -u2 "Missing icon source: $required_source"
        exit 1
    fi
done
if ! command -v rsvg-convert >/dev/null 2>&1; then
    print -u2 "Install librsvg (brew install librsvg) to rebuild AppIcon.icns."
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
iconset_dir="$temporary_dir/AppIcon.iconset"
/bin/mkdir -p "$iconset_dir"
for size in 16 32 128 256 512; do
    rsvg-convert -w "$size" -h "$size" "$source_svg" \
        > "$iconset_dir/icon_${size}x${size}.png"
    double_size=$((size * 2))
    rsvg-convert -w "$double_size" -h "$double_size" "$source_svg" \
        > "$iconset_dir/icon_${size}x${size}@2x.png"
done
/usr/bin/iconutil -c icns "$iconset_dir" -o "$output_icns"
rsvg-convert -w 18 -h 18 "$menu_source_svg" > "$menu_output_png"
rsvg-convert -w 36 -h 36 "$menu_source_svg" > "$menu_output_2x_png"
print -r -- "$output_icns"
print -r -- "$menu_output_png"
print -r -- "$menu_output_2x_png"
