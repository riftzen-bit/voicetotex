import json
import logging
import shutil
import subprocess
import threading

LOGGER = logging.getLogger(__name__)


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


class AudioDucker:
    def __init__(self) -> None:
        self._pactl_available = shutil.which("pactl") is not None
        self._xdotool_available = shutil.which("xdotool") is not None

        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._ducking = False
        self._exempt_pid: int | None = None
        self._snapshot: dict[int, tuple[bool, int]] = {}

    def is_available(self) -> bool:
        return self._pactl_available

    def start_ducking(self, exempt_pid: int | None = None) -> bool:
        if not self._pactl_available:
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
            thread.join(timeout=1.0)

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
            exempt_pid = self._exempt_pid

        for item in sink_inputs:
            sink_input_index = _to_int(item.get("index"))
            if sink_input_index is None:
                continue

            properties = item.get("properties")
            if not isinstance(properties, dict):
                properties = {}

            sink_pid = _to_int(properties.get("application.process.id"))
            if exempt_pid is not None and sink_pid == exempt_pid:
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
            return []

        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            return []

        if not isinstance(payload, list):
            return []

        outputs: list[dict[str, object]] = []
        for item in payload:
            if isinstance(item, dict):
                outputs.append(item)
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

        return 65536

    def _get_active_window_pid(self) -> int | None:
        if not self._xdotool_available:
            return None

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

    def _run_pactl(
        self,
        args: list[str],
        *,
        check: bool,
        capture_output: bool = False,
        text: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                ["pactl", *args],
                check=check,
                timeout=3,
                capture_output=capture_output,
                text=text,
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
