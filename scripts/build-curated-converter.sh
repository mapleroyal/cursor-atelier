#!/usr/bin/env bash
set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository_root=$(cd -- "${script_directory}/.." && pwd -P)
runtime_root="${repository_root}/native/cursor-packs"
build_root="${runtime_root}/build/curated-converter"
host_arch=$(uname -m)
host_platform=$(uname -s)

case "${host_arch}" in
  arm64|aarch64) package_arch=arm64 ;;
  x86_64) package_arch=x64 ;;
  *)
    printf '%s\n' >&2 "Unsupported converter build architecture: ${host_arch}"
    exit 65
    ;;
esac

python_command=${CURSOR_ATELIER_PYTHON:-python3}
if ! command -v "${python_command}" >/dev/null 2>&1; then
  printf '%s\n' >&2 "Python interpreter not found: ${python_command}"
  exit 69
fi

/bin/mkdir -p "${build_root}"
build_root=$(cd -- "${build_root}" && pwd -P)
staging=$(/usr/bin/mktemp -d "${build_root}/.curated-staging-XXXXXXXX")
tooling="${build_root}/tooling-${host_platform}-${package_arch}"
target="${build_root}/curated-cursor-converter"
previous="${build_root}/.previous-${package_arch}"

safe_remove() {
  local candidate=$1
  local candidate_name
  candidate_name=$(basename -- "${candidate}")
  if [[ "$(dirname -- "${candidate}")" != "${build_root}" ]] || [[ "${candidate_name}" != .curated-staging-* && "${candidate_name}" != .previous-* ]]; then
    printf '%s\n' >&2 "Refusing unsafe converter cleanup path: ${candidate}"
    exit 70
  fi
  if [[ -L "${candidate}" ]]; then
    printf '%s\n' >&2 "Refusing converter cleanup through symlink: ${candidate}"
    exit 70
  fi
  if [[ -d "${candidate}" ]]; then
    /bin/rm -rf -- "${candidate}"
  fi
}

cleanup() {
  if [[ -n "${staging:-}" && -d "${staging}" ]]; then
    safe_remove "${staging}"
  fi
}
trap cleanup EXIT

if [[ ! -x "${tooling}/bin/python" ]]; then
  "${python_command}" -m venv "${tooling}"
fi
"${tooling}/bin/python" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --requirement "${runtime_root}/curated-runtime-requirements.txt"

python_license=$("${tooling}/bin/python" - <<'PY'
import sys
import sysconfig
from pathlib import Path

candidates = (
    Path(sysconfig.get_path("stdlib")) / "LICENSE.txt",
    Path(sys.base_prefix) / "LICENSE.txt",
    Path(sys.base_prefix) / "share/licenses/python/LICENSE",
    Path(sys.base_prefix) / f"share/doc/python{sys.version_info.major}.{sys.version_info.minor}/copyright",
)
matches = [path.resolve() for path in candidates if path.is_file()]
if not matches:
    raise SystemExit("Python runtime license was not found")
print(matches[0])
PY
)

metadata_license() {
  "${tooling}/bin/python" - "$1" "$2" <<'PY'
import sys
from importlib.metadata import distribution

package, suffix = sys.argv[1:]
dist = distribution(package)
matches = [
    dist.locate_file(path).resolve()
    for path in (dist.files or ())
    if str(path).endswith(suffix)
]
if len(matches) != 1 or not matches[0].is_file():
    raise SystemExit(f"{package} runtime license was not found")
print(matches[0])
PY
}

pillow_license=$(metadata_license Pillow "licenses/LICENSE")
pyinstaller_license=$(metadata_license pyinstaller "licenses/COPYING.txt")
for runtime_license in "${python_license}" "${pillow_license}" "${pyinstaller_license}"; do
  if [[ -z "${runtime_license}" || ! -f "${runtime_license}" || -L "${runtime_license}" ]]; then
    printf '%s\n' >&2 "Invalid converter runtime license path: ${runtime_license}"
    exit 70
  fi
done

"${tooling}/bin/pyinstaller" \
  --log-level WARN \
  --noconfirm \
  --clean \
  --onedir \
  --console \
  --name curated-cursor-converter \
  --distpath "${staging}/dist" \
  --workpath "${staging}/work" \
  --specpath "${staging}/spec" \
  --paths "${repository_root}/native" \
  --paths "${runtime_root}" \
  --paths "${repository_root}/native/oreo/ArtworkSource" \
  --add-data "${runtime_root}/inventory-lock.json:." \
  --add-data "${runtime_root}/curated-family-catalog.json:." \
  --hidden-import svg_renderer \
  --hidden-import convert_oreo_to_macursor \
  "${runtime_root}/curated_runtime.py"

built="${staging}/dist/curated-cursor-converter"
executable="${built}/curated-cursor-converter"
if [[ ! -x "${executable}" ]]; then
  printf '%s\n' >&2 "PyInstaller did not create the curated converter executable."
  exit 70
fi
/bin/mkdir "${built}/licenses"
/bin/cp "${python_license}" "${built}/licenses/Python.txt"
/bin/cp "${pillow_license}" "${built}/licenses/Pillow.txt"
/bin/cp "${pyinstaller_license}" "${built}/licenses/PyInstaller.txt"
"${tooling}/bin/python" - "${built}/licenses" <<'PY'
import shutil
import sys
from importlib.metadata import distribution
from pathlib import Path

destination = Path(sys.argv[1])
for package in ("clickgen", "numpy"):
    dist = distribution(package)
    copied = 0
    for filename in dist.files or ():
        parts = Path(filename).parts
        if not parts[0].endswith(".dist-info"):
            continue
        relative = Path(*parts[1:])
        if not any(
            "license" in part.lower() or "copying" in part.lower()
            for part in relative.parts
        ):
            continue
        target_license = destination / package / relative
        target_license.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(dist.locate_file(filename), target_license)
        copied += 1
    if not copied:
        raise SystemExit(f"{package} runtime license was not found")
PY
"${executable}" self-test >/dev/null

if [[ -e "${previous}" || -L "${previous}" ]]; then
  printf '%s\n' >&2 "Refusing promotion while converter recovery path exists: ${previous}"
  exit 70
fi
if [[ -L "${target}" || ( -e "${target}" && ! -d "${target}" ) ]]; then
  printf '%s\n' >&2 "Refusing unexpected converter target: ${target}"
  exit 70
fi
if [[ -d "${target}" ]]; then
  /bin/mv "${target}" "${previous}"
fi
if ! /bin/mv "${built}" "${target}"; then
  if [[ -d "${previous}" && ! -e "${target}" ]]; then
    /bin/mv "${previous}" "${target}"
  fi
  exit 70
fi
if [[ -d "${previous}" ]]; then
  safe_remove "${previous}"
fi

printf '%s\n' "${target}"
