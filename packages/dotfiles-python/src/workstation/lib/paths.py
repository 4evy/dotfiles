import os
import sysconfig
from contextlib import suppress
from functools import cache
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path

from platformdirs import user_cache_path, user_data_path, user_state_path

_DEVELOPMENT_ASSET_SOURCES = {
    ("apps", "ghostty", "patches"): ("patches", "ghostty"),
    ("apps", "helium"): ("browser",),
    ("desktop", "catppuccin_palette.json"): (
        "packages",
        "dotfiles-python",
        "assets",
        "desktop",
        "catppuccin_palette.json",
    ),
}


def cache_path(*parts: str) -> Path:
    return user_cache_path("dotfiles").joinpath(*parts)


def data_path(*parts: str) -> Path:
    return user_data_path("dotfiles").joinpath(*parts)


def state_path(*parts: str) -> Path:
    return user_state_path("dotfiles").joinpath(*parts)


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


def _installed_asset_roots() -> tuple[Path, ...]:
    data_root = Path(sysconfig.get_path("data")) / "share/dotfiles-python"
    try:
        installed = Path(str(distribution("dotfiles-python").locate_file(""))).resolve()
    except PackageNotFoundError:
        return (data_root,)
    return (
        data_root,
        *(
            parent / "share/dotfiles-python"
            for parent in (installed, *installed.parents)
        ),
    )


@cache
def assets_root() -> Path:
    """Locate runtime assets in an override, installation, or source checkout."""
    configured = os.environ.get("DOTFILES_PYTHON_ASSETS")
    candidates = list(_installed_asset_roots())
    if configured:
        candidates.insert(0, Path(configured).expanduser())
    with suppress(FileNotFoundError):
        candidates.append(repository_root() / "packages/dotfiles-python/assets")
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("could not locate dotfiles-python runtime assets")


def asset_path(*parts: str) -> Path:
    """Return a path beneath the package's runtime assets."""
    installed = assets_root().joinpath(*parts)
    if installed.exists():
        return installed
    with suppress(FileNotFoundError):
        repository = repository_root()
        for prefix, source in _DEVELOPMENT_ASSET_SOURCES.items():
            if parts[: len(prefix)] == prefix:
                return repository.joinpath(*source, *parts[len(prefix) :])
    return installed
