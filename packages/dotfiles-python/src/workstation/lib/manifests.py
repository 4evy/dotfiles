import os
import sysconfig
from functools import cache
from pathlib import Path

from workstation.errors import DotfilesError


@cache
def manifests_root() -> Path:
    """Locate shared declarative manifests in an override, checkout, or install."""
    configured = os.environ.get("DOTFILES_MANIFESTS")
    candidates = []
    if configured:
        candidates.append(Path(configured).expanduser())
    candidates.extend((
        Path(__file__).resolve().parents[5] / "manifests",
        Path(sysconfig.get_path("data")) / "share/dotfiles-python/manifests",
    ))
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    raise DotfilesError("could not locate dotfiles shared manifests")


def manifest_path(name: str) -> Path:
    """Return one manifest path without permitting traversal outside its root."""
    if Path(name).name != name:
        raise DotfilesError(f"invalid manifest name: {name}")
    path = manifests_root() / name
    if not path.is_file():
        raise DotfilesError(f"shared manifest is missing: {path}")
    return path


def line_manifest(path: Path) -> tuple[str, ...]:
    """Read a non-empty, unique one-value-per-line manifest."""
    try:
        entries = tuple(
            line
            for raw_line in path.read_text(encoding="utf-8").splitlines()
            if (line := raw_line.strip()) and not line.startswith("#")
        )
    except OSError as error:
        raise DotfilesError(f"could not read line manifest {path}: {error}") from error
    if not entries:
        raise DotfilesError(f"line manifest is empty: {path}")
    if len(entries) != len(set(entries)):
        raise DotfilesError(f"line manifest contains duplicate entries: {path}")
    return entries


def listed_files(directory: Path, name: str, *, suffix: str) -> tuple[Path, ...]:
    """Resolve an ordered one-filename-per-line manifest beside its files."""
    manifest = directory / name
    entries = line_manifest(manifest)
    if invalid := next(
        (
            entry
            for entry in entries
            if Path(entry).name != entry or not entry.endswith(suffix)
        ),
        None,
    ):
        raise DotfilesError(f"invalid entry in {manifest}: {invalid}")
    paths = tuple(directory / entry for entry in entries)
    if missing := next((path for path in paths if not path.is_file()), None):
        raise DotfilesError(f"file manifest entry is missing: {missing}")
    unlisted = set(directory.glob(f"*{suffix}")).difference(paths)
    if unlisted:
        names = ", ".join(sorted(path.name for path in unlisted))
        raise DotfilesError(f"files missing from {manifest}: {names}")
    return paths
