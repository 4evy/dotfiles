import filecmp
import os
import shutil
import stat
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from io import Writer
from pathlib import Path

from workstation.errors import DotfilesError
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


def require_file(path: str | Path) -> Path:
    result = Path(path)
    if not result.is_file():
        raise DotfilesError(f"required file does not exist: {result}")
    return result


def require_directory(path: str | Path) -> Path:
    result = Path(path)
    if not result.is_dir():
        raise DotfilesError(f"required directory does not exist: {result}")
    return result


def require_executable(path: str | Path) -> Path:
    result = Path(path)
    if not is_executable(result):
        raise DotfilesError(
            f"required executable does not exist or is not executable: {result}"
        )
    return result


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


def remove_path(path: str | Path) -> None:
    """Remove a file, symlink, or directory tree if it exists."""
    target = safe_path(path)
    if target.is_dir(follow_symlinks=False):
        shutil.rmtree(target)
    else:
        target.unlink(missing_ok=True)


def fresh_directory(path: str | Path, mode: int | str | None = None) -> Path:
    result = safe_path(path)
    remove_path(result)
    return ensure_directory(result, mode)


def install_file_if_changed(
    source: str | Path,
    destination: str | Path,
    mode: int | str = "0644",
) -> bool:
    source_path = require_file(source)
    destination_path = safe_path(destination)
    parsed_mode = octal_mode(mode, label="file mode")
    if files_match(source_path, destination_path, mode=parsed_mode):
        return False

    with (
        atomic_binary_writer(destination_path, parsed_mode) as target,
        source_path.open("rb") as source_file,
    ):
        shutil.copyfileobj(source_file, target)
    return True


def files_match(
    source: str | Path,
    destination: str | Path,
    *,
    mode: int | str | None = None,
) -> bool:
    """Compare regular-file content and, when requested, destination mode."""
    source_path = Path(source)
    destination_path = Path(destination)
    if (
        not source_path.is_file()
        or not destination_path.is_file()
        or not filecmp.cmp(source_path, destination_path, shallow=False)
    ):
        return False
    if mode is None:
        return True
    parsed_mode = octal_mode(mode, label="file mode")
    return stat.S_IMODE(destination_path.stat().st_mode) == parsed_mode


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


def replace_directory(source: str | Path, destination: str | Path) -> None:
    source_path = require_directory(source)
    destination_path = safe_path(destination)
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{destination_path.name}-", dir=destination_path.parent
    ) as temporary_root:
        temporary_path = Path(temporary_root) / destination_path.name
        source_path.copy(temporary_path, follow_symlinks=False, preserve_metadata=True)
        remove_path(destination_path)
        temporary_path.replace(destination_path)
