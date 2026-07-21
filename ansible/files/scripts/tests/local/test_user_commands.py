import subprocess

import pytest

from workstation.local import user_commands
from workstation.local.user_commands import (
    _lspci_display_devices,
    _matching_lines,
)


def test_matching_lines_supports_head_and_tail_limits() -> None:
    text = "alpha GPU\nbeta\ngamma gpu\ndelta GPU\n"

    assert _matching_lines(text, "gpu", limit=2) == "alpha GPU\ngamma gpu"
    assert _matching_lines(text, "gpu", limit=2, tail=True) == "gamma gpu\ndelta GPU"


def test_lspci_display_devices_keeps_following_context() -> None:
    text = "\n".join((
        "00:00.0 Host bridge",
        "01:00.0 VGA compatible controller",
        "    Subsystem",
        "    Kernel driver in use: nvidia",
        "    Kernel modules: nouveau, nvidia",
        "02:00.0 Audio device",
        "03:00.0 Network controller",
    ))

    result = _lspci_display_devices(text)

    assert "VGA compatible controller" in result
    assert "Kernel driver in use: nvidia" in result
    assert "02:00.0 Audio device" in result
    assert "03:00.0 Network controller" not in result


def test_shottr_install_keeps_existing_activation_without_force(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activated: list[str] = []
    monkeypatch.setattr(user_commands, "_shottr_is_activated", lambda _domain: True)
    monkeypatch.setattr(user_commands, "_activate_shottr_license", activated.append)
    user_commands.shottr_license("install")

    assert activated == []


def test_shottr_force_install_reactivates_existing_license(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activated: list[str] = []
    monkeypatch.setattr(user_commands, "_shottr_is_activated", lambda _domain: True)
    monkeypatch.setattr(user_commands, "_shottr_license_key", lambda: "license-key")
    monkeypatch.setattr(user_commands, "_activate_shottr_license", activated.append)
    user_commands.shottr_license("install", force=True)

    assert activated == ["license-key"]


def test_shottr_activation_explains_macos_accessibility_denial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = subprocess.CompletedProcess(
        args=("/usr/bin/osascript", "-"),
        returncode=1,
        stdout="",
        stderr="osascript is not allowed assistive access. (-25211)",
    )
    monkeypatch.setattr(user_commands.subprocess, "run", lambda *_args, **_kwargs: result)

    with pytest.raises(user_commands.DotfilesError, match="Privacy & Security"):
        user_commands._activate_shottr_license("license-key")
