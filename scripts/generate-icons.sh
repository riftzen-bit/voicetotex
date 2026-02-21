#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SOURCE="$PROJECT_DIR/assets/icon.svg"
OUTDIR="$PROJECT_DIR/build/icons"

mkdir -p "$OUTDIR"

for size in 16 32 48 64 128 256 512; do
    rsvg-convert -w "$size" -h "$size" "$SOURCE" -o "$OUTDIR/${size}x${size}.png"
    echo "  Generated ${size}x${size}.png"
done

echo "Icons generated in $OUTDIR"
