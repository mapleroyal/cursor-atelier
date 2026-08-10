#!/usr/bin/env python3
"""Build every requested cursor family into deterministic native resources.

The repositories and GNOME-Look archives under ``sources/`` are build inputs,
not runtime dependencies.  This script is intentionally explicit about the
variants selected from each source so a release can be reproduced from the
pinned provenance files without guessing which upstream directory happened to
be discovered first.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import plistlib
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Collection, Mapping

from PIL import Image


ROOT = Path(__file__).resolve().parent
SOURCES = ROOT / "sources"
OUTPUT = ROOT / "generated"
sys.path.insert(0, str(ROOT))
from converter import (  # noqa: E402
    Frame,
    MAC_CURSOR_IDENTIFIERS,
    VECTOR_REPRESENTATION_SIZES,
    _natural_key,
    _xcursor_role_priority,
    canonical_role,
    convert_frames,
    convert_theme,
    export_theme_previews,
    frames_from_bitmap_config,
    frames_from_svg_assets,
    frames_from_svg_build_config,
    frames_from_svg_config,
    smil_cycle_duration,
    slug_identifier,
    validate_preview_entry,
    validate_theme,
)
from acquire_sources import verify_build_cache  # noqa: E402
from svg_renderer import render_svg_file  # noqa: E402


for _prefix, _namespace in (
    ("", "http://www.w3.org/2000/svg"),
    ("inkscape", "http://www.inkscape.org/namespaces/inkscape"),
    ("sodipodi", "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"),
    ("xlink", "http://www.w3.org/1999/xlink"),
):
    ElementTree.register_namespace(_prefix, _namespace)


GNOME_LICENSE = "CC BY-NC-ND 4.0"
GNOME_LICENSE_URL = "https://creativecommons.org/licenses/by-nc-nd/4.0/"
GNOME_AUTHOR = "Moyash (moyash / moyashos)"

INVENTORY_LOCK = json.loads((ROOT / "inventory-lock.json").read_text())
EXPECTED_EXTERNAL_IDENTIFIER_SHA256 = INVENTORY_LOCK["externalIdentifierSHA256"]
EXPECTED_UNIFIED_IDENTIFIER_SHA256 = INVENTORY_LOCK["unifiedIdentifierSHA256"]
EXPECTED_FALLBACK_COUNTS = {
    "Bibata": 0,
    "Bibata Extra": 2,
    "Capitaine": 1,
    "Colloid": 1,
    "Drop": 0,
    "Future": 1,
    "Google": 0,
    "Moga": 0,
    "Nordzy": 0,
    "Oreo": 0,
    "Qogir": 1,
    "Remus": 0,
    "Simp1e": 0,
    "Vimix": 1,
    "Volantes": 1,
}

FAMILY_ID_TO_NAME = {
    "oreo": "Oreo",
    "remus": "Remus",
    "drop": "Drop",
    "moga": "Moga",
    "volantes": "Volantes",
    "vimix": "Vimix",
    "qogir": "Qogir",
    "bibata-extra": "Bibata Extra",
    "google": "Google",
    "simp1e": "Simp1e",
    "capitaine": "Capitaine",
    "future": "Future",
    "nordzy": "Nordzy",
    "colloid": "Colloid",
    "bibata": "Bibata",
}


@dataclass(frozen=True)
class Job:
    identifier: str
    display_name: str
    source: Path | Callable[[], Path]
    family: str
    source_url: str
    license: str
    license_url: str
    author: str
    variant: str | None = None
    loader: Callable[[Path], Mapping[str, Any]] | None = None
    strict_semantics: bool = False
    variant_label: str | None = None


def _path(value: Path | Callable[[], Path]) -> Path:
    return value() if callable(value) else value


def _cache_root() -> Path:
    configured = os.environ.get("CURSOR_SOURCE_CACHE")
    if configured:
        return Path(configured).expanduser()
    cache = SOURCES / "cache"
    return cache if cache.exists() else SOURCES


def _repo(name: str, *parts: str) -> Path:
    """Resolve every build input from one ignored acquisition cache."""

    return _cache_root().joinpath(name, *parts)


def _split_label(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", " ", value)


def _humanize(value: str) -> str:
    label = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", value)
    label = re.sub(r"[-_]+", " ", label)
    words = [word for word in label.split() if word.lower() != "cursors"]
    replacements = {
        "adw": "Adwaita",
        "bibata": "Bibata",
        "frappe": "Frappé",
        "lefthand": "Left-handed",
        "lite": "Light",
        "nordzy": "Nordzy",
        "simp1e": "Simp1e",
    }
    return " ".join(replacements.get(word.lower(), word.title()) for word in words)


def _identifier_digest(identifiers: list[str]) -> str:
    payload = "".join(f"{identifier}\n" for identifier in sorted(identifiers))
    return hashlib.sha256(payload.encode()).hexdigest()


def _variant_metadata(job: Job) -> tuple[str, str]:
    if job.variant_label:
        label = job.variant_label
    else:
        raw = job.variant or job.display_name
        label = _humanize(raw)
        for prefix in (_humanize(job.family), "Bibata", "Nordzy", "Simp1e"):
            if label == prefix:
                label = ""
                break
            if label.startswith(prefix + " "):
                label = label[len(prefix) + 1 :]
                break
        label = label or "Default"
    display_name = job.family if label == "Default" else f"{job.family} {label}"
    return display_name, label


def _gnome_variant(root_name: str, variant: str) -> Path:
    matches = sorted(
        path
        for path in (_repo(root_name) / "expanded").rglob("cursors")
        if path.is_dir() and variant in path.parts
    )
    if len(matches) != 1:
        raise FileNotFoundError(f"expected one {root_name}/{variant}/cursors, got {matches}")
    return matches[0]


def _repo_job(
    identifier: str,
    display_name: str,
    source: Path,
    family: str,
    url: str,
    license_name: str,
    license_url: str,
    author: str,
    variant: str | None = None,
    loader: Callable[[Path], Mapping[str, Any]] | None = None,
    strict_semantics: bool = False,
    variant_label: str | None = None,
) -> Job:
    return Job(
        identifier,
        display_name,
        source,
        family,
        url,
        license_name,
        license_url,
        author,
        variant,
        loader,
        strict_semantics,
        variant_label,
    )


def _jobs(selected_families: Collection[str] | None = None) -> list[Job]:
    """Return the authoritative recipes, optionally without touching other sources.

    Runtime acquisition is intentionally family-selective.  Keeping the
    filtering inside the recipe registry is important: constructing a Bibata
    or Nordzy job enumerates files from that source, so filtering only after
    calling ``_jobs`` would still require every unrelated repository.
    """

    selected = set(selected_families) if selected_families is not None else None

    def includes(family: str) -> bool:
        return selected is None or family in selected

    jobs: list[Job] = []

    # GNOME-Look packs. The Linux variants are the portable Xcursor artwork;
    # the archives also contain Windows companions which are not usable by the
    # converter and are deliberately excluded from the macOS bundle.
    gnome_url = {
        "remus": "https://www.gnome-look.org/p/2355234",
        "drop": "https://www.gnome-look.org/p/2330173",
        "moga-classic": "https://www.gnome-look.org/p/2296782",
        "moga-candy": "https://www.gnome-look.org/p/2299255",
        "moga-colors": "https://www.gnome-look.org/p/2297654",
        "moga-neon": "https://www.gnome-look.org/p/2302110",
        "moga-light": "https://www.gnome-look.org/p/2364891",
    }
    gnome_variants = {
        "remus": [("Remus", "Remus-Black"), ("RemusDark", "Remus-Dark"), ("RemusWhite", "Remus-White")],
        "drop": [("Drop", "Drop-Alien"), ("DropBlood", "Drop-Blood"), ("DropBlue", "Drop-Blue"), ("DropBlueLayan", "Drop-BlueLayan")],
        "moga-classic": [("MogaClassic", "Moga-Black"), ("MogaClassicDark", "Moga-Dark"), ("MogaClassicWhite", "Moga-White")],
        "moga-candy": [("MogaCandy", "Moga-Candy-Blue"), ("MogaCandyCaramel", "Moga-Candy-Caramel"), ("MogaCandyGreen", "Moga-Candy-Green"), ("MogaCandyGrey", "Moga-Candy-Grey")],
        "moga-colors": [("MogaColors", "Moga-Blue"), ("MogaColorsCyan", "Moga-Cyan"), ("MogaColorsGreen", "Moga-Green"), ("MogaColorsGrey", "Moga-Grey")],
        "moga-neon": [("MogaNeon", "Moga-Neon-Blue"), ("MogaNeonButter", "Moga-Neon-Butter"), ("MogaNeonCyan", "Moga-Neon-Cyan"), ("MogaNeonGreen", "Moga-Neon-Green")],
        "moga-light": [("MogaLight", "Moga-Light-Blue")],
    }
    gnome_labels = {
        "remus": "Remus",
        "drop": "Drop",
        "moga-classic": "Moga Classic",
        "moga-candy": "Moga Candy",
        "moga-colors": "Moga Colors",
        "moga-neon": "Moga Neon",
        "moga-light": "Moga Light",
    }
    for root_name, variants in gnome_variants.items():
        for identifier, upstream_variant in variants:
            family = "Moga" if root_name.startswith("moga-") else gnome_labels[root_name]
            if not includes(family):
                continue
            upstream_label = _humanize(upstream_variant)
            for prefix in ("Moga ", "Remus ", "Drop "):
                if upstream_label.startswith(prefix):
                    upstream_label = upstream_label[len(prefix) :]
                    break
            if family == "Moga":
                style = gnome_labels[root_name].removeprefix("Moga ")
                if upstream_label.startswith(style + " "):
                    upstream_label = upstream_label[len(style) + 1 :]
                upstream_label = f"{style} {upstream_label}"
            jobs.append(
                Job(
                    identifier,
                    gnome_labels[root_name] if identifier in {"Remus", "Drop", "MogaClassic", "MogaCandy", "MogaColors", "MogaNeon", "MogaLight"} else upstream_variant.replace("-", " "),
                    lambda root_name=root_name, upstream_variant=upstream_variant: _gnome_variant(root_name, upstream_variant),
                    family,
                    gnome_url[root_name],
                    GNOME_LICENSE,
                    GNOME_LICENSE_URL,
                    GNOME_AUTHOR,
                    upstream_variant,
                    variant_label=upstream_label,
                )
            )

    github = "https://github.com"
    if includes("Volantes"):
        jobs.extend(
            [
            _repo_job("Volantes", "Volantes", _repo("volantes-cursors", "src", "volantes_cursors"), "Volantes", f"{github}/varlesh/volantes-cursors", "GPL-2.0-only", f"{github}/varlesh/volantes-cursors/blob/master/LICENSE", "Alexey Varfolomeev (varlesh)"),
            _repo_job("VolantesLight", "Volantes Light", _repo("volantes-cursors", "src", "volantes_light_cursors"), "Volantes", f"{github}/varlesh/volantes-cursors", "GPL-2.0-only", f"{github}/varlesh/volantes-cursors/blob/master/LICENSE", "Alexey Varfolomeev (varlesh)", "Light"),
            ]
        )
    if includes("Vimix"):
        jobs.extend(
            [
                _repo_job("Vimix", "Vimix", _repo("vimix-cursors", "src", "svg"), "Vimix", f"{github}/vinceliuice/Vimix-cursors", "GPL-3.0-only", f"{github}/vinceliuice/Vimix-cursors/blob/master/LICENSE", "Vince Liuice (vinceliuice)"),
                _repo_job("VimixWhite", "Vimix White", _repo("vimix-cursors", "src", "svg-white"), "Vimix", f"{github}/vinceliuice/Vimix-cursors", "GPL-3.0-only", f"{github}/vinceliuice/Vimix-cursors/blob/master/LICENSE", "Vince Liuice (vinceliuice)", "White"),
            ]
        )

    if includes("Qogir"):
        qogir_root = _repo("qogir-icon-theme", "src", "cursors")
        qogir_source = qogir_root / "src"
        qogir_variants = [
            ("Qogir", "svg", "Qogir", None),
            ("QogirDark", "svg-Dark", "Qogir Dark", None),
            ("QogirManjaro", "svg", "Qogir Manjaro", "#2eb398"),
            ("QogirManjaroDark", "svg-Dark", "Qogir Manjaro Dark", "#2eb398"),
            ("QogirUbuntu", "svg", "Qogir Ubuntu", "#fb8441"),
            ("QogirUbuntuDark", "svg-Dark", "Qogir Ubuntu Dark", "#fb8441"),
        ]
        for identifier, directory, label, accent in qogir_variants:
            replacements = {"#5294e2": accent} if accent else None
            jobs.append(
                _repo_job(
                    identifier,
                    label,
                    qogir_source / directory,
                    "Qogir",
                    f"{github}/vinceliuice/Qogir-icon-theme/tree/master/src/cursors",
                    "GPL-3.0-only",
                    f"{github}/vinceliuice/Qogir-icon-theme/blob/master/COPYING",
                    "Vince Liuice (vinceliuice)",
                    label,
                    loader=lambda source, replacements=replacements: frames_from_svg_config(
                        source,
                        qogir_source / "config",
                        replacements,
                    ),
                )
            )

    if includes("Bibata Extra"):
        bibata_extra = _repo("bibata-extra-cursor")
        extra_colors = {
            "DarkRed": "#B20000",
            "DodgerBlue": "#5848FF",
            "Turquoise": "#00F0B7",
            "Pink": "#FE009E",
        }
        extra_hotspots = bibata_extra / "builder/src/constants.py"
        for style in ("Original", "Modern"):
            svg_root = bibata_extra / "svg" / style.lower()
            for color_name, color in extra_colors.items():
                upstream_variant = f"Bibata-{style}-{color_name}"
                jobs.append(
                    _repo_job(
                        f"BibataExtra{style}{color_name}",
                        f"Bibata Extra {style} {_split_label(color_name)}",
                        svg_root,
                        "Bibata Extra",
                        f"{github}/ful1e5/Bibata_Extra_Cursor",
                        "GPL-3.0-only",
                        f"{github}/ful1e5/Bibata_Extra_Cursor/blob/main/LICENSE",
                        "Abdulkaiz Khatri (ful1e5)",
                        upstream_variant,
                        loader=lambda source, color=color: frames_from_svg_assets(
                            source,
                            extra_hotspots,
                            {"#00FF00": color, "#0000FF": "#FFFFFF", "#FF0000": "#000000"},
                        ),
                        strict_semantics=True,
                    ),
                )

    if includes("Google"):
        google_root = _repo("google-cursor")
        google_cycle = smil_cycle_duration(google_root / "svg/animated/wait.svg")
        google_cycles = {"wait": google_cycle, "progress": google_cycle}
        for color in ("Black", "Blue", "Red", "White"):
            jobs.append(
                _repo_job(
                    "Google" if color == "Black" else f"Google{color}",
                    "Google" if color == "Black" else f"Google {color}",
                    google_root / f"bitmaps/GoogleDot-{color}",
                    "Google",
                    f"{github}/ful1e5/Google_Cursor",
                    "GPL-3.0-only",
                    f"{github}/ful1e5/Google_Cursor/blob/main/LICENSE",
                    "Abdulkaiz Khatri (ful1e5)",
                    color,
                    loader=lambda source, config=google_root / "build.toml", cycles=google_cycles: frames_from_bitmap_config(source, config, cycles),
                    strict_semantics=True,
                )
            )

    if includes("Simp1e"):
        simp1e_root = _repo("simp1e")
        for scheme_path in sorted((simp1e_root / "src/color_schemes").glob("*.txt")):
            scheme = _pairs(scheme_path)
            display_name = scheme.get("name", scheme_path.stem)
            identifier = "Simp1e" if scheme_path.stem == "Simp1e" else slug_identifier(scheme_path.stem)
            jobs.append(
                _repo_job(
                    identifier,
                    display_name,
                    scheme_path,
                    "Simp1e",
                    "https://gitlab.com/cursors/simp1e",
                    "GPL-3.0-or-later",
                    "https://gitlab.com/cursors/simp1e/-/blob/master/LICENSE",
                    "Ács Zoltán (zoli111)",
                    display_name,
                    loader=_frames_from_simp1e,
                )
            )

    if includes("Capitaine"):
        jobs.extend([
            _repo_job("Capitaine", "Capitaine", _repo("capitaine-cursors", "src", "svg", "light"), "Capitaine", f"{github}/keeferrourke/capitaine-cursors", "LGPL-3.0-or-later", f"{github}/keeferrourke/capitaine-cursors/blob/master/COPYING", "Keefer Rourke and contributors", strict_semantics=True),
            _repo_job("CapitaineDark", "Capitaine Dark", _repo("capitaine-cursors", "src", "svg", "dark"), "Capitaine", f"{github}/keeferrourke/capitaine-cursors", "LGPL-3.0-or-later", f"{github}/keeferrourke/capitaine-cursors/blob/master/COPYING", "Keefer Rourke and contributors", "Dark", strict_semantics=True),
        ])
    if includes("Future"):
        jobs.extend([
            _repo_job("Future", "Future", _repo("Future-cursors", "src", "svg"), "Future", f"{github}/yeyushengfan258/Future-cursors", "GPL-3.0-only", f"{github}/yeyushengfan258/Future-cursors/blob/master/LICENSE", "Yeyu Shengfan (yeyushengfan258)"),
            _repo_job("FutureCyan", "Future Cyan", _repo("Future-cursors", "src", "svg-cyan"), "Future", f"{github}/yeyushengfan258/Future-cursors/tree/master/src/svg-cyan", "GPL-3.0-only", f"{github}/yeyushengfan258/Future-cursors/blob/master/LICENSE", "Yeyu Shengfan (yeyushengfan258)", "Cyan"),
        ])
    if includes("Colloid"):
        jobs.extend([
            _repo_job("Colloid", "Colloid", _repo("Colloid-icon-theme", "cursors", "src", "svg"), "Colloid", f"{github}/vinceliuice/Colloid-icon-theme/tree/main/cursors", "GPL-3.0-only", f"{github}/vinceliuice/Colloid-icon-theme/blob/main/LICENSE", "Vince Liuice (vinceliuice)"),
            _repo_job("ColloidDark", "Colloid Dark", _repo("Colloid-icon-theme", "cursors", "src", "svg-white"), "Colloid", f"{github}/vinceliuice/Colloid-icon-theme/tree/main/cursors", "GPL-3.0-only", f"{github}/vinceliuice/Colloid-icon-theme/blob/main/LICENSE", "Vince Liuice (vinceliuice)", "Dark"),
        ])

    if includes("Nordzy"):
        nordzy_root = _repo("Nordzy-cursors")
        xcursor_roots = sorted(
            path for path in (nordzy_root / "xcursors").glob("*/cursors")
            if path.is_dir()
        )
        for xcursor_source in xcursor_roots:
            xcursor_variant = xcursor_source.parent.name
            # Upstream historically published both Nordzy.cape and
            # Nordzy-cursors.cape for this same authoritative Xcursor source.
            # Preserve both curated identities without requiring Capes at
            # runtime; every other Xcursor directory maps one-to-one.
            variant_names = (
                ("Nordzy", "Nordzy-cursors")
                if xcursor_variant == "Nordzy-cursors"
                else (xcursor_variant,)
            )
            for variant_name in variant_names:
                label = variant_name.replace("-", " ").replace("cursors", "").strip()
                jobs.append(
                    _repo_job(
                        slug_identifier(variant_name),
                        label or "Nordzy",
                        xcursor_source,
                        "Nordzy",
                        f"{github}/guillaumeboehm/Nordzy-cursors",
                        "GPL-3.0-only",
                        f"{github}/guillaumeboehm/Nordzy-cursors/blob/main/COPYING",
                        "Guillaume Boehm (gboehm)",
                        variant_name,
                    )
                )

    if includes("Bibata"):
        bibata_root = _repo("Bibata_Cursor")
        render_profiles = json.loads((bibata_root / "render.json").read_text())
        for upstream_variant, profile in sorted(render_profiles.items()):
            right_handed = upstream_variant.endswith("-Right")
            config = bibata_root / "configs" / ("right" if right_handed else "normal") / "x.build.toml"
            colors = {row["match"]: row["replace"] for row in profile["colors"]}
            jobs.append(
                _repo_job(
                    slug_identifier(upstream_variant),
                    upstream_variant.replace("-", " "),
                    bibata_root / profile["dir"],
                    "Bibata",
                    f"{github}/ful1e5/Bibata_Cursor",
                    "GPL-3.0-only",
                    f"{github}/ful1e5/Bibata_Cursor/blob/master/LICENSE",
                    "Abdulkaiz Khatri (ful1e5)",
                    upstream_variant,
                    loader=lambda source, config=config, colors=colors: frames_from_svg_build_config(source, config, colors),
                    strict_semantics=True,
                )
            )
    return jobs


def _svg_number(value: str, label: str) -> float:
    match = re.fullmatch(r"\s*(-?[0-9]+(?:\.[0-9]*)?)\s*", value)
    if not match:
        raise ValueError(f"Simp1e SVG has invalid {label}={value!r}")
    return float(match.group(1))


def _svg_translate(node: ElementTree.Element) -> tuple[float, float]:
    raw = node.attrib.get("transform", "")
    if not raw:
        return 0.0, 0.0
    match = re.fullmatch(
        r"\s*translate\(\s*(-?[0-9]+(?:\.[0-9]*)?)"
        r"(?:\s*,?\s*(-?[0-9]+(?:\.[0-9]*)?))?\s*\)\s*",
        raw,
    )
    if not match:
        raise ValueError(f"unsupported Simp1e layer transform {raw!r}")
    return float(match.group(1)), float(match.group(2) or 0.0)


def _without_style_properties(style: str, removed: set[str]) -> str:
    rows = []
    for row in style.split(";"):
        name, separator, _value = row.partition(":")
        if separator and name.strip() in removed:
            continue
        if row:
            rows.append(row)
    return ";".join(rows)


def _simp1e_template(
    source: Path,
    scheme_path: Path,
) -> tuple[str, dict[str, tuple[float, float, float, float]], dict[str, tuple[float, float]]]:
    """Apply one palette and read upstream's slice/hotspot authoring layers."""

    template_colors = _pairs(source / "template_colors.txt")
    scheme = _simp1e_scheme(scheme_path)
    content = (source / "src/templates/cursors.svg").read_text()
    content = content.replace("_cursors_", scheme["name"])
    for key, template_value in template_colors.items():
        if key == "name" or key not in scheme:
            continue
        value = scheme[key]
        if key == "shadow_opacity":
            content = content.replace(
                "opacity:" + template_value,
                "opacity:" + value,
            )
        else:
            content = content.replace("#" + template_value, "#" + value)
            content = content.replace("#" + template_value.upper(), "#" + value)

    root = ElementTree.fromstring(content)
    inkscape_label = "{http://www.inkscape.org/namespaces/inkscape}label"
    layers = {
        node.attrib.get(inkscape_label): node
        for node in root.iter()
        if node.tag.rsplit("}", 1)[-1] == "g"
    }
    slices_layer = layers.get("slices")
    hotspots_layer = layers.get("hotspots")
    if slices_layer is None or hotspots_layer is None:
        raise ValueError(f"{scheme_path}: Simp1e template lacks authoring layers")
    slice_tx, slice_ty = _svg_translate(slices_layer)
    hotspot_tx, hotspot_ty = _svg_translate(hotspots_layer)

    slices: dict[str, tuple[float, float, float, float]] = {}
    for node in slices_layer.iter():
        if node.tag.rsplit("}", 1)[-1] != "rect":
            continue
        name = node.attrib.get(inkscape_label) or node.attrib.get("id")
        if not name:
            continue
        slices[name] = (
            _svg_number(node.attrib["x"], "x") + slice_tx,
            _svg_number(node.attrib["y"], "y") + slice_ty,
            _svg_number(node.attrib["width"], "width"),
            _svg_number(node.attrib["height"], "height"),
        )

    hotspots: dict[str, tuple[float, float]] = {}
    for node in hotspots_layer.iter():
        if node.tag.rsplit("}", 1)[-1] != "circle":
            continue
        label = node.attrib.get(inkscape_label) or node.attrib.get("id", "")
        if not label.startswith("hotspot."):
            continue
        name = label.removeprefix("hotspot.")
        if name not in slices:
            continue
        slice_x, slice_y, _width, _height = slices[name]
        hotspots[name] = (
            _svg_number(node.attrib["cx"], "cx") + hotspot_tx - 0.1 - slice_x,
            _svg_number(node.attrib["cy"], "cy") + hotspot_ty - 0.1 - slice_y,
        )
    if set(slices) != set(hotspots):
        missing = sorted(set(slices) - set(hotspots))
        raise ValueError(
            f"{scheme_path}: Simp1e slices lack hotspots: {', '.join(missing)}"
        )

    # Match the upstream generator's default, shadow-disabled filtering while
    # letting librsvg rasterize the whole sheet only once per output tier.
    for node in root.iter():
        if "shape-rendering" in node.attrib:
            del node.attrib["shape-rendering"]
        if "style" in node.attrib:
            node.attrib["style"] = _without_style_properties(
                node.attrib["style"],
                {"shape-rendering"},
            )
        if node.attrib.get(inkscape_label) == "shadow":
            node.attrib.pop("filter", None)
            node.attrib["style"] = _without_style_properties(
                node.attrib.get("style", ""),
                {"filter"},
            )
    return ElementTree.tostring(root, encoding="unicode"), slices, hotspots


