import ipaddress
import os
import re
import sys
from collections.abc import Sequence
from pathlib import Path
from subprocess import CompletedProcess
from typing import Annotated

from cyclopts import App, Parameter, validators
from cyclopts.config import Env
from pydantic import ValidationError

from workstation.console import error_console
from workstation.errors import DotfilesError
from workstation.lib.commands import exec_process, require_commands, run, which
from workstation.lib.files import ensure_directory, write_if_changed
from workstation.lib.paths import cache_path
from workstation.local.phone_mirror_models import (
    DEFAULT_NAME,
    DEFAULT_PORT,
    Config,
    IPAddress,
    RunCommand,
    TailscaleStatus,
    TargetCache,
)

_GUI_ENVIRONMENT_KEYS = frozenset({
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
})


def _run_command(
    argv: Sequence[str],
    *,
    timeout: float,
    input_text: str | None = None,
) -> CompletedProcess[str]:
    return run(
        argv,
        check=False,
        capture=True,
        input_text=input_text,
        timeout=timeout,
    )


def _detail(result: CompletedProcess[str]) -> str:
    lines = (result.stderr.strip() or result.stdout.strip()).splitlines()
    return lines[-1] if lines else "unknown error"


def resolve_tailscale_ip(name: str, run_command: RunCommand) -> str:
    result = run_command(("tailscale", "status", "--json"), timeout=8)
    if result.returncode != 0:
        raise DotfilesError(f"tailscale status failed: {_detail(result)}")
    try:
        status = TailscaleStatus.model_validate_json(result.stdout)
    except ValidationError as error:
        raise DotfilesError("tailscale status returned invalid data") from error

    wanted = name.rstrip(".").casefold()
    matches = [node for node in status.nodes if wanted in node.names]
    if not matches:
        raise DotfilesError(f"could not find {name} in tailscale status")
    if len(matches) > 1:
        raise DotfilesError(f"tailscale name {name!r} matched more than one device")
    if not matches[0].addresses:
        raise DotfilesError(f"tailscale did not report a valid IP for {name}")
    return str(
        min(
            matches[0].addresses,
            key=lambda address: ipaddress.ip_address(str(address)).version,
        )
    )


def _cache_file(name: str) -> Path:
    safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip("-.") or "phone"
    return cache_path("phone-mirror", f"{safe_name}.json")


def _read_cached_ip(path: Path, name: str) -> str | None:
    try:
        cached = TargetCache.model_validate_json(path.read_bytes())
    except OSError, ValidationError:
        return None
    return str(cached.ip) if cached.name == name else None


def _write_cached_ip(path: Path, name: str, ip: str) -> None:
    ensure_directory(path.parent, "0700")
    cached = TargetCache(name=name, ip=ipaddress.ip_address(ip))
    write_if_changed(path, f"{cached.model_dump_json(indent=2)}\n", "0600")


def _endpoint(host: str, port: int) -> str:
    address = ipaddress.ip_address(host)
    return f"[{address}]:{port}" if address.version == 6 else f"{address}:{port}"


