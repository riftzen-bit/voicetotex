import logging
import threading
from typing import Any

import noisereduce as nr
import numpy as np
import scipy.signal
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions


logger = logging.getLogger(__name__)


class Transcriber:
    def __init__(self):
        self._model = None
        self._ready = threading.Event()
        self._lock = threading.Lock()
        self._model_name = None
        self._device = None
        self._compute_type = None

    def load_model(
        self,
        model_name="large-v3-turbo",
        device="cuda",
        compute_type="float16",
        on_progress=None,
    ):
        # Claim the loading slot under the lock, then release before the
        # potentially multi-minute model download so other threads are not
        # blocked for the duration.
        with self._lock:
            self._ready.clear()
            self._model = None
            self._model_name = model_name
            self._device = device
            self._compute_type = compute_type

        if on_progress is not None:
            on_progress("downloading", 10.0)

        if on_progress is not None:
            on_progress("loading", 60.0)

        actual_device = device
        actual_compute = compute_type

        # "auto" mode: prefer CUDA, fall back to CPU
        if actual_device == "auto":
            actual_device = "cpu"
            try:
                import ctranslate2
                if "cuda" in ctranslate2.get_supported_compute_types("cuda"):
                    actual_device = "cuda"
            except Exception:
                pass
            if actual_device == "cpu" and actual_compute == "float16":
                actual_compute = "int8"
            logger.info("Auto device detection: selected %s", actual_device)

        try:
            new_model = WhisperModel(
                model_name,
                device=actual_device,
                compute_type=actual_compute,
            )
        except Exception as exc:
            if actual_device != "cpu":
                logger.warning(
                    "Failed to load model on %s: %s — falling back to CPU",
                    actual_device,
                    exc,
                )
                actual_device = "cpu"
                # float16 is not supported on CPU, use int8 for speed
                if actual_compute == "float16":
                    actual_compute = "int8"

                if on_progress is not None:
                    on_progress("loading_cpu_fallback", 65.0)

                new_model = WhisperModel(
                    model_name,
                    device="cpu",
                    compute_type=actual_compute,
                )
            else:
                raise

        with self._lock:
            self._model = new_model
            self._device = actual_device
            self._compute_type = actual_compute
            self._ready.set()

        if on_progress is not None:
            on_progress("ready", 100.0)

    def transcribe(
        self,
        audio,
        language="auto",
        beam_size=5,
        vad_threshold=0.3,
        noise_reduce=True,
        initial_prompt="",
    ) -> dict[str, object]:
        if not self.is_loaded():
            return {"error": "Model not loaded", "text": ""}

        model = self._model
        if model is None:
            return {"error": "Model not loaded", "text": ""}

        processed = self._preprocess(audio, noise_reduce=noise_reduce)

        # Clamp VAD threshold to a sane range — values above 0.8 reject
        # almost all speech and are almost certainly misconfigured.
        clamped_vad = max(0.1, min(0.8, vad_threshold))
        if clamped_vad != vad_threshold:
            logger.warning(
                "VAD threshold %.2f clamped to %.2f (range 0.1–0.8)",
                vad_threshold,
                clamped_vad,
            )

        vad_options = VadOptions(
            threshold=clamped_vad,
            neg_threshold=0.25,
            min_speech_duration_ms=100,
            min_silence_duration_ms=300,
            speech_pad_ms=600,
            max_speech_duration_s=29,
        )

        try:
            kwargs: dict[str, Any] = {
                "beam_size": beam_size,
                "vad_filter": True,
                "vad_parameters": vad_options,
                "no_speech_threshold": 0.35,
                "log_prob_threshold": -1.0,
                "compression_ratio_threshold": 2.4,
                "condition_on_previous_text": False,
                "temperature": 0.0,
            }

            if language != "auto":
                kwargs["language"] = language

            if initial_prompt:
                kwargs["initial_prompt"] = initial_prompt

            segments, info = model.transcribe(processed, **kwargs)
        except RuntimeError as exc:
            message = str(exc).lower()
            if "cuda" in message and "out of memory" in message:
                logger.exception("CUDA out of memory while transcribing")
                return {"error": "CUDA out of memory", "text": ""}
            raise

        text_chunks = []
        segment_items = []

        for segment in segments:
            segment_text = segment.text.strip()
            if segment_text:
                text_chunks.append(segment_text)
            segment_items.append(
                {
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": segment_text,
                }
            )

        language_out = getattr(info, "language", language if language != "auto" else "")
        language_probability = float(getattr(info, "language_probability", 0.0) or 0.0)
        duration = getattr(info, "duration", None)
        if duration is None:
            duration = float(processed.shape[0]) / 16000.0

        return {
            "text": " ".join(text_chunks).strip(),
            "language": language_out,
            "language_probability": language_probability,
            "duration": float(duration),
            "segments": segment_items,
        }

    def unload_model(self):
        with self._lock:
            self._model = None
            self._ready.clear()

    def is_loaded(self) -> bool:
        return self._ready.is_set() and self._model is not None

    def get_model_info(self) -> dict[str, str]:
        return {
            "model": self._model_name or "",
            "device": self._device or "",
            "compute_type": self._compute_type or "",
        }

    @classmethod
    def list_available_models(cls) -> list[dict[str, str]]:
        return [
            {"name": "large-v3", "size": "~3.1GB"},
            {"name": "large-v2", "size": "~3.1GB"},
            {"name": "large-v3-turbo", "size": "~1.6GB"},
        ]

    def _preprocess(self, audio, noise_reduce):
        samples = np.asarray(audio, dtype=np.float32).copy()

        if samples.ndim != 1:
            raise ValueError("Audio input must be a mono 1D numpy array")

        peak = float(np.max(np.abs(samples))) if samples.size else 0.0
        if peak > 0.0:
            samples = (samples / peak) * 0.95

        samples = samples - np.mean(samples)

        if noise_reduce and samples.size:
            samples = nr.reduce_noise(
                y=samples,
                sr=16000,
                prop_decrease=0.35,
                stationary=True,
            )

        nyquist = 16000.0 / 2.0
        coeffs = scipy.signal.butter(5, 80.0 / nyquist, btype="highpass", output="ba")
        if samples.size > 32 and coeffs is not None and len(coeffs) >= 2:
            b = coeffs[0]
            a = coeffs[1]
            samples = scipy.signal.filtfilt(b, a, samples)

        return samples.astype(np.float32, copy=False)
