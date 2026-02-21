"""Configuration management for VoiceToTex."""

import json
import logging
import threading
from pathlib import Path
from typing import cast

logger = logging.getLogger(__name__)

DEFAULTS = {
    "model": "large-v3-turbo",
    "language": "auto",
    "device": "cuda",
    "compute_type": "float16",
    "beam_size": 5,
    "output_mode": "paste",
    "hotkey": "ctrl+shift+space",
    "hotkey_mode": "hold",
    "audio_device": None,
    "vad_threshold": 0.3,
    "noise_reduction": True,
    "websocket_port": 8765,
    "initial_prompt": "",
    "max_history": 100,
    "max_recording_seconds": 300,
}

VALID_LANGUAGES = {
    "auto",
    "en",
    "es",
    "fr",
    "de",
    "it",
    "pt",
    "nl",
    "ru",
    "zh",
    "ja",
    "ko",
    "ar",
    "hi",
    "pl",
    "tr",
    "vi",
    "th",
    "sv",
    "da",
    "fi",
    "no",
    "cs",
    "hu",
}

VALID_DEVICES = {"cuda", "cpu", "mps"}
VALID_COMPUTE_TYPES = {"float16", "float32", "int8"}
VALID_OUTPUT_MODES = {"type", "paste", "copy"}
VALID_HOTKEY_MODES = {"hold", "toggle"}

_config_lock = threading.Lock()
_config_path = Path.home() / ".config" / "voicetotex" / "config.json"
_config_cache: dict[str, object] | None = None


def _ensure_config_dir() -> None:
    """Create config directory if it doesn't exist."""
    _config_path.parent.mkdir(parents=True, exist_ok=True)


def _validate_value(key: str, value: object) -> bool:
    """Validate a config value."""
    if key == "beam_size":
        return isinstance(value, int) and 1 <= value <= 10
    elif key == "language":
        return value in VALID_LANGUAGES
    elif key == "device":
        return value in VALID_DEVICES
    elif key == "compute_type":
        return value in VALID_COMPUTE_TYPES
    elif key == "output_mode":
        return value in VALID_OUTPUT_MODES
    elif key == "hotkey_mode":
        return value in VALID_HOTKEY_MODES
    elif key == "vad_threshold":
        return isinstance(value, (int, float)) and 0 <= value <= 1
    elif key == "noise_reduction":
        return isinstance(value, bool)
    elif key == "websocket_port":
        return isinstance(value, int) and 1 <= value <= 65535
    elif key == "max_history":
        return isinstance(value, int) and value > 0
    elif key == "max_recording_seconds":
        return isinstance(value, (int, float)) and value > 0
    elif key == "audio_device":
        return value is None or isinstance(value, (str, int))
    elif key == "model":
        return isinstance(value, str) and len(value) > 0
    elif key == "hotkey":
        return isinstance(value, str) and len(value) > 0
    elif key == "initial_prompt":
        return isinstance(value, str)
    return True


def _load_locked() -> dict[str, object]:
    """Load configuration from file. Caller must hold _config_lock."""
    global _config_cache

    if _config_cache is not None:
        return _config_cache.copy()

    _ensure_config_dir()

    if _config_path.exists():
        try:
            with open(_config_path, "r") as f:
                loaded = json.load(f)
            config = cast(dict[str, object], {**DEFAULTS, **loaded})
            if len(config) != len(loaded):
                try:
                    with open(_config_path, "w") as f:
                        json.dump(config, f, indent=2)
                except IOError:
                    pass
            _config_cache = config
            return config.copy()
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"Failed to load config: {e}. Using defaults.")

    # Create default config file
    defaults_copy = DEFAULTS.copy()
    _config_cache = cast(dict[str, object], defaults_copy)
    try:
        with open(_config_path, "w") as f:
            json.dump(DEFAULTS, f, indent=2)
    except IOError as e:
        logger.error(f"Failed to write default config: {e}")

    return cast(dict[str, object], defaults_copy)


def load() -> dict[str, object]:
    """Load configuration from file. Returns defaults if file doesn't exist."""
    with _config_lock:
        return _load_locked()


def save(config: dict[str, object]) -> None:
    """Save configuration to file."""
    global _config_cache

    with _config_lock:
        _ensure_config_dir()
        try:
            with open(_config_path, "w") as f:
                json.dump(config, f, indent=2)
            _config_cache = config.copy()
        except IOError as e:
            logger.error(f"Failed to save config: {e}")


def get(key: str) -> object:
    """Get a config value by key."""
    config = load()
    return config.get(key, DEFAULTS.get(key))


def set(key: str, value: object) -> bool:
    """Set a config value. Returns True if successful, False if validation fails."""
    if not _validate_value(key, value):
        logger.warning(f"Invalid value for {key}: {value}")
        return False

    global _config_cache

    with _config_lock:
        config = _load_locked()
        config[key] = value
        _ensure_config_dir()
        try:
            with open(_config_path, "w") as f:
                json.dump(config, f, indent=2)
            _config_cache = config.copy()
        except IOError as e:
            logger.error(f"Failed to save config: {e}")
    return True
