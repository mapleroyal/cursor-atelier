#!/bin/zsh
set -euo pipefail

if (( $# != 1 )); then
    print -u2 "usage: ${0:t} OUTPUT_DIRECTORY"
    exit 64
fi

script_directory=${0:A:h}
oreo_root="${script_directory}/oreo-cursors"
converter="${script_directory}/convert_oreo_to_macursor.py"
output_directory=${1:A}
python_command=${PYTHON:-python3}

if ! command -v "${python_command}" >/dev/null 2>&1; then
    print -u2 "Python interpreter not found: ${python_command}"
    exit 69
fi

mkdir -p "${output_directory}"

for source_directory in "${oreo_root}"/src/oreo_*_cursors; do
    variant=${source_directory:t}
    variant=${variant#oreo_}
    variant=${variant%_cursors}

    display_name=${(C)${variant//_/ }}
    compact_name=${display_name// /}
    "${python_command}" "${converter}" \
        "${oreo_root}" \
        "${variant}" \
        "${output_directory}/Oreo${compact_name}.cursor"
done
