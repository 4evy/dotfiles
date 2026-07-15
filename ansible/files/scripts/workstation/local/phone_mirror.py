import contextlib
import datetime as dt
import ipaddress
import os
import re
import socket
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Annotated, Protocol
from urllib.parse import urlsplit

import questionary
from cyclopts import App, Parameter, Token, validators
from cyclopts.config import Env
from defusedxml import ElementTree
from filelock import FileLock
from pydantic import BaseModel, ConfigDict, Field, IPvAnyAddress, ValidationError

from workstation.console import error_console
from workstation.errors import DotfilesError
from workstation.lib.commands import CommandResult, require_commands, run, which
from workstation.lib.files import ensure_directory, write_if_changed
from workstation.lib.paths import cache_path
from workstation.lib.retry import wait_until

_DEFAULT_NAME = "samsung-s25"
_DEFAULT_STABLE_PORT = 5555
_DEFAULT_SCAN_PORTS = "30000-49999"
_MDNS_CONNECT_SERVICE = "_adb-tls-connect._tcp"
_GUI_ENVIRONMENT_KEYS = frozenset({
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
})
_PORT = Annotated[int, Field(ge=1, le=65535)]


class RunCommand(Protocol):
    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
        input_text: str | None = None,
    ) -> CommandResult: ...


def _run_command(
    argv: Sequence[str],
    *,
    timeout: float,
    input_text: str | None = None,
) -> CommandResult:
    return run(
        argv,
        check=False,
        capture=True,
        input_text=input_text,
        timeout=timeout,
    )


class MdnsService(BaseModel):
    model_config = ConfigDict(frozen=True)

    instance: str
    service: str
    host: str
    port: _PORT


