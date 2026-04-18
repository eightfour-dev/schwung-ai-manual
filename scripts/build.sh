#!/usr/bin/env bash
set -euo pipefail

# JS-only module — no cross-compilation. Packages src/ into a versioned
# tarball. The Module Store installs to modules/tools/ai-manual/ based on
# component_type in module.json.

MODULE_ID="ai-manual"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist/${MODULE_ID}"

rm -rf "${ROOT_DIR}/dist"
mkdir -p "${DIST_DIR}"
cp -r "${ROOT_DIR}/src/." "${DIST_DIR}/"

cd "${ROOT_DIR}/dist"
tar -czvf "${MODULE_ID}-module.tar.gz" "${MODULE_ID}/"

echo "Tarball: ${ROOT_DIR}/dist/${MODULE_ID}-module.tar.gz"
