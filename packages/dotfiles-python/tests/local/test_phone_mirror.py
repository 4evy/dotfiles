import json
from collections.abc import Sequence
from pathlib import Path
from subprocess import CompletedProcess

from workstation.local.phone_mirror import (
    Config,
    PhoneMirror,
    _endpoint,
    _read_cached_ip,
    _write_cached_ip,
    resolve_tailscale_ip,
)


class FakeRunner:
    def __init__(
        self,
        responses: dict[tuple[str, ...], CompletedProcess[str]],
    ) -> None:
        self.responses = responses
        self.calls: list[tuple[str, ...]] = []

    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
        input_text: str | None = None,
    ) -> CompletedProcess[str]:
        del timeout, input_text
        call = tuple(argv)
        self.calls.append(call)
        return self.responses.get(call, CompletedProcess(call, 0, "", ""))


def _config(**overrides: object) -> Config:
    values: dict[str, object] = {
        "name": "phone",
        "ip": "100.64.0.9",
        "port": 5555,
        "connect_only": False,
        "render_driver": "software",
        "sdl_video_driver": "x11",
        "scrcpy_args": (),
    }
    values.update(overrides)
    return Config.model_validate(values)


def test_endpoint_formats_ipv6_literals() -> None:
    assert _endpoint("fd7a:115c:a1e0::1", 5555) == "[fd7a:115c:a1e0::1]:5555"


def test_resolve_tailscale_ip_uses_exact_name_and_prefers_ipv4() -> None:
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
        ("tailscale", "status", "--json"): CompletedProcess(
            (),
            0,
            json.dumps(payload),
            "",
        )
    })

    assert resolve_tailscale_ip("samsung-s25", runner) == "100.64.0.9"


def test_tailscale_address_cache_is_bound_to_name(tmp_path: Path) -> None:
    path = tmp_path / "phone.json"

    _write_cached_ip(path, "phone", "100.64.0.9")

    assert _read_cached_ip(path, "phone") == "100.64.0.9"
    assert _read_cached_ip(path, "another-phone") is None
    assert path.stat().st_mode & 0o777 == 0o600


def test_scrcpy_owns_tcpip_connection_and_launch() -> None:
    runner = FakeRunner({
        ("scrcpy", "--help"): CompletedProcess((), 0, "options: --keep-active", "")
    })
    mirror = PhoneMirror(
        _config(scrcpy_args=("--turn-screen-off",)),
        run_command=runner,
    )

    assert mirror._scrcpy_arguments("100.64.0.9") == (
        "--tcpip=100.64.0.9:5555",
        "--keep-active",
        "--turn-screen-off",
    )


def test_connect_only_still_uses_scrcpy_tcpip() -> None:
    runner = FakeRunner({
        ("scrcpy", "--help"): CompletedProcess((), 0, "--stay-awake", "")
    })
    mirror = PhoneMirror(_config(connect_only=True), run_command=runner)

    assert mirror._scrcpy_arguments("100.64.0.9") == (
        "--tcpip=100.64.0.9:5555",
        "--stay-awake",
        "--no-video",
        "--no-audio",
        "--no-control",
        "--time-limit=1",
    )
