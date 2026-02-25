import json
import logging
import os
import re
import shutil
import subprocess
import threading

LOGGER = logging.getLogger(__name__)
PA_VOLUME_NORM = 65536


def _to_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _detect_session_type() -> str:
    """Return 'wayland' or 'x11' based on the current session."""
    if os.environ.get("WAYLAND_DISPLAY"):
        return "wayland"
    session_type = os.environ.get("XDG_SESSION_TYPE", "").lower()
    if session_type == "wayland":
        return "wayland"
    return "x11"


class AudioDucker:
    def __init__(self) -> None:
        self._pactl_available = shutil.which("pactl") is not None
        self._xdotool_available = shutil.which("xdotool") is not None
        self._session_type = _detect_session_type()
        self._compositor = self._detect_compositor()

        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._ducking = False
        self._exempt_pid: int | None = None
        self._snapshot: dict[int, tuple[bool, int]] = {}

        # Binary name to exempt from ducking so our own sound feedback is audible.
        self._own_binary = "voicetotex"

        LOGGER.info(
            "AudioDucker: pactl=%s xdotool=%s session=%s compositor=%s",
            self._pactl_available,
            self._xdotool_available,
            self._session_type,
            self._compositor or "unknown",
        )

    def is_available(self) -> bool:
        return self._pactl_available

    def start_ducking(self, exempt_pid: int | None = None) -> bool:
        if not self._pactl_available:
            LOGGER.warning("Audio ducking unavailable: pactl not found")
            return False

        with self._lock:
            if self._ducking:
                return True
            self._ducking = True
            self._snapshot = {}
            self._exempt_pid = (
                exempt_pid if exempt_pid is not None else self._get_active_window_pid()
            )
            self._stop_event.clear()

        self._apply_duck_once()

        thread = threading.Thread(
            target=self._monitor_loop,
            name="AudioDucker",
            daemon=True,
        )
        with self._lock:
            self._thread = thread
        thread.start()
        return True

    def stop_ducking(self) -> bool:
        if not self._pactl_available:
            return False

        with self._lock:
            if not self._ducking:
                return True
            self._ducking = False
            self._stop_event.set()
            thread = self._thread
            self._thread = None
            snapshot = dict(self._snapshot)
            self._snapshot = {}
            self._exempt_pid = None

        if thread is not None and thread.is_alive():
            # pactl calls can take up to 3s; wait long enough so the monitor
            # thread doesn't re-apply ducking after we restore volumes.
            thread.join(timeout=4.5)
            if thread.is_alive():
                LOGGER.warning(
                    "Audio ducking monitor thread did not stop in time; retrying restore"
                )

        self._restore_snapshot(snapshot)
        if thread is not None and thread.is_alive():
            # Final best-effort restore in case a late-running pactl call from
            # the monitor thread modified volumes after the first restore pass.
            self._restore_snapshot(snapshot)

        return True

    def _monitor_loop(self) -> None:
        while not self._stop_event.wait(0.35):
            with self._lock:
                if not self._ducking:
                    return
            self._apply_duck_once()

    def _apply_duck_once(self) -> None:
        sink_inputs = self._list_sink_inputs()

        with self._lock:
            if not self._ducking:
                return
            exempt_pid = self._exempt_pid

        for item in sink_inputs:
            with self._lock:
                if not self._ducking:
                    return
            sink_input_index = _to_int(item.get("index"))
            if sink_input_index is None:
                continue

            properties = item.get("properties")
            if not isinstance(properties, dict):
                properties = {}

            sink_pid = _to_int(properties.get("application.process.id"))
            if exempt_pid is not None and sink_pid == exempt_pid:
                continue
            # Never mute our own app so sound feedback stays audible
            sink_binary = str(properties.get("application.process.binary", ""))
            if sink_binary == self._own_binary:
                continue

            was_muted = bool(item.get("mute", False))
            volume_value = self._extract_volume_value(item)

            with self._lock:
                if sink_input_index not in self._snapshot:
                    self._snapshot[sink_input_index] = (was_muted, volume_value)

            if not was_muted:
                _ = self._run_pactl(
                    ["set-sink-input-mute", str(sink_input_index), "1"],
                    check=False,
                )

    def _list_sink_inputs(self) -> list[dict[str, object]]:
        result = self._run_pactl(
            ["-f", "json", "list", "sink-inputs"],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return self._list_sink_inputs_text_fallback()

        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            return self._list_sink_inputs_text_fallback()

        if not isinstance(payload, list):
            return []

        outputs: list[dict[str, object]] = []
        for item in payload:
            if isinstance(item, dict):
                outputs.append(item)
        return outputs

    def _list_sink_inputs_text_fallback(self) -> list[dict[str, object]]:
        """Fallback parser for systems where pactl -f json is unavailable."""
        result = self._run_pactl(
            ["list", "sink-inputs"],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return []

        outputs: list[dict[str, object]] = []
        current: dict[str, object] | None = None
        properties: dict[str, str] = {}

        for line in result.stdout.splitlines():
            index_match = re.match(r"^Sink Input #(\d+)", line)
            if index_match:
                if current is not None:
                    current["properties"] = properties
                    outputs.append(current)
                current = {"index": int(index_match.group(1))}
                properties = {}
                continue

            if current is None:
                continue

            stripped = line.strip()
            if stripped.startswith("Mute:"):
                current["mute"] = "yes" in stripped.lower()
            elif stripped.startswith("Volume:"):
                vol_match = re.search(r"(\d+)\s*/\s*\d+%", stripped)
                if vol_match:
                    current["volume"] = {
                        "front-left": {"value": int(vol_match.group(1))}
                    }
            elif "=" in stripped and not stripped.startswith("Volume:"):
                key, _, val = stripped.partition("=")
                key = key.strip()
                val = val.strip().strip('"')
                properties[key] = val

        if current is not None:
            current["properties"] = properties
            outputs.append(current)

        return outputs

    def _extract_volume_value(self, item: dict[str, object]) -> int:
        volume = item.get("volume")
        if not isinstance(volume, dict):
            return 65536

        for channel_data in volume.values():
            if not isinstance(channel_data, dict):
                continue
            value = _to_int(channel_data.get("value"))
            if value is not None:
                return value

        return PA_VOLUME_NORM

    def _restore_snapshot(self, snapshot: dict[int, tuple[bool, int]]) -> None:
        for sink_input_index, (was_muted, volume_value) in snapshot.items():
            _ = self._run_pactl(
                ["set-sink-input-volume", str(sink_input_index), str(volume_value)],
                check=False,
            )
            _ = self._run_pactl(
                [
                    "set-sink-input-mute",
                    str(sink_input_index),
                    "1" if was_muted else "0",
                ],
                check=False,
            )

    def _get_active_window_pid(self) -> int | None:
        """Get the PID of the currently focused window, trying multiple methods."""
        # Method 1: xdotool (works on X11 and XWayland)
        if self._xdotool_available:
            pid = self._get_pid_xdotool()
            if pid is not None:
                return pid

        # Method 2: Compositor-specific (Wayland native)
        if self._compositor == "sway":
            pid = self._get_pid_sway()
            if pid is not None:
                return pid
        elif self._compositor == "hyprland":
            pid = self._get_pid_hyprland()
            if pid is not None:
                return pid
        elif self._compositor == "kde":
            pid = self._get_pid_kde()
            if pid is not None:
                return pid

        # Method 3: GNOME D-Bus (Wayland)
        if self._session_type == "wayland" and self._compositor not in ("kde",):
            pid = self._get_pid_gdbus()
            if pid is not None:
                return pid

        return None

    def _get_pid_xdotool(self) -> int | None:
        window_result = self._run_xdotool(
            ["getactivewindow"], capture_output=True, text=True
        )
        if window_result is None or window_result.returncode != 0:
            return None

        window_id = window_result.stdout.strip()
        if not window_id:
            return None

        pid_result = self._run_xdotool(
            ["getwindowpid", window_id], capture_output=True, text=True
        )
        if pid_result is None or pid_result.returncode != 0:
            return None

        return _to_int(pid_result.stdout.strip())

    def _get_pid_sway(self) -> int | None:
        try:
            result = subprocess.run(
                ["swaymsg", "-t", "get_tree"],
                capture_output=True, text=True, timeout=2,
            )
            if result.returncode != 0:
                return None
            tree = json.loads(result.stdout)
            return self._find_sway_focused_pid(tree)
        except Exception:
            return None

    def _get_pid_hyprland(self) -> int | None:
        try:
            result = subprocess.run(
                ["hyprctl", "activewindow", "-j"],
                capture_output=True, text=True, timeout=2,
            )
            if result.returncode != 0:
                return None
            data = json.loads(result.stdout)
            pid = data.get("pid")
            return int(pid) if isinstance(pid, (int, float)) else None
        except Exception:
            return None

    def _get_pid_kde(self) -> int | None:
        """Get focused window PID via KDE's KWin D-Bus scripting interface."""
        try:
            script = "print(workspace.activeWindow.pid)"
            result = subprocess.run(
                [
                    "gdbus", "call", "--session",
                    "--dest", "org.kde.KWin",
                    "--object-path", "/Scripting",
                    "--method", "org.kde.kwin.Scripting.loadScript",
                    "/dev/stdin", "",
                ],
                input=script,
                capture_output=True, text=True, timeout=2,
            )
            if result.returncode != 0:
                return None
            match = re.search(r"(\d+)", result.stdout)
            if match:
                script_id = match.group(1)
                run_result = subprocess.run(
                    [
                        "gdbus", "call", "--session",
                        "--dest", "org.kde.KWin",
                        "--object-path", f"/Scripting/Script{script_id}",
                        "--method", "org.kde.kwin.Script.run",
                    ],
                    capture_output=True, text=True, timeout=2,
                )
                subprocess.run(
                    [
                        "gdbus", "call", "--session",
                        "--dest", "org.kde.KWin",
                        "--object-path", f"/Scripting/Script{script_id}",
                        "--method", "org.kde.kwin.Script.stop",
                    ],
                    capture_output=True, text=True, timeout=2,
                )
                if run_result.returncode == 0 and run_result.stdout.strip():
                    pid_match = re.search(r"(\d+)", run_result.stdout)
                    if pid_match:
                        return int(pid_match.group(1))
        except Exception:
            pass

        try:
            result = subprocess.run(
                ["kdotool", "getactivewindow"],
                capture_output=True, text=True, timeout=2,
            )
            if result.returncode == 0 and result.stdout.strip():
                wid = result.stdout.strip()
                pid_result = subprocess.run(
                    ["kdotool", "getwindowpid", wid],
                    capture_output=True, text=True, timeout=2,
                )
                if pid_result.returncode == 0:
                    return _to_int(pid_result.stdout.strip())
        except Exception:
            pass
        return None

    def _get_pid_gdbus(self) -> int | None:
        """Try to get the focused window PID via GNOME D-Bus interface."""
        try:
            result = subprocess.run(
                [
                    "gdbus", "call", "--session",
                    "--dest", "org.gnome.Shell",
                    "--object-path", "/org/gnome/Shell",
                    "--method", "org.gnome.Shell.Eval",
                    "global.get_window_actors().find(a=>a.meta_window.has_focus())?.meta_window.get_pid()",
                ],
                capture_output=True, text=True, timeout=2,
            )
            if result.returncode == 0 and result.stdout.strip():
                match = re.search(r"'(\d+)'", result.stdout)
                if match:
                    return int(match.group(1))
        except Exception:
            pass
        return None

    @staticmethod
    def _find_sway_focused_pid(node: object) -> int | None:
        if not isinstance(node, dict):
            return None
        if node.get("focused") and node.get("type") in ("con", "floating_con"):
            pid = node.get("pid")
            return int(pid) if isinstance(pid, (int, float)) else None
        for child in list(node.get("nodes") or []) + list(
            node.get("floating_nodes") or []
        ):
            result = AudioDucker._find_sway_focused_pid(child)
            if result is not None:
                return result
        return None

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

    def _run_pactl(
        self,
        args: list[str],
        *,
        check: bool,
        capture_output: bool = False,
        text: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        try:
            run_kwargs: dict[str, object] = {
                "check": check,
                "timeout": 3,
                "text": text,
            }
            if capture_output:
                run_kwargs["capture_output"] = True
            else:
                # Suppress pactl stderr/stdout spam (e.g. transient "No such
                # entity" during teardown of apps/audio streams).
                run_kwargs["stdout"] = subprocess.DEVNULL
                run_kwargs["stderr"] = subprocess.DEVNULL
            return subprocess.run(
                ["pactl", *args],
                **run_kwargs,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            LOGGER.debug("pactl call failed (%s): %s", args, exc)
            return subprocess.CompletedProcess(
                args=["pactl", *args],
                returncode=1,
                stdout="",
                stderr="",
            )

    def _run_xdotool(
        self,
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
    ) -> subprocess.CompletedProcess[str] | None:
        try:
            return subprocess.run(
                ["xdotool", *args],
                check=False,
                timeout=2,
                capture_output=capture_output,
                text=text,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return None
