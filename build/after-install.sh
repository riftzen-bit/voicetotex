#!/bin/bash
set -e

BACKEND_DIR="/opt/VoiceToTex/resources/backend"
VENV_DIR="$BACKEND_DIR/.venv"

echo "VoiceToTex: Setting up Python environment..."

if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi

"$VENV_DIR/bin/pip" install --upgrade pip --quiet 2>/dev/null || true
"$VENV_DIR/bin/pip" install -r "$BACKEND_DIR/requirements.txt" --quiet 2>/dev/null || true

chmod -R a+rX "$VENV_DIR"

echo "VoiceToTex: Python environment ready."
