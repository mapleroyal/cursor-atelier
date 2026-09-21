"""Build the self-contained converter on Windows using its pinned runtime."""
from __future__ import annotations
import json
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "native" / "cursor-packs"
BUILD = RUNTIME / "build" / "curated-converter"
ARCH = {"AMD64": "x64", "ARM64": "arm64"}.get(platform.machine())

def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)

def build():
    if sys.platform != "win32" or ARCH is None or sys.version_info < (3, 10):
        raise SystemExit("Windows converter builds require native x64/ARM64 Python 3.10+.")
    BUILD.mkdir(parents=True, exist_ok=True)
    tooling = BUILD / f"tooling-Windows-{ARCH}"
    python = tooling / "Scripts" / "python.exe"
    if not python.is_file():
        run(sys.executable, "-m", "venv", tooling)
    run(python, "-m", "pip", "install", "--disable-pip-version-check", "--quiet", "--requirement", RUNTIME / "curated-runtime-requirements.txt")
    target, previous = BUILD / "curated-cursor-converter", BUILD / f".previous-{ARCH}"
    if previous.exists() or previous.is_symlink():
        raise RuntimeError(f"Resolve converter recovery directory before rebuilding: {previous}")
    if target.is_symlink() or (target.exists() and not target.is_dir()):
        raise RuntimeError(f"Unexpected converter target: {target}")
    with tempfile.TemporaryDirectory(prefix=".curated-staging-", dir=BUILD) as temporary:
        staging = Path(temporary)
        # Python 3.13 creates Windows temporary directories with a protected
        # owner-only DACL. An elevated SSH build has Administrators as owner,
        # so its frozen output would be inaccessible to the desktop token.
        # This empty build directory must inherit the checkout's normal ACL.
        run("icacls.exe", staging, "/inheritance:e", stdout=subprocess.DEVNULL)
        run(python, "-m", "PyInstaller", "--log-level", "WARN", "--noconfirm", "--clean", "--onedir", "--console",
            "--name", "curated-cursor-converter", "--distpath", staging / "dist", "--workpath", staging / "work", "--specpath", staging / "spec",
            "--paths", ROOT / "native", "--paths", RUNTIME, "--paths", ROOT / "native" / "oreo" / "ArtworkSource",
            "--add-data", f"{RUNTIME / 'inventory-lock.json'};.", "--add-data", f"{RUNTIME / 'curated-family-catalog.json'};.",
            "--hidden-import", "svg_renderer", "--hidden-import", "convert_oreo_to_macursor", "--collect-submodules", "clickgen", RUNTIME / "curated_runtime.py")
        built = staging / "dist" / "curated-cursor-converter"
        executable = built / "curated-cursor-converter.exe"
        if not executable.is_file():
            raise RuntimeError("PyInstaller did not produce the Windows converter.")
        licenses = built / "licenses"
        licenses.mkdir()
        license_script = r"""
import shutil, sys
from importlib.metadata import distribution
from pathlib import Path
output = Path(sys.argv[1])
python_license = Path(sys.base_prefix) / 'LICENSE.txt'
if not python_license.is_file():
    raise RuntimeError('Python license was not found')
shutil.copyfile(python_license, output / 'Python.txt')
for package in ('Pillow', 'pyinstaller', 'clickgen', 'numpy'):
    dist = distribution(package)
    copied = 0
    for filename in dist.files or ():
        parts = Path(filename).parts
        if not parts[0].endswith('.dist-info'):
            continue
        relative = Path(*parts[1:])
        if not any('license' in part.lower() or 'copying' in part.lower() for part in relative.parts):
            continue
        source = dist.locate_file(filename)
        if not source.is_file():
            continue
        destination = output / package / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        copied += 1
    if not copied:
        raise RuntimeError(f'{package} runtime license was not found')
"""
        run(python, "-c", license_script, licenses)
        result = json.loads(run(executable, "self-test", capture_output=True, text=True).stdout)
        if not result.get("ok"):
            raise RuntimeError("Frozen converter self-test failed.")
        if target.exists():
            target.rename(previous)
        try:
            built.rename(target)
        except BaseException:
            if previous.exists() and not target.exists():
                previous.rename(target)
            raise
        if previous.exists():
            shutil.rmtree(previous)
    print(target)

if __name__ == "__main__":
    build()