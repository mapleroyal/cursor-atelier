"""Checks for the deterministic source-acquisition lock set."""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
import zipfile
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
