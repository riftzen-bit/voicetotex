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

# ── Distro Detection ─────────────────────────────────────────────
detect_distro() {
    DISTRO="unknown"
    PKG_MANAGER="unknown"

    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO="${ID:-unknown}"
    fi

    if command -v apt-get &>/dev/null; then
        PKG_MANAGER="apt"
    elif command -v dnf &>/dev/null; then
        PKG_MANAGER="dnf"
    elif command -v pacman &>/dev/null; then
        PKG_MANAGER="pacman"
    elif command -v zypper &>/dev/null; then
        PKG_MANAGER="zypper"
    elif command -v apk &>/dev/null; then
        PKG_MANAGER="apk"
    fi

    ok "Distro: $DISTRO (package manager: $PKG_MANAGER)"
}

# ── Session Type Detection ────────────────────────────────────────
detect_session() {
    if [ -n "${WAYLAND_DISPLAY:-}" ]; then
        SESSION_TYPE="wayland"
    elif [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
        SESSION_TYPE="wayland"
    else
        SESSION_TYPE="x11"
    fi
    ok "Session type: $SESSION_TYPE"
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

check_optional_cmd() {
    local cmd="$1"
    local label="${2:-$cmd}"
    local hint="${3:-}"
    if command -v "$cmd" &>/dev/null; then
        local ver
        ver="$("$cmd" --version 2>/dev/null | head -1)" || ver="found"
        ok "$label — $ver"
    else
        warn "$label — not found (optional)"
        [ -n "$hint" ] && info "$hint"
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
        case "$PKG_MANAGER" in
            apt)     info "Install: sudo apt install python3 python3-venv python3-pip python3-dev" ;;
            dnf)     info "Install: sudo dnf install python3 python3-pip python3-devel" ;;
            pacman)  info "Install: sudo pacman -S python python-pip" ;;
            zypper)  info "Install: sudo zypper install python3 python3-pip python3-devel" ;;
            *)       info "Install Python 3.11+ using your package manager" ;;
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

install_system_deps() {
    printf "\n${BOLD}[3/6] System Dependencies${NC}\n"

    local to_install=()

    # Audio dependencies
    check_optional_cmd pactl "PulseAudio tools (pactl)" "Needed for audio ducking"
    if ! command -v pactl &>/dev/null; then
        case "$PKG_MANAGER" in
            apt) to_install+=("pulseaudio-utils") ;;
            dnf) to_install+=("pulseaudio-utils") ;;
            pacman) to_install+=("libpulse") ;;
            zypper) to_install+=("pulseaudio-utils") ;;
        esac
    fi

    # PortAudio (required for audio capture)
    if ! ldconfig -p 2>/dev/null | grep -q "libportaudio"; then
        warn "libportaudio — not found"
        case "$PKG_MANAGER" in
            apt) to_install+=("libportaudio2") ;;
            dnf) to_install+=("portaudio") ;;
            pacman) to_install+=("portaudio") ;;
            zypper) to_install+=("portaudio") ;;
        esac
    else
        ok "libportaudio — found"
    fi

    # Clipboard tools
    if [ "$SESSION_TYPE" = "wayland" ]; then
        check_optional_cmd wl-copy "wl-clipboard (Wayland clipboard)" "Needed for paste mode"
        if ! command -v wl-copy &>/dev/null; then
            case "$PKG_MANAGER" in
                apt) to_install+=("wl-clipboard") ;;
                dnf) to_install+=("wl-clipboard") ;;
                pacman) to_install+=("wl-clipboard") ;;
                zypper) to_install+=("wl-clipboard") ;;
            esac
        fi
    else
        check_optional_cmd xclip "xclip (X11 clipboard)" "Needed for paste mode"
        if ! command -v xclip &>/dev/null; then
            case "$PKG_MANAGER" in
                apt) to_install+=("xclip") ;;
                dnf) to_install+=("xclip") ;;
                pacman) to_install+=("xclip") ;;
                zypper) to_install+=("xclip") ;;
            esac
        fi
    fi

    # Window management
    check_optional_cmd xdotool "xdotool (window control)" "Needed for focus save/restore"
    if ! command -v xdotool &>/dev/null; then
        case "$PKG_MANAGER" in
            apt) to_install+=("xdotool") ;;
            dnf) to_install+=("xdotool") ;;
            pacman) to_install+=("xdotool") ;;
            zypper) to_install+=("xdotool") ;;
        esac
    fi

    # Input group check
    if [ -d /dev/input ]; then
        if groups 2>/dev/null | grep -qw input; then
            ok "User is in 'input' group (hotkeys will work)"
        else
            warn "User is NOT in 'input' group — hotkeys may not work"
            info "Fix: sudo usermod -aG input \$USER && logout/login"
        fi
    fi

    if [ ${#to_install[@]} -gt 0 ]; then
        printf "\n"
        info "Missing system packages: ${to_install[*]}"

        local install_cmd=""
        case "$PKG_MANAGER" in
            apt)    install_cmd="sudo apt install -y ${to_install[*]}" ;;
            dnf)    install_cmd="sudo dnf install -y ${to_install[*]}" ;;
            pacman) install_cmd="sudo pacman -S --noconfirm ${to_install[*]}" ;;
            zypper) install_cmd="sudo zypper install -y ${to_install[*]}" ;;
        esac

        if [ -n "$install_cmd" ]; then
            info "Installing: $install_cmd"
            if eval "$install_cmd" 2>/dev/null; then
                ok "System packages installed"
            else
                warn "Auto-install failed — please run manually: $install_cmd"
            fi
        else
            warn "Install manually using your package manager: ${to_install[*]}"
        fi
    else
        ok "All system dependencies present"
    fi
}

# ── Main ──────────────────────────────────────────────────────────
printf "\n${BOLD}╔══════════════════════════════════════╗${NC}\n"
printf "${BOLD}║       VoiceToTex Setup v1.1.0        ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════╝${NC}\n\n"

PYTHON_CMD="python3"
SESSION_TYPE="x11"

printf "${BOLD}[1/6] Platform${NC}\n"
detect_platform
detect_distro
detect_session

printf "\n${BOLD}[2/6] Core Dependencies${NC}\n"
check_python
check_node
check_cmd npm npm "Comes with Node.js — reinstall Node"
check_cmd pip3 pip "Install: sudo apt install python3-pip (Linux) / brew install python (macOS)"

if [ "$MISSING" -gt 0 ]; then
    printf "\n${RED}${BOLD}✗ $MISSING missing core dependency(ies). Install them and re-run this script.${NC}\n\n"
    exit 1
fi

install_system_deps

printf "\n${BOLD}[4/6] Python Environment${NC}\n"
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

printf "\n${BOLD}[5/6] Node.js Packages${NC}\n"
info "Running npm install..."
cd "$PROJECT_DIR"
npm install --silent 2>/dev/null
ok "Node packages installed"

printf "\n${BOLD}[6/6] Input Group Check${NC}\n"
if groups 2>/dev/null | grep -qw input; then
    ok "User is in 'input' group — global hotkeys will work"
else
    warn "User is NOT in 'input' group — global hotkeys will NOT work"
    info "Run: sudo usermod -aG input \$USER"
    info "Then log out and log back in for the change to take effect"
fi

printf "\n${GREEN}${BOLD}╔══════════════════════════════════════╗${NC}\n"
printf "${GREEN}${BOLD}║         Setup complete! ✓             ║${NC}\n"
printf "${GREEN}${BOLD}╚══════════════════════════════════════╝${NC}\n\n"
printf "  Run: ${CYAN}bash scripts/start.sh${NC}\n\n"
