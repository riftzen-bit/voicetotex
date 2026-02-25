import re

_VIET_DIACRITICS = frozenset(
    "àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ"
    + "ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝĂĐƠƯẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸ"
)

# Only unambiguous ASCII->diacritics corrections.
# Each key has exactly ONE plausible Vietnamese diacritical form.
_SAFE_CORRECTIONS: dict[str, str] = {
    "duoc": "được",
    "khong": "không",
    "nhieu": "nhiều",
    "truoc": "trước",
    "nguoi": "người",
    "nhung": "nhưng",
    "biet": "biết",
    "viec": "việc",
}

_REPEATED_PHRASE = re.compile(
    r"\b(\w+(?:\s+\w+){0,4})\s+\1(?:\s+\1)*\b", re.IGNORECASE | re.UNICODE
)
_MULTI_SPACE = re.compile(r"\s+")
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([.,!?;:)])")
_NO_SPACE_AFTER_PUNCT = re.compile(r"([.,!?;:])([A-Za-zÀ-ỹ])")
_LEADING_PUNCT = re.compile(r"^[.,;:\s]+")

_TECH_PHRASE_REPLACEMENTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bclaude\s*code\b", re.IGNORECASE), "Claude Code"),
    (re.compile(r"\bcloud\s*code\b", re.IGNORECASE), "Claude Code"),
    (re.compile(r"\bclawde\s*code\b", re.IGNORECASE), "Claude Code"),
    (re.compile(r"\bopen\s*a[\.\-\s]*i\b", re.IGNORECASE), "OpenAI"),
    (re.compile(r"\bopenclaw\b", re.IGNORECASE), "OpenAI"),
    (re.compile(r"\bchat\s*gpt\b", re.IGNORECASE), "ChatGPT"),
    (re.compile(r"\bgithub\s*co[-\s]*pilot\b", re.IGNORECASE), "GitHub Copilot"),
    (re.compile(r"\bvs\s*code\b", re.IGNORECASE), "VS Code"),
    (re.compile(r"\bvscode\b", re.IGNORECASE), "VS Code"),
    (re.compile(r"\bvisual\s+studio\s+code\b", re.IGNORECASE), "VS Code"),
    (re.compile(r"\bnode(?:\.\s*|\s*)js\b", re.IGNORECASE), "Node.js"),
    (re.compile(r"\bnext(?:\.\s*|\s*)js\b", re.IGNORECASE), "Next.js"),
    (re.compile(r"\btype\s*script\b", re.IGNORECASE), "TypeScript"),
    (re.compile(r"\bjava\s*script\b", re.IGNORECASE), "JavaScript"),
    (re.compile(r"\bfig\s*ma\b", re.IGNORECASE), "Figma"),
    (re.compile(r"\bui\s*/\s*ux\b", re.IGNORECASE), "UI/UX"),
)


def _has_diacritics(word: str) -> bool:
    return any(c in _VIET_DIACRITICS for c in word)


class VietnamesePostProcessor:
    def process(self, text: str, language: str = "") -> str:
        if not text or not text.strip():
            return ""

        result = text
        result = self._deduplicate_phrases(result)

        if language in ("vi", "auto", ""):
            result = self._apply_safe_corrections(result)

        result = self._normalize_tech_terms(result)
        result = self._normalize_whitespace(result)
        result = self._normalize_punctuation(result)
        result = self._normalize_tech_terms(result)

        return result.strip()

    def _deduplicate_phrases(self, text: str) -> str:
        return _REPEATED_PHRASE.sub(r"\1", text)

    def _apply_safe_corrections(self, text: str) -> str:
        words = text.split()
        out: list[str] = []
        for word in words:
            if _has_diacritics(word):
                out.append(word)
                continue

            stripped = word.strip(".,!?;:\"'()[]")
            prefix = word[: len(word) - len(word.lstrip(".,!?;:\"'()[]"))]
            suffix = word[len(prefix) + len(stripped) :]

            lower = stripped.lower()
            if lower in _SAFE_CORRECTIONS:
                corrected = _SAFE_CORRECTIONS[lower]
                if stripped and stripped[0].isupper():
                    corrected = corrected[0].upper() + corrected[1:]
                out.append(prefix + corrected + suffix)
            else:
                out.append(word)
        return " ".join(out)

    def _normalize_whitespace(self, text: str) -> str:
        return _MULTI_SPACE.sub(" ", text)

    def _normalize_tech_terms(self, text: str) -> str:
        result = text
        for pattern, replacement in _TECH_PHRASE_REPLACEMENTS:
            result = pattern.sub(replacement, result)
        return result

    def _normalize_punctuation(self, text: str) -> str:
        text = _SPACE_BEFORE_PUNCT.sub(r"\1", text)
        text = _NO_SPACE_AFTER_PUNCT.sub(r"\1 \2", text)
        text = _LEADING_PUNCT.sub("", text)
        return text
