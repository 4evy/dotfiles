"""Helium browser installation and configuration."""

import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import ClassVar

from githubkit import GitHub
from githubkit.exception import GitHubException
from pydantic import BaseModel, ConfigDict, Field

from workstation.apps.installer_support import (
    extract_application_directory,
    verified_download,
)
from workstation.automation import automation_check_mode
from workstation.automation_models import OperationResult
from workstation.errors import DotfilesError
from workstation.lib.commands import require_commands, run, which
from workstation.lib.files import (
    ensure_directory,
    fresh_directory,
    install_file_if_changed,
    remove_path,
    replace_directory,
    require_directory,
    write_if_changed,
)
from workstation.lib.paths import asset_path, repository_root
from workstation.lib.platform import machine_architecture
from workstation.lib.settings import EnvironmentSettings

BROWSER_GO_PACKAGE = "github.com/4evy/browser/cmd/browser@latest"
CUSTOM_AVATAR_FILENAME = "Custom Avatar Picture.png"


class HeliumSettings(EnvironmentSettings):
    """Environment-backed credentials used for GitHub release discovery."""

    configuration_name: ClassVar[str] = "Helium installer"

    github_token: str | None = None
    gh_token: str | None = None
    cookie_allowlist: tuple[str, ...] = Field(
        default=(),
        validation_alias="DOTFILES_HELIUM_COOKIE_ALLOWLIST",
    )


class HeliumApplyInput(BaseModel):
    """Typed input passed to the declarative browser configurer."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    cookie_allowlist: tuple[str, ...] = ()
    extension_values: Mapping[str, str] = Field(default_factory=dict)


def _architecture() -> str:
    return machine_architecture().name


def _apply_input(settings: HeliumSettings) -> str:
    extension_values: Mapping[str, str] = {}
    if which("gh") is not None:
        token = run(("gh", "auth", "token"), check=False, capture=True)
        value = token.stdout.strip()
        if token.returncode == 0 and value:
            extension_values = {
                "refined-github-personal-token": value,
            }
    apply_input = HeliumApplyInput(
        cookie_allowlist=settings.cookie_allowlist,
        extension_values=extension_values,
    )
    return apply_input.model_dump_json(exclude_defaults=True)


def _profile_dir(platform_name: str) -> Path:
    if platform_name == "macos":
        return (
            Path.home()
            / "Library"
            / "Application Support"
            / "net.imput.helium"
            / "Default"
        )
    if platform_name == "linux":
        config_home = Path(
            os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")
        ).expanduser()
        return config_home / "net.imput.helium" / "Default"
    raise DotfilesError(f"unsupported Helium platform: {platform_name}")


def _install_profile_avatar(platform_name: str) -> Path:
    profile_dir = ensure_directory(_profile_dir(platform_name))
    destination = profile_dir / CUSTOM_AVATAR_FILENAME
    install_file_if_changed(
        asset_path("apps", "helium", "helium-profile-avatar.png"),
        destination,
    )
    return destination


def _run_configurer(
    *,
    platform_name: str,
    root: Path,
    app_dir: Path,
    bin_dir: Path,
    installer_bin: Path,
    flags: str,
    settings: HeliumSettings,
) -> None:
    require_commands("go")
    ensure_directory(installer_bin)
    _install_profile_avatar(platform_name)
    config = asset_path("apps", "helium", "helium.toml")
    try:
        repository = repository_root()
    except FileNotFoundError:
        browser_checkout = None
    else:
        browser_checkout = repository.parent / "browser"
    if (
        browser_checkout is not None
        and browser_checkout.is_dir()
        and (browser_checkout / "go.mod").is_file()
        and "module github.com/4evy/browser"
        in (browser_checkout / "go.mod").read_text()
    ):
        install_command = ("go", "install", "./cmd/browser")
        install_cwd = browser_checkout
    else:
        install_command = ("go", "install", BROWSER_GO_PACKAGE)
        install_cwd = config.parent
    run(
        install_command,
        cwd=install_cwd,
        env={
            "GOBIN": os.fspath(installer_bin),
            "CGO_ENABLED": "0"
            if platform_name == "linux"
            else os.environ.get("CGO_ENABLED", "1"),
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
        input_text=_apply_input(settings),
    )


def install_helium_linux(
    cache_root: Path,
    app_root: Path,
    bin_dir: Path,
    installer_bin: Path,
    flags: str = "",
) -> OperationResult:
    """Install the latest verified Helium Linux release and configure it."""
    if automation_check_mode():
        return OperationResult(changed=True, msg="Would reconcile Helium on Linux")
    cache = ensure_directory(cache_root)
    app_root = ensure_directory(app_root)
    bin_dir = ensure_directory(bin_dir)
    settings = HeliumSettings.load()
    try:
        release = (
            GitHub(
                settings.github_token or settings.gh_token,
                user_agent="dotfiles-helium-installer",
                timeout=60,
            )
            .rest.repos.get_latest_release("imputnet", "helium-linux")
            .parsed_data
        )
    except GitHubException as error:
        raise DotfilesError(
            f"failed to read the latest Helium release: {error}"
        ) from error
    version = release.tag_name
    name = f"helium-{version}-{_architecture()}_linux.tar.xz"
    asset = next(
        (candidate for candidate in release.assets if candidate.name == name), None
    )
    if asset is None:
        raise DotfilesError(f"latest Helium release does not include {name}")
    archive = cache / name
    app_dir = app_root / "app"
    version_file = app_dir / ".helium-version"
    if not version_file.is_file() or version_file.read_text().strip() != version:
        verified_download(archive, str(asset.browser_download_url), asset.digest)
        extract = fresh_directory(cache / "extract")
        payload = extract_application_directory(archive, extract, label="Helium")
        replace_directory(payload, app_dir)
        wrapper = app_dir / "helium-wrapper"
        if wrapper.is_file():
            write_if_changed(
                wrapper,
                re.sub(
                    r"^CHROME_VERSION_EXTRA=.*$",
                    "CHROME_VERSION_EXTRA=ansible",
                    wrapper.read_text(),
                    flags=re.MULTILINE,
                ),
                "0755",
            )
        write_if_changed(version_file, version + "\n")
        remove_path(extract)
    _run_configurer(
        platform_name="linux",
        root=cache,
        app_dir=app_dir,
        bin_dir=bin_dir,
        installer_bin=installer_bin,
        flags=flags,
        settings=settings,
    )
    return OperationResult(changed=True, msg=f"Configured Helium {version} on Linux")


def install_helium_macos(
    root: Path, bin_dir: Path, installer_bin: Path, flags: str = ""
) -> OperationResult:
    """Configure the Homebrew Helium macOS application."""
    if automation_check_mode():
        return OperationResult(changed=True, msg="Would reconcile Helium on macOS")
    root = ensure_directory(root)
    bin_dir = ensure_directory(bin_dir)
    app_dir = require_directory("/Applications/Helium.app")
    _run_configurer(
        platform_name="macos",
        root=root,
        app_dir=app_dir,
        bin_dir=bin_dir,
        installer_bin=installer_bin,
        flags=flags,
        settings=HeliumSettings.load(),
    )
    return OperationResult(changed=True, msg="Configured Helium on macOS")
