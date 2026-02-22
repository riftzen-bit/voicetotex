# pyright: reportMissingTypeStubs=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportAny=false
import logging
import threading

import numpy as np
import scipy.signal
import sounddevice as sd


LOGGER = logging.getLogger(__name__)


class AudioCapture:
    def __init__(self, device_id: int | None = None, sample_rate: int = 16000):
        self._device_id: int | None = device_id
        self._requested_sample_rate: float = float(sample_rate)
        self._active_sample_rate: float = float(sample_rate)
        self._stream: sd.InputStream | None = None
        self._buffer: list[np.ndarray] = []
        self._current_rms: float = 0.0
        self._recording: bool = False
        self._lock: threading.Lock = threading.Lock()

    def _audio_callback(
        self, indata: np.ndarray, frames: int, time_info: object, status: object
    ) -> None:
        del frames, time_info
        if status:
            LOGGER.warning("Audio stream status: %s", status)

        block = np.asarray(indata[:, 0], dtype=np.float32).copy()
        rms = float(np.sqrt(np.mean(block * block))) if block.size else 0.0

        with self._lock:
            if not self._recording:
                return
            self._buffer.append(block)
            if rms > 1e-6:
                db = 20.0 * np.log10(rms)
                normalized = max(0.0, (db + 60.0) / 60.0)
            else:
                normalized = 0.0
            self._current_rms = max(0.0, min(1.0, normalized))

    def _create_stream(self, samplerate: float):
        return sd.InputStream(
            device=self._device_id,
            channels=1,
            samplerate=float(samplerate),
            dtype="float32",
            blocksize=1600,
            latency="low",
            callback=self._audio_callback,
        )

    def start_recording(self) -> None:
        with self._lock:
            if self._recording:
                raise RuntimeError("Recording is already in progress.")
            self._buffer = []
            self._current_rms = 0.0

        stream = None
        used_samplerate = self._requested_sample_rate

        try:
            stream = self._create_stream(used_samplerate)
        except sd.PortAudioError as exc:
            try:
                device_info = sd.query_devices(self._device_id, "input")
                fallback_rate = float(device_info["default_samplerate"])
            except sd.PortAudioError as query_exc:
                LOGGER.exception("Failed to query input device details.")
                raise RuntimeError(
                    "Could not start microphone recording. Failed to inspect input device."
                ) from query_exc

            if fallback_rate != used_samplerate:
                LOGGER.info(
                    "Device does not accept %s Hz; using default %s Hz instead.",
                    used_samplerate,
                    fallback_rate,
                )
                try:
                    stream = self._create_stream(fallback_rate)
                    used_samplerate = fallback_rate
                except sd.PortAudioError as fallback_exc:
                    LOGGER.exception("Failed to start input stream at fallback rate.")
                    raise RuntimeError(
                        "Could not start microphone recording. Check audio device permissions and format support."
                    ) from fallback_exc
            else:
                LOGGER.exception("Failed to start input stream.")
                raise RuntimeError(
                    "Could not start microphone recording. Check audio device permissions and format support."
                ) from exc

        try:
            with self._lock:
                self._stream = stream
                self._recording = True
                self._active_sample_rate = float(used_samplerate)
            stream.start()
        except sd.PortAudioError as exc:
            LOGGER.exception("Failed while starting input stream.")
            with self._lock:
                self._stream = None
                self._recording = False
            try:
                stream.close()
            except sd.PortAudioError:
                LOGGER.exception("Failed to close stream after start error.")
            raise RuntimeError(
                "Could not start microphone recording. Audio backend returned an error."
            ) from exc

    def stop_recording(self) -> np.ndarray:
        with self._lock:
            stream = self._stream
            if not self._recording or stream is None:
                self._buffer = []
                self._current_rms = 0.0
                return np.empty(0, dtype=np.float32)
            # Clear both flags atomically so no other thread sees a
            # partially-stopped state (stream still set but recording False
            # or vice-versa).
            self._recording = False
            self._stream = None

        try:
            stream.stop()
            stream.close()
        except sd.PortAudioError as exc:
            LOGGER.exception("Failed to stop input stream cleanly.")
            raise RuntimeError("Could not stop microphone recording cleanly.") from exc
        finally:
            with self._lock:
                blocks = self._buffer
                self._buffer = []
                self._current_rms = 0.0

        if blocks:
            audio = np.concatenate(blocks).astype(np.float32, copy=False)

            # Resample to the target rate if captured at a different rate.
            # Whisper expects 16 kHz; many USB mics only support 44.1/48 kHz.
            with self._lock:
                captured_rate = self._active_sample_rate
            target_rate = self._requested_sample_rate
            if captured_rate != target_rate and captured_rate > 0:
                num_target_samples = int(
                    round(len(audio) * target_rate / captured_rate)
                )
                if num_target_samples > 0:
                    LOGGER.debug(
                        "Resampling %d samples from %.0f Hz to %.0f Hz",
                        len(audio),
                        captured_rate,
                        target_rate,
                    )
                    audio = scipy.signal.resample(audio, num_target_samples).astype(
                        np.float32, copy=False
                    )

            return np.ascontiguousarray(audio, dtype=np.float32)
        return np.empty(0, dtype=np.float32)

    def get_rms_level(self) -> float:
        with self._lock:
            return float(self._current_rms)

    def is_recording(self) -> bool:
        with self._lock:
            return self._recording

    def list_devices(self) -> list[dict[str, int | str | float]]:
        try:
            devices = sd.query_devices()
        except sd.PortAudioError as exc:
            LOGGER.exception("Failed to list audio devices.")
            raise RuntimeError("Could not list audio input devices.") from exc

        input_devices: list[dict[str, int | str | float]] = []
        for index, device in enumerate(devices):
            channels = int(device.get("max_input_channels", 0))
            if channels <= 0:
                continue
            input_devices.append(
                {
                    "id": int(index),
                    "name": str(device.get("name", "Unknown")),
                    "channels": channels,
                    "default_samplerate": float(device.get("default_samplerate", 0.0)),
                }
            )
        return input_devices

    def set_device(self, device_id: int) -> None:
        with self._lock:
            if self._recording:
                raise RuntimeError("Cannot change input device while recording.")

        try:
            info = sd.query_devices(device_id, "input")
        except sd.PortAudioError as exc:
            LOGGER.exception("Invalid input device selection: %s", device_id)
            raise RuntimeError(f"Input device {device_id} is not available.") from exc

        if int(info.get("max_input_channels", 0)) <= 0:
            raise RuntimeError(f"Device {device_id} is not an input device.")

        with self._lock:
            self._device_id = int(device_id)
