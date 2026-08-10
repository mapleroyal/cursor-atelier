"""Pinned Oreo source generation and native conversion recipe.

Oreo upstream stores palette-neutral ``.svg.oreo`` templates plus a color
configuration.  Runtime conversion deliberately ports the small deterministic
part of upstream's Ruby generator instead of requiring Ruby in the released
application or distributing previously converted cursor payloads.
"""

from __future__ import annotations

import hashlib
import plistlib
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
ARTWORK_SOURCE = ROOT.parent / "oreo" / "ArtworkSource"
if ARTWORK_SOURCE.is_dir() and str(ARTWORK_SOURCE) not in sys.path:
    sys.path.insert(0, str(ARTWORK_SOURCE))

from convert_oreo_to_macursor import convert as convert_oreo  # noqa: E402
from converter import (  # noqa: E402
    export_theme_previews,
    validate_preview_entry,
    validate_theme,
)


OREO_AUTHOR = "Alexey Varfolomeev (varlesh), Sourav Goswami"
OREO_SOURCE_URL = "https://github.com/varlesh/oreo-cursors"
OREO_LICENSE = "GPL-2.0-only"
OREO_LICENSE_URL = "https://github.com/varlesh/oreo-cursors/blob/master/LICENSE"

# Preserve the curated ordering and human-facing spelling used by the previous
# source-built catalog.  The native identifier still follows upstream's
# original spelling (for example OreoGrey and OreoSparkLite).
OREO_VARIANTS = (
    ("white", "White"),
    ("grey", "Gray"),
    ("black", "Black"),
    ("blue", "Blue"),
    ("pink", "Pink"),
    ("purple", "Purple"),
    ("red", "Red"),
    ("teal", "Teal"),
    ("spark_lite", "Spark Light"),
    ("spark_dark", "Spark Dark"),
    ("spark_blue", "Spark Blue"),
    ("spark_green", "Spark Green"),
    ("spark_light_pink", "Spark Light Pink"),
    ("spark_lime", "Spark Lime"),
    ("spark_orange", "Spark Orange"),
    ("spark_pink", "Spark Pink"),
    ("spark_purple", "Spark Purple"),
    ("spark_red", "Spark Red"),
    ("spark_violet", "Spark Violet"),
)


@dataclass(frozen=True)
class OreoPalette:
    name: str
    background: str
    label: str
    shadow: str
    shadow_opacity: str


def _color(value: str, *, field: str, line_number: int) -> str:
    raw = value.strip()
    if not re.fullmatch(r"#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})", raw):
        raise ValueError(
            f"colours.conf:{line_number}: invalid {field} color {value!r}"
        )
    digits = raw.removeprefix("#")
    if len(digits) == 3:
        digits = "".join(character * 2 for character in digits)
    return "#" + digits.upper()


def parse_oreo_palettes(path: Path) -> dict[str, OreoPalette]:
    palettes: dict[str, OreoPalette] = {}
    for line_number, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, values = line.partition("=")
        name = name.strip()
        tokens = values.split()
        if not separator or not name or len(name) > 512 or not tokens:
            raise ValueError(f"{path}:{line_number}: malformed Oreo palette")
        if name in palettes:
            raise ValueError(f"{path}:{line_number}: duplicate Oreo palette {name}")
        background = _color(tokens[0], field="background", line_number=line_number)
        label = _color(
            tokens[1] if len(tokens) >= 2 else "#fff",
            field="label",
            line_number=line_number,
        )
        shadow = _color(
            tokens[2] if len(tokens) >= 3 else "#000",
            field="shadow",
            line_number=line_number,
        )
        opacity = tokens[3] if len(tokens) >= 4 else "0.3"
        try:
            opacity_value = float(opacity)
        except ValueError as exc:
            raise ValueError(
                f"{path}:{line_number}: invalid shadow opacity {opacity!r}"
            ) from exc
        if not 0.0 <= opacity_value <= 1.0:
            raise ValueError(
                f"{path}:{line_number}: shadow opacity is outside 0..1"
            )
        palettes[name] = OreoPalette(
            name,
            background,
            label,
            shadow,
            opacity,
        )
    expected = {variant for variant, _label in OREO_VARIANTS}
    if set(palettes) != expected:
        missing = sorted(expected - set(palettes))
        unexpected = sorted(set(palettes) - expected)
        raise ValueError(
            "Oreo palette inventory differs from the curated 19-variant set "
            f"(missing={missing}, unexpected={unexpected})"
        )
    return palettes


