import json
import os
import platform
import tempfile
from pathlib import Path
from typing import cast

from cyclopts import App
from filelock import FileLock

from workstation import __version__
from workstation.console import error_console
from workstation.errors import DotfilesError
from workstation.lib.commands import require_commands, run
from workstation.lib.files import install_file_if_changed, remove_path, require_file
from workstation.lib.paths import state_path_for_home

PACKAGE_PATH = Path("packages/hyper-window-tiling")

app = App(
    help="Build the shared GNOME and KDE window-tiling package.",
    version_flags=[],
    result_action="return_none",
)


def normalize_os(name: str) -> str:
    normalized = name.casefold()
    if normalized == "linux":
        return "linux"
    if normalized in {"darwin", "macos"}:
        return "darwin"
    return name


def _looks_like_source(path: Path) -> bool:
    return any(
        (path / marker).exists()
        for marker in (
            ".chezmoiignore",
            ".chezmoiexternal.toml",
            ".chezmoiexternal.toml.tmpl",
            ".chezmoiscripts",
        )
    )


def infer_source_directory(start: Path) -> Path:
    resolved = start.resolve()
    for candidate in (resolved, *resolved.parents):
        if _looks_like_source(candidate):
            return candidate
        nested = candidate / "dotfiles"
        if nested.is_dir() and _looks_like_source(nested):
            return nested
    raise DotfilesError(
        f"could not find chezmoi source dir from {resolved}; "
        "pass --source-dir DIR or run from this repo"
    )


def repo_root_from_source(source_directory: Path) -> Path:
    resolved = source_directory.expanduser().resolve()
    for candidate in (resolved, *resolved.parents):
        if (candidate / PACKAGE_PATH / "package.json").is_file():
            return candidate
    raise DotfilesError(
        f"could not find repo root containing {PACKAGE_PATH} from {source_directory}"
    )


def _manifest_value(path: Path, *keys: str) -> str:
    try:
        value: object = json.loads(path.read_bytes())
    except (OSError, json.JSONDecodeError) as error:
        raise DotfilesError(f"invalid package manifest {path}: {error}") from error
    for key in keys:
        if not isinstance(value, dict):
            raise DotfilesError(f"invalid package manifest {path}: missing {key}")
        mapping = cast("dict[str, object]", value)
        if key not in mapping:
            raise DotfilesError(f"invalid package manifest {path}: missing {key}")
        value = mapping[key]
    if not isinstance(value, str) or not value:
        raise DotfilesError(
            f"invalid package manifest {path}: {'.'.join(keys)} must be a string"
        )
    return value


def _stage_gnome(package_root: Path, destination: Path) -> None:
    install_file_if_changed(
        package_root / "gnome/metadata.json", destination / "metadata.json"
    )
    install_file_if_changed(
        package_root / "dist/gnome/extension.js", destination / "extension.js"
    )
    schemas = package_root / "gnome/schemas"
    if not schemas.is_dir():
        raise DotfilesError(f"required directory does not exist: {schemas}")
    schemas.copy(destination / "schemas", preserve_metadata=True)


def _stage_kde(package_root: Path, destination: Path) -> None:
    install_file_if_changed(
        package_root / "kde/metadata.json", destination / "metadata.json"
    )
    install_file_if_changed(
        package_root / "dist/kde/contents/code/main.js",
        destination / "contents/code/main.js",
    )


def build_package(
    *,
    source_directory: Path | None,
    home_directory: Path,
    os_name: str,
) -> Path | None:
    if normalize_os(os_name) != "linux":
        return None
    source = source_directory or infer_source_directory(Path.cwd())
    if not os.fspath(home_directory):
        raise DotfilesError("environment variable HOME is required")

    require_commands("bun")
    repository_root = repo_root_from_source(source)
    package_root = repository_root / PACKAGE_PATH
    require_file(package_root / "package.json")
    gnome_uuid = _manifest_value(package_root / "gnome/metadata.json", "uuid")
    kde_plugin_id = _manifest_value(package_root / "kde/metadata.json", "KPlugin", "Id")

    stage_root = state_path_for_home(
        home_directory.expanduser(), "hyper-window-tiling", "build"
    )
    stage_root.parent.mkdir(parents=True, exist_ok=True)
    lock = FileLock(stage_root.parent / ".build.lock")
    with lock:
        run(
            ("bun", "install", "--frozen-lockfile"),
            cwd=package_root,
            output_mode="stderr",
        )
        run(("bun", "run", "build"), cwd=package_root, output_mode="stderr")

        with tempfile.TemporaryDirectory(
            prefix=".build-", dir=stage_root.parent
        ) as temporary:
            temporary_root = Path(temporary)
            _stage_gnome(package_root, temporary_root / "gnome" / gnome_uuid)
            _stage_kde(package_root, temporary_root / "kde" / kde_plugin_id)
            remove_path(stage_root)
            temporary_root.replace(stage_root)
    return stage_root


@app.command(name="build")
def build(
    *,
    source_dir: Path | None = None,
    home_dir: Path | None = None,
    os_name: str | None = None,
) -> None:
    """Build and atomically stage both desktop integrations.

    Parameters
    ----------
    source_dir
        Chezmoi source directory.
    home_dir
        Home directory used for staged output.
    os_name
        Override the target operating-system name.

    """
    home = home_dir or Path(os.environ.get("CHEZMOI_HOME_DIR") or Path.home())
    source_value = source_dir
    if source_value is None and os.environ.get("CHEZMOI_SOURCE_DIR"):
        source_value = Path(os.environ["CHEZMOI_SOURCE_DIR"])
    target_os = os_name or os.environ.get("CHEZMOI_OS") or platform.system()
    result = build_package(
        source_directory=source_value,
        home_directory=home,
        os_name=target_os,
    )
    if result is not None:
        print(result)


def alias(
    *,
    source_dir: Path | None = None,
    home_dir: Path | None = None,
    os_name: str | None = None,
) -> None:
    """Build the shared GNOME and KDE window-tiling package."""
    build(source_dir=source_dir, home_dir=home_dir, os_name=os_name)


alias_app = App(
    default_command=alias,
    version=f"hyper-window-tiling-build version {__version__}",
    result_action="return_none",
)


def entrypoint() -> None:
    try:
        alias_app()
    except DotfilesError as error:
        error_console.print(f"[bold red]hyper-window-tiling-build:[/bold red] {error}")
        raise SystemExit(1) from error


if __name__ == "__main__":
    entrypoint()
