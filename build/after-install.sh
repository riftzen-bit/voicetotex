#!/usr/bin/env bash
set -e

BACKEND_DIR="/opt/VoiceToTex/resources/backend"
VENV_DIR="$BACKEND_DIR/.venv"

echo "VoiceToTex: Setting up Python environment..."

if [ ! -d "$VENV_DIR" ]; then
    if ! python3 -m venv "$VENV_DIR"; then
        echo "VoiceToTex: ERROR — failed to create Python venv." >&2
        echo "  Install python3-venv: sudo apt install python3-venv" >&2
        exit 1
    fi
fi

"$VENV_DIR/bin/pip" install --upgrade pip --quiet 2>/dev/null || true

if ! "$VENV_DIR/bin/pip" install -r "$BACKEND_DIR/requirements.txt" --quiet; then
    echo "VoiceToTex: WARNING — pip install failed. Backend may not start." >&2
    echo "  Try manually: $VENV_DIR/bin/pip install -r $BACKEND_DIR/requirements.txt" >&2
fi

chmod -R a+rX "$VENV_DIR"

# Fix chrome-sandbox SUID permissions (required for Electron on Linux)
SANDBOX="/opt/VoiceToTex/chrome-sandbox"
if [ -f "$SANDBOX" ]; then
    chown root:root "$SANDBOX"
    chmod 4755 "$SANDBOX"
    echo "VoiceToTex: chrome-sandbox permissions set."
fi

echo "VoiceToTex: Python environment ready."
