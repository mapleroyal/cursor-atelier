# Oreo artwork conversion source

This directory contains the corresponding source for the bundled Oreo
cursor themes:

- `oreo-cursors/`: a snapshot of varlesh/oreo-cursors at commit
  `7483f2dec06ae0fce182f9e9fe96c7db23b312b5`, without Git metadata, plus
  the 19 SVG color-variant directories generated from that revision's base
  templates and `generator/colours.conf`.
- `convert_oreo_to_macursor.py`: the macOS conversion script, most recently
  modified on 2026-08-06.

The SVG variants were generated on 2026-07-25 with:

```sh
ruby ArtworkSource/oreo-cursors/generator/convert.rb
```

The vendored generator's `index.theme` comment was normalized on 2026-07-26
to avoid embedding the original generator invocation path. The generated SVG
artwork is otherwise the output of the pinned upstream templates and color
configuration.

Requirements are librsvg's `rsvg-convert`, Python 3, and the Pillow version
pinned in `requirements.txt`. From the Cursor Atelier repository root:

```sh
brew install librsvg
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r native/oreo/ArtworkSource/requirements.txt
python3 native/oreo/ArtworkSource/convert_oreo_to_macursor.py \
  native/oreo/ArtworkSource/oreo-cursors black \
  native/oreo/Resources/Themes/OreoBlack.cursor
```

To regenerate every upstream color variant:

```sh
native/oreo/ArtworkSource/generate_all_themes.sh \
  native/oreo/Resources/Themes
```

Set `PYTHON=/path/to/python3` to use a specific interpreter; otherwise the
script uses `python3` from `PATH`, including an active virtual environment.

The identifiers, display metadata, UUIDs, and expected SHA-256 values are
recorded once in `Resources/Themes/catalog.json`.

The checked-in hashes were produced on macOS 26.5.2 (build 25F84) with
`rsvg-convert` 2.62.3, Python 3.9.6, and Pillow 11.3.0. The checked-in
`.cursor` files contain directly rendered 32/64/96/128px representations and
build on every supported system without regeneration. Future librsvg or
Pillow encoders may produce byte-different PNG data even when the rendered
artwork is equivalent.
