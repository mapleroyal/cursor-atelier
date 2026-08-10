# Cursor pack conversion

This directory contains both source-specific curated recipes and the general
compiled-theme importer. The signed app ships the recipes in a self-contained
converter, not the generated `.cursor` resources or upstream source archives.

The locked corpus is 221 generated external variants plus 19 vendored Oreo
variants. Its unified schema-v2 manifest has 240 rows, 47 native roles per
row, and 9,328 unique PNG previews derived from the real resources. The source
cache and bulk `generated/` corpus are ignored build data. Only 45 small static
family-choice previews are tracked and shipped.

Acquire a fresh cache, or verify an existing one, before conversion:

```sh
python3 native/cursor-packs/acquire_sources.py
python3 native/cursor-packs/acquire_sources.py --verify-only
```

Set `CURSOR_SOURCE_CACHE` to use a cache outside this directory. `build_all.py`
uses that path, `sources/cache`, or the legacy `sources/` layout as one cache
root; it never mixes repositories from several roots. Every build verifies
the pinned Git revision and exact paths it consumes, plus the archive hash and
expanded-tree contents for GNOME-Look inputs. Builds never update or reset a
source checkout.

## Input formats

The converter accepts:

- Xcursor binaries (`Xcur` files under a `cursors/` directory). It decodes
  every useful native-resolution image chunk directly, preserves animation
  order, and downsamples animations to at most 24 frames.
- `xcursorgen` text configs (`*.cursor`) paired with SVG/PNG artwork. Config
  hotspots and delays are retained. SVG artwork is rasterized directly at
  32/64/96/128px; bitmap tiers are preserved rather than reconstructing a
  larger cursor from the 32px image.
- Capitaine-style `*.spec` configs, whose hotspots are pixel coordinates in
  the 24px source canvas.
- Mousecape `*.cape` property lists (including vertical animation sprite
  sheets). These are normalized to the same output shape.
- Google bitmaps plus its clickgen TOML, retaining its exact hotspots, aliases,
  delays, and animation frame order.
- All 12 Bibata palettes/handedness profiles from `render.json` plus its normal
  and right-hand TOML metadata.
- All eight Bibata Extra palette profiles plus the upstream hotspot table.
  Its rotation SMIL is frozen at 24 deterministic timestamps rather than
  silently becoming a static cursor.
- Every Simp1e color scheme and every supplied Nordzy Xcursor variant,
  preserving its correctly scaled native tiers and hotspots.

Every output contains all 47 CoreGraphics cursor identifiers used by the
native engine. Missing source roles use the source's default arrow as a
declared fallback; `com.apple.coregraphics.Empty` remains transparent. Strict
profiles fail the build if default, Wait, or Progress falls back, if their busy
cursors are static, or if preview metadata is incomplete. The complete corpus
also enforces its per-family fallback counts, exact 221 external/19 Oreo ID
inventory, and 47-role contract from `inventory-lock.json`.

## Packaged-app conversion paths

For curated onboarding, `curated_runtime.py` selects the existing recipes for
one requested family. `curated-source-acquisition.js` downloads only that
family's pinned original source inputs, verifies archive and filtered-tree
locks, and passes a private cache root to the packaged converter. Each
completed artifact is installed transactionally in small progressive batches;
successful source caches are then removed. All 240 variants across the 15
families are represented in `curated-family-catalog.json`.

Arbitrary user imports use a separate, deliberately narrower conversion path.
It accepts an extracted compiled Xcursor theme
directory; a ZIP, `.tar`, `.tar.gz`/`.tgz`, or `.tar.xz`/`.txz` archive; a
compatible Mousecape `.cape`; or a compiled macOS `.cursor` property list. It
converts every discovered variant to the same 47-role schema-v2 contract and
installs a self-contained resource, manifest, and preview tree under
`~/Library/Application Support/Cursor Atelier/ImportedPacks`.

The arbitrary-import path does not acquire source repositories or invoke the
curated SVG/config recipes. It rejects raw SVG/config
trees, xcursorgen text files, unsafe archive paths, and unbounded/malformed
inputs. Imported artifacts are staged privately, checked for path and
identifier collisions, verified by SHA-256, and atomically moved into the
store; the Electron and native readers validate them again before listing or
applying them.

## Commands

Install librsvg and Pillow (the repository's Oreo requirements file pins the
tested Python version):

```sh
brew install librsvg
python3 -m pip install -r native/oreo/ArtworkSource/requirements.txt
```

On Debian/Ubuntu, the command-line renderer is provided by `librsvg2-bin`.
Developer conversions use `rsvg-convert`. The released curated converter uses
the app's packaged Sharp/libvips renderer over a bounded JSON-lines protocol;
it needs no user-installed Python, Pillow, librsvg, Git, or Homebrew.

