#!/usr/bin/env python3
"""Selective, self-contained curated source conversion worker.

The released Electron process drives this executable over JSON Lines.  It
acquires and verifies source archives separately, then passes their normalized
cache root here.  Every completed variant is atomically exposed as one native
import artifact so the application can install it immediately while the rest
of a family continues converting.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

import build_all
import oreo_recipe
import xcursor_encoder
from PIL import Image, __version__ as PILLOW_VERSION


SAFE_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
CATALOG_PATH = Path(__file__).resolve().parent / "curated-family-catalog.json"


@dataclass(frozen=True)
class RuntimeVariant:
    family_id: str
    family: str
    identifier: str
    display_name: str
    variant: str
    convert: Callable[[Path], dict[str, Any]]


def _emit(event: str, **values: Any) -> None:
    sys.stdout.write(
        json.dumps({"type": event, **values}, separators=(",", ":")) + "\n"
    )
    sys.stdout.flush()


def catalog_document() -> dict[str, Any]:
    document = json.loads(CATALOG_PATH.read_text())
    families = document.get("families")
    if (
        document.get("schemaVersion") != 1
        or not isinstance(families, list)
        or [row.get("id") for row in families]
        != list(build_all.FAMILY_ID_TO_NAME)
    ):
        raise ValueError("the curated family catalog has an unsupported schema")
    lines: list[str] = []
    identifiers: set[str] = set()
    for family in families:
        family_id = family.get("id")
        if family.get("name") != build_all.FAMILY_ID_TO_NAME[family_id]:
            raise ValueError(f"{family_id}: curated family name differs from recipes")
        variants = family.get("variants")
        if not isinstance(variants, list) or not variants:
            raise ValueError(f"{family_id}: curated family has no variants")
        for variant in variants:
            identifier = variant.get("identifier")
            display_name = variant.get("displayName")
            variant_name = variant.get("variant")
            if (
                not isinstance(identifier, str)
                or not SAFE_IDENTIFIER.fullmatch(identifier)
                or identifier in identifiers
                or not isinstance(display_name, str)
                or not display_name
                or not isinstance(variant_name, str)
                or not variant_name
            ):
                raise ValueError(f"{family_id}: curated variant metadata is invalid")
            identifiers.add(identifier)
            lines.append(
                f"{family_id}\0{identifier}\0{display_name}\0{variant_name}\n"
            )
    digest = hashlib.sha256("".join(lines).encode()).hexdigest()
    if (
        document.get("themeCount") != len(identifiers)
        or document.get("themeCount") != 240
        or document.get("sha256") != digest
    ):
        raise ValueError("the curated family catalog digest is invalid")
    return document


def _catalog_family(family_id: str) -> dict[str, Any]:
    return next(
        family
        for family in catalog_document()["families"]
        if family["id"] == family_id
    )


def self_test_document() -> dict[str, Any]:
    """Verify frozen catalog data and Pillow's native imaging extension."""

    catalog = catalog_document()
    encoded = io.BytesIO()
    expected = bytes((255, 0, 0, 255, 0, 128, 255, 64))
    Image.frombytes("RGBA", (2, 1), expected).save(encoded, format="PNG")
    encoded.seek(0)
    with Image.open(encoded) as decoded:
        actual = decoded.convert("RGBA").tobytes()
    if actual != expected:
        raise RuntimeError("the packaged Pillow runtime failed its PNG self-test")
    return {
        "ok": True,
        "catalogSha256": catalog["sha256"],
        "themeCount": catalog["themeCount"],
        "roleCount": len(build_all.MAC_CURSOR_IDENTIFIERS),
        "pillowVersion": PILLOW_VERSION,
        "xcursorEncoderVersion": xcursor_encoder.self_test(),
    }


def _ordered_unique(values: Iterable[str], label: str) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise ValueError(f"duplicate {label}: {value}")
        seen.add(value)
        result.append(value)
    return result


def _external_variants(family_id: str) -> list[RuntimeVariant]:
    family = build_all.FAMILY_ID_TO_NAME[family_id]
    jobs = build_all._jobs({family})
    variants: list[RuntimeVariant] = []
    for job in jobs:
        variants.append(
            RuntimeVariant(
                family_id,
                family,
                job.identifier,
                build_all._variant_metadata(job)[0],
                build_all._variant_metadata(job)[1],
                lambda output, job=job: build_all.convert_job(job, output),
            )
        )
    return variants


def _oreo_variants(source_root: Path, work_root: Path) -> list[RuntimeVariant]:
    upstream = source_root / "oreo-cursors"
    prepared = oreo_recipe.prepare_oreo_source(upstream, work_root / "oreo-prepared")
    return [
        RuntimeVariant(
            "oreo",
            "Oreo",
            "Oreo" + "".join(word.capitalize() for word in variant.split("_")),
            f"Oreo {label}",
            label,
            lambda output, variant=variant, label=label: oreo_recipe.convert_oreo_variant(
                prepared,
                variant,
                label,
                output,
            ),
        )
        for variant, label in oreo_recipe.OREO_VARIANTS
    ]