class PhoneMirror:
    def __init__(
        self,
        config: Config,
        *,
        run_command: RunCommand = _run_command,
        environment: dict[str, str] | None = None,
        cache_file: Path | None = None,
    ) -> None:
        self.config = config
        self.run_command = run_command
        self.environment = environment if environment is not None else os.environ.copy()
        self.cache_path = cache_file or _cache_file(config.name)

    def _target_ip(self) -> str:
        if self.config.ip is not None:
            return str(self.config.ip)
        require_commands("tailscale")
        try:
            host = resolve_tailscale_ip(self.config.name, self.run_command)
        except DotfilesError:
            cached = _read_cached_ip(self.cache_path, self.config.name)
            if cached is None:
                raise
            error_console.print(
                f"phone-mirror: using cached Tailscale address {cached}",
                highlight=False,
            )
            return cached
        _write_cached_ip(self.cache_path, self.config.name, host)
        return host

    def _hydrate_gui_environment(self) -> None:
        if not sys.platform.startswith("linux"):
            return
        if not self.environment.get("XDG_RUNTIME_DIR"):
            runtime = Path(f"/run/user/{os.getuid()}")
            if runtime.is_dir():
                self.environment["XDG_RUNTIME_DIR"] = os.fspath(runtime)
        if which("systemctl") is None:
            return
        result = self.run_command(
            ("systemctl", "--user", "show-environment"),
            timeout=5,
        )
        if result.returncode != 0:
            return
        for line in result.stdout.splitlines():
            key, separator, value = line.partition("=")
            if separator and key in _GUI_ENVIRONMENT_KEYS:
                self.environment.setdefault(key, value)

    def _scrcpy_arguments(self, host: str) -> tuple[str, ...]:
        result = self.run_command(("scrcpy", "--help"), timeout=5)
        active_option = (
            "--keep-active"
            if "--keep-active" in result.stdout + result.stderr
            else "--stay-awake"
        )
        arguments = [
            f"--tcpip={_endpoint(host, self.config.port)}",
            active_option,
        ]
        if sys.platform.startswith("linux") and self.config.render_driver:
            arguments.extend(("--render-driver", self.config.render_driver))
        if self.config.connect_only:
            arguments.extend((
                "--no-video",
                "--no-audio",
                "--no-control",
                "--time-limit=1",
            ))
        arguments.extend(self.config.scrcpy_args)
        return tuple(arguments)

    def run(self) -> None:
        require_commands("scrcpy")
        host = self._target_ip()
        self._hydrate_gui_environment()
        if sys.platform.startswith("linux") and not (
            self.environment.get("WAYLAND_DISPLAY") or self.environment.get("DISPLAY")
        ):
            raise DotfilesError(
                "no graphical Linux session found; run from the desktop or export "
                "DISPLAY/WAYLAND_DISPLAY"
            )
        if sys.platform.startswith("linux") and self.config.sdl_video_driver:
            self.environment.setdefault("SDL_VIDEODRIVER", self.config.sdl_video_driver)
        executable = which("scrcpy")
        if executable is None:
            raise DotfilesError("required command is not available: scrcpy")
        exec_process(
            os.fspath(executable),
            self._scrcpy_arguments(host),
            self.environment,
            argument_zero="scrcpy",
        )


def mirror(
    *scrcpy_args: Annotated[str, Parameter(allow_leading_hyphen=True)],
    name: Annotated[str, Parameter(help="Tailscale host name.")] = DEFAULT_NAME,
    ip: Annotated[IPAddress | None, Parameter(help="Target IP address.")] = None,
    port: Annotated[
        int,
        Parameter(
            validator=validators.Number(gte=1, lte=65535),
            help="ADB TCP/IP port passed to scrcpy.",
        ),
    ] = DEFAULT_PORT,
    connect_only: Annotated[
        bool,
        Parameter(negative="", help="Connect without opening a mirror window."),
    ] = False,
    render_driver: str | None = "software",
    sdl_video_driver: Annotated[
        str | None,
        Parameter(env_var="PHONE_MIRROR_SDL_VIDEODRIVER"),
    ] = "x11",
) -> None:
    """Mirror an Android phone through scrcpy's native TCP/IP support."""
    PhoneMirror(
        Config(
            name=name,
            ip=ip,
            port=port,
            connect_only=connect_only,
            render_driver=render_driver or None,
            sdl_video_driver=sdl_video_driver or None,
            scrcpy_args=tuple(argument for argument in scrcpy_args if argument != "--"),
        )
    ).run()


app = App(
    config=Env("PHONE_MIRROR_"),
    default_command=mirror,
    version_flags=[],
    result_action="return_none",
)


def entrypoint() -> None:
    try:
        app()
    except DotfilesError as error:
        error_console.print(f"[bold red]phone-mirror:[/bold red] {error}")
        raise SystemExit(1) from error


if __name__ == "__main__":
    entrypoint()
