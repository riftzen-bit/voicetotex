# pyright: reportImplicitRelativeImport=false, reportMissingImports=false
import argparse
import asyncio
import errno
import json
import logging
import os
import secrets
import signal
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

import config
from audio_capture import AudioCapture
from audio_ducker import AudioDucker
from history import TranscriptionHistory
from hotkey import HotkeyListener
from text_injector import TextInjector
from postprocessor import VietnamesePostProcessor
from transcriber import Transcriber
from rewards import RewardsManager


LOGGER = logging.getLogger(__name__)

VALID_STATES = {"loading", "ready", "recording", "processing", "error"}


def _log_task_exception(task: asyncio.Task[object]) -> None:
    """Done-callback that logs unhandled exceptions from fire-and-forget tasks."""
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        LOGGER.error(
            "Unhandled exception in background task %s: %s",
            task.get_name(),
            exc,
            exc_info=exc,
        )


def _to_int(value: object, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _to_float(value: object, default: float) -> float:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return default
    return default


def _to_optional_int(value: object) -> int | None:
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


class VoiceToTexServer:
    def __init__(self, port: int, initial_config: dict[str, object]) -> None:
        self.port = port
        self.config = initial_config
        self._auth_token: str = secrets.token_urlsafe(32)

        self.state = "loading"
        self.state_message = "Initializing"
        self.model_progress: dict[str, object] = {
            "type": "model_progress",
            "stage": "initializing",
            "percent": 0.0,
        }

        self.clients: set[Any] = set()
        self.server: Any | None = None
        self.loop: asyncio.AbstractEventLoop | None = None

        self.audio_capture = AudioCapture()
        self.audio_ducker = AudioDucker()
        self.hotkey_listener = HotkeyListener(
            hotkey_combo=str(self.config.get("hotkey", "ctrl+shift+space")),
            mode=str(self.config.get("hotkey_mode", "hold")),
        )
        self.text_injector = TextInjector()
        self.history = TranscriptionHistory(
            max_entries=_to_int(self.config.get("max_history", 100), 100)
        )
        self.transcriber = Transcriber()
        self.postprocessor = VietnamesePostProcessor()
        self.rewards = RewardsManager()

        self.executor = ThreadPoolExecutor(
            max_workers=3, thread_name_prefix="voicetotex"
        )
        self.shutdown_event = asyncio.Event()

        self._state_lock = asyncio.Lock()
        self._record_lock = asyncio.Lock()
        self._audio_level_task: asyncio.Task[None] | None = None
        self._recording_timeout_task: asyncio.Task[None] | None = None
        self._orphan_watchdog_task: asyncio.Task[None] | None = None
        self._model_load_task: asyncio.Task[None] | None = None
        self._is_shutting_down = False

    async def initialize(self) -> None:
        self.loop = asyncio.get_running_loop()
        self._apply_runtime_config()

        await self._set_state("loading", "Starting WebSocket server")
        try:
            self.server = await websockets.serve(
                self._handle_client, "127.0.0.1", self.port
            )
        except OSError as exc:
            if exc.errno == errno.EADDRINUSE:
                LOGGER.warning("Port %d busy, binding to random free port", self.port)
                self.server = await websockets.serve(
                    self._handle_client, "127.0.0.1", 0
                )
                self.port = self.server.sockets[0].getsockname()[1]
            else:
                raise

        model_name = str(self.config.get("model", "large-v3-turbo"))
        self._model_load_task = asyncio.create_task(
            self._load_model_background(model_name), name="initial-model-load"
        )
        self._model_load_task.add_done_callback(_log_task_exception)

        # Retroactively populate rewards from existing transcription history
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            self.executor,
            lambda: self.rewards.populate_from_history(self.history.get_all()),
        )

        self.hotkey_listener.async_start(
            self.loop, self._on_hotkey_start, self._on_hotkey_stop
        )
        self._orphan_watchdog_task = asyncio.create_task(self._orphan_watchdog_loop())
        self._orphan_watchdog_task.add_done_callback(_log_task_exception)

        print(f"READY:{self.port}:{self._auth_token}", flush=True)

    async def _load_model_background(self, model_name: str) -> None:
        try:
            await self._load_model(model_name)
        except Exception:
            return
        finally:
            self._model_load_task = None

        if not self._is_shutting_down:
            # Notify frontend of actual device (may differ from config after
            # CUDA → CPU fallback) so the UI can display the correct status.
            model_info = self.transcriber.get_model_info()
            await self.broadcast({"type": "model_info", **model_info})
            await self._set_state("ready", "Ready")

    async def _set_state(self, state: str, message: str = "") -> None:
        if state not in VALID_STATES:
            raise ValueError(f"Invalid server state: {state}")

        async with self._state_lock:
            self.state = state
            self.state_message = message

        await self.broadcast(
            {
                "type": "status",
                "state": state,
                "message": message,
            }
        )

    async def _report_error(self, message: str, transition_state: bool = True) -> None:
        LOGGER.error(message)
        if transition_state:
            await self._set_state("error", message)
        await self.broadcast({"type": "error", "message": message})
        if transition_state and not self._is_shutting_down:
            await self._set_state("ready", "Ready")

    async def _send_json(self, websocket: Any, payload: Mapping[str, object]) -> None:
        await websocket.send(json.dumps(payload))

    async def broadcast(self, payload: Mapping[str, object]) -> None:
        if not self.clients:
            return

        message = json.dumps(payload)
        stale_clients: list[Any] = []

        clients_snapshot = tuple(self.clients)
        coroutines = [client.send(message) for client in clients_snapshot]
        results = await asyncio.gather(*coroutines, return_exceptions=True)

        for client, result in zip(clients_snapshot, results):
            if isinstance(result, Exception):
                stale_clients.append(client)

        for client in stale_clients:
            self.clients.discard(client)

    def _schedule_broadcast(self, payload: Mapping[str, object]) -> None:
        if self.loop is None or self.loop.is_closed():
            return
        task = asyncio.create_task(self.broadcast(payload))
        task.add_done_callback(_log_task_exception)

    def _threadsafe_broadcast(self, payload: Mapping[str, object]) -> None:
        if self.loop is None or self.loop.is_closed():
            return
        self.loop.call_soon_threadsafe(self._schedule_broadcast, payload)

    def _on_model_progress(self, stage: str, percent: float) -> None:
        self.model_progress = {
            "type": "model_progress",
            "stage": str(stage),
            "percent": float(percent),
        }
        self._threadsafe_broadcast(self.model_progress)

    async def _load_model(self, model_name: str) -> None:
        await self._set_state("loading", f"Loading model: {model_name}")

        device = str(self.config.get("device", "cuda"))
        compute_type = str(self.config.get("compute_type", "float16"))
        loop = asyncio.get_running_loop()

        timeout_seconds = 900.0
        try:
            await asyncio.wait_for(
                loop.run_in_executor(
                    self.executor,
                    lambda: self.transcriber.load_model(
                        model_name=model_name,
                        device=device,
                        compute_type=compute_type,
                        on_progress=self._on_model_progress,
                    ),
                ),
                timeout=timeout_seconds,
            )
        except asyncio.TimeoutError:
            await self._report_error(
                f"Model load timed out after {int(timeout_seconds)}s ({model_name})"
            )
            raise
        except Exception as exc:
            await self._report_error(f"Failed to load model '{model_name}': {exc}")
            raise

    def _apply_runtime_config(self) -> None:
        audio_device = self.config.get("audio_device")
        if audio_device is not None:
            try:
                parsed_device = _to_optional_int(audio_device)
                if parsed_device is not None:
                    self.audio_capture.set_device(parsed_device)
            except Exception as exc:
                LOGGER.warning(
                    "Failed to apply saved audio device %s: %s", audio_device, exc
                )

        try:
            self.hotkey_listener.set_hotkey(
                str(self.config.get("hotkey", "ctrl+shift+space"))
            )
        except Exception as exc:
            LOGGER.warning("Invalid hotkey in config, keeping default: %s", exc)

        try:
            self.hotkey_listener.set_mode(str(self.config.get("hotkey_mode", "hold")))
        except Exception as exc:
            LOGGER.warning("Invalid hotkey mode in config, keeping default: %s", exc)

    def _on_hotkey_start(self) -> None:
        LOGGER.info("Hotkey start callback received on event loop")
        task = asyncio.create_task(self.start_recording(source="hotkey"))
        task.add_done_callback(_log_task_exception)

    def _on_hotkey_stop(self) -> None:
        LOGGER.info("Hotkey stop callback received on event loop")
        task = asyncio.create_task(self.stop_recording(source="hotkey"))
        task.add_done_callback(_log_task_exception)

    async def start_recording(self, source: str) -> None:
        async with self._record_lock:
            if self._is_shutting_down:
                return

            if self.state == "recording" or self.audio_capture.is_recording():
                await self._report_error(
                    "Recording is already in progress", transition_state=False
                )
                return

            if self.state in {"loading", "processing"}:
                await self._report_error(
                    f"Cannot start recording while state is '{self.state}'",
                    transition_state=False,
                )
                return

            if not self.transcriber.is_loaded():
                await self._report_error(
                    "Model is not loaded yet", transition_state=False
                )
                return

            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                self.executor, self.text_injector.save_focused_window
            )

            await self._set_state("recording", f"Recording started via {source}")
            await asyncio.sleep(0.18)

            _ = await loop.run_in_executor(
                self.executor, self.audio_ducker.start_ducking
            )

            try:
                self.audio_capture.start_recording()
            except Exception as exc:
                _ = await loop.run_in_executor(
                    self.executor, self.audio_ducker.stop_ducking
                )
                await self._report_error(f"Failed to start recording ({source}): {exc}")
                return

            self._cancel_audio_level_task()
            self._audio_level_task = asyncio.create_task(self._audio_level_loop())

            self._cancel_recording_timeout_task()
            max_seconds = _to_float(
                self.config.get("max_recording_seconds", 300), 300.0
            )
            self._recording_timeout_task = asyncio.create_task(
                self._recording_timeout_loop(max_seconds)
            )

    async def _recording_timeout_loop(self, max_seconds: float) -> None:
        try:
            await asyncio.sleep(max_seconds)
            if self.state == "recording" and self.audio_capture.is_recording():
                LOGGER.warning(
                    "Recording exceeded %s seconds — auto-stopping", max_seconds
                )
                await self.broadcast(
                    {
                        "type": "error",
                        "message": f"Recording auto-stopped after {int(max_seconds)}s limit",
                    }
                )
                await self.stop_recording(source="timeout")
        except asyncio.CancelledError:
            raise

    def _cancel_recording_timeout_task(self) -> None:
        if self._recording_timeout_task is not None:
            self._recording_timeout_task.cancel()
            self._recording_timeout_task = None

    async def stop_recording(self, source: str) -> None:
        async with self._record_lock:
            if self._is_shutting_down:
                return

            if self.state != "recording" and not self.audio_capture.is_recording():
                await self._report_error(
                    "No active recording to stop", transition_state=False
                )
                return

            self._cancel_audio_level_task()
            self._cancel_recording_timeout_task()

            loop = asyncio.get_running_loop()
            try:
                audio = self.audio_capture.stop_recording()
            except Exception as exc:
                _ = await loop.run_in_executor(
                    self.executor, self.audio_ducker.stop_ducking
                )
                await self._report_error(f"Failed to stop recording ({source}): {exc}")
                return

            _ = await loop.run_in_executor(
                self.executor, self.audio_ducker.stop_ducking
            )

            await self._set_state("processing", "Transcribing audio")
            await asyncio.sleep(0.18)

        await self._process_audio(audio)

    async def _process_audio(self, audio: Any) -> None:
        if getattr(audio, "size", 0) == 0:
            await self._set_state("ready", "Ready")
            return

        loop = asyncio.get_running_loop()
        language = str(self.config.get("language", "auto"))
        beam_size = _to_int(self.config.get("beam_size", 5), 5)
        vad_threshold = _to_float(self.config.get("vad_threshold", 0.3), 0.3)
        noise_reduction = bool(self.config.get("noise_reduction", True))
        initial_prompt = str(self.config.get("initial_prompt", ""))

        try:
            result = await loop.run_in_executor(
                self.executor,
                lambda: self.transcriber.transcribe(
                    audio,
                    language=language,
                    beam_size=beam_size,
                    vad_threshold=vad_threshold,
                    noise_reduce=noise_reduction,
                    initial_prompt=initial_prompt,
                ),
            )
        except Exception as exc:
            await self._report_error(f"Transcription failed: {exc}")
            return

        if isinstance(result, dict) and result.get("error"):
            await self._report_error(
                str(result.get("error", "Unknown transcription error"))
            )
            return

        raw_text = str(result.get("text", "")).strip()
        language_out = str(result.get("language", language))
        text = self.postprocessor.process(raw_text, language=language_out)
        duration = _to_float(result.get("duration", 0.0), 0.0)
        model_name = str(self.config.get("model", ""))
        segments_data = []
        raw_segments = result.get("segments", [])
        if isinstance(raw_segments, list):
            for seg in raw_segments:
                if isinstance(seg, dict):
                    segments_data.append(
                        {
                            "start": float(seg.get("start", 0)),
                            "end": float(seg.get("end", 0)),
                            "text": str(seg.get("text", "")).strip(),
                        }
                    )

        if text:
            await self._inject_text(text)
            entry_id = await loop.run_in_executor(
                self.executor,
                lambda: self.history.add(
                    text,
                    language_out,
                    duration,
                    model_name,
                    segments=segments_data,
                ),
            )

            timestamp_str = datetime.now().isoformat()
            await loop.run_in_executor(
                self.executor,
                lambda: self.rewards.record_transcription(
                    text, language_out, duration, timestamp_str
                ),
            )

            transcript_payload = {
                "type": "transcript",
                "id": str(entry_id),
                "text": text,
                "language": language_out,
                "duration": duration,
                "timestamp": datetime.now().isoformat(),
                "segments": segments_data,
            }
            await self.broadcast(transcript_payload)

            # Broadcast updated rewards/dashboard data to all clients
            rewards_data = await loop.run_in_executor(
                self.executor, self.rewards.get_rewards
            )
            await self.broadcast({"type": "rewards", "data": rewards_data})

        await self._set_state("ready", "Ready")

    async def _inject_text(self, text: str) -> None:
        mode = str(self.config.get("output_mode", "type"))
        loop = asyncio.get_running_loop()

        _ = await loop.run_in_executor(
            self.executor, self.text_injector.restore_focused_window
        )

        def _run_injection() -> None:
            if mode == "copy":
                _ = self.text_injector.copy_to_clipboard(text)
                return
            if mode == "paste":
                _ = self.text_injector.type_text(text, "clipboard")
                return
            _ = self.text_injector.type_text(text, "type")

        await loop.run_in_executor(self.executor, _run_injection)

    async def _audio_level_loop(self) -> None:
        try:
            while not self._is_shutting_down and self.audio_capture.is_recording():
                level = float(self.audio_capture.get_rms_level())
                await self.broadcast({"type": "audio_level", "level": level})
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._report_error(f"Audio level loop failed: {exc}")

    def _cancel_audio_level_task(self) -> None:
        if self._audio_level_task is not None:
            self._audio_level_task.cancel()
            self._audio_level_task = None

    async def _send_initial_client_payloads(self, websocket: Any) -> None:
        await self._send_json(
            websocket,
            {
                "type": "status",
                "state": self.state,
                "message": self.state_message,
            },
        )

        config_payload = dict(self.config)
        config_payload["model_info"] = self.transcriber.get_model_info()
        config_payload["available_models"] = self.transcriber.list_available_models()
        config_payload["injector_availability"] = self.text_injector.is_available()
        await self._send_json(websocket, {"type": "config", "data": config_payload})

        await self._send_json(websocket, self.model_progress)

        # Send initial rewards/dashboard data
        loop = asyncio.get_running_loop()
        rewards_data = await loop.run_in_executor(
            self.executor, self.rewards.get_rewards
        )
        await self._send_json(websocket, {"type": "rewards", "data": rewards_data})

    async def _authenticate_client(self, websocket: Any) -> bool:
        """Expect an auth message with the correct token within 2 seconds."""
        try:
            raw = await asyncio.wait_for(websocket.recv(), timeout=2.0)
            payload = json.loads(raw)
            if (
                isinstance(payload, dict)
                and payload.get("type") == "auth"
                and secrets.compare_digest(
                    str(payload.get("token", "")), self._auth_token
                )
            ):
                return True
        except (asyncio.TimeoutError, json.JSONDecodeError, Exception):
            pass
        return False

    async def _handle_client(self, websocket: Any) -> None:
        if not await self._authenticate_client(websocket):
            LOGGER.warning("WebSocket client failed authentication; closing connection")
            await websocket.close()
            return

        self.clients.add(websocket)
        try:
            await self._send_initial_client_payloads(websocket)

            async for raw_message in websocket:
                await self._handle_client_message(websocket, raw_message)
        except ConnectionClosed:
            pass
        finally:
            self.clients.discard(websocket)

    async def _handle_client_message(self, websocket: Any, raw_message: str) -> None:
        try:
            payload = json.loads(raw_message)
        except json.JSONDecodeError:
            await self._send_json(
                websocket, {"type": "error", "message": "Invalid JSON"}
            )
            return

        if not isinstance(payload, dict):
            await self._send_json(
                websocket,
                {"type": "error", "message": "Message must be a JSON object"},
            )
            return

        msg_type = payload.get("type")
        if msg_type == "ping":
            await self._send_json(websocket, {"type": "pong"})
            return

        if msg_type != "command":
            await self._send_json(
                websocket, {"type": "error", "message": "Unknown message type"}
            )
            return

        action = payload.get("action")
        if not isinstance(action, str):
            await self._send_json(
                websocket, {"type": "error", "message": "Missing action"}
            )
            return

        await self._execute_command(websocket, action, payload)

    async def _execute_command(
        self, websocket: Any, action: str, payload: dict[str, object]
    ) -> None:
        if action == "start_recording":
            await self.start_recording(source="command")
            return

        if action == "stop_recording":
            await self.stop_recording(source="command")
            return

        if action == "get_devices":
            await self._command_get_devices(websocket)
            return

        if action == "get_history":
            entries = self.history.get_all()
            await self._send_json(websocket, {"type": "history", "entries": entries})
            return

        if action == "clear_history":
            self.history.clear()
            await self.broadcast({"type": "history", "entries": []})
            return

        if action == "delete_history_entry":
            entry_id = payload.get("id")
            if isinstance(entry_id, str) and entry_id:
                self.history.delete(entry_id)
                entries = self.history.get_all()
                await self.broadcast({"type": "history", "entries": entries})
            return

        if action == "update_history_entry":
            entry_id = payload.get("id")
            new_text = payload.get("text")
            if isinstance(entry_id, str) and entry_id and isinstance(new_text, str):
                cleaned_text = new_text.strip()
                if not cleaned_text:
                    await self._send_json(
                        websocket,
                        {"type": "error", "message": "History text cannot be empty"},
                    )
                    return
                loop = asyncio.get_running_loop()
                updated = await loop.run_in_executor(
                    self.executor, lambda: self.history.update(entry_id, cleaned_text)
                )
                if updated:
                    entries = self.history.get_all()
                    await self.broadcast({"type": "history", "entries": entries})
                else:
                    await self._send_json(
                        websocket,
                        {"type": "error", "message": "History entry not found"},
                    )
            return

        if action == "get_config":
            await self._send_json(
                websocket, {"type": "config", "data": dict(self.config)}
            )
            return

        if action == "set_config":
            await self._command_set_config(websocket, payload)
            return

        if action == "switch_model":
            await self._command_switch_model(payload)
            return

        if action == "get_rewards":
            loop = asyncio.get_running_loop()
            rewards_data = await loop.run_in_executor(
                self.executor, self.rewards.get_rewards
            )
            await self._send_json(websocket, {"type": "rewards", "data": rewards_data})
            return

        if action == "annotate_entry":
            entry_id = payload.get("id")
            notes = payload.get("notes")
            tags = payload.get("tags")
            if isinstance(entry_id, str) and entry_id:
                loop = asyncio.get_running_loop()
                annotated = await loop.run_in_executor(
                    self.executor,
                    lambda: self.history.annotate(
                        entry_id,
                        notes=notes if isinstance(notes, str) else None,
                        tags=tags if isinstance(tags, list) else None,
                    ),
                )
                if annotated:
                    entries = self.history.get_all()
                    await self.broadcast({"type": "history", "entries": entries})
            return

        if action == "get_tags":
            loop = asyncio.get_running_loop()
            tags = await loop.run_in_executor(self.executor, self.history.get_all_tags)
            await self._send_json(websocket, {"type": "tags", "tags": tags})
            return

        if action == "shutdown":
            task = asyncio.create_task(self.shutdown("Shutdown requested by client"))
            task.add_done_callback(_log_task_exception)
            return

        await self._send_json(
            websocket, {"type": "error", "message": f"Unknown action: {action}"}
        )

    async def _command_get_devices(self, websocket: Any) -> None:
        loop = asyncio.get_running_loop()
        try:
            devices = await loop.run_in_executor(
                self.executor, self.audio_capture.list_devices
            )
        except Exception as exc:
            await self._send_json(
                websocket,
                {"type": "error", "message": f"Failed to list devices: {exc}"},
            )
            return

        await self._send_json(websocket, {"type": "devices", "list": devices})

    async def _command_set_config(
        self, websocket: Any, payload: dict[str, object]
    ) -> None:
        key = payload.get("key")
        if not isinstance(key, str):
            await self._send_json(
                websocket,
                {"type": "error", "message": "set_config requires string key"},
            )
            return

        value = payload.get("value")
        if not config.set(key, value):
            await self._send_json(
                websocket,
                {"type": "error", "message": f"Invalid config value for key: {key}"},
            )
            return

        self.config = config.load()

        try:
            if key == "audio_device" and value is not None:
                parsed_device = _to_optional_int(value)
                if parsed_device is None:
                    raise ValueError("audio_device must be an integer device id")
                self.audio_capture.set_device(parsed_device)
            elif key == "hotkey":
                self.hotkey_listener.set_hotkey(str(value))
            elif key == "hotkey_mode":
                self.hotkey_listener.set_mode(str(value))
        except Exception as exc:
            await self._report_error(
                f"Config applied but runtime update failed for {key}: {exc}",
                transition_state=False,
            )

        await self.broadcast({"type": "config", "data": dict(self.config)})

    async def _command_switch_model(self, payload: dict[str, object]) -> None:
        model = payload.get("model")
        if not isinstance(model, str) or not model:
            await self._report_error(
                "switch_model requires non-empty model", transition_state=False
            )
            return

        if self._model_load_task is not None and not self._model_load_task.done():
            await self._report_error(
                "Model is still loading. Please wait.", transition_state=False
            )
            return

        loop = asyncio.get_running_loop()
        await self._set_state("loading", f"Switching model to: {model}")

        try:
            await loop.run_in_executor(self.executor, self.transcriber.unload_model)
            await self._load_model(model)
        except Exception as exc:
            await self._report_error(f"Failed to switch model: {exc}")
            return

        _ = config.set("model", model)
        self.config = config.load()
        await self.broadcast({"type": "config", "data": dict(self.config)})
        await self._set_state("ready", "Ready")

    async def _orphan_watchdog_loop(self) -> None:
        try:
            while not self._is_shutting_down:
                await asyncio.sleep(5)
                if os.getppid() == 1:
                    LOGGER.warning("Detected orphan backend process; shutting down")
                    await self.shutdown("Parent process exited")
                    return
        except asyncio.CancelledError:
            raise

    async def shutdown(self, reason: str) -> None:
        if self._is_shutting_down:
            return

        self._is_shutting_down = True
        LOGGER.info("Shutting down server: %s", reason)

        self.shutdown_event.set()
        self._cancel_audio_level_task()
        self._cancel_recording_timeout_task()
        loop = asyncio.get_running_loop()

        if self._orphan_watchdog_task is not None:
            self._orphan_watchdog_task.cancel()
            self._orphan_watchdog_task = None

        if self._model_load_task is not None:
            self._model_load_task.cancel()
            self._model_load_task = None

        if self.audio_capture.is_recording():
            try:
                _ = self.audio_capture.stop_recording()
            except Exception:
                LOGGER.exception("Failed to stop recording during shutdown")

        try:
            _ = await loop.run_in_executor(
                self.executor, self.audio_ducker.stop_ducking
            )
        except Exception:
            LOGGER.exception("Failed to restore app audio during shutdown")

        try:
            self.hotkey_listener.stop()
        except Exception:
            LOGGER.exception("Failed to stop hotkey listener during shutdown")

        try:
            await loop.run_in_executor(self.executor, self.transcriber.unload_model)
        except Exception:
            LOGGER.exception("Failed to unload model during shutdown")

        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()

        if self.clients:
            close_coroutines = [client.close() for client in tuple(self.clients)]
            _ = await asyncio.gather(*close_coroutines, return_exceptions=True)
            self.clients.clear()

        self.executor.shutdown(wait=False, cancel_futures=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="VoiceToTex backend WebSocket server")
    _ = parser.add_argument("--port", type=int, help="Override websocket port")
    _ = parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    return parser.parse_args()