Convert one resolved source variant:

```sh
python3 native/cursor-packs/converter.py convert \
  --source native/cursor-packs/sources/vimix-cursors/src/svg \
  --output native/cursor-packs/generated/Vimix.cursor \
  --id Vimix --name 'Vimix Cursors' \
  --source-url https://github.com/vinceliuice/Vimix-cursors \
  --license GPL-3.0
```

Convert a root containing variants (one Xcursor `cursors/` directory or Cape
file per variant) and write a deterministic manifest:

```sh
python3 native/cursor-packs/converter.py batch \
  --source-root native/cursor-packs/sources/qogir-icon-theme/src/cursors \
  --output native/cursor-packs/generated \
  --manifest native/cursor-packs/generated/manifest.json
```

Validate a generated resource before packaging:

```sh
python3 native/cursor-packs/converter.py validate \
  native/cursor-packs/generated/Vimix.cursor
```

The manifest has a stable, engine- and renderer-friendly shape. Preview paths
are relative to the manifest; aliases share PNG/APNG assets rather than
embedding base64 data:

```json
{
  "schemaVersion": 2,
  "roleCount": 47,
  "themes": [
    {
      "Identifier": "Vimix",
      "DisplayName": "Vimix",
      "Variant": "Default",
      "UpstreamVariant": "Vimix",
      "Resource": "Vimix.cursor",
      "SHA256": "…",
      "UUID": "…",
      "ThemeName": "Vimix",
      "Group": "Vimix",
      "preview": "previews/Vimix/default.png",
      "rolePreviews": [
        {
          "asset": "previews/Vimix/default.png",
          "fallback": false,
          "frameCount": 1,
          "frameDuration": 1.0,
          "hotspot": { "x": 4.0, "y": 4.0 },
          "macIdentifier": "com.apple.coregraphics.Arrow",
          "resolvedRole": "default",
          "role": "default"
        }
      ]
    }
  ]
}
```

The unified manifest contains every generated external variant and the 19
built-in Oreo rows. Human-facing `Group`, `DisplayName`, and `Variant` values
are kept separate from `UpstreamVariant`, which preserves the source label.
The built-in identities and metadata come from the canonical
`native/oreo/Resources/Themes/catalog.json`. Oreo resources stay beside that
catalog; only their renderer preview assets and unified-manifest rows are
generated here.

The 240 rows contain 11,280 role-preview references. Aliases intentionally
share files, so the generated preview tree contains 9,328 unique PNGs rather
than duplicating identical artwork. Each preview uses the cursor's exact 96px
representation, matching the renderer's 48 CSS-pixel canvas at 2x without an
extra browser resampling pass. Static roles remain single-frame PNGs. Animated
roles are indefinitely looping APNGs with the resource's normalized frame
count and frame duration rounded to the nearest APNG millisecond, so the
preview tracks the applied cursor's cycle timing. Because long source
animations are sampled without changing their total duration, their previews
retain that source-cycle timing as well.

UUIDs are UUIDv5 values under a Cursor Atelier namespace and the theme
identifier, so rebuilding the same pinned input is reproducible. Binary plist
keys and manifest keys are sorted; PNG sprite sheets use Pillow's deterministic
encoder. The generated directory is intentionally separate from the vendored
source tree and is ignored by Git apart from the 45 onboarding previews.
`build_all.py` builds and validates a staging sibling before atomically
replacing `generated/`; a failed build keeps the previous valid output. These
`.cursor` files, bulk previews, and the generated manifest are developer
artifacts. The native build rejects a staged `Contents/Resources/Themes`
payload.

## Role and animation details

Source aliases (`left_ptr`, `arrow`, `xterm`, resize names, `hand1`, and so on)
are normalized to the CoreGraphics role map in `converter.py`. Xcursor ARGB
words are decoded by channel rather than copied as bytes, which avoids an
endianness-dependent color swap. Associated Xcursor and Mousecape edge colors
are converted to PNG's straight-alpha form exactly once, and resizing is done
in premultiplied-alpha space to avoid light or dark halos. Every generated
theme contains a common 32/64/96px ladder; vector and sufficiently large
bitmap sources also include a 128px tier, while larger native tiers are kept.
MaCursor stores one frame duration per sprite sheet, so variable Xcursor
delays are normalized to one uniform output delay. A source animation longer
than 24 frames is evenly sampled, and the output delay is adjusted so the
complete animation cycle takes the same amount of time as the source.

The converter reports malformed/truncated source files and invalid output
through a non-zero exit status. It never silently emits a theme without a
usable default arrow.
