import json
from pathlib import Path
from typing import TYPE_CHECKING

from workstation.apps import installers
from workstation.automation import run_machine_protocol

if TYPE_CHECKING:
    import pytest


def _payload(tmp_path: Path, command: list[str], *, check: bool = True) -> str:
    return json.dumps({
        "protocol": 1,
        "command": command,
        "context": {
            "repo_root": str(tmp_path),
            "home": str(tmp_path / "home"),
            "cache_dir": str(tmp_path / "cache"),
            "data_dir": str(tmp_path / "data"),
            "bin_dir": str(tmp_path / "bin"),
            "system": "Linux",
            "architecture": "x86_64",
        },
        "check": check,
        "diff": True,
    })


def test_machine_protocol_uses_cli_parser_and_operation_result(tmp_path: Path) -> None:
    response = run_machine_protocol(
        _payload(
            tmp_path,
            [
                "apps",
                "install-ghostty-tip-linux",
                str(tmp_path / "cache"),
                str(tmp_path / "prefix"),
            ],
        )
    )

    assert not response.failed
    assert response.changed
    assert response.msg == "Would check and install the current Ghostty tip"


def test_machine_protocol_rejects_commands_outside_allowlist(tmp_path: Path) -> None:
    response = run_machine_protocol(_payload(tmp_path, ["chezmoi", "shell-init"]))

    assert response.failed
    assert response.msg is not None
    assert "not exposed to Ansible automation" in response.msg


def test_machine_protocol_rejects_unknown_context(tmp_path: Path) -> None:
    payload = json.loads(
        _payload(
            tmp_path,
            [
                "apps",
                "install-ghostty-tip-linux",
                str(tmp_path / "cache"),
                str(tmp_path / "prefix"),
            ],
        )
    )
    payload["context"]["hostvars"] = {"secret": "must not cross the boundary"}

    response = run_machine_protocol(json.dumps(payload))

    assert response.failed
    assert response.msg is not None
    assert "Extra inputs are not permitted" in response.msg


def test_machine_protocol_accepts_helium_flags_that_begin_with_options(
    tmp_path: Path,
) -> None:
    response = run_machine_protocol(
        _payload(
            tmp_path,
            [
                "apps",
                "install-helium-macos",
                str(tmp_path / "cache"),
                str(tmp_path / "bin"),
                str(tmp_path / "installer-bin"),
                str(tmp_path / "secrets.yaml"),
                "--flags=--no-first-run --set-color-scheme=dark",
            ],
        )
    )

    assert not response.failed
    assert response.changed
    assert response.msg == "Would reconcile Helium on macOS"


def test_ghostty_check_mode_does_not_create_directories(tmp_path: Path) -> None:
    payload = _payload(
        tmp_path,
        [
            "apps",
            "install-ghostty-tip-linux",
            str(tmp_path / "cache"),
            str(tmp_path / "prefix"),
        ],
    )

    response = run_machine_protocol(payload)

    assert not response.failed
    assert response.changed
    assert not (tmp_path / "cache").exists()
    assert not (tmp_path / "prefix").exists()


def test_ghostty_staged_prefix_merge_replaces_links_without_rewriting_dirs(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    (source / "lib").mkdir(parents=True)
    (destination / "lib").mkdir(parents=True)
    (source / "lib/libghostty.so.1").write_text("new")
    (source / "lib/libghostty.so.1").chmod(0o751)
    (source / "lib/libghostty.so").symlink_to("libghostty.so.1")
    (destination / "lib/libghostty.so.0").write_text("old")
    (destination / "lib/libghostty.so").symlink_to("libghostty.so.0")

    installers._merge_install_tree(source, destination)

    assert (destination / "lib/libghostty.so.1").read_text() == "new"
    assert (destination / "lib/libghostty.so.1").stat().st_mode & 0o777 == 0o751
    assert (destination / "lib/libghostty.so").readlink() == Path("libghostty.so.1")


def test_ghostty_current_state_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(installers, "require_commands", lambda *_args: None)
    monkeypatch.setattr(installers, "_missing_libraries", lambda _path: [])
    prefix = tmp_path / "prefix"
    executable = prefix / "bin/ghostty"
    executable.parent.mkdir(parents=True)
    executable.write_text(f"#!/bin/sh\necho 'Ghostty {installers.GHOSTTY_VERSION}'\n")
    executable.chmod(0o755)
    patches = installers._ghostty_patches()
    installers.BuildState.write(
        prefix / ".ghostty-tip-state.json",
        installers.GHOSTTY_REVISION,
        inputs={"patches": installers._ghostty_patch_key(patches)},
    )
    payload = _payload(
        tmp_path,
        [
            "apps",
            "install-ghostty-tip-linux",
            str(tmp_path / "cache"),
            str(prefix),
        ],
        check=False,
    )

    response = run_machine_protocol(payload)

    assert not response.failed
    assert not response.changed
    assert response.msg == "Ghostty tip was checked recently"


def test_build_state_round_trips_and_rejects_corruption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = 1_750_000_000
    monkeypatch.setattr(installers.time, "time", lambda: now)
    path = tmp_path / "state.json"

    written = installers.BuildState.write(
        path,
        "revision",
        inputs={"toolchain": "pinned"},
    )

    assert installers.BuildState.read(path) == written
    assert written.is_fresh(1)
    monkeypatch.setattr(installers.time, "time", lambda: now - 1)
    assert not written.is_fresh(1)
    monkeypatch.setattr(installers.time, "time", lambda: now + 1)
    assert not written.is_fresh(1)

    path.write_text('{"schema_version":2}')
    assert installers.BuildState.read(path) is None
