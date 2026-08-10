# Third-party notices

This notice accompanies Cursor Atelier's native runtime. The signed app does
not contain the 240 installable cursor resources or the original upstream
archives. The outer app carries a self-contained conversion runtime, locked
source metadata, and three small representative preview images per family. It
downloads a selected family's pinned original source, verifies it, and creates
the installable resources locally on the user's Mac.

## Oreo cursors

The 19 curated Oreo themes are macOS conversions of the
[Oreo cursor artwork](https://github.com/varlesh/oreo-cursors) by Alexey
Varfolomeev (`varlesh`), with generator colors by Sourav Goswami.

- Source revision: `7483f2dec06ae0fce182f9e9fe96c7db23b312b5`
- License: GPL-2.0-only
- License text: `Resources/Oreo-GPL-2.0.txt`
- Author list: `Resources/Oreo-AUTHORS.txt`
- Corresponding artwork source/converter: `ArtworkSource/`

The conversion rasterizes the upstream SVG sources at 1x and 2x. Original
48-frame Wait and Progress animations are evenly sampled to 24 frames and
their duration is doubled, preserving the 1.44-second period. The source
generator's unresolved `opacity="{{ opacity }}"` placeholder is normalized to
`opacity="1"`.

The macOS drag-link role (`com.apple.cursor.2`) uses Oreo's alias artwork and
the standard crosshair role (`com.apple.cursor.20`) uses crosshair artwork.
The vendored source snapshot also includes 19 generated SVG color directories
from `generator/colours.conf`; its `index.theme` comment was normalized to
remove a workstation path.

The source-specific runtime recipe reproduces the same 19 resources. The
canonical metadata remains in `native/oreo/Resources/Themes/catalog.json`, but
`native/oreo/build.sh` deliberately stages no Themes payload in the signed
native app.

```sh
ArtworkSource/generate_all_themes.sh Resources/Themes
cd ../..
npm run native:preflight
```

## Generated external cursor packs

`native/cursor-packs/build_all.py` defines source-specific recipes for 221
resources. The released converter runs only the selected recipes against
verified upstream input; neither the generated resources nor upstream Linux
installation scripts are bundled in the app.

- Remus (3), Drop (4), and Moga Classic/Candy/Colors/Neon/Light (16 total):
  MOYASH/Moyash GNOME-Look artwork, whose embedded ReadMe files specify CC
  BY-NC-ND 4.0.
- Volantes (2): GPL-2.0-only.
- Vimix (2), Qogir (6), Bibata Extra (8), Google (4), Future (2), Nordzy
  (133), Colloid (2), and Bibata (12): GPL-3.0-only.
- Simp1e (25): GPL-3.0-or-later.
- Capitaine (2): LGPL-3.0-or-later.

Repository commits, GNOME archive file IDs/checksums, consumed paths, and
license-file locations are recorded under `native/cursor-packs/sources`.
`CURSOR_PACK_NOTICES.md` is the concise family-level map. Upstream author names
and source URLs are retained as provenance.

The GNOME archive license restricts derivatives and commercial use. Runtime
download and local conversion do not remove those restrictions. Public
distribution must separately review the seven GNOME-Look packs and the small
representative preview images bundled for their onboarding rows.

## License map

- MIT: Cursor Atelier application/helper code, build and conversion scripts,
  and project documentation.
- GPL-2.0-only: the vendored developer-source Oreo artwork tree and locally
  generated Oreo resources.
- External artwork and local conversions: the licenses listed above and in
  their manifest rows.

## MaCursor research

The public [MaCursor project](https://github.com/writronic/MaCursor) was
reviewed to understand current macOS cursor behavior and private API names.
Cursor Atelier is an independent implementation and does not include MaCursor
source, helper, updater, parser, editor, or theme library. MaCursor is
GPL-3.0-licensed.

## Apple private APIs

The component dynamically resolves undocumented cursor functions in Apple
system frameworks. These functions may change in a future macOS release.
Failure to resolve or live-verify them is treated as unsupported; Cursor
Atelier does not patch system files.
