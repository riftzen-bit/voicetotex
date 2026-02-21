"""
TextInjector: Auto-typing and clipboard operations for Wayland.

Uses ydotool (uinput, compositor-agnostic) as primary backend with wtype
(wlroots-only) as fallback.  Clipboard via wl-copy.  Focus save/restore
via xdotool (XWayland) or compositor-specific tools.
"""

import json as _json
import os
import re
import subprocess
import shutil
import time
import logging

logger = logging.getLogger(__name__)

_RE_HYPRLAND_ADDR = re.compile(r"^0x[0-9a-fA-F]+$")


def _validate_sway_con_id(value: object) -> int:
    """Return value as a non-negative integer or raise ValueError."""
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    raise ValueError(f"Invalid sway con_id (must be non-negative integer): {value!r}")


def _validate_hyprland_address(value: object) -> str:
    """Return value as a validated hyprland address string or raise ValueError."""
    if isinstance(value, str) and _RE_HYPRLAND_ADDR.match(value):
        return value
    raise ValueError(f"Invalid hyprland address (must match 0x[0-9a-fA-F]+): {value!r}")

_KEY_LEFTCTRL = 29
_KEY_LEFTSHIFT = 42
_KEY_V = 47
_TERMINAL_KEYWORDS = (
    "konsole",
    "gnome-terminal",
    "wezterm",
    "alacritty",
    "kitty",
    "xterm",
    "tilix",
    "terminator",
    "ghostty",
    "foot",
)


