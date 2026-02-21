# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnnecessaryIsInstance=false
import asyncio
import fcntl
import logging
import os
import pathlib
import select
import threading

from evdev import InputDevice
from evdev import ecodes


LOGGER = logging.getLogger(__name__)


class HotkeyListener:
    def __init__(
        self, hotkey_combo: str = "ctrl+shift+space", mode: str = "hold"
    ) -> None:
        self._lock: threading.Lock = threading.Lock()
        self._stop_event: threading.Event = threading.Event()
        self._thread: threading.Thread | None = None

        self._devices: list[InputDevice[str]] = []
        self._device_by_fd: dict[int, InputDevice[str]] = {}

        self._on_start_callback: object | None = None
        self._on_stop_callback: object | None = None

        self._pressed_keys: set[int] = set()
        self._combo_groups: list[tuple[int, ...]] = []
        self._combo_satisfied: bool = False
        self._toggle_on: bool = False

        self._mode: str = "hold"
        self.set_mode(mode)
        self.set_hotkey(hotkey_combo)
        self._discover_devices()

    def start(self, on_start_callback: object, on_stop_callback: object) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                LOGGER.debug("Hotkey listener is already running")
                return

            self._on_start_callback = on_start_callback
            self._on_stop_callback = on_stop_callback
            self._stop_event.clear()
            self._combo_satisfied = False
            self._pressed_keys.clear()

            if not self._devices:
                self._discover_devices()

            self._thread = threading.Thread(
                target=self._listen_loop,
                name="HotkeyListener",
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()

        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=1.0)

        with self._lock:
            self._thread = None
            self._close_devices()
            self._pressed_keys.clear()
            self._combo_satisfied = False

    def set_hotkey(self, combo_string: str) -> None:
        combo_groups = self._parse_hotkey(combo_string)
        with self._lock:
            self._combo_groups = combo_groups
            self._combo_satisfied = False
            self._pressed_keys.clear()

    def set_mode(self, mode: str) -> None:
        if mode not in {"hold", "toggle"}:
            raise ValueError("mode must be 'hold' or 'toggle'")

        with self._lock:
            self._mode = mode
            self._combo_satisfied = False
            self._toggle_on = False

    def async_start(
        self, loop: asyncio.AbstractEventLoop, on_start: object, on_stop: object
    ) -> None:
        def start_proxy() -> None:
            if callable(on_start):
                _ = loop.call_soon_threadsafe(on_start)

        def stop_proxy() -> None:
            if callable(on_stop):
                _ = loop.call_soon_threadsafe(on_stop)

        self.start(start_proxy, stop_proxy)

    def _required_keycodes(self) -> set[int]:
        codes: set[int] = set()
        for group in self._combo_groups:
            codes.update(group)
        return codes

    def _discover_devices(self) -> None:
        self._close_devices()

        required = self._required_keycodes()
        if not required:
            LOGGER.warning("No hotkey combo configured — skipping device discovery")
            return

        input_dir = pathlib.Path("/dev/input")
        candidates: list[InputDevice[str]] = []

        for event_path in sorted(input_dir.glob("event*")):
            try:
                device: InputDevice[str] = InputDevice(str(event_path))
            except PermissionError:
                LOGGER.warning(
                    "Permission denied for %s — user may need to be in 'input' group",
                    event_path,
                )
                continue
            except OSError as exc:
                LOGGER.debug("Skipping unreadable input device %s: %s", event_path, exc)
                continue

            capabilities = device.capabilities()
            raw_key_caps = capabilities.get(ecodes.EV_KEY)
            if not isinstance(raw_key_caps, list):
                device.close()
                continue

            key_caps: set[int] = {int(code) for code in raw_key_caps}
            if not key_caps:
                device.close()
                continue

            has_all_combo_keys = all(
                any(alt in key_caps for alt in group) for group in self._combo_groups
            )
            if has_all_combo_keys:
                candidates.append(device)
            else:
                device.close()

        for device in candidates:
            try:
                flags = fcntl.fcntl(device.fd, fcntl.F_GETFL)
                fcntl.fcntl(device.fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
            except OSError as exc:
                LOGGER.warning(
                    "Failed to configure non-blocking device %s: %s",
                    str(device.path),
                    exc,
                )
                _ = device.close()
                continue

            self._devices.append(device)

        self._device_by_fd = {device.fd: device for device in self._devices}

        if self._devices:
            for d in self._devices:
                LOGGER.info(
                    "Hotkey: using device %s (%s) fd=%d",
                    d.name,
                    d.path,
                    d.fd,
                )
        else:
            LOGGER.warning(
                "No input devices found with required keycodes %s in /dev/input. "
                "Ensure the user is in the 'input' group: groups $(whoami)",
                required,
            )

    def _close_devices(self) -> None:
        for device in self._devices:
            try:
                device.close()
            except OSError:
                pass
        self._devices = []
        self._device_by_fd = {}

    def _listen_loop(self) -> None:
        poller = select.poll()

        with self._lock:
            for device in self._devices:
                poller.register(device.fd, select.POLLIN)

        LOGGER.info(
            "Hotkey listener thread started — monitoring %d device(s), combo_groups=%s",
            len(self._devices),
            self._combo_groups,
        )

        poll_count = 0

        while not self._stop_event.is_set():
            if not self._device_by_fd:
                _ = self._stop_event.wait(0.2)
                continue

            try:
                events = poller.poll(200)
            except OSError as exc:
                LOGGER.warning("Input polling failed: %s", exc)
                break

            poll_count += 1
            if poll_count == 1 or poll_count % 500 == 0:
                LOGGER.debug(
                    "Hotkey poll iteration %d, pending events: %d",
                    poll_count,
                    len(events),
                )

            for fd, _ in events:
                device = self._device_by_fd.get(fd)
                if device is None:
                    continue

                try:
                    for event in device.read():
                        event_type = getattr(event, "type", None)
                        event_code = getattr(event, "code", None)
                        event_value = getattr(event, "value", None)

                        if (
                            not isinstance(event_type, int)
                            or event_type != ecodes.EV_KEY
                        ):
                            continue
                        if not isinstance(event_code, int) or not isinstance(
                            event_value, int
                        ):
                            continue

                        LOGGER.debug(
                            "Key event: code=%d value=%d pressed=%s",
                            event_code,
                            event_value,
                            self._pressed_keys,
                        )
                        self._handle_key_event(event_code, event_value)
                except BlockingIOError:
                    continue
                except OSError as exc:
                    LOGGER.warning(
                        "Input device read failed (%s): %s", device.path, exc
                    )
                    try:
                        poller.unregister(fd)
                    except OSError:
                        pass
                    _ = self._device_by_fd.pop(fd, None)
                    with self._lock:
                        try:
                            self._devices.remove(device)
                        except ValueError:
                            pass
                    try:
                        device.close()
                    except OSError:
                        pass

        LOGGER.info("Hotkey listener thread exiting")

    def _handle_key_event(self, keycode: int, value: int) -> None:
        if value == 2:
            return

        trigger_start = False
        trigger_stop = False

        with self._lock:
            if value == 1:
                self._pressed_keys.add(keycode)
            elif value == 0:
                self._pressed_keys.discard(keycode)
            else:
                return

            combo_now = self._is_combo_pressed()

            if self._mode == "hold":
                if combo_now and not self._combo_satisfied:
                    self._combo_satisfied = True
                    trigger_start = True
                elif self._combo_satisfied and not combo_now:
                    self._combo_satisfied = False
                    trigger_stop = True
            else:
                if combo_now and not self._combo_satisfied:
                    self._combo_satisfied = True
                    self._toggle_on = not self._toggle_on
                    if self._toggle_on:
                        trigger_start = True
                    else:
                        trigger_stop = True
                elif self._combo_satisfied and not combo_now:
                    self._combo_satisfied = False

        if trigger_start:
            LOGGER.info("Hotkey combo PRESSED — triggering start callback")
            if callable(self._on_start_callback):
                try:
                    _ = self._on_start_callback()
                except Exception as exc:
                    LOGGER.exception("on_start_callback failed: %s", exc)

        if trigger_stop:
            LOGGER.info("Hotkey combo RELEASED — triggering stop callback")
            if callable(self._on_stop_callback):
                try:
                    _ = self._on_stop_callback()
                except Exception as exc:
                    LOGGER.exception("on_stop_callback failed: %s", exc)

    def _is_combo_pressed(self) -> bool:
        if not self._combo_groups:
            return False
        for group in self._combo_groups:
            if not any(code in self._pressed_keys for code in group):
                return False
        return True

    def _parse_hotkey(self, combo_string: str) -> list[tuple[int, ...]]:
        if not combo_string:
            raise ValueError("hotkey_combo must be a non-empty string")

        groups: list[tuple[int, ...]] = []
        tokens = [
            token.strip().lower() for token in combo_string.split("+") if token.strip()
        ]
        if not tokens:
            raise ValueError("hotkey_combo must contain at least one key")

        alias_map = {
            "ctrl": [int(ecodes.KEY_LEFTCTRL), int(ecodes.KEY_RIGHTCTRL)],
            "control": [int(ecodes.KEY_LEFTCTRL), int(ecodes.KEY_RIGHTCTRL)],
            "shift": [int(ecodes.KEY_LEFTSHIFT), int(ecodes.KEY_RIGHTSHIFT)],
            "alt": [int(ecodes.KEY_LEFTALT), int(ecodes.KEY_RIGHTALT)],
            "space": [int(ecodes.KEY_SPACE)],
            "super": [int(ecodes.KEY_LEFTMETA)],
            "meta": [int(ecodes.KEY_LEFTMETA)],
        }

        for token in tokens:
            if token in alias_map:
                groups.append(tuple(alias_map[token]))
                continue

            if len(token) == 1 and token.isalpha():
                key_name = f"KEY_{token.upper()}"
            elif len(token) == 1 and token.isdigit():
                key_name = f"KEY_{token}"
            else:
                key_name = f"KEY_{token.upper()}"

            keycode = getattr(ecodes, key_name, None)
            if keycode is None:
                raise ValueError(f"Unsupported hotkey token: {token}")
            if not isinstance(keycode, int):
                raise ValueError(f"Unsupported hotkey token: {token}")

            groups.append((int(keycode),))

        return groups
