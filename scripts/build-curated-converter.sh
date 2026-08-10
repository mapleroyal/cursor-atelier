#!/bin/zsh
set -euo pipefail

script_directory=${0:A:h}
repository_root=${script_directory:h}
runtime_root="${repository_root}/native/cursor-packs"
build_root="${runtime_root}/build/curated-converter"
host_arch=$(/usr/bin/uname -m)

case "${host_arch}" in
  arm64) package_arch=arm64 ;;
  x86_64) package_arch=x64 ;;
  *)
    print -u2 "Unsupported converter build architecture: ${host_arch}"
    exit 65
    ;;
esac

python_command=${CURSOR_ATELIER_PYTHON:-python3}
if ! command -v "${python_command}" >/dev/null 2>&1; then
  print -u2 "Python interpreter not found: ${python_command}"
  exit 69
fi

/bin/mkdir -p "${build_root}"
build_root=${build_root:A}
staging=$(/usr/bin/mktemp -d "${build_root}/.curated-staging-XXXXXXXX")
tooling="${build_root}/tooling-${package_arch}"
target="${build_root}/curated-cursor-converter"
previous="${build_root}/.previous-${package_arch}"

safe_remove() {
  local candidate=${1:A}
  if [[ "${candidate:h}" != "${build_root}" ]] || [[ "${candidate:t}" != .curated-staging-* && "${candidate:t}" != .previous-* ]]; then
    print -u2 "Refusing unsafe converter cleanup path: ${candidate}"
    exit 70
  fi
  if [[ -L "${candidate}" ]]; then
    print -u2 "Refusing converter cleanup through symlink: ${candidate}"
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
    print -u2 "Invalid converter runtime license path: ${runtime_license}"
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
  print -u2 "PyInstaller did not create the curated converter executable."
  exit 70
fi
/bin/mkdir "${built}/licenses"
/bin/cp "${python_license}" "${built}/licenses/Python.txt"
/bin/cp "${pillow_license}" "${built}/licenses/Pillow.txt"
/bin/cp "${pyinstaller_license}" "${built}/licenses/PyInstaller.txt"
"${executable}" self-test >/dev/null

if [[ -e "${previous}" || -L "${previous}" ]]; then
  print -u2 "Refusing promotion while converter recovery path exists: ${previous}"
  exit 70
fi
if [[ -L "${target}" || ( -e "${target}" && ! -d "${target}" ) ]]; then
  print -u2 "Refusing unexpected converter target: ${target}"
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

print "${target}"
