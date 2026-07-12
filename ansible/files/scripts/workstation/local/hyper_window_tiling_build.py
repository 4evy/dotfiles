import os
import platform
import shutil
import tempfile
from pathlib import Path
from typing import Annotated

import typer
from filelock import FileLock

from workstation import __version__
from workstation.console import error_console
from workstation.errors import DotfilesError
from workstation.lib.commands import require_commands, run
from workstation.lib.files import install_file_if_changed, require_file
from workstation.lib.paths import state_path_for_home

PACKAGE_PATH = Path("packages/hyper-window-tiling")
GNOME_UUID = "hyper-window-tiling@4evy.local"

app = typer.Typer(no_args_is_help=True, pretty_exceptions_enable=False)


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
            _stage_gnome(package_root, temporary_root / "gnome" / GNOME_UUID)
            _stage_kde(package_root, temporary_root / "kde/hyper-window-tiling")
            if stage_root.is_symlink() or stage_root.is_file():
                stage_root.unlink()
            elif stage_root.exists():
                shutil.rmtree(stage_root)
            temporary_root.replace(stage_root)
    return stage_root


@app.command("build")
def build(
    source_dir: Annotated[
        Path | None,
        typer.Option("--source-dir", help="Chezmoi source directory."),
    ] = None,
    home_dir: Annotated[
        Path | None,
        typer.Option("--home-dir", help="Home directory used for staged output."),
    ] = None,
    os_name: Annotated[
        str | None,
        typer.Option("--os", help="Override the target operating-system name."),
    ] = None,
) -> None:
    """Build and atomically stage both desktop integrations."""
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
        typer.echo(result)


def version_callback(value: bool) -> None:
    if value:
        typer.echo(f"hyper-window-tiling-build version {__version__}")
        raise typer.Exit()


def alias(
    source_dir: Annotated[Path | None, typer.Option("--source-dir")] = None,
    home_dir: Annotated[Path | None, typer.Option("--home-dir")] = None,
    os_name: Annotated[str | None, typer.Option("--os")] = None,
    version: Annotated[
        bool,
        typer.Option("--version", callback=version_callback, is_eager=True),
    ] = False,
) -> None:
    """Build the shared GNOME and KDE window-tiling package."""
    del version
    build(source_dir=source_dir, home_dir=home_dir, os_name=os_name)


def entrypoint() -> None:
    try:
        typer.run(alias)
    except DotfilesError as error:
        error_console.print(f"[bold red]hyper-window-tiling-build:[/bold red] {error}")
        raise SystemExit(1) from error


if __name__ == "__main__":
    entrypoint()
