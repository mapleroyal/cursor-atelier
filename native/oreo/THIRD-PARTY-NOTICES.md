# Third-party notices

This notice accompanies Cursor Atelier's nested native runtime. The current
personal bundle contains 19 Oreo resources and 221 generated external
resources. Exact per-variant author, source, upstream label, license URL, UUID,
and SHA-256 values are recorded in the schema-v2 manifest.

## Oreo cursors

The 19 files originating in `Resources/Themes/` are macOS conversions of the
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

Reproduce the 19 resources and check their locked digests from
`native/oreo` with:

```sh
ArtworkSource/generate_all_themes.sh Resources/Themes
cd Resources/Themes
shasum -a 256 -c ../../ArtworkSource/THEME-SHA256SUMS.txt
```

## Generated external cursor packs

`native/cursor-packs/build_all.py` generates 221 resources from pinned
upstream inputs. These are format conversions produced for Cursor Atelier;
they do not include the upstream Linux installation scripts in the runtime
bundle.

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

The GNOME archive license restricts derivatives and redistribution. This
project records that restriction without reinterpreting it. The current work
is a personal local build; permission/review and a complete distributable
notice/source corpus are intentionally deferred release gates.

## License map

- MIT: Cursor Atelier application/helper code, build and conversion scripts,
  and project documentation.
- GPL-2.0-only: the complete vendored Oreo artwork tree, generated Oreo SVG
  variants, and converted Oreo resources.
- External resources: the licenses listed above and in their manifest rows.

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