class Config(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str = _DEFAULT_NAME
    ip: str | None = None
    stable_port: _PORT = _DEFAULT_STABLE_PORT
    scan_start: _PORT = 30000
    scan_end: _PORT = 49999
    connect_only: bool = False
    keep_random_port: bool = False
    render_driver: str | None = "software"
    sdl_video_driver: str | None = "x11"
    scrcpy_args: tuple[str, ...] = ()


class _TailscaleNode(BaseModel):
    model_config = ConfigDict(extra="ignore")

    host_name: str = Field(alias="HostName")
    dns_name: str = Field(default="", alias="DNSName")
    addresses: tuple[IPvAnyAddress, ...] = Field(default=(), alias="TailscaleIPs")

    @property
    def names(self) -> set[str]:
        values = (self.host_name, self.dns_name)
        normalized = (value.rstrip(".").casefold() for value in values if value)
        return {
            name for value in normalized for name in (value, value.split(".", 1)[0])
        }


class _TailscaleStatus(BaseModel):
    model_config = ConfigDict(extra="ignore")

    own_node: _TailscaleNode | None = Field(default=None, alias="Self")
    peers: dict[str, _TailscaleNode] = Field(default_factory=dict, alias="Peer")

    @property
    def nodes(self) -> tuple[_TailscaleNode, ...]:
        own = (self.own_node,) if self.own_node is not None else ()
        return (*own, *self.peers.values())


class _PortCache(BaseModel):
    model_config = ConfigDict(frozen=True)

    version: int = 1
    host: str
    port: _PORT
    updated_at: dt.datetime = Field(default_factory=lambda: dt.datetime.now(dt.UTC))


def _log(message: str) -> None:
    error_console.print(f"phone-mirror: {message}", highlight=False)


def _detail(result: CommandResult) -> str:
    lines = (result.stderr.strip() or result.stdout.strip()).splitlines()
    return lines[-1] if lines else "unknown error"


def _parse_port_range(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"(\d+)-(\d+)", value.strip())
    if match is None:
        raise ValueError("port range must look like 30000-49999")
    start, end = map(int, match.groups())
    if not 1 <= start <= end <= 65535:
        raise ValueError("port range must be ordered and between 1 and 65535")
    return start, end


def _port_range(
    _type: type[tuple[int, int]], tokens: Sequence[Token]
) -> tuple[int, int]:
    return _parse_port_range(tokens[0].value)


def _split_endpoint(endpoint: str) -> tuple[str, int]:
    value = endpoint.strip()
    try:
        parsed = urlsplit(f"//{value}")
        host, port = parsed.hostname, parsed.port
    except ValueError as error:
        raise ValueError(endpoint) from error
    if host is None or port is None:
        raise ValueError(endpoint)
    return host, port


def _endpoint(host: str, port: int) -> str:
    address = ipaddress.ip_address(host)
    return f"[{address}]:{port}" if address.version == 6 else f"{address}:{port}"


def _endpoint_port(value: str) -> int:
    stripped = value.strip()
    try:
        port = int(stripped) if stripped.isdecimal() else _split_endpoint(stripped)[1]
    except ValueError as error:
        raise DotfilesError(
            "expected a port or endpoint such as 37123 or 192.0.2.1:37123"
        ) from error
    if not 1 <= port <= 65535:
        raise DotfilesError(f"port must be between 1 and 65535: {port}")
    return port


def parse_mdns_services(output: str) -> tuple[MdnsService, ...]:
    services: list[MdnsService] = []
    for line in output.splitlines():
        fields = line.split()
        if len(fields) != 3 or not fields[1].startswith("_adb"):
            continue
        with contextlib.suppress(ValueError, ValidationError):
            host, port = _split_endpoint(fields[2])
            services.append(
                MdnsService(instance=fields[0], service=fields[1], host=host, port=port)
            )
    return tuple(services)


def resolve_tailscale_ip(name: str, run_command: RunCommand) -> str:
    result = run_command(("tailscale", "status", "--json"), timeout=8)
    if result.returncode != 0:
        raise DotfilesError(f"tailscale status failed: {_detail(result)}")
    try:
        status = _TailscaleStatus.model_validate_json(result.stdout)
    except ValidationError as error:
        raise DotfilesError("tailscale status returned invalid data") from error

    wanted = name.rstrip(".").casefold()
    matches = [node for node in status.nodes if wanted in node.names]
    if not matches:
        raise DotfilesError(
            f"could not find {name} in tailscale status; pass --ip or set "
            "PHONE_MIRROR_IP"
        )
    if len(matches) > 1:
        raise DotfilesError(f"tailscale name {name!r} matched more than one device")
    if not matches[0].addresses:
        raise DotfilesError(f"tailscale did not report a valid IP for {name}")
    return str(min(matches[0].addresses, key=lambda address: address.version))


def _target_serials(output: str, host: str) -> dict[str, str]:
    wanted = ipaddress.ip_address(host)
    target: dict[str, str] = {}
    for line in output.splitlines()[1:]:
        fields = line.split()
        if len(fields) < 2:
            continue
        with contextlib.suppress(ValueError):
            serial_host, _ = _split_endpoint(fields[0])
            if ipaddress.ip_address(serial_host) == wanted:
                target[fields[0]] = fields[1]
    return target


def _cache_path(name: str) -> Path:
    safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip("-.") or "phone"
    return cache_path("phone-mirror", f"{safe_name}.json")


def _cached_port(path: Path, host: str) -> int | None:
    try:
        cached = _PortCache.model_validate_json(path.read_text(encoding="utf-8"))
    except OSError, ValidationError:
        return None
    return cached.port if cached.version == 1 and cached.host == host else None


def _write_cached_port(path: Path, host: str, port: int) -> None:
    ensure_directory(path.parent, "0700")
    cached = _PortCache(host=host, port=port)
    write_if_changed(path, f"{cached.model_dump_json(indent=2)}\n", "0600")


def _open_ports_from_nmap(output: str) -> tuple[int, ...]:
    try:
        root = ElementTree.fromstring(output)
    except ElementTree.ParseError as error:
        raise DotfilesError("nmap returned invalid XML") from error
    ports: list[int] = []
    for element in root.findall("./host/ports/port"):
        state = element.find("state")
        if state is not None and state.get("state") == "open":
            with contextlib.suppress(TypeError, ValueError):
                ports.append(int(element.get("portid")))
    return tuple(ports)


def scan_open_ports(
    host: str,
    start: int,
    end: int,
    run_command: RunCommand = _run_command,
) -> tuple[int, ...]:
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


def _ask_text(message: str) -> str | None:
    return questionary.text(message).ask()


def _ask_secret(message: str) -> str | None:
    return questionary.password(message).ask()


class PhoneMirror:
    def __init__(
        self,
        config: Config,
        *,
        run_command: RunCommand = _run_command,
        environment: dict[str, str] | None = None,
        ask_text: Callable[[str], str | None] = _ask_text,
        ask_secret: Callable[[str], str | None] = _ask_secret,
        cache_file: Path | None = None,
    ) -> None:
        self.config = config
        self.run_command = run_command
        self.environment = environment if environment is not None else os.environ.copy()
        self.ask_text = ask_text
        self.ask_secret = ask_secret
        self.host = ""
        self.cache_path = cache_file or _cache_path(config.name)

    def _adb(self, *arguments: str, timeout: float = 10) -> CommandResult:
        return self.run_command(("adb", *arguments), timeout=timeout)

    def _devices(self) -> dict[str, str]:
        result = self._adb("devices", "-l")
        if result.returncode != 0:
            raise DotfilesError(f"adb devices failed: {_detail(result)}")
        return _target_serials(result.stdout, self.host)

    def _online_serial(self) -> str | None:
        stable = _endpoint(self.host, self.config.stable_port)
        online = [
            serial for serial, state in self._devices().items() if state == "device"
        ]
        return stable if stable in online else next(iter(online), None)

    def _clear_stale(self) -> None:
        for serial, state in self._devices().items():
            if state == "offline":
                _log(f"forgetting stale ADB session {serial}")
                self._adb("disconnect", serial, timeout=5)

    def _wait_online(self, serial: str, timeout: float = 6) -> bool:
        return wait_until(
            lambda: self._devices().get(serial) == "device",
            attempts=max(1, round(timeout / 0.25)),
            interval=0.25,
        )

    def _connect(self, port: int) -> str | None:
        serial = _endpoint(self.host, port)
        _log(f"trying {serial}")
        result = self._adb("connect", serial, timeout=10)
        if result.returncode == 0 and self._wait_online(serial):
            try:
                _write_cached_port(self.cache_path, self.host, port)
            except OSError as error:
                _log(f"could not update the port cache: {error}")
            return serial
        return None

    def _mdns_ports(self) -> tuple[int, ...]:
        result = self._adb("mdns", "services", timeout=5)
        if result.returncode != 0:
            return ()
        return tuple(
            service.port
            for service in parse_mdns_services(result.stdout)
            if service.service.rstrip(".") == _MDNS_CONNECT_SERVICE
        )

    def _try_ports(self, ports: Sequence[int], tried: set[int]) -> str | None:
        for port in dict.fromkeys(ports):
            if port not in tried:
                tried.add(port)
                if serial := self._connect(port):
                    return serial
        return None

    def _discover(self, tried: set[int], *, scan: bool) -> str | None:
        cached = _cached_port(self.cache_path, self.host)
        candidates = ((cached,) if cached is not None else ()) + self._mdns_ports()
        if serial := self._try_ports(candidates, tried):
            return serial
        if not scan:
            return None
        _log(
            f"probing Wireless Debugging ports {self.config.scan_start}-"
            f"{self.config.scan_end} with nmap"
        )
        ports = scan_open_ports(
            self.host,
            self.config.scan_start,
            self.config.scan_end,
            self.run_command,
        )
        return self._try_ports(ports, tried)

    @staticmethod
    def _require_tty() -> None:
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            raise DotfilesError(
                "pairing needs a terminal; enable Wireless debugging and rerun "
                "interactively"
            )

    def _answer(self, prompt: Callable[[str], str | None], message: str) -> str:
        answer = prompt(message)
        if answer is None:
            raise DotfilesError("prompt cancelled")
        return answer.strip()

    def _pair(self) -> None:
        self._require_tty()
        error_console.print(
            "\nOn the phone, open:\n"
            "  Developer options -> Wireless debugging -> Pair device with pairing code\n"
        )
        pairing_value = self._answer(
            self.ask_text, "Paste pairing endpoint or just port:"
        )
        if not pairing_value:
            raise DotfilesError("pairing endpoint is required")
        pairing_endpoint = _endpoint(self.host, _endpoint_port(pairing_value))
        code = self._answer(self.ask_secret, "Paste pairing code:")
        if not code:
            raise DotfilesError("pairing code is required")
        _log(f"pairing with {pairing_endpoint}")
        result = self.run_command(
            ("adb", "pair", pairing_endpoint),
            timeout=35,
            input_text=f"{code}\n",
        )
        if (
            result.returncode != 0
            or "success" not in (result.stdout + result.stderr).casefold()
        ):
            raise DotfilesError(f"ADB pairing failed: {_detail(result)}")

    def _manual_connect_port(self, tried: set[int]) -> str | None:
        self._require_tty()
        error_console.print(
            "\nOn the main Wireless debugging screen, find 'IP address & Port'."
        )
        value = self._answer(self.ask_text, "Paste that connection endpoint or port:")
        if not value:
            raise DotfilesError("Wireless debugging connection port is required")
        port = _endpoint_port(value)
        tried.discard(port)
        return self._try_ports((port,), tried)

    def _make_stable(self, serial: str) -> str:
        stable = _endpoint(self.host, self.config.stable_port)
        if serial == stable or self.config.keep_random_port:
            return serial
        _log(f"making future runs code-free on {stable}")
        result = self._adb(
            "-s", serial, "tcpip", str(self.config.stable_port), timeout=15
        )
        if result.returncode != 0:
            if self._devices().get(serial) == "device":
                _log(
                    f"could not enable stable ADB; keeping {serial}: {_detail(result)}"
                )
                return serial
            raise DotfilesError(f"could not enable stable ADB: {_detail(result)}")

        def stable_port_is_open() -> bool:
            try:
                with socket.create_connection(
                    (self.host, self.config.stable_port), timeout=0.3
                ):
                    return True
            except OSError:
                return False

        wait_until(stable_port_is_open, attempts=60, interval=0.25)
        if connected := self._connect(self.config.stable_port):
            self._clear_stale()
            return connected
        if self._devices().get(serial) == "device":
            _log(f"stable port did not come up; keeping {serial}")
            return serial
        raise DotfilesError(
            f"could not reconnect to {stable} after enabling stable ADB"
        )

    def _connect_phone(self) -> str:
        started = self._adb("start-server", timeout=15)
        if started.returncode != 0:
            raise DotfilesError(f"could not start adb: {_detail(started)}")
        self._clear_stale()
        if online := self._online_serial():
            return self._make_stable(online)
        tried: set[int] = set()
        serial = self._try_ports((self.config.stable_port,), tried)
        serial = serial or self._discover(tried, scan=True)
        if serial is None:
            self._pair()
            # Pairing can make an already rejected connect port usable immediately.
            tried.clear()
            serial = self._online_serial()
            if serial is None:
                wait_until(
                    lambda: self._discover(tried, scan=False) is not None,
                    attempts=8,
                    interval=0.5,
                )
                serial = self._online_serial()
            serial = serial or self._discover(tried, scan=True)
        serial = serial or self._manual_connect_port(tried)
        if serial is None:
            raise DotfilesError(
                "could not connect; toggle Wireless debugging off/on and try again"
            )
        return self._make_stable(serial)

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
            ("systemctl", "--user", "show-environment"), timeout=5
        )
        if result.returncode != 0:
            return
        for line in result.stdout.splitlines():
            key, separator, value = line.partition("=")
            if separator and key in _GUI_ENVIRONMENT_KEYS:
                self.environment.setdefault(key, value)

    def _scrcpy_command(self, serial: str) -> tuple[str, ...]:
        result = self.run_command(("scrcpy", "--help"), timeout=5)
        active_option = (
            "--keep-active"
            if "--keep-active" in result.stdout + result.stderr
            else "--stay-awake"
        )
        arguments = ["scrcpy", "--serial", serial, active_option]
        if sys.platform.startswith("linux") and self.config.render_driver:
            arguments.extend(("--render-driver", self.config.render_driver))
        arguments.extend(self.config.scrcpy_args)
        return tuple(arguments)

    def run(self) -> None:
        require_commands("adb", "nmap")
        if self.config.ip:
            try:
                self.host = str(ipaddress.ip_address(self.config.ip))
            except ValueError as error:
                raise DotfilesError(
                    f"invalid --ip address: {self.config.ip}"
                ) from error
        else:
            require_commands("tailscale")
            self.host = resolve_tailscale_ip(self.config.name, self.run_command)
        _log(f"targeting {self.config.name} at {self.host}")

        lock_path = self.cache_path.parent / "connection.lock"
        ensure_directory(lock_path.parent, "0700")
        with FileLock(lock_path):
            serial = self._connect_phone()
        if self.config.connect_only:
            _log(f"connected to {serial}")
            return

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
        _log("opening screen mirror")
        executable = which("scrcpy")
        if (
            executable is None
        ):  # Kept explicit for the type checker after require_commands.
            raise DotfilesError("required command is not available: scrcpy")
        os.execvpe(
            os.fspath(executable),
            self._scrcpy_command(serial),
            self.environment,
        )


