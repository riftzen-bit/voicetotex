#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

VENV_PYTHON="$PROJECT_DIR/backend/.venv/bin/python"

if [ -f "$VENV_PYTHON" ]; then
    export VOICETOTEX_PYTHON="$(realpath "$VENV_PYTHON")"
elif command -v python3 &> /dev/null; then
    export VOICETOTEX_PYTHON="$(command -v python3)"
elif command -v python &> /dev/null; then
    export VOICETOTEX_PYTHON="$(command -v python)"
else
    echo "Error: No Python found. Install Python or run: bash scripts/setup.sh"
    exit 1
fi

NVIDIA_CUBLAS_DIR="$($VOICETOTEX_PYTHON -c "
import site, os
for base in (site.getsitepackages() + [site.getusersitepackages()]):
    p = os.path.join(base, 'nvidia', 'cublas', 'lib')
    if os.path.isdir(p):
        print(p)
        break
" 2>/dev/null)"

if [ -n "$NVIDIA_CUBLAS_DIR" ]; then
    export LD_LIBRARY_PATH="${NVIDIA_CUBLAS_DIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

export ELECTRON_OZONE_PLATFORM_HINT=auto
export ELECTRON_ENABLE_LOGGING=0

cd "$PROJECT_DIR"
exec npx electron .
