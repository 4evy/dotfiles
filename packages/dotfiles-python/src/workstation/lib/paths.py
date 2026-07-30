import os
import sysconfig
from contextlib import suppress
from functools import cache
from pathlib import Path

from platformdirs import PlatformDirs

_DIRECTORIES = PlatformDirs("dotfiles")


def cache_path(*parts: str) -> Path:
    return _DIRECTORIES.user_cache_path.joinpath(*parts)


def data_path(*parts: str) -> Path:
    return _DIRECTORIES.user_data_path.joinpath(*parts)


def state_path(*parts: str) -> Path:
    return _DIRECTORIES.user_state_path.joinpath(*parts)


def state_path_for_home(home: Path, *parts: str) -> Path:
    configured = os.environ.get("XDG_STATE_HOME")
    root = Path(configured).expanduser() if configured else home / ".local/state"
    return root.joinpath("dotfiles", *parts)


def find_repo_root(start: str | Path) -> Path:
    current = Path(start).expanduser().resolve()
    if current.is_file():
        current = current.parent
    for candidate in (current, *current.parents):
        if (candidate / "pyproject.toml").is_file() and (
            candidate / "ansible"
        ).is_dir():
            return candidate
    raise FileNotFoundError(f"could not find dotfiles repository root from {start}")


@cache
def repository_root() -> Path:
    """Return the development repository containing the workstation sources."""
    return find_repo_root(Path(__file__))


def installed_data_roots() -> tuple[Path, ...]:
    """Return possible share/dotfiles-python roots for this installation."""
    data_root = Path(sysconfig.get_path("data")) / "share/dotfiles-python"
    installed = Path(__file__).resolve()
    return (
        data_root,
        *(
            parent / "share/dotfiles-python"
            for parent in (installed.parent, *installed.parents)
        ),
    )


@cache
def assets_root() -> Path:
    """Locate runtime assets in an override, installation, or source checkout."""
    configured = os.environ.get("DOTFILES_PYTHON_ASSETS")
    candidates = list(installed_data_roots())
    if configured:
        candidates.insert(0, Path(configured).expanduser())
    with suppress(FileNotFoundError):
        candidates.append(repository_root() / "packages/dotfiles-python/assets")
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("could not locate dotfiles-python runtime assets")


def asset_path(
    *parts: str,
    development_source: tuple[str, ...] | None = None,
) -> Path:
    """Return a path beneath the package's runtime assets."""
    installed = assets_root().joinpath(*parts)
    if installed.exists():
        return installed
    with suppress(FileNotFoundError):
        repository = repository_root()
        source_asset = repository.joinpath(
            "packages",
            "dotfiles-python",
            "assets",
            *parts,
        )
        if source_asset.exists():
            return source_asset
        if development_source is not None:
            return repository.joinpath(*development_source)
    return installed