def mirror(
    *scrcpy_args: Annotated[str, Parameter(allow_leading_hyphen=True)],
    name: Annotated[
        str,
        Parameter(help="Tailscale host name."),
    ] = _DEFAULT_NAME,
    ip: Annotated[
        str | None,
        Parameter(help="Target IP address."),
    ] = None,
    stable_port: Annotated[
        int,
        Parameter(
            validator=validators.Number(gte=1, lte=65535),
            help="Persistent legacy ADB port.",
        ),
    ] = _DEFAULT_STABLE_PORT,
    scan_ports: Annotated[
        tuple[int, int],
        Parameter(
            converter=_port_range,
            accepts_keys=False,
            negative_iterable="",
            n_tokens=1,
            help="Wireless Debugging fallback range scanned by nmap.",
        ),
    ] = _parse_port_range(_DEFAULT_SCAN_PORTS),
    connect_only: Annotated[
        bool,
        Parameter(
            negative="",
            help="Do not run scrcpy.",
        ),
    ] = False,
    keep_random_port: Annotated[
        bool,
        Parameter(
            negative="",
            help="Do not switch ADB to the stable port.",
        ),
    ] = False,
    render_driver: str | None = "software",
    sdl_video_driver: Annotated[
        str | None,
        Parameter(env_var="PHONE_MIRROR_SDL_VIDEODRIVER"),
    ] = "x11",
) -> None:
    """Connect to and mirror an Android phone over Tailscale."""
    scan_start, scan_end = scan_ports
    PhoneMirror(
        Config(
            name=name,
            ip=ip,
            stable_port=stable_port,
            scan_start=scan_start,
            scan_end=scan_end,
            connect_only=connect_only,
            keep_random_port=keep_random_port,
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