async def async_main() -> None:
    args = parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    loaded_config = config.load()

    port = (
        _to_int(args.port, 8765)
        if args.port is not None
        else _to_int(loaded_config.get("websocket_port", 8765), 8765)
    )
    if args.port is not None:
        _ = config.set("websocket_port", port)
        loaded_config = config.load()

    server = VoiceToTexServer(port=port, initial_config=loaded_config)

    loop = asyncio.get_running_loop()

    def _signal_handler(sig_name: str) -> None:
        task = asyncio.create_task(server.shutdown(f"Received signal {sig_name}"))
        task.add_done_callback(_log_task_exception)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal_handler, sig.name)
        except NotImplementedError:
            pass

    try:
        await server.initialize()
        await server.shutdown_event.wait()
    finally:
        await server.shutdown("Process exiting")


def _preload_cuda_libs() -> None:
    import ctypes
    import site

    search_dirs: list[str] = []
    try:
        search_dirs.extend(site.getsitepackages())
    except AttributeError:
        pass
    try:
        search_dirs.append(site.getusersitepackages())
    except AttributeError:
        pass

    lib_prefixes = ["libcublas.so", "libcublasLt.so"]

    for base in search_dirs:
        nvidia_lib = os.path.join(base, "nvidia", "cublas", "lib")
        if not os.path.isdir(nvidia_lib):
            continue
        for entry in sorted(os.listdir(nvidia_lib), reverse=True):
            if any(entry.startswith(pfx) for pfx in lib_prefixes):
                lib_path = os.path.join(nvidia_lib, entry)
                try:
                    ctypes.CDLL(lib_path, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass
        return


if __name__ == "__main__":
    _preload_cuda_libs()
    asyncio.run(async_main())
