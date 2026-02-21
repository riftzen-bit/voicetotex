#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== VoiceToTex Setup ==="

# Create Python venv if it doesn't exist
VENV_DIR="$PROJECT_DIR/backend/.venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "[1/3] Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
else
    echo "[1/3] Python venv already exists, skipping."
fi

# Install Python dependencies
echo "[2/3] Installing Python dependencies..."
"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install -r "$PROJECT_DIR/backend/requirements.txt" -q

# Install Node.js dependencies
echo "[3/3] Installing Node.js dependencies..."
cd "$PROJECT_DIR"
npm install --silent

echo ""
echo "=== Setup complete ==="
echo "Run: bash scripts/start.sh"
