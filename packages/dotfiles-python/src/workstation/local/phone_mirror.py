import ipaddress
import os
import re
import socket
import sys
import time
import xml.etree.ElementTree as ET  # ruff: ignore[suspicious-xml-etree-import] — parses our local Nmap output
from collections.abc import Sequence
from pathlib import Path
from subprocess import CompletedProcess
from typing import Annotated

import psutil
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
_WIRELESS_DEBUGGING_PORTS = (30000, 49999)
_PHONE_LAN_INTERFACE_PREFIXES = ("eth", "wlan")


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
    result = run_command(("tailscale", "ip", "--", name), timeout=8)
    if result.returncode != 0:
        raise DotfilesError(f"tailscale ip failed: {_detail(result)}")
    try:
        addresses: list[IPAddress] = [
            ipaddress.ip_address(line) for line in result.stdout.splitlines()
        ]
    except ValueError as error:
        raise DotfilesError("tailscale ip returned invalid data") from error
    if not addresses:
        raise DotfilesError(f"tailscale did not report a valid IP for {name}")
    return str(
        next((address for address in addresses if address.version == 4), addresses[0])
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


def _serial_host(serial: str) -> str | None:
    if serial.startswith("["):
        host, separator, _port = serial[1:].partition("]:")
    else:
        host, separator, _port = serial.rpartition(":")
    if not separator:
        return None
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return None


def _parse_devices(output: str) -> dict[str, str]:
    devices: dict[str, str] = {}
    for line in output.splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 2:
            devices[fields[0]] = fields[1]
    return devices


def _local_ipv4_networks() -> tuple[ipaddress.IPv4Network, ...]:
    networks: list[ipaddress.IPv4Network] = []
    for addresses in psutil.net_if_addrs().values():
        for address in addresses:
            if address.family != socket.AF_INET or address.netmask is None:
                continue
            interface = ipaddress.IPv4Interface(f"{address.address}/{address.netmask}")
            if interface.ip.is_loopback or interface.ip.is_link_local:
                continue
            networks.append(interface.network)
    return tuple(dict.fromkeys(networks))


def _phone_lan_addresses(output: str) -> tuple[ipaddress.IPv4Address, ...]:
    addresses: list[ipaddress.IPv4Address] = []
    for line in output.splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        interface = fields[1].rstrip(":")
        if not interface.startswith(_PHONE_LAN_INTERFACE_PREFIXES):
            continue
        try:
            inet = fields.index("inet")
            address = ipaddress.IPv4Address(fields[inet + 1].partition("/")[0])
        except ValueError, IndexError:
            continue
        addresses.append(address)
    return tuple(dict.fromkeys(addresses))


def _open_ports_from_nmap(output: str) -> tuple[int, ...]:
    try:
        scan = ET.fromstring(output)  # ruff: ignore[suspicious-xml-element-tree-usage] — Nmap generates this XML locally
        return tuple(
            dict.fromkeys(
                int(port.attrib["portid"])
                for port in scan.findall("./host/ports/port[@protocol='tcp']")
                if port.find("state[@state='open']") is not None
            )
        )
    except (ET.ParseError, KeyError, ValueError) as exc:
        raise DotfilesError(f"Invalid Nmap scan output: {exc}") from exc


def scan_open_ports(
    host: str,
    run_command: RunCommand,
) -> tuple[int, ...]:
    start, end = _WIRELESS_DEBUGGING_PORTS
    result = run_command(
        (
            "nmap",
            "-Pn",
            "-n",
            "--open",
            "-T4",
            "--host-timeout",
            "45s",
            "-p",
            f"{start}-{end}",
            "-oX",
            "-",
            host,
        ),
        timeout=50,
    )
    if result.returncode != 0:
        raise DotfilesError(f"nmap port discovery failed: {_detail(result)}")
    return _open_ports_from_nmap(result.stdout)


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

    def _adb(self, *arguments: str, timeout: float = 10) -> CompletedProcess[str]:
        return self.run_command(("adb", *arguments), timeout=timeout)

    def _devices(self) -> dict[str, str]:
        result = self._adb("devices", "-l")
        if result.returncode != 0:
            raise DotfilesError(f"adb devices failed: {_detail(result)}")
        return _parse_devices(result.stdout)

    def _connect(self, host: str, port: int) -> str | None:
        serial = _endpoint(host, port)
        error_console.print(f"phone-mirror: trying {serial}", highlight=False)
        self._adb("connect", serial)
        if self._devices().get(serial) == "device":
            return serial
        self._adb("disconnect", serial, timeout=5)
        return None

    def _make_stable(self, serial: str, host: str) -> str:
        stable = _endpoint(host, self.config.port)
        if serial == stable:
            return serial
        error_console.print(
            f"phone-mirror: moving ADB from {serial} to {stable}",
            highlight=False,
        )
        result = self._adb(
            "-s",
            serial,
            "tcpip",
            str(self.config.port),
            timeout=15,
        )
        if result.returncode != 0:
            raise DotfilesError(f"could not enable stable ADB: {_detail(result)}")
        for _attempt in range(12):
            time.sleep(0.25)
            if connected := self._connect(host, self.config.port):
                return connected
        raise DotfilesError(f"could not reconnect to {stable} after enabling ADB")

    def _connect_phone(self, host: str) -> str:
        started = self._adb("start-server", timeout=15)
        if started.returncode != 0:
            raise DotfilesError(f"could not start adb: {_detail(started)}")

        devices = self._devices()
        target = [
            serial
            for serial, state in devices.items()
            if state == "device" and _serial_host(serial) == host
        ]
        if target:
            stable = _endpoint(host, self.config.port)
            serial = stable if stable in target else target[0]
            return self._make_stable(serial, host)

        if connected := self._connect(host, self.config.port):
            return connected

        # A USB or LAN Wireless Debugging session can bootstrap the stable
        # Tailscale endpoint without scanning.
        online = [
            serial for serial, state in self._devices().items() if state == "device"
        ]
        if len(online) == 1:
            return self._make_stable(online[0], host)

        require_commands("nmap")
        start, end = _WIRELESS_DEBUGGING_PORTS
        error_console.print(
            f"phone-mirror: probing Wireless Debugging ports {start}-{end}",
            highlight=False,
        )
        for port in scan_open_ports(host, self.run_command):
            if connected := self._connect(host, port):
                return self._make_stable(connected, host)

        if len(online) > 1:
            raise DotfilesError(
                "more than one ADB device is connected and none matches the target"
            )
        raise DotfilesError(
            "could not reach ADB; enable Wireless debugging or connect the phone "
            "over USB, then retry"
        )

    def _prefer_lan(self, serial: str) -> str:
        result = self._adb(
            "-s",
            serial,
            "shell",
            "ip",
            "-o",
            "-4",
            "addr",
            "show",
            "up",
            "scope",
            "global",
        )
        if result.returncode != 0:
            return serial

        networks = _local_ipv4_networks()
        for address in _phone_lan_addresses(result.stdout):
            if not any(address in network for network in networks):
                continue
            if connected := self._connect(str(address), self.config.port):
                error_console.print(
                    f"phone-mirror: using local network address {address}",
                    highlight=False,
                )
                return connected
        return serial

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

    def _scrcpy_arguments(self, serial: str) -> tuple[str, ...]:
        result = self.run_command(("scrcpy", "--help"), timeout=5)
        active_option = (
            "--keep-active"
            if "--keep-active" in result.stdout + result.stderr
            else "--stay-awake"
        )
        arguments = [
            f"--serial={serial}",
            active_option,
            "--video-codec=h265",
            "--video-bit-rate=2M",
            "--max-size=1280",
            "--max-fps=30",
        ]
        if sys.platform.startswith("linux") and self.config.render_driver:
            arguments.extend(("--render-driver", self.config.render_driver))
        arguments.extend(self.config.scrcpy_args)
        return tuple(arguments)

    def run(self) -> None:
        require_commands("adb")
        host = self._target_ip()
        serial = self._connect_phone(host)
        if self.config.connect_only:
            error_console.print(f"phone-mirror: connected to {serial}", highlight=False)
            return
        serial = self._prefer_lan(serial)

        require_commands("scrcpy")
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
            self._scrcpy_arguments(serial),
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