class TextInjector:
    """Injects text into focused windows and manages clipboard on Wayland."""

    def __init__(self) -> None:
        self._ydotool: bool = shutil.which("ydotool") is not None
        self._wtype: bool = self._probe_wtype()
        self._wl_copy: bool = shutil.which("wl-copy") is not None
        self._xdotool: bool = shutil.which("xdotool") is not None

        self._compositor: str | None = self._detect_compositor()
        self._saved_window_id: str | int | None = None

        if not self._ydotool and not self._wtype:
            logger.warning("No typing backend available — install ydotool or wtype")
        if not self._wl_copy:
            logger.warning("wl-copy not found — clipboard operations unavailable")

        logger.info(
            "TextInjector: ydotool=%s wtype=%s wl_copy=%s xdotool=%s compositor=%s",
            self._ydotool,
            self._wtype,
            self._wl_copy,
            self._xdotool,
            self._compositor or "unknown",
        )

    @staticmethod
    def _probe_wtype() -> bool:
        """Return True only if wtype is installed AND the compositor supports it."""
        if not shutil.which("wtype"):
            return False
        try:
            result = subprocess.run(
                ["wtype", ""],
                capture_output=True,
                text=True,
                timeout=3,
            )
            if "does not support" in (result.stderr or "").lower():
                logger.info("wtype present but compositor does not support it")
                return False
            return result.returncode == 0
        except Exception:
            return False

    def is_available(self) -> dict[str, bool]:
        return {
            "ydotool": self._ydotool,
            "wtype": self._wtype,
            "wl_copy": self._wl_copy,
            "can_type": self._ydotool or self._wtype,
            "can_paste": (self._ydotool or self._wtype) and self._wl_copy,
        }

    def type_text(self, text: str, mode: str = "type") -> bool:
        if not text:
            return True

        if mode == "type" and (len(text) > 100 or "\n" in text):
            logger.debug(
                "Text length %d / has newlines — switching to clipboard mode",
                len(text),
            )
            mode = "clipboard"

        if mode == "type":
            return self._type_direct(text)
        if mode == "clipboard":
            return self._type_via_clipboard(text)

        logger.error("Unknown injection mode: %s", mode)
        return False

    def copy_to_clipboard(self, text: str) -> bool:
        if not text:
            return True
        if not self._wl_copy:
            logger.error("wl-copy not available")
            return False
        try:
            _ = subprocess.run(
                ["wl-copy", "--"],
                input=text.encode("utf-8"),
                timeout=5,
                check=True,
            )
            return True
        except Exception as exc:
            logger.error("wl-copy failed: %s", exc)
            return False

    def _type_direct(self, text: str) -> bool:
        if self._ydotool:
            ok = self._ydotool_type(text)
            if ok:
                return True

        if self._wtype:
            ok = self._wtype_type(text)
            if ok:
                return True

        logger.debug("Direct typing failed, falling back to clipboard")
        return self._type_via_clipboard(text)

    def _type_via_clipboard(self, text: str) -> bool:
        if not self.copy_to_clipboard(text):
            return False
        time.sleep(0.12)
        return self._simulate_paste()

    def _simulate_paste(self) -> bool:
        for backend in ["xdotool", "ydotool", "wtype"]:
            if backend == "xdotool" and self._xdotool:
                ok = self._xdotool_paste(with_shift=True)
                if ok:
                    return True
            if backend == "ydotool" and self._ydotool:
                ok = self._ydotool_key_combo([_KEY_LEFTCTRL, _KEY_LEFTSHIFT], _KEY_V)
                if ok:
                    return True
            if backend == "wtype" and self._wtype:
                ok = self._wtype_paste(with_shift=True)
                if ok:
                    return True

        logger.error("Paste simulation failed — text is in clipboard, paste manually")
        return False

    def _is_active_window_terminal(self) -> bool | None:
        if not self._xdotool:
            return None

        if (
            not isinstance(self._saved_window_id, str)
            or not self._saved_window_id.isdigit()
        ):
            return None

        try:
            class_result = subprocess.run(
                ["xdotool", "getwindowclassname", self._saved_window_id],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
            name_result = subprocess.run(
                ["xdotool", "getwindowname", self._saved_window_id],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
            haystack = (
                (class_result.stdout if class_result.returncode == 0 else "")
                + " "
                + (name_result.stdout if name_result.returncode == 0 else "")
            ).lower()
            if not haystack.strip():
                return None
            return any(keyword in haystack for keyword in _TERMINAL_KEYWORDS)
        except Exception:
            return None

    def _ydotool_type(self, text: str) -> bool:
        try:
            _ = subprocess.run(
                ["ydotool", "type", "--key-delay", "2", "--file=-"],
                input=text.encode("utf-8"),
                timeout=30,
                check=True,
            )
            return True
        except Exception as exc:
            logger.warning("ydotool type failed: %s", exc)
            return False

    def _ydotool_key_combo(self, modifiers: list[int], key: int) -> bool:
        try:
            down = [f"{code}:1" for code in modifiers]
            up = [f"{code}:0" for code in reversed(modifiers)]
            _ = subprocess.run(
                [
                    "ydotool",
                    "key",
                    *down,
                    f"{key}:1",
                    f"{key}:0",
                    *up,
                ],
                timeout=5,
                check=True,
            )
            time.sleep(0.03)
            return True
        except Exception as exc:
            logger.warning("ydotool key failed: %s", exc)
            return False

    def _xdotool_paste(self, with_shift: bool) -> bool:
        try:
            if with_shift:
                cmd = ["xdotool", "key", "--clearmodifiers", "ctrl+shift+v"]
            else:
                cmd = ["xdotool", "key", "--clearmodifiers", "ctrl+v"]
            _ = subprocess.run(cmd, timeout=5, check=True)
            time.sleep(0.03)
            return True
        except Exception as exc:
            logger.warning("xdotool paste failed: %s", exc)
            return False

    def _wtype_type(self, text: str) -> bool:
        try:
            _ = subprocess.run(
                ["wtype", "--", text],
                timeout=10,
                check=True,
            )
            return True
        except Exception as exc:
            logger.warning("wtype type failed: %s", exc)
            return False

    def _wtype_paste(self, with_shift: bool) -> bool:
        try:
            cmd = ["wtype", "-M", "ctrl"]
            if with_shift:
                cmd.extend(["-M", "shift"])
            cmd.extend(["-k", "v"])
            if with_shift:
                cmd.extend(["-m", "shift"])
            cmd.extend(["-m", "ctrl"])
            _ = subprocess.run(
                cmd,
                timeout=5,
                check=True,
            )
            time.sleep(0.03)
            return True
        except Exception as exc:
            logger.warning("wtype paste failed: %s", exc)
            return False

    @staticmethod
    def _detect_compositor() -> str | None:
        if os.environ.get("HYPRLAND_INSTANCE_SIGNATURE") and shutil.which("hyprctl"):
            return "hyprland"
        if os.environ.get("SWAYSOCK") and shutil.which("swaymsg"):
            return "sway"
        desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").lower()
        if "kde" in desktop:
            return "kde"
        if "gnome" in desktop:
            return "gnome"
        return None

    def save_focused_window(self) -> None:
        self._saved_window_id = None

        if self._xdotool:
            try:
                result = subprocess.run(
                    ["xdotool", "getactivewindow"],
                    capture_output=True,
                    text=True,
                    timeout=2,
                )
                if result.returncode == 0 and result.stdout.strip():
                    self._saved_window_id = result.stdout.strip()
                    logger.debug(
                        "Saved focused window (xdotool): %s", self._saved_window_id
                    )
                    return
            except Exception as exc:
                logger.debug("xdotool getactivewindow failed: %s", exc)

        if self._compositor == "sway":
            self._save_focused_sway()
        elif self._compositor == "hyprland":
            self._save_focused_hyprland()

    def restore_focused_window(self) -> bool:
        if self._saved_window_id is None:
            return False

        restored = False

        if (
            self._xdotool
            and isinstance(self._saved_window_id, str)
            and self._saved_window_id.isdigit()
        ):
            try:
                _ = subprocess.run(
                    [
                        "xdotool",
                        "windowactivate",
                        "--sync",
                        self._saved_window_id,
                    ],
                    capture_output=True,
                    timeout=3,
                    check=True,
                )
                restored = True
                logger.debug("Restored focus (xdotool): %s", self._saved_window_id)
            except Exception as exc:
                logger.debug("xdotool windowactivate failed: %s", exc)

        if not restored and self._compositor == "sway":
            restored = self._restore_focused_sway()

        if not restored and self._compositor == "hyprland":
            restored = self._restore_focused_hyprland()

        if restored:
            time.sleep(0.15)
        return restored

    def _save_focused_sway(self) -> None:
        try:
            result = subprocess.run(
                ["swaymsg", "-t", "get_tree"],
                capture_output=True,
                text=True,
                timeout=2,
            )
            if result.returncode != 0:
                return
            tree = _json.loads(result.stdout)
            wid = self._find_sway_focused(tree)
            if wid is not None:
                self._saved_window_id = wid
                logger.debug("Saved focused window (sway con_id): %s", wid)
        except Exception as exc:
            logger.debug("sway save_focused failed: %s", exc)

    def _restore_focused_sway(self) -> bool:
        try:
            con_id = _validate_sway_con_id(self._saved_window_id)
        except ValueError as exc:
            logger.warning("Refusing sway focus restore: %s", exc)
            return False
        try:
            _ = subprocess.run(
                ["swaymsg", f"[con_id={con_id}]", "focus"],
                capture_output=True,
                timeout=2,
                check=True,
            )
            logger.debug("Restored focus (sway): %s", con_id)
            return True
        except Exception as exc:
            logger.debug("sway restore_focused failed: %s", exc)
            return False

    @staticmethod
    def _find_sway_focused(node: object) -> int | None:
        if not isinstance(node, dict):
            return None
        if node.get("focused") and node.get("type") in ("con", "floating_con"):
            cid = node.get("id")
            return int(cid) if cid is not None else None
        for child in list(node.get("nodes") or []) + list(
            node.get("floating_nodes") or []
        ):
            result = TextInjector._find_sway_focused(child)
            if result is not None:
                return result
        return None

    def _save_focused_hyprland(self) -> None:
        try:
            result = subprocess.run(
                ["hyprctl", "activewindow", "-j"],
                capture_output=True,
                text=True,
                timeout=2,
            )
            if result.returncode != 0:
                return
            data = _json.loads(result.stdout)
            address = data.get("address")
            if address:
                self._saved_window_id = str(address)
                logger.debug("Saved focused window (hyprland): %s", address)
        except Exception as exc:
            logger.debug("hyprland save_focused failed: %s", exc)

    def _restore_focused_hyprland(self) -> bool:
        try:
            address = _validate_hyprland_address(self._saved_window_id)
        except ValueError as exc:
            logger.warning("Refusing hyprland focus restore: %s", exc)
            return False
        try:
            _ = subprocess.run(
                [
                    "hyprctl",
                    "dispatch",
                    "focuswindow",
                    f"address:{address}",
                ],
                capture_output=True,
                timeout=2,
                check=True,
            )
            logger.debug("Restored focus (hyprland): %s", address)
            return True
        except Exception as exc:
            logger.debug("hyprland restore_focused failed: %s", exc)
            return False
