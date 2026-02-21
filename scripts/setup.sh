#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ── Colors & Symbols ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { printf "  ${GREEN}✓${NC} %s\n" "$*"; }
warn() { printf "  ${YELLOW}⚠${NC} %s\n" "$*"; }
fail() { printf "  ${RED}✗${NC} %s\n" "$*"; }
info() { printf "  ${CYAN}→${NC} %s\n" "$*"; }

# ── Platform Detection ────────────────────────────────────────────
detect_platform() {
    local os
    os="$(uname -s)"
    case "$os" in
        Linux*)
            if grep -qi microsoft /proc/version 2>/dev/null; then
                PLATFORM="wsl"
                ok "Platform: WSL (Windows Subsystem for Linux)"
            else
                PLATFORM="linux"
                ok "Platform: Linux"
            fi
            ;;
        Darwin*)
            PLATFORM="macos"
            ok "Platform: macOS"
            ;;
        *)
            PLATFORM="unknown"
            warn "Platform: $os (untested — may need manual adjustments)"
            ;;
    esac
}

# ── Dependency Checks ─────────────────────────────────────────────
MISSING=0

check_cmd() {
    local cmd="$1"
    local label="${2:-$cmd}"
    local hint="${3:-}"
    if command -v "$cmd" &>/dev/null; then
        local ver
        ver="$("$cmd" --version 2>/dev/null | head -1)" || ver="found"
        ok "$label — $ver"
    else
        fail "$label — not found"
        [ -n "$hint" ] && info "$hint"
        MISSING=$((MISSING + 1))
    fi
}

check_python() {
    local py=""
    for candidate in python3 python; do
        if command -v "$candidate" &>/dev/null; then
            py="$candidate"
            break
        fi
    done

    if [ -z "$py" ]; then
        fail "Python 3.11+ — not found"
        case "$PLATFORM" in
            linux)  info "Install: sudo apt install python3 python3-venv python3-pip" ;;
            macos)  info "Install: brew install python@3.11" ;;
            wsl)    info "Install: sudo apt install python3 python3-venv python3-pip" ;;
        esac
        MISSING=$((MISSING + 1))
        return
    fi

    local pyver
    pyver="$("$py" --version 2>&1)"
    local major minor
    major="$("$py" -c 'import sys; print(sys.version_info.major)')"
    minor="$("$py" -c 'import sys; print(sys.version_info.minor)')"

    if [ "$major" -ge 3 ] && [ "$minor" -ge 11 ]; then
        ok "Python — $pyver"
        PYTHON_CMD="$py"
    else
        fail "Python — $pyver (requires 3.11+)"
        MISSING=$((MISSING + 1))
    fi
}

check_node() {
    if ! command -v node &>/dev/null; then
        fail "Node.js 18+ — not found"
        info "Install: https://nodejs.org/ or use nvm"
        MISSING=$((MISSING + 1))
        return
    fi

    local nodever
    nodever="$(node --version)"
    local major
    major="${nodever#v}"
    major="${major%%.*}"

    if [ "$major" -ge 18 ]; then
        ok "Node.js — $nodever"
    else
        fail "Node.js — $nodever (requires 18+)"
        MISSING=$((MISSING + 1))
    fi
}

# ── Main ──────────────────────────────────────────────────────────
printf "\n${BOLD}╔══════════════════════════════════════╗${NC}\n"
printf "${BOLD}║       VoiceToTex Setup v1.0.0        ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════╝${NC}\n\n"

PYTHON_CMD="python3"

printf "${BOLD}[1/4] Platform${NC}\n"
detect_platform

printf "\n${BOLD}[2/4] Dependencies${NC}\n"
check_python
check_node
check_cmd npm npm "Comes with Node.js — reinstall Node"
check_cmd pip3 pip "Install: sudo apt install python3-pip (Linux) / brew install python (macOS)"

if [ "$MISSING" -gt 0 ]; then
    printf "\n${RED}${BOLD}✗ $MISSING missing dependency(ies). Install them and re-run this script.${NC}\n\n"
    exit 1
fi

printf "\n${BOLD}[3/4] Python Environment${NC}\n"
VENV_DIR="$PROJECT_DIR/backend/.venv"
if [ ! -d "$VENV_DIR" ]; then
    info "Creating virtual environment..."
    "$PYTHON_CMD" -m venv "$VENV_DIR"
    ok "Virtual environment created"
else
    ok "Virtual environment exists"
fi

info "Installing Python packages..."
"$VENV_DIR/bin/pip" install --upgrade pip -q 2>/dev/null
"$VENV_DIR/bin/pip" install -r "$PROJECT_DIR/backend/requirements.txt" -q 2>/dev/null
ok "Python packages installed"

printf "\n${BOLD}[4/4] Node.js Packages${NC}\n"
info "Running npm install..."
cd "$PROJECT_DIR"
npm install --silent 2>/dev/null
ok "Node packages installed"

printf "\n${GREEN}${BOLD}╔══════════════════════════════════════╗${NC}\n"
printf "${GREEN}${BOLD}║         Setup complete! ✓             ║${NC}\n"
printf "${GREEN}${BOLD}╚══════════════════════════════════════╝${NC}\n\n"
printf "  Run: ${CYAN}bash scripts/start.sh${NC}\n\n"
