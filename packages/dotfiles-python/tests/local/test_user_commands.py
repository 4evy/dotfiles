import subprocess
from pathlib import Path

import pytest

from workstation.local import licenses, raycast
from workstation.local.desktop_audit import _lspci_display_devices


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
    monkeypatch.setattr(licenses, "_shottr_is_activated", lambda _domain: True)
    monkeypatch.setattr(licenses, "_activate_shottr_license", activated.append)
    licenses.shottr_license("install")

    assert activated == []


def test_shottr_force_install_reactivates_existing_license(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activated: list[str] = []
    monkeypatch.setattr(licenses, "_shottr_is_activated", lambda _domain: True)
    monkeypatch.setattr(licenses, "_shottr_license_key", lambda: "license-key")
    monkeypatch.setattr(licenses, "_activate_shottr_license", activated.append)
    licenses.shottr_license("install", force=True)

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
    monkeypatch.setattr(licenses.subprocess, "run", lambda *_args, **_kwargs: result)

    with pytest.raises(licenses.DotfilesError, match="Privacy & Security"):
        licenses._activate_shottr_license("license-key")


def test_shottr_activation_passes_license_to_external_applescript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[tuple[str | Path, ...], dict[str, object]]] = []

    def fake_run(
        argv: tuple[str | Path, ...], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess[str](argv, 0, "", "")

    monkeypatch.setattr(licenses.subprocess, "run", fake_run)

    licenses._activate_shottr_license("license-key")

    argv, kwargs = calls[0]
    assert argv[0] == "/usr/bin/osascript"
    assert isinstance(argv[1], Path)
    assert argv[1].name == "activate-shottr-license.applescript"
    assert argv[2] == "license-key"
    assert "input" not in kwargs


def test_raycast_node_wrapper_is_rendered_from_python_template(tmp_path: Path) -> None:
    node = tmp_path / "node"
    real = tmp_path / "node 'real'"
    hook = tmp_path / "keydump.cjs"
    key_file = tmp_path / "key cache"

    raycast._write_node_wrapper(node, real, hook, key_file)

    source = node.read_text(encoding="utf-8")
    compile(source, node, "exec")
    assert f'real = "{real}"' in source
    assert f'hook = "{hook}"' in source
    assert f'key_file = "{key_file}"' in source
    assert node.stat().st_mode & 0o111