def _simp1e_aliases(source: Path, names: Collection[str]) -> dict[str, str]:
    aliases = {name: name for name in names}
    for raw in (source / "names.txt").read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        actual, *links = line.split()
        if actual not in names:
            continue
        aliases.update({link: actual for link in links})
    return aliases


def _frames_from_simp1e(scheme_path: Path) -> dict[str, Mapping[int, list[Frame]]]:
    """Render Simp1e directly, without Python/rsvg/xcursorgen subprocesses."""

    source = _repo("simp1e")
    content, slices, hotspots = _simp1e_template(source, scheme_path)
    grouped_names: dict[str, list[tuple[int, str]]] = {}
    for name in slices:
        match = re.fullmatch(r"(.+)_([0-9]{4})", name)
        base, index = (match.group(1), int(match.group(2))) if match else (name, -1)
        grouped_names.setdefault(base, []).append((index, name))
    grouped_names = {
        base: sorted(rows, key=lambda row: (row[0], _natural_key(row[1])))
        for base, rows in grouped_names.items()
    }

    temporary = Path(tempfile.mkdtemp(prefix="cursor-simp1e-direct-"))
    raw_frames: dict[str, dict[int, list[Frame]]] = {
        base: {} for base in grouped_names
    }
    try:
        root = ElementTree.fromstring(content)
        canvas_width = _svg_number(root.attrib["width"], "canvas width")
        canvas_height = _svg_number(root.attrib["height"], "canvas height")
        for size in VECTOR_REPRESENTATION_SIZES:
            scale = size / 24.0
            pixel_width = math.ceil(canvas_width * scale)
            pixel_height = math.ceil(canvas_height * scale)
            scaled_root = ElementTree.fromstring(content)
            original_children = list(scaled_root)
            for child in original_children:
                scaled_root.remove(child)
            scaled_group = ElementTree.SubElement(
                scaled_root,
                "{http://www.w3.org/2000/svg}g",
                {"transform": f"scale({scale:.17g})"},
            )
            scaled_group.extend(original_children)
            scaled_root.set("width", str(pixel_width))
            scaled_root.set("height", str(pixel_height))
            scaled_root.set("viewBox", f"0 0 {pixel_width} {pixel_height}")
            svg_path = temporary / f"sheet-{size}.svg"
            svg_path.write_text(ElementTree.tostring(scaled_root, encoding="unicode"))
            rendered_path = temporary / f"sheet-{size}.png"
            render_svg_file(
                svg_path,
                pixel_width,
                rendered_path,
                height=pixel_height,
            )
            with Image.open(rendered_path) as rendered:
                sheet = rendered.convert("RGBA")
            for base, rows in grouped_names.items():
                frames: list[Frame] = []
                for index, name in rows:
                    x, y, width, height = slices[name]
                    left, top = round(x * scale), round(y * scale)
                    frame_width, frame_height = round(width * scale), round(height * scale)
                    if (frame_width, frame_height) != (size, size):
                        raise ValueError(
                            f"{scheme_path}: {name} is not a 24px square slice"
                        )
                    hot_x, hot_y = hotspots[name]
                    frames.append(
                        Frame(
                            sheet.crop((left, top, left + size, top + size)),
                            round(hot_x * scale),
                            round(hot_y * scale),
                            round(1000.0 / 30.0) if index >= 0 else None,
                            size,
                        )
                    )
                raw_frames[base][size] = frames
    finally:
        shutil.rmtree(temporary, ignore_errors=True)

    selected: dict[str, tuple[int, Mapping[int, list[Frame]]]] = {}
    aliases = _simp1e_aliases(source, raw_frames)
    for alias, actual in sorted(aliases.items()):
        role = canonical_role(alias)
        priority = _xcursor_role_priority(alias)
        if selected.get(role, (-1, {}))[0] >= priority:
            continue
        selected[role] = (priority, raw_frames[actual])
    return {role: frames for role, (_priority, frames) in selected.items()}


