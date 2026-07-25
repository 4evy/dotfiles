import os
import shlex
import sys
from pathlib import Path
from typing import Annotated

from cyclopts import App, Parameter
from packaging.version import InvalidVersion, Version
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError

from workstation.errors import DotfilesError
from workstation.lib.commands import run
from workstation.lib.files import ensure_directory, write_if_changed
from workstation.lib.host import user_config_home


class ChromiumSwitches(BaseModel):
    model_config = ConfigDict(extra="allow")

    force_high_performance_gpu: bool = True


class DiscordSettings(BaseModel):
    model_config = ConfigDict(extra="allow")

    enable_hardware_acceleration: bool = Field(True, alias="enableHardwareAcceleration")
    enable_devtools: bool = Field(
        True,
        alias="DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING",
    )
    chromium_switches: Annotated[
        ChromiumSwitches,
        BeforeValidator(lambda value: value if isinstance(value, dict) else {}),
    ] = Field(default_factory=ChromiumSwitches, alias="chromiumSwitches")


DISCORD_FLAGS = (
    "--ozone-platform-hint=auto",
    "--disable-gpu-process-crash-limit",
    "--enable-gpu-rasterization",
)


def _flags_from_file(path: Path) -> list[str]:
    if not path.is_file():
        return []
    result: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            result.extend(shlex.split(stripped))
    return result


def _configure_gpu(discord_dir: Path) -> None:
    settings = discord_dir / "settings.json"
    try:
        value = (
            DiscordSettings.model_validate_json(settings.read_bytes())
            if settings.is_file()
            else DiscordSettings()
        )
    except ValidationError as error:
        raise DotfilesError(f"invalid Discord settings JSON: {settings}") from error
    value.enable_hardware_acceleration = True
    value.enable_devtools = True
    value.chromium_switches.force_high_performance_gpu = True
    write_if_changed(
        settings, value.model_dump_json(by_alias=True, indent=2) + "\n", "0600"
    )


def _patch_location(location: Path, equilotl: Path) -> None:
    if not equilotl.is_file() or not os.access(equilotl, os.X_OK):
        return
    asar = location / "resources/app.asar"
    build_info = location / "resources/build_info.json"
    if not asar.is_file() and not build_info.is_file():
        return
    if asar.is_file() and asar.stat().st_size <= 131072:
        content = asar.read_bytes()
        expected = os.fsencode(user_config_home() / "Equicord/equicord.asar")
        if b'"name": "discord"' in content and expected in content:
            return
    run((equilotl, "--repair", "--location", location), check=False)


def _version_key(path: Path) -> tuple[int, Version | str]:
    name = path.name.removeprefix("app-")
    try:
        return 1, Version(name)
    except InvalidVersion:
        return 0, name


def _patch_current(discord_dir: Path, equilotl: Path) -> None:
    host = discord_dir / "Discord"
    if host.exists():
        try:
            target = host.resolve(strict=True)
        except OSError:
            pass
        else:
            _patch_location(target.parent, equilotl)
            return
    config_home = user_config_home()
    locations: set[Path] = set()
    for root in (discord_dir, config_home / "Discord"):
        if not root.is_dir():
            continue
        for marker in ("app-*/resources/app.asar", "app-*/resources/build_info.json"):
            locations.update(path.parent.parent for path in root.glob(marker))
    if locations:
        _patch_location(max(locations, key=_version_key), equilotl)


def _macos_equilotl(package_bin: Path) -> Path | None:
    configured = os.environ.get("DISCORD_EQUICORD_EQUILOTL")
    candidates = (
        Path(configured) if configured else None,
        Path.home() / ".local/bin/EquilotlCli-darwin-arm64",
        package_bin / "EquilotlCli-darwin-arm64",
    )
    return next(
        (
            candidate
            for candidate in candidates
            if candidate is not None
            and candidate.is_file()
            and os.access(candidate, os.X_OK)
        ),
        None,
    )


