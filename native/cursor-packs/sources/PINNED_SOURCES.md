# Pinned cursor sources

This manifest records the upstream revisions used by the Cursor Atelier
conversion pipeline. Large source trees are acquired into an ignored local
cache by `../acquire_sources.py`; they are not application source and are
never copied into the package. Once acquired, conversion requires no network
access. `upstreamRevision` is the full commit checked out in each tree.

The `assetRoots` paths are relative to each source directory.  They identify
the smallest useful input set for conversion; generated Linux/Windows output
is retained when it is part of the upstream checkout, but should not be
copied into the packaged Electron app.

| id | upstream | revision | license | conversion inputs |
| --- | --- | --- | --- | --- |
| `simp1e` | [cursors/simp1e](https://gitlab.com/cursors/simp1e) | `f8f8f3c09dd0aa31cc9bc5499c683aad025984be` (`master`) | GPL-3.0-or-later (`LICENSE`, `COPYING`) | `src/color_schemes/*.txt`, `src/templates/` |
| `capitaine` | [keeferrourke/capitaine-cursors](https://github.com/keeferrourke/capitaine-cursors) | `06c88433662a4004cf56a6e471b523a0a8880be0` (`master`) | LGPL-3.0-or-later (`COPYING`) | `src/svg/{dark,light}/`, `src/config/`, `src/{static-cursor-list,animated-cursor-list,cursor-aliases}` |
| `future` | [yeyushengfan258/Future-cursors](https://github.com/yeyushengfan258/Future-cursors) | `587c14d2f5bd2dc34095a4efbb1a729eb72a1d36` (`master`) | GPL-3.0 (`LICENSE`) | `src/svg/`, `src/svg-black/`, `src/svg-cyan/`, `src/svg-dark/`, `src/config/`, `dist/` |
| `nordzy` | [guillaumeboehm/Nordzy-cursors](https://github.com/guillaumeboehm/Nordzy-cursors) | `c7fc485e9e4fd974c4f4ff9f5f14610fa7835e7b` (`main`) | GPL-3.0 (`COPYING`) | `MacOs_cursors/*.cape` (variant inventory), `xcursors/*/cursors/` (artwork, tiers, hotspots) |
| `colloid` | [vinceliuice/Colloid-icon-theme](https://github.com/vinceliuice/Colloid-icon-theme) | `c9e702beb96f731e2b3bea2fa1c619fa94e79a9f` (`main`) | GPL-3.0 (`cursors/LICENSE`, repository `LICENSE`) | `cursors/src/svg-*`, `cursors/src/config`, `cursors/src/cursorList`, `cursors/dist`, `cursors/dist-dark` |
| `bibata` | [ful1e5/Bibata_Cursor](https://github.com/ful1e5/Bibata_Cursor) | `35ccfe209a808e40d6c2ca60a46cbe4faf68b690` (`main`) | GPL-3.0 (`LICENSE`) | `svg/{original,modern,original-right,modern-right}`, `configs/{normal,right}/*.toml`, `render.json` |

## Source integrity

The revision values above are verified by `../acquire_sources.py
--verify-only`, which also rejects a dirty checkout. Acquisition stages Git
checkouts and archive extraction in temporary sibling directories before
promotion. Existing expanded GNOME-Look trees are accepted only when every
file matches the locked archive; partial or locally modified trees fail
closed. `build_all.py` applies the same checks to every path it consumes.
License files remain verbatim in each upstream checkout and must be copied
into any distributable converted-pack notice. The conversion output must
retain the corresponding source id and revision in its pack manifest.

## Format notes

- `simp1e`, `capitaine`, `future`, `colloid`, and `bibata` provide SVG/Xcursor
  sources.  Their SVG hotspot and role metadata must be read from the checked
  in config files rather than inferred from rendered pixels.
- Nordzy includes native macOS `.cape` XML plists, but their 64-point canvas
  metadata scales both artwork and hotspots down by half during normalization.
  Use the corresponding Xcursor binaries, whose native tiers and hotspot
  metadata match the authored cursor size. The Cape filenames remain the
  authoritative variant inventory; do not use the `.cur` or `.ani` Windows
  output as macOS assets.
- Colloid's `cursors/dist` and `cursors/dist-dark` are Xcursor binaries.  The
  source SVG/config tree is preferred when generating deterministic macOS
  representations; the dist folders are useful as a cross-check.
- Bibata's six normal and six right-hand variants are represented by separate
  SVG groups/configs.  Keep the right-hand variants as distinct pack entries;
  they are not aliases for the normal set.