def _pairs(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        values[key.strip()] = value.strip()
    return values


def _simp1e_scheme(path: Path) -> dict[str, str]:
    """Read one palette while normalizing a known upstream delimiter typo."""

    values = _pairs(path)
    for key, raw_value in list(values.items()):
        if key in {"name", "shadow_opacity"}:
            continue
        # The three Rose Pine palettes append a second ``:`` to spinner_bg.
        # Treat it as a delimiter typo, then reject any other malformed color
        # before it can be substituted into the SVG as an invalid hex value.
        value = raw_value.removesuffix(":")
        if not re.fullmatch(r"[0-9a-fA-F]{6}", value):
            raise ValueError(f"{path}: invalid Simp1e color {key}={raw_value!r}")
        values[key] = value
    return values


def _oreo_manifest_entries(output: Path) -> list[dict[str, Any]]:
    """Add preview metadata for built-ins without duplicating their resources."""

    theme_root = ROOT.parent / "oreo/Resources/Themes"
    catalog = json.loads((theme_root / "catalog.json").read_text())
    catalog_themes = catalog.get("themes")
    if (
        catalog.get("schemaVersion") != 1
        or not isinstance(catalog_themes, list)
        or catalog.get("defaultThemeId")
        not in {theme.get("nativeThemeId") for theme in catalog_themes}
    ):
        raise ValueError("built-in Oreo catalog has an unsupported schema")
    common_fields = {
        "Author": str(catalog["author"]),
        "Group": str(catalog["family"]),
        "License": str(catalog["license"]),
        "LicenseURL": str(catalog["licenseUrl"]),
        "SourceURL": str(catalog["upstreamUrl"]),
    }
    entries: list[dict[str, Any]] = []
    for catalog_theme in catalog_themes:
        theme_path = theme_root / str(catalog_theme["resourceFile"])
        theme = plistlib.loads(theme_path.read_bytes())
        identifier = str(catalog_theme["nativeThemeId"])
        theme_name = str(catalog_theme["plistName"])
        variant_label = str(catalog_theme["name"])
        digest = hashlib.sha256(theme_path.read_bytes()).hexdigest()
        if (
            theme.get("Identifier") != identifier
            or theme.get("ThemeName") != theme_name
            or theme.get("UUID") != catalog_theme["uuid"]
            or digest != catalog_theme["sha256"]
        ):
            raise ValueError(f"{identifier}: cursor resource differs from catalog.json")
        entry: dict[str, Any] = {
            **common_fields,
            "DisplayName": f"{catalog['family']} {variant_label}",
            "Identifier": identifier,
            "Resource": theme_path.name,
            "SHA256": digest,
            "ThemeName": theme_name,
            "UpstreamVariant": theme_name,
            "UUID": str(catalog_theme["uuid"]),
            "Variant": variant_label,
            "VariantLabel": variant_label,
        }
        entry.update(
            export_theme_previews(
                theme_path,
                output / "previews",
                manifest_root=output,
            )
        )
        validate_theme(theme_path)
        validate_preview_entry(entry, output)
        entries.append(entry)
    if len(entries) != 19:
        raise ValueError(f"expected 19 built-in Oreo themes, found {len(entries)}")
    return entries


def _validate_direct_roles(entry: dict[str, Any], roles: tuple[str, ...]) -> None:
    rows = entry.get("rolePreviews", [])
    for role in roles:
        matching = [row for row in rows if row.get("role") == role]
        if not matching or all(row.get("fallback") for row in matching):
            raise ValueError(f"{entry['Identifier']}: required source role {role} fell back to default")


def _validate_corpus(
    manifest: list[dict[str, Any]],
    output: Path,
    external_job_count: int,
) -> None:
    oreo_catalog = json.loads(
        (ROOT.parent / "oreo/Resources/Themes/catalog.json").read_text()
    )
    oreo_family = str(oreo_catalog["family"])
    cursor_files = sorted(output.glob("*.cursor"))
    expected_external = int(INVENTORY_LOCK["externalThemeCount"])
    expected_unified = int(INVENTORY_LOCK["unifiedThemeCount"])
    if len(MAC_CURSOR_IDENTIFIERS) != int(INVENTORY_LOCK["roleCount"]):
        raise ValueError("native role inventory differs from inventory-lock.json")
    if external_job_count != expected_external or len(cursor_files) != expected_external:
        raise ValueError(
            f"expected {expected_external} external themes, got "
            f"{external_job_count} jobs and "
            f"{len(cursor_files)} resources"
        )
    if len(manifest) != expected_unified:
        raise ValueError(
            f"expected {expected_unified} unified manifest rows, got {len(manifest)}"
        )
    identifiers = [str(entry["Identifier"]) for entry in manifest]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("unified manifest contains duplicate identifiers")
    external_identifiers = [
        str(entry["Identifier"])
        for entry in manifest
        if entry["Group"] != oreo_family
    ]
    oreo_identifiers = {
        str(entry["Identifier"])
        for entry in manifest
        if entry["Group"] == oreo_family
    }
    if _identifier_digest(external_identifiers) != EXPECTED_EXTERNAL_IDENTIFIER_SHA256:
        raise ValueError(
            f"external theme inventory differs from the pinned {expected_external}-ID lock"
        )
    expected_oreo_identifiers = {
        str(theme["nativeThemeId"]) for theme in oreo_catalog["themes"]
    }
    if oreo_identifiers != expected_oreo_identifiers:
        raise ValueError("built-in Oreo inventory differs from catalog.json")
    if _identifier_digest(identifiers) != EXPECTED_UNIFIED_IDENTIFIER_SHA256:
        raise ValueError(
            f"unified theme inventory differs from the pinned {expected_unified}-ID lock"
        )
    oreo_root = ROOT.parent / "oreo/Resources/Themes"
    for entry in manifest:
        validate_preview_entry(entry, output)
        group = str(entry["Group"])
        if group not in EXPECTED_FALLBACK_COUNTS:
            raise ValueError(f"{entry['Identifier']}: unexpected family {group}")
        fallback_count = sum(
            row.get("fallback") is True for row in entry["rolePreviews"]
        )
        if fallback_count != EXPECTED_FALLBACK_COUNTS[group]:
            raise ValueError(
                f"{entry['Identifier']}: expected "
                f"{EXPECTED_FALLBACK_COUNTS[group]} role fallbacks, got "
                f"{fallback_count}"
            )
        if entry.get("Variant") != entry.get("VariantLabel"):
            raise ValueError(f"{entry['Identifier']}: inconsistent variant labels")
        if not entry.get("UpstreamVariant"):
            raise ValueError(f"{entry['Identifier']}: missing upstream variant metadata")
        resource_root = oreo_root if entry["Group"] == oreo_family else output
        resource = resource_root / str(entry["Resource"])
        if not resource.is_file():
            raise FileNotFoundError(resource)
        if hashlib.sha256(resource.read_bytes()).hexdigest() != entry["SHA256"]:
            raise ValueError(f"{entry['Identifier']}: manifest digest mismatch")

    by_identifier = {entry["Identifier"]: entry for entry in manifest}
    expected_metadata = {
        "MogaClassic": ("Moga", "Moga Classic Black", "Classic Black"),
        "BibataModernAmber": ("Bibata", "Bibata Modern Amber", "Modern Amber"),
        "BibataExtraModernDarkRed": (
            "Bibata Extra",
            "Bibata Extra Modern Dark Red",
            "Modern Dark Red",
        ),
        "NordzyCatppuccinFrappeBlue": (
            "Nordzy",
            "Nordzy Catppuccin Frappé Blue",
            "Catppuccin Frappé Blue",
        ),
        "Simp1eAdwDark": ("Simp1e", "Simp1e Adwaita Dark", "Adwaita Dark"),
    }
    for identifier, expected in expected_metadata.items():
        actual = by_identifier[identifier]
        values = (actual["Group"], actual["DisplayName"], actual["Variant"])
        if values != expected:
            raise ValueError(f"{identifier}: expected metadata {expected}, got {values}")


def convert_job(job: Job, output: Path) -> dict[str, Any]:
    """Execute one registered source recipe into one manifest root."""

    source = _path(job.source)
    if not source.exists():
        raise FileNotFoundError(source)
    output.mkdir(parents=True, exist_ok=True)
    convert = convert_frames if job.loader else convert_theme
    source_or_frames = job.loader(source) if job.loader else source
    entry = convert(
        source_or_frames,
        output / f"{job.identifier}.cursor",
        job.identifier,
        job.display_name,
        author=job.author,
        source_url=job.source_url,
        license_name=job.license,
        group=job.family,
        preview_root=output / "previews",
        manifest_root=output,
    )
    display_name, variant_label = _variant_metadata(job)
    # Keep attribution and the exact selected variant in the manifest; the
    # native validator ignores unknown optional keys, while the UI can show
    # them without inspecting binary plist resources.
    entry.update(
        {
            "Author": job.author,
            "DisplayName": display_name,
            "SourceURL": job.source_url,
            "License": job.license,
            "LicenseURL": job.license_url,
            "Group": job.family,
            "UpstreamVariant": job.variant or job.display_name,
            "Variant": variant_label,
            "VariantLabel": variant_label,
        }
    )
    validate_theme(
        output / f"{job.identifier}.cursor",
        required_animated_roles=("wait", "progress") if job.strict_semantics else (),
    )
    validate_preview_entry(entry, output)
    if job.strict_semantics:
        _validate_direct_roles(entry, ("default", "wait", "progress"))
    return entry


def _build_into(output: Path) -> list[dict[str, Any]]:
    output.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, Any]] = []
    jobs = _jobs()
    seen: set[str] = set()
    for index, job in enumerate(jobs, 1):
        if job.identifier in seen:
            raise ValueError(f"duplicate theme identifier {job.identifier}")
        seen.add(job.identifier)
        source = _path(job.source)
        print(f"[{index:02d}/{len(jobs):02d}] {job.identifier} <- {source}", flush=True)
        manifest.append(convert_job(job, output))

    manifest.extend(_oreo_manifest_entries(output))
    manifest.sort(key=lambda item: item["Identifier"])
    _validate_corpus(manifest, output, len(jobs))
    (output / "manifest.json").write_text(
        json.dumps(
            {
                "roleCount": int(INVENTORY_LOCK["roleCount"]),
                "schemaVersion": 2,
                "themes": manifest,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    return manifest


def _safe_generated_sibling(path: Path, prefix: str) -> bool:
    return path.parent == ROOT and path.name.startswith(prefix) and not path.is_symlink()


def _promote(staging: Path) -> None:
    if not _safe_generated_sibling(staging, ".generated-staging-"):
        raise ValueError(f"refusing unexpected staging directory {staging}")
    previous = ROOT / ".generated-previous"
    if previous.exists() or previous.is_symlink():
        raise ValueError(f"refusing promotion while recovery directory exists: {previous}")
    if OUTPUT.is_symlink() or (OUTPUT.exists() and not OUTPUT.is_dir()):
        raise ValueError(f"refusing unexpected output path {OUTPUT}")
    had_previous = OUTPUT.is_dir()
    if had_previous:
        OUTPUT.rename(previous)
    try:
        staging.rename(OUTPUT)
    except BaseException:
        if had_previous and previous.is_dir() and not OUTPUT.exists():
            previous.rename(OUTPUT)
        raise
    if had_previous:
        shutil.rmtree(previous)


def build() -> list[dict[str, Any]]:
    verify_build_cache(_cache_root())
    staging = Path(tempfile.mkdtemp(prefix=".generated-staging-", dir=ROOT))
    try:
        manifest = _build_into(staging)
        _promote(staging)
    finally:
        if staging.exists():
            if not _safe_generated_sibling(staging, ".generated-staging-"):
                raise ValueError(f"refusing unexpected cleanup path {staging}")
            shutil.rmtree(staging)
    print(f"Built {len(manifest)} themes in {OUTPUT}")
    return manifest


if __name__ == "__main__":
    try:
        build()
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"build_all: {exc}", file=sys.stderr)
        raise SystemExit(2)