def plan_variants(
    family_ids: Iterable[str],
    source_root: Path,
    work_root: Path,
) -> dict[str, list[RuntimeVariant]]:
    """Resolve selected recipes without enumerating any unrelated source."""

    selected = _ordered_unique(family_ids, "family")
    unknown = [value for value in selected if value not in build_all.FAMILY_ID_TO_NAME]
    if unknown:
        raise ValueError(f"unknown curated families: {', '.join(unknown)}")
    result: dict[str, list[RuntimeVariant]] = {}
    for family_id in selected:
        variants = (
            _oreo_variants(source_root, work_root)
            if family_id == "oreo"
            else _external_variants(family_id)
        )
        catalog_family = _catalog_family(family_id)
        expected_rows = catalog_family["variants"]
        by_identifier = {variant.identifier: variant for variant in variants}
        if len(by_identifier) != len(variants) or set(by_identifier) != {
            row["identifier"] for row in expected_rows
        }:
            raise ValueError(
                f"{family_id}: acquired recipes differ from the locked catalog"
            )
        ordered = [by_identifier[row["identifier"]] for row in expected_rows]
        for expected, actual in zip(expected_rows, ordered):
            if (
                expected["displayName"] != actual.display_name
                or expected["variant"] != actual.variant
            ):
                raise ValueError(
                    f"{family_id}/{actual.identifier}: recipe metadata differs "
                    "from the locked catalog"
                )
        result[family_id] = ordered
    return result


def _write_manifest(
    artifact_root: Path,
    family_id: str,
    entry: dict[str, Any],
) -> tuple[Path, dict[str, Any]]:
    entry = {
        **entry,
        "CuratedCatalogSHA256": catalog_document()["sha256"],
        "CuratedFamilyId": family_id,
        "SourceFormat": "curated-source",
    }
    manifest_path = artifact_root / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "roleCount": len(build_all.MAC_CURSOR_IDENTIFIERS),
                "schemaVersion": 2,
                "themes": [entry],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    return manifest_path, entry


def _make_private(root: Path) -> None:
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        if current_path.is_symlink():
            raise ValueError(f"generated artifact contains a symlink: {current_path}")
        os.chmod(current_path, stat.S_IRWXU)
        for name in directories:
            path = current_path / name
            if path.is_symlink():
                raise ValueError(f"generated artifact contains a symlink: {path}")
            os.chmod(path, stat.S_IRWXU)
        for name in files:
            path = current_path / name
            if path.is_symlink() or not path.is_file():
                raise ValueError(f"generated artifact contains an unsafe file: {path}")
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def _safe_remove_work(path: Path, parent: Path, prefix: str) -> None:
    if (
        path.parent != parent
        or not path.name.startswith(prefix)
        or path.is_symlink()
    ):
        raise ValueError(f"refusing unexpected conversion cleanup path: {path}")
    if path.exists():
        shutil.rmtree(path)


def _convert_artifact(
    variant: RuntimeVariant,
    output_root: Path,
) -> tuple[Path, Path, dict[str, Any]]:
    final = output_root / variant.identifier
    if final.exists() or final.is_symlink():
        raise FileExistsError(f"artifact already exists: {final}")
    staging = output_root / f".{variant.identifier}.staging-{uuid.uuid4().hex}"
    if not SAFE_IDENTIFIER.fullmatch(variant.identifier):
        raise ValueError(f"unsafe generated identifier: {variant.identifier}")
    staging.mkdir(mode=0o700)
    try:
        entry = variant.convert(staging)
        if entry.get("Identifier") != variant.identifier:
            raise ValueError(
                f"{variant.identifier}: recipe returned {entry.get('Identifier')!r}"
            )
        manifest_path, entry = _write_manifest(staging, variant.family_id, entry)
        build_all.validate_preview_entry(entry, staging)
        _make_private(staging)
        staging.rename(final)
        return final, final / manifest_path.name, entry
    except BaseException:
        if staging.exists():
            _safe_remove_work(staging, output_root, f".{variant.identifier}.staging-")
        raise


