"""Focused contract tests for the packaged curated conversion worker."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import curated_runtime


class CuratedRuntimeTests(unittest.TestCase):
    def test_fast_catalog_locks_every_family_and_identifier(self) -> None:
        catalog = curated_runtime.catalog_document()
        self.assertEqual(catalog["themeCount"], 240)
        self.assertRegex(catalog["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            [family["id"] for family in catalog["families"]],
            [
                "oreo",
                "remus",
                "drop",
                "moga",
                "volantes",
                "vimix",
                "qogir",
                "bibata-extra",
                "google",
                "simp1e",
                "capitaine",
                "future",
                "nordzy",
                "colloid",
                "bibata",
            ],
        )
        self.assertEqual(
            [len(family["variants"]) for family in catalog["families"]],
            [19, 3, 4, 16, 2, 2, 6, 8, 4, 25, 2, 2, 133, 2, 12],
        )
        identifiers = [
            variant["identifier"]
            for family in catalog["families"]
            for variant in family["variants"]
        ]
        self.assertEqual(len(identifiers), len(set(identifiers)))
        self.assertEqual(len(identifiers), 240)

    def test_resume_skips_completed_identifiers_and_reports_exact_set(self) -> None:
        first = curated_runtime.RuntimeVariant(
            "remus", "Remus", "First", "Remus First", "First", mock.Mock()
        )
        second = curated_runtime.RuntimeVariant(
            "remus", "Remus", "Second", "Remus Second", "Second", mock.Mock()
        )
        catalog = curated_runtime.catalog_document()
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as output:
            events = io.StringIO()

            def artifact(variant, output_root):
                root = output_root / variant.identifier
                root.mkdir()
                manifest = root / "manifest.json"
                manifest.write_text("{}")
                return root, manifest, {"Identifier": variant.identifier}

            with (
                mock.patch.object(
                    curated_runtime,
                    "plan_variants",
                    return_value={"remus": [first, second]},
                ),
                mock.patch.object(curated_runtime, "catalog_document", return_value=catalog),
                mock.patch.object(curated_runtime, "_convert_artifact", side_effect=artifact),
                contextlib.redirect_stdout(events),
            ):
                curated_runtime.convert(
                    source_root=Path(source),
                    output_root=Path(output),
                    family_ids=["remus"],
                    skip_identifiers=["First"],
                    renderer="native",
                )

        decoded = [json.loads(line) for line in events.getvalue().splitlines()]
        self.assertEqual(
            [event["type"] for event in decoded],
            [
                "catalog",
                "conversion-started",
                "variant-started",
                "variant-complete",
                "family-complete",
                "done",
            ],
        )
        self.assertEqual(decoded[2]["identifier"], "Second")
        self.assertEqual(decoded[-1]["completedIdentifiers"], ["First", "Second"])
        self.assertEqual(decoded[-1]["catalogSha256"], catalog["sha256"])
        self.assertFalse(first.convert.called)

    def test_source_free_self_test_exercises_the_imaging_runtime(self) -> None:
        result = curated_runtime.self_test_document()
        self.assertTrue(result["ok"])
        self.assertEqual(result["themeCount"], 240)
        self.assertEqual(result["roleCount"], 47)
        self.assertEqual(
            result["catalogSha256"],
            curated_runtime.catalog_document()["sha256"],
        )

    def test_plan_rejects_a_count_preserving_identifier_substitution(self) -> None:
        family = curated_runtime._catalog_family("remus")
        variants = [
            curated_runtime.RuntimeVariant(
                "remus",
                "Remus",
                row["identifier"],
                row["displayName"],
                row["variant"],
                mock.Mock(),
            )
            for row in family["variants"]
        ]
        variants[-1] = curated_runtime.RuntimeVariant(
            "remus", "Remus", "Substituted", "Remus White", "White", mock.Mock()
        )
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as work:
            with mock.patch.object(
                curated_runtime, "_external_variants", return_value=variants
            ):
                with self.assertRaisesRegex(ValueError, "locked catalog"):
                    curated_runtime.plan_variants(
                        ["remus"], Path(source), Path(work)
                    )

    def test_manifest_stamps_the_exact_curated_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as output:
            manifest, entry = curated_runtime._write_manifest(
                Path(output),
                "remus",
                {"Identifier": "Remus"},
            )
            self.assertEqual(entry["CuratedFamilyId"], "remus")
            self.assertEqual(entry["SourceFormat"], "curated-source")
            self.assertEqual(
                entry["CuratedCatalogSHA256"],
                curated_runtime.catalog_document()["sha256"],
            )
            self.assertEqual(
                json.loads(manifest.read_text())["themes"][0],
                entry,
            )

    def test_conversion_restores_process_temp_and_environment(self) -> None:
        previous_tempdir = tempfile.tempdir
        previous_cache = os.environ.get("CURSOR_SOURCE_CACHE")
        previous_renderer = os.environ.get("CURSOR_SVG_RENDERER")
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as output:
            previous_tempdir = tempfile.tempdir
            with (
                mock.patch.object(
                    curated_runtime, "plan_variants", return_value={"remus": []}
                ),
                mock.patch.object(
                    curated_runtime,
                    "catalog_document",
                    return_value={
                        "schemaVersion": 1,
                        "themeCount": 240,
                        "sha256": "0" * 64,
                        "families": [],
                    },
                ),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                curated_runtime.convert(
                    source_root=Path(source),
                    output_root=Path(output),
                    family_ids=["remus"],
                    renderer="stdio",
                )
            self.assertFalse(
                any(path.name.startswith(".work-") for path in Path(output).iterdir())
            )
        self.assertEqual(tempfile.tempdir, previous_tempdir)
        self.assertEqual(os.environ.get("CURSOR_SOURCE_CACHE"), previous_cache)
        self.assertEqual(os.environ.get("CURSOR_SVG_RENDERER"), previous_renderer)


if __name__ == "__main__":
    unittest.main()