def _substitute_template(content: str, palette: OreoPalette) -> str:
    substitutions = {
        r"\{\{\s*background\s*\}\}": palette.background,
        r"\{\{\s*label\s*\}\}": palette.label,
        r"\{\{\s*shadow\s*\}\}": palette.shadow,
        r"\{\{\s*shadow\s*opacity\s*\}\}": palette.shadow_opacity,
    }
    rendered = content
    # Replace the longer shadow-opacity token before its shadow prefix.
    for pattern in (
        r"\{\{\s*shadow\s*opacity\s*\}\}",
        r"\{\{\s*background\s*\}\}",
        r"\{\{\s*label\s*\}\}",
        r"\{\{\s*shadow\s*\}\}",
    ):
        rendered = re.sub(pattern, substitutions[pattern], rendered, flags=re.I)
    # Upstream intentionally leaves ``{{ opacity }}`` in a few templates;
    # the native Oreo converter normalizes that known invalid value to 1 just
    # before rasterization.  No other generator token may remain.
    unresolved = [
        token
        for token in re.findall(r"\{\{[^}]+\}\}", rendered)
        if token.strip().lower() != "{{ opacity }}"
    ]
    if unresolved:
        raise ValueError(f"unresolved Oreo template tokens: {sorted(set(unresolved))}")
    return rendered


def prepare_oreo_source(upstream_root: Path, destination: Path) -> Path:
    """Generate all curated SVG variants in a caller-owned working directory."""

    upstream_root = upstream_root.resolve()
    templates = upstream_root / "generator" / "oreo_base_cursors"
    config = upstream_root / "generator" / "colours.conf"
    cursor_configs = upstream_root / "src" / "config"
    if not templates.is_dir() or not config.is_file() or not cursor_configs.is_dir():
        raise FileNotFoundError("the acquired Oreo source tree is incomplete")
    if destination.exists():
        raise FileExistsError(destination)
    (destination / "src").mkdir(parents=True, mode=0o700)
    shutil.copytree(cursor_configs, destination / "src" / "config")
    palettes = parse_oreo_palettes(config)
    template_paths = sorted(templates.glob("*.svg.oreo"))
    if not template_paths:
        raise FileNotFoundError(f"no Oreo SVG templates found under {templates}")
    for variant, _label in OREO_VARIANTS:
        output = destination / "src" / f"oreo_{variant}_cursors"
        output.mkdir(mode=0o700)
        palette = palettes[variant]
        for template in template_paths:
            target = output / template.name.removesuffix(".oreo")
            target.write_text(_substitute_template(template.read_text(), palette))
    return destination


def convert_oreo_variant(
    prepared_root: Path,
    variant: str,
    variant_label: str,
    output: Path,
) -> dict[str, Any]:
    """Convert one generated variant and return its complete manifest row."""

    identifier = "Oreo" + "".join(word.capitalize() for word in variant.split("_"))
    cursor_path = output / f"{identifier}.cursor"
    convert_oreo(prepared_root, variant, cursor_path)
    theme = plistlib.loads(cursor_path.read_bytes())
    entry: dict[str, Any] = {
        "Author": OREO_AUTHOR,
        "DisplayName": f"Oreo {variant_label}",
        "Group": "Oreo",
        "Identifier": identifier,
        "License": OREO_LICENSE,
        "LicenseURL": OREO_LICENSE_URL,
        "Resource": cursor_path.name,
        "SHA256": hashlib.sha256(cursor_path.read_bytes()).hexdigest(),
        "SourceURL": OREO_SOURCE_URL,
        "ThemeName": str(theme["ThemeName"]),
        "UUID": str(theme["UUID"]),
        "UpstreamVariant": variant,
        "Variant": variant_label,
        "VariantLabel": variant_label,
    }
    entry.update(
        export_theme_previews(
            cursor_path,
            output / "previews",
            manifest_root=output,
        )
    )
    validate_theme(cursor_path, required_animated_roles=("wait", "progress"))
    validate_preview_entry(entry, output)
    return entry


def oreo_recipe_digest(prepared_root: Path) -> str:
    """Expose a deterministic generated-source digest for focused tests/audits."""

    digest = hashlib.sha256()
    for path in sorted((prepared_root / "src").rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(prepared_root).as_posix().encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    return digest.hexdigest()