def convert(
    *,
    source_root: Path,
    output_root: Path,
    family_ids: Iterable[str],
    skip_identifiers: Iterable[str] = (),
    renderer: str = "stdio",
) -> None:
    source_root = source_root.expanduser().resolve(strict=True)
    if not source_root.is_dir():
        raise NotADirectoryError(source_root)
    output_root = output_root.expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if output_root.is_symlink() or not output_root.is_dir():
        raise NotADirectoryError(output_root)
    os.chmod(output_root, stat.S_IRWXU)

    work_root = output_root / f".work-{uuid.uuid4().hex}"
    work_root.mkdir(mode=0o700)
    previous_tempdir = tempfile.tempdir
    tempfile.tempdir = str(work_root)
    previous_cache = os.environ.get("CURSOR_SOURCE_CACHE")
    previous_renderer = os.environ.get("CURSOR_SVG_RENDERER")
    os.environ["CURSOR_SOURCE_CACHE"] = str(source_root)
    if renderer == "stdio":
        os.environ["CURSOR_SVG_RENDERER"] = "stdio"
    else:
        os.environ.pop("CURSOR_SVG_RENDERER", None)

    current: RuntimeVariant | None = None
    try:
        catalog = catalog_document()
        _emit("catalog", **catalog)
        plans = plan_variants(family_ids, source_root, work_root)
        all_variants = [variant for variants in plans.values() for variant in variants]
        identifiers = {variant.identifier for variant in all_variants}
        skipped = set(_ordered_unique(skip_identifiers, "skipped identifier"))
        unknown_skips = sorted(skipped - identifiers)
        if unknown_skips:
            raise ValueError(
                f"skip identifiers are outside the selected families: {', '.join(unknown_skips)}"
            )
        completed_identifiers = [
            variant.identifier for variant in all_variants if variant.identifier in skipped
        ]
        total = len(all_variants)
        _emit(
            "conversion-started",
            familyIds=list(plans),
            total=total,
            completed=len(completed_identifiers),
            completedIdentifiers=completed_identifiers,
            progress=len(completed_identifiers) / total if total else 1.0,
            catalogSha256=catalog["sha256"],
        )
        overall_index = 0
        for family_id, variants in plans.items():
            family_completed = sum(
                variant.identifier in skipped for variant in variants
            )
            for family_index, variant in enumerate(variants, 1):
                overall_index += 1
                if variant.identifier in skipped:
                    continue
                current = variant
                common = {
                    "familyId": family_id,
                    "family": variant.family,
                    "identifier": variant.identifier,
                    "displayName": variant.display_name,
                    "variant": variant.variant,
                    "familyIndex": family_index,
                    "familyTotal": len(variants),
                    "overallIndex": overall_index,
                    "total": total,
                    "completedIdentifiers": completed_identifiers,
                }
                _emit(
                    "variant-started",
                    **common,
                    progress=len(completed_identifiers) / total,
                    familyProgress=family_completed / len(variants),
                )
                artifact, manifest, entry = _convert_artifact(variant, output_root)
                completed_identifiers.append(variant.identifier)
                family_completed += 1
                _emit(
                    "variant-complete",
                    **{**common, "completedIdentifiers": completed_identifiers},
                    artifactDirectory=str(artifact),
                    manifestPath=str(manifest),
                    entry=entry,
                    progress=len(completed_identifiers) / total,
                    familyProgress=family_completed / len(variants),
                )
                current = None
            _emit(
                "family-complete",
                familyId=family_id,
                family=build_all.FAMILY_ID_TO_NAME[family_id],
                total=len(variants),
                completed=family_completed,
                completedIdentifiers=completed_identifiers,
                progress=len(completed_identifiers) / total if total else 1.0,
            )
        _emit(
            "done",
            total=total,
            completed=len(completed_identifiers),
            completedIdentifiers=completed_identifiers,
            progress=1.0,
            catalogSha256=catalog["sha256"],
        )
    except BaseException as exc:
        _emit(
            "failed",
            familyId=current.family_id if current else None,
            family=current.family if current else None,
            identifier=current.identifier if current else None,
            displayName=current.display_name if current else None,
            variant=current.variant if current else None,
            error=str(exc).strip() or exc.__class__.__name__,
        )
        raise
    finally:
        tempfile.tempdir = previous_tempdir
        if previous_cache is None:
            os.environ.pop("CURSOR_SOURCE_CACHE", None)
        else:
            os.environ["CURSOR_SOURCE_CACHE"] = previous_cache
        if previous_renderer is None:
            os.environ.pop("CURSOR_SVG_RENDERER", None)
        else:
            os.environ["CURSOR_SVG_RENDERER"] = previous_renderer
        _safe_remove_work(work_root, output_root, ".work-")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="curated-cursor-converter")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("catalog")
    subparsers.add_parser("self-test")
    encode = subparsers.add_parser("encode-xcursor")
    encode.add_argument("--manifest", type=Path, required=True)
    encode.add_argument("--output-root", type=Path, required=True)
    command = subparsers.add_parser("convert")
    command.add_argument("--source-root", type=Path, required=True)
    command.add_argument("--output-root", type=Path, required=True)
    command.add_argument("--family", action="append", required=True)
    command.add_argument("--skip-identifier", action="append", default=[])
    command.add_argument(
        "--renderer",
        choices=("stdio", "native"),
        default="stdio",
        help="native is for source-tree development only",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "catalog":
            _emit("catalog", **catalog_document())
            return 0
        if args.command == "self-test":
            _emit("self-test", **self_test_document())
            return 0
        if args.command == "encode-xcursor":
            xcursor_encoder.encode_theme(args.manifest, args.output_root)
            return 0
        convert(
            source_root=args.source_root,
            output_root=args.output_root,
            family_ids=args.family,
            skip_identifiers=args.skip_identifier,
            renderer=args.renderer,
        )
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"curated-cursor-converter: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
