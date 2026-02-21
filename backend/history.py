"""Transcription history management for VoiceToTex."""

import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import cast
from uuid import uuid4

logger = logging.getLogger(__name__)

_history_lock = threading.Lock()
_history_path = Path.home() / ".config" / "voicetotex" / "history.json"

_ENTRY_SCHEMA: dict[str, type | tuple[type, ...]] = {
    "id": str,
    "text": str,
    "language": str,
    "duration": (int, float),
    "timestamp": str,
    "model": str,
    "segments": list,
}


def _validate_entry(entry: object) -> bool:
    """Return True if entry is a dict with all required fields and correct types."""
    if not isinstance(entry, dict):
        return False
    for field, expected_types in _ENTRY_SCHEMA.items():
        if field == "segments":
            continue
        value = entry.get(field)
        if value is None or not isinstance(value, expected_types):
            return False
    return True


class TranscriptionHistory:
    """Manages transcription history with thread-safe operations."""

    def __init__(self, max_entries: int = 100) -> None:
        """Initialize history manager.

        Args:
            max_entries: Maximum number of entries to keep (default: 100)
        """
        self.max_entries = max_entries
        self._entries: list[dict[str, object]] = []
        self._load_internal()

    def _ensure_history_dir(self) -> None:
        """Create history directory if it doesn't exist."""
        _history_path.parent.mkdir(parents=True, exist_ok=True)

    def _load_internal(self) -> None:
        """Load history from file (internal, no lock). Start empty if file doesn't exist or is corrupted."""
        self._ensure_history_dir()

        if _history_path.exists():
            try:
                with open(_history_path, "r") as f:
                    data = json.load(f)
                if isinstance(data, list):
                    valid = [e for e in data if _validate_entry(e)]
                    dropped = len(data) - len(valid)
                    if dropped:
                        logger.warning(
                            "Dropped %d malformed history entry/entries on load.",
                            dropped,
                        )
                    self._entries = valid
                else:
                    logger.warning("History file format invalid. Starting empty.")
                    self._entries = []
            except (json.JSONDecodeError, IOError) as e:
                logger.warning(f"Failed to load history: {e}. Starting empty.")
                self._entries = []
        else:
            self._entries = []

    def _save_internal(self) -> None:
        """Save history to file (internal, no lock)."""
        self._ensure_history_dir()
        try:
            with open(_history_path, "w") as f:
                json.dump(self._entries, f, indent=2)
        except IOError as e:
            logger.error(f"Failed to save history: {e}")

    def add(
        self,
        text: str,
        language: str,
        duration: float,
        model: str,
        segments: list[dict[str, object]] | None = None,
    ) -> str:
        """Add a new transcription entry.

        Args:
            text: Transcribed text
            language: Language code
            duration: Duration in seconds
            model: Model name used
            segments: Optional transcript segments with start/end/text

        Returns:
            Entry ID (UUID string)
        """
        with _history_lock:
            entry_id = str(uuid4())
            entry = cast(
                dict[str, object],
                {
                    "id": entry_id,
                    "text": text,
                    "language": language,
                    "duration": duration,
                    "timestamp": datetime.now().isoformat(),
                    "model": model,
                    "segments": segments or [],
                },
            )
            self._entries.append(entry)

            # Keep only the last max_entries
            if len(self._entries) > self.max_entries:
                self._entries = self._entries[-self.max_entries :]

            self._save_internal()
            return entry_id

    def get_all(self) -> list[dict[str, object]]:
        """Get all history entries.

        Returns:
            List of history entries (newest first)
        """
        with _history_lock:
            return list(reversed(self._entries))

    def delete(self, entry_id: str) -> bool:
        """Delete a history entry by ID.

        Args:
            entry_id: UUID of the entry to delete

        Returns:
            True if entry was deleted, False if not found
        """
        with _history_lock:
            original_len = len(self._entries)
            self._entries = [e for e in self._entries if e.get("id") != entry_id]

            if len(self._entries) < original_len:
                self._save_internal()
                return True
            return False

    def update(self, entry_id: str, text: str) -> bool:
        """Update the text of an existing history entry.

        Args:
            entry_id: UUID of the entry to update
            text: New text content

        Returns:
            True if entry was updated, False if not found
        """
        with _history_lock:
            for entry in self._entries:
                if entry.get("id") == entry_id:
                    entry["text"] = text
                    self._save_internal()
                    return True
            return False

    def clear(self) -> None:
        """Clear all history entries."""
        with _history_lock:
            self._entries = []
            self._save_internal()