def _linux_equilotl(package_bin: Path) -> Path:
    configured = os.environ.get("DISCORD_EQUICORD_EQUILOTL")
    candidates = (
        Path(configured) if configured else None,
        Path.home() / ".local/bin/EquilotlCli-linux",
        package_bin / "EquilotlCli-linux",
    )
    return next(
        (
            candidate
            for candidate in candidates
            if candidate is not None
            and candidate.is_file()
            and os.access(candidate, os.X_OK)
        ),
        package_bin / "EquilotlCli-linux",
    )


def _macos_asars(resources: Path) -> tuple[Path, ...]:
    return tuple(
        path
        for path in (resources / "app.asar", resources / "_app.asar")
        if path.is_file()
    )


def _set_macos_asar_lock(resources: Path, *, locked: bool) -> None:
    asars = _macos_asars(resources)
    if asars:
        run(("chflags", "uchg" if locked else "nouchg", *asars), check=False)


def _macos_equicord_is_patched(resources: Path) -> bool:
    app_asar = resources / "app.asar"
    if not app_asar.is_file() or app_asar.stat().st_size > 131072:
        return False
    content = app_asar.read_bytes()
    return b"Equicord/equicord.asar" in content and b'"name": "discord"' in content


def _repair_macos(package_bin: Path) -> None:
    app = Path(os.environ.get("DISCORD_EQUICORD_APP", "/Applications/Discord.app"))
    resources = app / "Contents/Resources"
    if not (resources / "app.asar").is_file():
        return
    if _macos_equicord_is_patched(resources):
        _set_macos_asar_lock(resources, locked=True)
        return
    equilotl = _macos_equilotl(package_bin)
    if equilotl is None:
        return

    _set_macos_asar_lock(resources, locked=False)
    environment = {"HOME": os.fspath(Path.home())}
    result = run(
        (equilotl, "--repair", "--branch", "stable"),
        check=False,
        env=environment,
    )
    if result.returncode != 0:
        result = run(
            (equilotl, "--install", "--branch", "stable"),
            check=False,
            env=environment,
        )
    if result.returncode != 0 or not _macos_equicord_is_patched(resources):
        raise DotfilesError("discord-equicord: failed to patch Discord on macOS")
    _set_macos_asar_lock(resources, locked=True)


def main(
    *arguments: Annotated[str, Parameter(allow_leading_hyphen=True)],
    repair_only: bool = False,
) -> int:
    """Launch Discord with Equicord, or repair the current installation."""
    config_home = user_config_home()
    discord_dir = config_home / "discord"
    discord_host = discord_dir / "Discord"
    package_bin = Path(sys.argv[0]).resolve().parent
    equilotl = _linux_equilotl(package_bin)
    if repair_only:
        if sys.platform == "darwin":
            _repair_macos(package_bin)
            return 0
        _configure_gpu(discord_dir)
        _patch_current(discord_dir, equilotl)
        return 0
    if sys.platform == "darwin":
        raise DotfilesError(
            "discord-equicord: launching Discord is only supported on Linux"
        )
    if not discord_host.is_file() or not os.access(discord_host, os.X_OK):
        ensure_directory(discord_dir)
        bootstrap = next(
            (
                path
                for path in (
                    Path("/usr/share/discord/updater_bootstrap"),
                    Path("/opt/discord/updater_bootstrap"),
                    Path("/opt/Discord/updater_bootstrap"),
                )
                if path.is_file() and os.access(path, os.X_OK)
            ),
            None,
        )
        if bootstrap is None:
            raise DotfilesError(
                "discord-equicord: Discord updater bootstrap was not found"
            )
        zenity = "--no-zenity" if sys.stdout.isatty() else "--zenity"
        run((bootstrap, zenity, discord_dir, "stable", "https://updates.discord.com/"))
    flags = [*DISCORD_FLAGS, *_flags_from_file(config_home / "discord-flags.conf")]
    _configure_gpu(discord_dir)
    _patch_current(discord_dir, equilotl)
    result = run((discord_host, *flags, *arguments), check=False)
    _patch_current(discord_dir, equilotl)
    return result.returncode


app = App(
    default_command=main,
    version_flags=[],
    result_action="return_int_as_exit_code_else_zero",
)


def entrypoint() -> None:
    try:
        app()
    except DotfilesError as error:
        raise SystemExit(str(error)) from error
