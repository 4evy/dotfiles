import re
import string
from pathlib import Path

from workstation.errors import DotfilesError

_TEMPLATE_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")


def path_component(value: str, *, label: str = "path component") -> str:
    if not value or value in {".", ".."} or "/" in value:
        raise DotfilesError(f"{label} must be a single path component: {value!r}")
    return value


def safe_path(value: str | Path) -> Path:
    path = Path(value)
    if str(path) in {"", "/", "//", ".", ".."} or path.name in {".", ".."}:
        raise DotfilesError(f"refusing unsafe path: {path}")
    return path


def octal_mode(value: str | int, *, label: str = "mode") -> int:
    if type(value) is int:
        if 0 <= value <= 0o7777:
            return value
        raise DotfilesError(f"{label} must be a permission mode: {value}")
    text = str(value)
    if not text or any(character not in string.octdigits for character in text):
        raise DotfilesError(f"{label} must be octal: {value}")
    mode = int(text, 8)
    if mode > 0o7777:
        raise DotfilesError(f"{label} must be a permission mode: {value}")
    return mode


def template_name(value: str) -> str:
    if not _TEMPLATE_NAME.fullmatch(value):
        raise DotfilesError(f"invalid template replacement name: {value}")
    return value
