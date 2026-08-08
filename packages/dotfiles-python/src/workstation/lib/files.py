import os
import stat
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from io import Writer
from pathlib import Path

from workstation.lib.validation import octal_mode, safe_path


@contextmanager
def atomic_binary_writer(
    destination: str | Path,
    mode: int = 0o644,
) -> Iterator[Writer[bytes]]:
    """Write a file beside its destination and atomically replace it on success."""
    destination_path = safe_path(destination)
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w+b",
        prefix=f".{destination_path.name}-",
        dir=destination_path.parent,
        delete_on_close=False,
    ) as temporary:
        os.fchmod(temporary.fileno(), mode)
        # NamedTemporaryFile owns rollback cleanup if the body raises.
        yield temporary  # ruff: ignore[fallible-context-manager]
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary.close()
        Path(temporary.name).replace(destination_path)


def is_executable(path: str | Path) -> bool:
    """Return whether a path names an executable regular file."""
    candidate = Path(path)
    return candidate.is_file() and os.access(candidate, os.X_OK)


def ensure_directory(path: str | Path, mode: int | str | None = None) -> Path:
    result = safe_path(path)
    result.mkdir(parents=True, exist_ok=True)
    if mode is not None:
        result.chmod(octal_mode(mode, label="directory mode"))
    return result


def write_if_changed(
    destination: str | Path,
    content: str | bytes,
    mode: int | str = "0644",
) -> bool:
    destination_path = safe_path(destination)
    data = content.encode() if isinstance(content, str) else content
    parsed_mode = octal_mode(mode, label="file mode")
    if destination_path.is_file():
        current_mode = stat.S_IMODE(destination_path.stat().st_mode)
        if destination_path.read_bytes() == data:
            if current_mode == parsed_mode:
                return False
            destination_path.chmod(parsed_mode)
            return True

    with atomic_binary_writer(destination_path, parsed_mode) as target:
        target.write(data)
    return True
