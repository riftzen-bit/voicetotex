# pyright: reportImplicitRelativeImport=false, reportMissingImports=false

import json
import logging
import threading
from collections.abc import Callable
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_rewards_lock = threading.Lock()
_rewards_path = Path.home() / ".config" / "voicetotex" / "rewards.json"

_BadgeCheck = Callable[[dict[str, Any]], bool]
_BadgeProgress = Callable[[dict[str, Any]], float]

_BADGE_DEFINITIONS: list[dict[str, Any]] = [
    {
        "id": "first_transcription",
        "title": "First Words",
        "description": "Complete your first transcription",
        "icon": "mic",
        "check": lambda s: s["total_transcriptions"] >= 1,
        "progress": lambda s: min(1.0, s["total_transcriptions"] / 1),
    },
    {
        "id": "ten_transcriptions",
        "title": "Getting Warm",
        "description": "Complete 10 transcriptions",
        "icon": "mic",
        "check": lambda s: s["total_transcriptions"] >= 10,
        "progress": lambda s: min(1.0, s["total_transcriptions"] / 10),
    },
    {
        "id": "fifty_transcriptions",
        "title": "On a Roll",
        "description": "Complete 50 transcriptions",
        "icon": "mic",
        "check": lambda s: s["total_transcriptions"] >= 50,
        "progress": lambda s: min(1.0, s["total_transcriptions"] / 50),
    },
    {
        "id": "hundred_transcriptions",
        "title": "Transcription Titan",
        "description": "Complete 100 transcriptions",
        "icon": "mic",
        "check": lambda s: s["total_transcriptions"] >= 100,
        "progress": lambda s: min(1.0, s["total_transcriptions"] / 100),
    },
    {
        "id": "three_day_streak",
        "title": "Spark",
        "description": "Maintain a 3-day streak",
        "icon": "flame",
        "check": lambda s: s["longest_streak"] >= 3,
        "progress": lambda s: min(1.0, s["longest_streak"] / 3),
    },
    {
        "id": "seven_day_streak",
        "title": "Week Warrior",
        "description": "Maintain a 7-day streak",
        "icon": "flame",
        "check": lambda s: s["longest_streak"] >= 7,
        "progress": lambda s: min(1.0, s["longest_streak"] / 7),
    },
    {
        "id": "thirty_day_streak",
        "title": "Unbreakable",
        "description": "Maintain a 30-day streak",
        "icon": "flame",
        "check": lambda s: s["longest_streak"] >= 30,
        "progress": lambda s: min(1.0, s["longest_streak"] / 30),
    },
    {
        "id": "thousand_words",
        "title": "Word Smith",
        "description": "Transcribe 1,000 words",
        "icon": "book",
        "check": lambda s: s["total_words"] >= 1000,
        "progress": lambda s: min(1.0, s["total_words"] / 1000),
    },
    {
        "id": "ten_thousand_words",
        "title": "Lexicon Builder",
        "description": "Transcribe 10,000 words",
        "icon": "book",
        "check": lambda s: s["total_words"] >= 10000,
        "progress": lambda s: min(1.0, s["total_words"] / 10000),
    },
    {
        "id": "polyglot",
        "title": "Polyglot",
        "description": "Use 3+ languages",
        "icon": "globe",
        "check": lambda s: len(s.get("all_languages", set())) >= 3,
        "progress": lambda s: min(1.0, len(s.get("all_languages", set())) / 3),
    },
    {
        "id": "night_owl",
        "title": "Night Owl",
        "description": "Transcribe late at night",
        "icon": "moon",
        "check": lambda s: s.get("night_owl", False),
        "progress": lambda s: 1.0 if s.get("night_owl", False) else 0.0,
    },
    {
        "id": "early_bird",
        "title": "Early Bird",
        "description": "Transcribe before sunrise",
        "icon": "sun",
        "check": lambda s: s.get("early_bird", False),
        "progress": lambda s: 1.0 if s.get("early_bird", False) else 0.0,
    },
]


