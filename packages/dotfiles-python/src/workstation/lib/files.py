import filecmp
import os
import shutil
import stat
import tarfile
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
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w+b",
            prefix=f".{destination_path.name}-",
            dir=destination_path.parent,
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            os.fchmod(temporary.fileno(), mode)
            yield temporary
            temporary.flush()
            os.fsync(temporary.fileno())
        temporary_path.replace(destination_path)
    except BaseException:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise


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
    if not result.is_file() or not os.access(result, os.X_OK):
        raise DotfilesError(
            f"required executable does not exist or is not executable: {result}"
        )
    return result


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


def extract_tar_archive(archive: tarfile.TarFile, destination: str | Path) -> None:
    """Extract an archive using Python 3.14's hardened data filter."""
    archive.extractall(ensure_directory(destination), filter="data")


def install_file_if_changed(
    source: str | Path,
    destination: str | Path,
    mode: int | str = "0644",
) -> bool:
    source_path = require_file(source)
    destination_path = safe_path(destination)
    parsed_mode = octal_mode(mode, label="file mode")
    content_matches = destination_path.is_file() and filecmp.cmp(
        source_path, destination_path, shallow=False
    )
    mode_matches = (
        content_matches and stat.S_IMODE(destination_path.stat().st_mode) == parsed_mode
    )
    if content_matches and mode_matches:
        return False

    with (
        atomic_binary_writer(destination_path, parsed_mode) as target,
        source_path.open("rb") as source_file,
    ):
        shutil.copyfileobj(source_file, target)
    return True


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
