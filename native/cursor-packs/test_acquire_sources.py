"""Checks for the deterministic source-acquisition lock set."""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
import zipfile
from unittest.mock import MagicMock, patch
from pathlib import Path

import acquire_sources


class AcquisitionLockTests(unittest.TestCase):
    def test_all_git_sources_are_uniquely_pinned(self) -> None:
        entries = acquire_sources._git_sources()
        self.assertEqual(len(entries), 11)
        self.assertEqual(len({entry["directory"] for entry in entries}), 11)
        for entry in entries:
            self.assertRegex(entry["revision"], r"^[0-9a-f]{40}$")
            self.assertTrue(entry["repository"].endswith(".git"))
            self.assertTrue(entry["inputs"])

    def test_gnome_archives_have_sha256_locks(self) -> None:
        lock = json.loads(
            (acquire_sources.LOCKS / "gnome-look-sources.json").read_text()
        )
        archives = [
            (name, digest)
            for product in lock["products"]
            for name, digest in product["archives"].items()
        ]
        self.assertEqual(len(archives), 23)
        for name, digest in archives:
            self.assertTrue(name.endswith(".zip"))
            self.assertTrue(re.fullmatch(r"[0-9a-f]{64}", digest))

    def test_expanded_archive_integrity_rejects_partial_or_modified_trees(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "theme.zip"
            expanded = root / "expanded"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("Theme/cursors/default", b"cursor")
                bundle.writestr("Theme/index.theme", b"[Icon Theme]\n")
            acquire_sources._extract_zip(archive, expanded)
            acquire_sources._verify_expanded_zip(archive, expanded)
            (expanded / "Theme/index.theme").write_text("modified")
            with self.assertRaisesRegex(ValueError, "does not match"):
                acquire_sources._verify_expanded_zip(archive, expanded)

    def test_gnome_downloads_select_the_pinned_archived_revision(self) -> None:
        source = next(
            entry
            for entry in acquire_sources._json(acquire_sources.LOCKS / "curated-source-catalog.json")["sources"]
            if entry.get("productId") == 2302110
        )
        data = {"id": 2302110}
        for index, archive in enumerate(source["archives"], 101):
            data[f"downloadname{index}"] = archive["name"]
            data[f"downloadmd5sum{index}"] = archive["upstreamMd5"]
            data[f"downloadlink{index}"] = f"https://example.test/pinned-{index}.zip"
        data.update({
            "downloadname201": source["archives"][0]["name"],
            "downloadmd5sum201": "f" * 32,
            "downloadlink201": "https://example.test/replacement.zip",
        })
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({"data": [data]})
        with patch.object(acquire_sources.urllib.request, "urlopen", return_value=response) as fetch:
            downloads = acquire_sources._ocs_downloads(2302110)
        self.assertEqual(downloads[source["archives"][0]["name"]], "https://example.test/pinned-101.zip")
        self.assertIn("/2302110/archived?format=json", fetch.call_args.args[0].full_url)

        del data["downloadmd5sum101"]
        response.__enter__.return_value.read.return_value = json.dumps({"data": [data]})
        with patch.object(acquire_sources.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "no longer lists the pinned revision"):
                acquire_sources._ocs_downloads(2302110)

    def test_git_verification_rejects_dirty_build_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.email", "test@example.invalid"],
                cwd=root,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Cursor Test"],
                cwd=root,
                check=True,
            )
            source = root / "cursor.svg"
            source.write_text("clean")
            subprocess.run(["git", "add", "cursor.svg"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "--quiet", "-m", "fixture"],
                cwd=root,
                check=True,
            )
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=root, text=True
            ).strip()
            entry = {
                "directory": "fixture",
                "inputs": ["cursor.svg"],
                "repository": "fixture.git",
                "revision": revision,
            }
            acquire_sources._verify_git_checkout(entry, root, all_paths=False)
            source.write_text("dirty")
            with self.assertRaisesRegex(ValueError, "dirty build inputs"):
                acquire_sources._verify_git_checkout(entry, root, all_paths=False)


if __name__ == "__main__":
    unittest.main()
