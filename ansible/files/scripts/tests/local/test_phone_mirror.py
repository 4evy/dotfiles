import json
from collections.abc import Sequence
from pathlib import Path
from typing import override

import pytest

from workstation.errors import DotfilesError
from workstation.lib.commands import CommandResult
from workstation.local import phone_mirror as phone_mirror_module
from workstation.local.phone_mirror import (
    Config,
    PhoneMirror,
    _cached_port,
    _endpoint,
    _endpoint_port,
    _open_ports_from_nmap,
    _target_serials,
    _write_cached_port,
    app,
    parse_mdns_services,
    resolve_tailscale_ip,
    scan_open_ports,
)


class FakeRunner:
    def __init__(self, responses: dict[tuple[str, ...], CommandResult]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, ...]] = []

    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
        input_text: str | None = None,
    ) -> CommandResult:
        del timeout, input_text
        call = tuple(argv)
        self.calls.append(call)
        return self.responses.get(call, CommandResult(0, "", ""))


def _config(**overrides: object) -> Config:
    values: dict[str, object] = {
        "name": "phone",
        "ip": "100.64.0.9",
        "stable_port": 5555,
        "scan_start": 30000,
        "scan_end": 49999,
        "connect_only": True,
        "keep_random_port": False,
        "render_driver": "software",
        "sdl_video_driver": "x11",
        "scrcpy_args": (),
    }
    values.update(overrides)
    return Config.model_validate(values)