def _to_date_key(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def _default_state() -> dict[str, Any]:
    return {
        "total_transcriptions": 0,
        "total_words": 0,
        "total_duration": 0.0,
        "all_languages": [],
        "night_owl": False,
        "early_bird": False,
        "daily_log": {},
        "badges": {},
    }


class RewardsManager:
    def __init__(self) -> None:
        self._state: dict[str, Any] = _default_state()
        self._load()

    def populate_from_history(self, entries: list[dict[str, Any]]) -> None:
        """Retroactively populate rewards from existing history entries.

        Only processes entries whose dates are not already in daily_log,
        so running this multiple times is safe (idempotent).
        """
        if not entries:
            return

        daily_log = self._state.get("daily_log", {})
        if not isinstance(daily_log, dict):
            daily_log = {}

        existing_dates = set(daily_log.keys())
        new_entries = []
        for entry in entries:
            ts = entry.get("timestamp", "")
            if not isinstance(ts, str) or not ts:
                continue
            day_key = ts[:10]  # YYYY-MM-DD
            if day_key not in existing_dates:
                new_entries.append(entry)

        if not new_entries:
            return

        for entry in new_entries:
            text = str(entry.get("text", ""))
            language = str(entry.get("language", ""))
            duration = float(entry.get("duration", 0.0))
            timestamp = str(entry.get("timestamp", ""))
            self.record_transcription(text, language, duration, timestamp)

        logger.info(
            "Retroactively populated rewards from %d history entries.",
            len(new_entries),
        )

    def _ensure_dir(self) -> None:
        _rewards_path.parent.mkdir(parents=True, exist_ok=True)

    def _load(self) -> None:
        self._ensure_dir()
        if _rewards_path.exists():
            try:
                with open(_rewards_path, "r") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    self._state = data
                else:
                    logger.warning("Rewards file invalid format, starting fresh.")
                    self._state = _default_state()
            except (json.JSONDecodeError, IOError) as e:
                logger.warning("Failed to load rewards: %s. Starting fresh.", e)
                self._state = _default_state()
        else:
            self._state = _default_state()

    def _save(self) -> None:
        self._ensure_dir()
        try:
            with open(_rewards_path, "w") as f:
                json.dump(self._state, f, indent=2)
        except IOError as e:
            logger.error("Failed to save rewards: %s", e)

    def record_transcription(
        self,
        text: str,
        language: str,
        duration: float,
        timestamp: str,
    ) -> dict[str, Any]:
        with _rewards_lock:
            word_count = len(text.split()) if text else 0

            self._state["total_transcriptions"] = (
                self._state.get("total_transcriptions", 0) + 1
            )
            self._state["total_words"] = self._state.get("total_words", 0) + word_count
            self._state["total_duration"] = (
                self._state.get("total_duration", 0.0) + duration
            )

            all_langs = set(self._state.get("all_languages", []))
            if language and language != "auto":
                all_langs.add(language)
            self._state["all_languages"] = sorted(all_langs)

            try:
                dt = datetime.fromisoformat(timestamp)
            except (ValueError, TypeError):
                dt = datetime.now()

            hour = dt.hour
            if 0 <= hour < 5:
                self._state["night_owl"] = True
            if 5 <= hour < 7:
                self._state["early_bird"] = True

            day_key = _to_date_key(dt)
            daily_log = self._state.get("daily_log", {})
            if not isinstance(daily_log, dict):
                daily_log = {}

            day_entry = daily_log.get(day_key, {})
            if not isinstance(day_entry, dict):
                day_entry = {}

            day_entry["count"] = day_entry.get("count", 0) + 1
            day_entry["words"] = day_entry.get("words", 0) + word_count
            day_entry["duration"] = day_entry.get("duration", 0.0) + duration

            day_languages = day_entry.get("languages", [])
            if not isinstance(day_languages, list):
                day_languages = []
            if language and language not in day_languages:
                day_languages.append(language)
            day_entry["languages"] = day_languages

            daily_log[day_key] = day_entry
            self._state["daily_log"] = daily_log

            newly_earned = self._check_badges()

            self._save()
            return {"newly_earned": newly_earned}

    def _check_badges(self) -> list[str]:
        badges_state = self._state.get("badges", {})
        if not isinstance(badges_state, dict):
            badges_state = {}

        check_ctx: dict[str, Any] = dict(self._state)
        check_ctx["all_languages"] = set(self._state.get("all_languages", []))

        streaks = self._compute_streaks()
        check_ctx["current_streak"] = streaks["current_streak"]
        check_ctx["longest_streak"] = streaks["longest_streak"]

        newly_earned: list[str] = []
        for badge_def in _BADGE_DEFINITIONS:
            badge_id: str = badge_def["id"]
            if badge_id in badges_state and badges_state[badge_id].get("earned"):
                continue
            check_fn: _BadgeCheck = badge_def["check"]
            if check_fn(check_ctx):
                badges_state[badge_id] = {
                    "earned": True,
                    "earned_at": datetime.now().isoformat(),
                }
                newly_earned.append(badge_id)

        self._state["badges"] = badges_state
        return newly_earned

    def _compute_streaks(self) -> dict[str, int]:
        daily_log = self._state.get("daily_log", {})
        if not daily_log:
            return {"current_streak": 0, "longest_streak": 0, "total_active_days": 0}

        active_dates = sorted(daily_log.keys())
        if not active_dates:
            return {"current_streak": 0, "longest_streak": 0, "total_active_days": 0}

        total_active_days = len(active_dates)

        parsed_dates: list[date] = []
        for d in active_dates:
            try:
                parsed_dates.append(datetime.strptime(d, "%Y-%m-%d").date())
            except ValueError:
                continue

        if not parsed_dates:
            return {
                "current_streak": 0,
                "longest_streak": 0,
                "total_active_days": total_active_days,
            }

        parsed_dates.sort()
        date_set = set(parsed_dates)

        longest = 1
        current = 1
        for i in range(1, len(parsed_dates)):
            if parsed_dates[i] - parsed_dates[i - 1] == timedelta(days=1):
                current += 1
                longest = max(longest, current)
            else:
                current = 1
        longest = max(longest, current)

        today = datetime.now().date()
        current_streak = 0
        check_date = today
        while check_date in date_set:
            current_streak += 1
            check_date -= timedelta(days=1)

        if current_streak == 0:
            yesterday = today - timedelta(days=1)
            check_date = yesterday
            while check_date in date_set:
                current_streak += 1
                check_date -= timedelta(days=1)

        return {
            "current_streak": current_streak,
            "longest_streak": longest,
            "total_active_days": total_active_days,
        }

    def get_rewards(self) -> dict[str, Any]:
        with _rewards_lock:
            streaks = self._compute_streaks()

            badges_state = self._state.get("badges", {})
            if not isinstance(badges_state, dict):
                badges_state = {}

            check_ctx: dict[str, Any] = dict(self._state)
            check_ctx["all_languages"] = set(self._state.get("all_languages", []))
            check_ctx["current_streak"] = streaks["current_streak"]
            check_ctx["longest_streak"] = streaks["longest_streak"]

            badges_list = []
            for badge_def in _BADGE_DEFINITIONS:
                badge_id: str = badge_def["id"]
                saved = badges_state.get(badge_id, {})
                earned = bool(saved.get("earned", False))
                progress_fn: _BadgeProgress = badge_def["progress"]
                progress = progress_fn(check_ctx)

                badges_list.append(
                    {
                        "id": badge_id,
                        "title": badge_def["title"],
                        "description": badge_def["description"],
                        "icon": badge_def["icon"],
                        "earned": earned,
                        "progress": progress,
                        "earned_at": saved.get("earned_at"),
                    }
                )

            return {
                "current_streak": streaks["current_streak"],
                "longest_streak": streaks["longest_streak"],
                "total_active_days": streaks["total_active_days"],
                "total_transcriptions": self._state.get("total_transcriptions", 0),
                "total_words": self._state.get("total_words", 0),
                "total_duration": self._state.get("total_duration", 0.0),
                "badges": badges_list,
                "daily_log": self._state.get("daily_log", {}),
            }
