#!/usr/bin/env python3
"""Acquire or verify the ignored, pinned cursor-source cache."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent
LOCKS = ROOT / "sources"
DEFAULT_CACHE = LOCKS / "cache"


def _json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return value


def _git_sources() -> list[dict[str, Any]]:
    sources: dict[str, dict[str, Any]] = {}
    for entry in _json(LOCKS / "pinned-sources.json")["sources"]:
        sources[entry["directory"]] = {
            "directory": entry["directory"],
            "inputs": sorted(
                set(entry.get("assetRoots", []) + entry.get("buildInputs", []))
            ),
            "repository": entry["repository"],
            "revision": entry["revision"],
        }
    for entry in _json(LOCKS / "github-pack-provenance.json")["entries"]:
        repository_path = entry.get("repositoryPath") or entry["sourcePath"]
        marker = "native/cursor-packs/sources/"
        relative = repository_path.split(marker, 1)[-1]
        directory = relative.split("/", 1)[0]
        source_path = entry["sourcePath"].split(marker, 1)[-1]
        source_prefix = source_path.split("/", 1)[1] if "/" in source_path else ""
        inputs: list[str] = []
        for root in entry.get("assetRoots", []):
            for key in ("source", "animatedSource", "svgSource", "generated"):
                value = root.get(key)
                if value:
                    inputs.append(str(Path(source_prefix) / value))
        for key in (
            "buildConfig",
            "hotspotConfig",
            "sharedConfig",
            "sharedSource",
        ):
            value = entry.get(key)
            if value:
                inputs.append(str(Path(source_prefix) / value))
        for value in entry.get("variantConfig", []):
            inputs.append(str(Path(source_prefix) / value))
        sources[directory] = {
            "directory": directory,
            "inputs": sorted(set(inputs)),
            "repository": entry["sourceUrl"].split("/tree/", 1)[0].rstrip("/") + ".git",
            "revision": entry["revision"],
        }
    return [sources[key] for key in sorted(sources)]


def _run(*arguments: str, cwd: Path | None = None) -> str:
    result = subprocess.run(
        arguments,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _verify_git_checkout(
    entry: dict[str, Any], destination: Path, *, all_paths: bool
) -> None:
    if destination.is_symlink() or not (destination / ".git").is_dir():
        raise ValueError(f"{destination}: is not a complete Git checkout")
    try:
        actual = _run("git", "rev-parse", "--verify", "HEAD", cwd=destination)
    except subprocess.CalledProcessError as error:
        raise ValueError(f"{destination}: has no checked-out revision") from error
    if actual != entry["revision"]:
        raise ValueError(
            f"{destination}: expected {entry['revision']}, found {actual}; "
            "use a clean cache directory rather than mutating it"
        )
    inputs = [] if all_paths else list(entry["inputs"])
    arguments = ["git", "status", "--porcelain=v1", "--untracked-files=all"]
    if inputs:
        arguments.extend(["--", *inputs])
    dirty = _run(*arguments, cwd=destination)
    if dirty:
        scope = "worktree" if all_paths else "build inputs"
        first = dirty.splitlines()[0]
        raise ValueError(f"{destination}: dirty {scope} ({first})")
    for relative in inputs:
        if not (destination / relative).exists():
            raise FileNotFoundError(destination / relative)


def _safe_temporary(path: Path, parent: Path, prefix: str) -> bool:
    return (
        path.parent == parent
        and path.name.startswith(prefix)
        and not path.is_symlink()
    )


def _acquire_git(entry: dict[str, Any], cache: Path, verify_only: bool) -> None:
    destination = cache / entry["directory"]
    git_dir = destination / ".git"
    if git_dir.is_dir():
        _verify_git_checkout(entry, destination, all_paths=True)
        print(f"verified git {entry['directory']} {entry['revision']}")
        return
    if destination.exists():
        raise ValueError(f"{destination}: exists but is not a Git checkout")
    if verify_only:
        raise FileNotFoundError(destination)
    prefix = f".{entry['directory']}-acquiring-"
    temporary = Path(tempfile.mkdtemp(prefix=prefix, dir=cache))
    try:
        _run("git", "init", "--quiet", cwd=temporary)
        _run("git", "remote", "add", "origin", entry["repository"], cwd=temporary)
        _run(
            "git",
            "fetch",
            "--quiet",
            "--depth=1",
            "origin",
            entry["revision"],
            cwd=temporary,
        )
        _run("git", "checkout", "--quiet", "--detach", "FETCH_HEAD", cwd=temporary)
        _verify_git_checkout(entry, temporary, all_paths=True)
        if destination.exists() or destination.is_symlink():
            raise ValueError(f"{destination}: appeared while it was being acquired")
        temporary.rename(destination)
    finally:
        if temporary.exists():
            if not _safe_temporary(temporary, cache, prefix):
                raise ValueError(f"refusing unexpected cleanup path {temporary}")
            shutil.rmtree(temporary)
    print(f"acquired git {entry['directory']} {entry['revision']}")


def _ocs_downloads(product_id: int) -> dict[str, str]:
    source = next(
        entry
        for entry in _json(LOCKS / "curated-source-catalog.json")["sources"]
        if entry.get("productId") == product_id
    )
    request = urllib.request.Request(
        source["metadataUrl"],
        headers={"User-Agent": "CursorAtelier-source-acquirer/1"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    data = payload["data"][0]
    if data.get("id") != product_id:
        raise ValueError("GNOME-Look returned the wrong product metadata")
    downloads: dict[str, str] = {}
    for archive in source["archives"]:
        for key, name in data.items():
            if not key.startswith("downloadname") or name != archive["name"]:
                continue
            index = key.removeprefix("downloadname")
            link = data.get(f"downloadlink{index}")
            if (
                link
                and data.get(f"downloadmd5sum{index}", "").lower()
                == archive["upstreamMd5"]
            ):
                # This is a revision selector; _acquire_gnome still verifies
                # the archive's pinned SHA-256 before writing any source data.
                downloads[name] = str(link)
                break
        if archive["name"] not in downloads:
            raise ValueError(
                f"GNOME-Look no longer lists the pinned revision of {archive['name']}"
            )
    return downloads


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _zip_member_name(raw: str) -> str:
    if not raw or "\\" in raw:
        raise ValueError(f"unsafe archive member {raw}")
    path = PurePosixPath(raw)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"unsafe archive member {raw}")
    return path.as_posix().rstrip("/")


def _content_tree_digest(entries: Iterable[tuple[str, bytes]]) -> tuple[str, int]:
    digest = hashlib.sha256()
    count = 0
    for name, payload in sorted(entries, key=lambda item: item[0]):
        encoded = name.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
        count += 1
    return digest.hexdigest(), count


def _archive_tree_digest(archive: Path) -> tuple[str, int]:
    entries: list[tuple[str, bytes]] = []
    names: set[str] = set()
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            name = _zip_member_name(member.filename)
            if member.is_dir():
                continue
            if name in names:
                raise ValueError(f"{archive}: duplicate archive member {name}")
            names.add(name)
            entries.append((name, bundle.read(member)))
    return _content_tree_digest(entries)


def _expanded_tree_digest(root: Path) -> tuple[str, int]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f"{root}: expanded archive root is not a directory")
    entries: list[tuple[str, bytes]] = []
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"{path}: symlinks are not allowed in expanded archives")
        if path.is_file():
            entries.append((path.relative_to(root).as_posix(), path.read_bytes()))
    return _content_tree_digest(entries)


def _verify_expanded_zip(archive: Path, expanded: Path) -> None:
    expected_digest, expected_count = _archive_tree_digest(archive)
    actual_digest, actual_count = _expanded_tree_digest(expanded)
    if (actual_digest, actual_count) != (expected_digest, expected_count):
        raise ValueError(
            f"{expanded}: expanded tree does not match {archive.name} "
            f"({actual_count}/{expected_count} files)"
        )


def _extract_zip(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    resolved_root = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            _zip_member_name(member.filename)
            target = (destination / member.filename).resolve()
            if target != resolved_root and resolved_root not in target.parents:
                raise ValueError(f"{archive}: unsafe archive member {member.filename}")
        bundle.extractall(destination)


def _acquire_gnome(product: dict[str, Any], cache: Path, verify_only: bool) -> None:
    root = cache / product["directory"]
    archives_dir = root / "archives"
    expanded_dir = root / "expanded"
    downloads: dict[str, str] | None = None
    for name, expected in sorted(product["archives"].items()):
        archive = archives_dir / name
        if archive.is_symlink():
            raise ValueError(f"{archive}: archive cache entry cannot be a symlink")
        if not archive.is_file():
            if verify_only:
                raise FileNotFoundError(archive)
            downloads = downloads or _ocs_downloads(int(product["productId"]))
            url = downloads.get(name)
            if not url:
                raise ValueError(f"GNOME-Look product {product['productId']} no longer lists {name}")
            with urllib.request.urlopen(url, timeout=60) as response:
                payload = response.read()
            actual = hashlib.sha256(payload).hexdigest()
            if actual != expected:
                raise ValueError(f"{name}: expected {expected}, downloaded {actual}")
            archives_dir.mkdir(parents=True, exist_ok=True)
            archive.write_bytes(payload)
        actual = _sha256(archive)
        if actual != expected:
            raise ValueError(f"{archive}: expected {expected}, found {actual}")
        expanded = expanded_dir / archive.stem
        if expanded.exists() or expanded.is_symlink():
            _verify_expanded_zip(archive, expanded)
        else:
            if verify_only:
                raise FileNotFoundError(expanded)
            expanded_dir.mkdir(parents=True, exist_ok=True)
            prefix = f".{archive.stem}-extracting-"
            temporary = Path(tempfile.mkdtemp(prefix=prefix, dir=expanded_dir))
            try:
                _extract_zip(archive, temporary)
                _verify_expanded_zip(archive, temporary)
                if expanded.exists() or expanded.is_symlink():
                    raise ValueError(
                        f"{expanded}: appeared while it was being extracted"
                    )
                temporary.rename(expanded)
            finally:
                if temporary.exists():
                    if not _safe_temporary(temporary, expanded_dir, prefix):
                        raise ValueError(f"refusing unexpected cleanup path {temporary}")
                    shutil.rmtree(temporary)
        print(f"verified archive {product['directory']}/{name} {actual}")


def acquire(cache: Path, verify_only: bool = False) -> None:
    cache = cache.expanduser()
    if cache.is_symlink():
        raise ValueError(f"{cache}: source cache root cannot be a symlink")
    cache = cache.resolve()
    if cache.is_symlink() or (cache.exists() and not cache.is_dir()):
        raise ValueError(f"{cache}: source cache root must be a directory")
    if not cache.exists():
        if verify_only:
            raise FileNotFoundError(cache)
        cache.mkdir(parents=True)
    for entry in _git_sources():
        _acquire_git(entry, cache, verify_only)
    for product in _json(LOCKS / "gnome-look-sources.json")["products"]:
        _acquire_gnome(product, cache, verify_only)


def verify_build_cache(cache: Path) -> None:
    """Verify exactly the pinned paths consumed by the converter."""

    cache = cache.expanduser()
    if cache.is_symlink():
        raise ValueError(f"{cache}: source cache root cannot be a symlink")
    cache = cache.resolve()
    if cache.is_symlink() or not cache.is_dir():
        raise ValueError(f"{cache}: source cache root must be a directory")
    for entry in _git_sources():
        destination = cache / entry["directory"]
        _verify_git_checkout(entry, destination, all_paths=False)
    for product in _json(LOCKS / "gnome-look-sources.json")["products"]:
        _acquire_gnome(product, cache, verify_only=True)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args(argv)
    try:
        acquire(args.cache, args.verify_only)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"acquire_sources: {error}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