def test_cli_preserves_environment_and_scrcpy_argument_compatibility(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configurations: list[Config] = []
    monkeypatch.setattr(
        PhoneMirror, "run", lambda mirror: configurations.append(mirror.config)
    )
    environment = {
        "PHONE_MIRROR_NAME": "pixel",
        "PHONE_MIRROR_IP": "100.100.1.2",
        "PHONE_MIRROR_CONNECT_ONLY": "1",
        "PHONE_MIRROR_KEEP_RANDOM_PORT": "true",
        "PHONE_MIRROR_RENDER_DRIVER": "opengl",
        "PHONE_MIRROR_SDL_VIDEODRIVER": "wayland",
    }
    for name, value in environment.items():
        monkeypatch.setenv(name, value)

    app(["--", "--turn-screen-off"])

    assert configurations == [
        _config(
            name="pixel",
            ip="100.100.1.2",
            connect_only=True,
            keep_random_port=True,
            render_driver="opengl",
            sdl_video_driver="wayland",
            scrcpy_args=("--turn-screen-off",),
        )
    ]


@pytest.mark.parametrize(
    ("arguments", "message"),
    [
        (["--stable-port", "0"], ">= 1"),
        (["--scan-ports", "49999-30000"], "port range must be ordered"),
    ],
)
def test_cli_declaratively_validates_ports(
    arguments: list[str],
    message: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.delenv("PHONE_MIRROR_STABLE_PORT", raising=False)
    monkeypatch.delenv("PHONE_MIRROR_SCAN_PORTS", raising=False)
    monkeypatch.setattr(
        PhoneMirror,
        "run",
        lambda _mirror: pytest.fail("invalid input must not run the mirror"),
    )

    with pytest.raises(SystemExit) as error:
        app(arguments)

    assert error.value.code == 1
    captured = capsys.readouterr()
    assert message in captured.out + captured.err


def test_parse_mdns_services_ignores_headers_and_unrelated_lines() -> None:
    output = """List of discovered mdns services
adb-phone-a _adb-tls-pairing._tcp 192.168.1.8:37777
adb-phone-b _adb-tls-connect._tcp. 192.168.1.8:38888
printer _ipp._tcp 192.168.1.3:631
"""

    services = parse_mdns_services(output)

    assert [(item.service, item.port) for item in services] == [
        ("_adb-tls-pairing._tcp", 37777),
        ("_adb-tls-connect._tcp.", 38888),
    ]


@pytest.mark.parametrize(
    ("host", "port", "expected"),
    [
        ("100.64.0.1", 5555, "100.64.0.1:5555"),
        ("fd7a:115c:a1e0::1", 5555, "[fd7a:115c:a1e0::1]:5555"),
    ],
)
def test_endpoint_formats_ip_literals(host: str, port: int, expected: str) -> None:
    assert _endpoint(host, port) == expected
    assert _endpoint_port(expected) == port


def test_target_serials_selects_only_target_ip() -> None:
    output = """List of devices attached
100.64.0.9:5555 device product:x
100.64.0.90:5555 offline product:y
[fd7a:115c:a1e0::9]:38000 unauthorized
"""

    assert _target_serials(output, "100.64.0.9") == {"100.64.0.9:5555": "device"}
    assert _target_serials(output, "fd7a:115c:a1e0::9") == {
        "[fd7a:115c:a1e0::9]:38000": "unauthorized"
    }


def test_resolve_tailscale_ip_uses_exact_host_name_and_prefers_ipv4() -> None:
    payload = {
        "Peer": {
            "node-key": {
                "HostName": "samsung-s25",
                "DNSName": "samsung-s25.example.ts.net.",
                "TailscaleIPs": ["fd7a:115c:a1e0::9", "100.64.0.9"],
            }
        }
    }
    runner = FakeRunner({
        ("tailscale", "status", "--json"): CommandResult(0, json.dumps(payload), "")
    })

    assert resolve_tailscale_ip("samsung-s25", runner) == "100.64.0.9"


def test_cache_is_bound_to_target_host_and_written_atomically(tmp_path: Path) -> None:
    path = tmp_path / "phone.json"

    _write_cached_port(path, "100.64.0.9", 38888)

    assert _cached_port(path, "100.64.0.9") == 38888
    assert _cached_port(path, "100.64.0.10") is None
    assert path.stat().st_mode & 0o777 == 0o600


def test_nmap_xml_selects_only_open_tcp_ports() -> None:
    output = """<?xml version="1.0"?>
<nmaprun><host><ports>
  <port protocol="tcp" portid="37777"><state state="closed"/></port>
  <port protocol="tcp" portid="38888"><state state="open"/></port>
</ports></host></nmaprun>
"""

    assert _open_ports_from_nmap(output) == (38888,)


def test_port_scan_is_delegated_to_nmap() -> None:
    xml = (
        '<nmaprun><host><ports><port protocol="tcp" portid="38888">'
        '<state state="open"/></port></ports></host></nmaprun>'
    )
    runner = FakeRunner({})
    runner.responses = {
        (
            "nmap",
            "-Pn",
            "-n",
            "--open",
            "-T4",
            "--host-timeout",
            "45s",
            "-p",
            "30000-49999",
            "-oX",
            "-",
            "100.64.0.9",
        ): CommandResult(0, xml, "")
    }

    assert scan_open_ports("100.64.0.9", 30000, 49999, runner) == (38888,)


def test_connect_uses_mdns_port_on_tailscale_address(tmp_path: Path) -> None:
    devices = iter([
        "List of devices attached\n",
        "List of devices attached\n100.64.0.9:38888 device product:x\n",
    ])

    class MdnsRunner(FakeRunner):
        @override
        def __call__(
            self,
            argv: Sequence[str],
            *,
            timeout: float,
            input_text: str | None = None,
        ) -> CommandResult:
            del timeout, input_text
            call = tuple(argv)
            self.calls.append(call)
            if call == ("adb", "devices", "-l"):
                return CommandResult(0, next(devices), "")
            return self.responses.get(call, CommandResult(0, "", ""))

    runner = MdnsRunner({
        ("adb", "mdns", "services"): CommandResult(
            0, "phone _adb-tls-connect._tcp 192.168.1.20:38888\n", ""
        ),
    })
    mirror = PhoneMirror(
        _config(keep_random_port=True),
        run_command=runner,
        cache_file=tmp_path / "phone.json",
    )
    mirror.host = "100.64.0.9"

    serial = mirror._discover(set(), scan=False)

    assert serial == "100.64.0.9:38888"
    assert ("adb", "connect", "100.64.0.9:38888") in runner.calls


def test_existing_stable_connection_is_reused(tmp_path: Path) -> None:
    devices = CommandResult(
        0,
        "List of devices attached\n100.64.0.9:5555 device product:x\n",
        "",
    )
    runner = FakeRunner({
        ("adb", "start-server"): CommandResult(0, "", ""),
        ("adb", "devices", "-l"): devices,
    })
    mirror = PhoneMirror(
        _config(),
        run_command=runner,
        cache_file=tmp_path / "phone.json",
    )
    mirror.host = "100.64.0.9"

    assert mirror._connect_phone() == "100.64.0.9:5555"
    assert not any(call[1:2] == ("connect",) for call in runner.calls)


def test_manual_port_can_retry_a_previously_failed_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mirror = PhoneMirror(
        _config(),
        run_command=FakeRunner({}),
        ask_text=lambda _prompt: "100.64.0.9:38888",
    )
    mirror.host = "100.64.0.9"
    tried = {38888}
    attempted: list[int] = []
    monkeypatch.setattr(mirror, "_require_tty", lambda: None)
    monkeypatch.setattr(
        mirror,
        "_connect",
        lambda port: attempted.append(port) or "100.64.0.9:38888",
    )

    assert mirror._manual_connect_port(tried) == "100.64.0.9:38888"
    assert attempted == [38888]


def test_scrcpy_uses_keep_active_and_forwards_arguments() -> None:
    runner = FakeRunner({
        ("scrcpy", "--help"): CommandResult(0, "options: --keep-active", "")
    })
    mirror = PhoneMirror(
        _config(connect_only=False, scrcpy_args=("--turn-screen-off",)),
        run_command=runner,
    )

    assert mirror._scrcpy_command("100.64.0.9:5555") == (
        "scrcpy",
        "--serial",
        "100.64.0.9:5555",
        "--keep-active",
        "--render-driver",
        "software",
        "--turn-screen-off",
    )


def test_macos_does_not_force_linux_rendering(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(phone_mirror_module.sys, "platform", "darwin")
    runner = FakeRunner({
        ("scrcpy", "--help"): CommandResult(0, "options: --keep-active", "")
    })
    mirror = PhoneMirror(
        _config(connect_only=False),
        run_command=runner,
        environment={},
    )

    mirror._hydrate_gui_environment()

    assert mirror.environment == {}
    assert mirror._scrcpy_command("100.64.0.9:5555") == (
        "scrcpy",
        "--serial",
        "100.64.0.9:5555",
        "--keep-active",
    )


def test_invalid_ip_is_rejected_before_any_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(phone_mirror_module, "require_commands", lambda *_names: None)
    mirror = PhoneMirror(_config(ip="not-an-ip"), run_command=FakeRunner({}))

    with pytest.raises(DotfilesError, match="invalid --ip"):
        mirror.run()
