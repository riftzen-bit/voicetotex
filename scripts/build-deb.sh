#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== VoiceToTex .deb Build ==="

# Step 1: Generate icons
echo "[1/3] Generating icons..."
bash scripts/generate-icons.sh

# Step 2: Install dependencies
echo "[2/3] Installing build dependencies..."
npm install

# Step 3: Build .deb
echo "[3/3] Building .deb package..."
npx electron-builder --linux deb

echo ""
echo "=== Build complete ==="
echo "Package location: dist/"
ls -lh dist/*.deb 2>/dev/null || echo "No .deb found — check build logs above."
