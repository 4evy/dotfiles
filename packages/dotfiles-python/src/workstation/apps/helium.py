"""Apply the shared profile configuration to a natively installed Helium."""

import os
from pathlib import Path
from typing import ClassVar, Literal

from pydantic import BaseModel, Field

from workstation.errors import DotfilesError
from workstation.lib.commands import require_commands, run
from workstation.lib.files import (
    ensure_directory,
    install_file_if_changed,
    require_directory,
)
from workstation.lib.paths import asset_path
from workstation.lib.settings import EnvironmentSettings

# renovate: datasource=git-refs depName=https://github.com/4evy/browser currentValue=HEAD
BROWSER_GO_PACKAGE = (
    "downloads.com/4evy/browser/cmd/browser@b4f39de39c1d2cf516e78cc2a52803777f6fb02c"
)
CUSTOM_AVATAR_FILENAME = "Google Profile Picture.png"


class HeliumSettings(EnvironmentSettings):
    """Private profile values supplied through the standard dotfiles environment."""

    configuration_name: ClassVar[str] = "Helium profile"
    cookie_allowlist: list[str] = Field(
        default_factory=list,
        validation_alias="DOTFILES_HELIUM_COOKIE_ALLOWLIST",
    )


class HeliumApplyInput(BaseModel):
    """Values passed to the profile configurer on stdin."""

    cookie_allowlist: list[str] = Field(default_factory=list)
    extension_values: dict[str, str] = Field(default_factory=dict)


def _helium_asset(*parts: str) -> Path:
    return asset_path("apps", "helium", *parts, development_source=("browser", *parts))


def _apply_input(settings: HeliumSettings) -> str:
    extension_values: dict[str, str] = {}
    if os.environ.get("OP_ACCOUNT"):
        token = run(
            ("op", "read", "op://Private/Refined GitHub/token"),
            check=False,
            capture=True,
        )
        value = token.stdout.strip()
        if token.returncode == 0 and value:
            extension_values["refined-github-personal-token"] = value
    return HeliumApplyInput(
        cookie_allowlist=settings.cookie_allowlist,
        extension_values=extension_values,
    ).model_dump_json(exclude_defaults=True)


def _profile_dir(platform_name: Literal["linux", "macos"]) -> Path:
    home = Path.home()
    if platform_name == "macos":
        return home / "Library/Application Support/net.imput.helium/Default"
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    return config_home / "net.imput.helium/Default"


def _configure(
    platform_name: Literal["linux", "macos"],
    root: Path,
    app_dir: Path,
    bin_dir: Path,
    installer_bin: Path,
    flags: str,
    *,
    check: bool,
) -> None:
    require_directory(app_dir)
    if check:
        return
    require_commands("go")
    ensure_directory(root)
    ensure_directory(bin_dir)
    ensure_directory(installer_bin)
    profile = ensure_directory(_profile_dir(platform_name))
    install_file_if_changed(
        _helium_asset("helium-profile-avatar.png"),
        profile / CUSTOM_AVATAR_FILENAME,
    )
    config = _helium_asset("helium.toml")
    run(
        ("go", "install", BROWSER_GO_PACKAGE),
        cwd=config.parent,
        env={
            "GOBIN": os.fspath(installer_bin),
            "CGO_ENABLED": "0" if platform_name == "linux" else "1",
        },
    )
    run(
        (
            installer_bin / "browser",
            "configure",
            "--config",
            config,
            "--mode",
            platform_name,
            "--root",
            root,
            "--app-dir",
            app_dir,
            "--bin-dir",
            bin_dir,
            "--input",
            "-",
            f"--flags={flags}",
        ),
        cwd=config.parent,
        input_text=_apply_input(HeliumSettings.load()),
    )


def configure_helium_linux(
    root: Path,
    app_dir: Path,
    bin_dir: Path,
    installer_bin: Path,
    flags: str = "",
    check: bool = False,
) -> None:
    """Configure a natively installed Helium Linux release."""
    _configure(
        "linux",
        root,
        app_dir,
        bin_dir,
        installer_bin,
        flags,
        check=check,
    )


def configure_helium_macos(
    root: Path,
    bin_dir: Path,
    installer_bin: Path,
    flags: str = "",
    check: bool = False,
) -> None:
    """Configure the Homebrew-owned Helium macOS application."""
    app_dir = Path("/Applications/Helium.app")
    if not app_dir.is_dir():
        raise DotfilesError(f"Helium application does not exist: {app_dir}")
    _configure(
        "macos",
        root,
        app_dir,
        bin_dir,
        installer_bin,
        flags,
        check=check,
    )
