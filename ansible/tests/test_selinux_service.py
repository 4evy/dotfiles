import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any, cast

import pytest


def _selinux_module() -> ModuleType:
    path = Path(__file__).parents[1] / "library/dotfiles_selinux_service.py"
    spec = importlib.util.spec_from_file_location("dotfiles_selinux_service", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


selinux = cast("Any", _selinux_module())


def test_policy_state_tracks_source_content(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    names = ("example.te", "example.fc", "example.if")
    for name in names:
        (tmp_path / name).write_text(name, encoding="utf-8")
    hash_file = tmp_path / "installed.sha256"
    monkeypatch.setattr(selinux, "module_installed", lambda _name: True)

    digest, stale = selinux.policy_state(tmp_path, "example", names, hash_file)
    assert stale

    hash_file.write_text(f"{digest}\n", encoding="utf-8")
    assert not selinux.policy_state(tmp_path, "example", names, hash_file)[1]

    (tmp_path / "example.te").write_text("changed", encoding="utf-8")
    assert selinux.policy_state(tmp_path, "example", names, hash_file)[1]


def test_reconcile_defers_changes_while_protected_child_is_active(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(selinux, "selinux_enabled", lambda: True)
    monkeypatch.setattr(selinux, "policy_state", lambda *_args: ("digest", True))
    monkeypatch.setattr(selinux, "service_active", lambda _service: True)
    monkeypatch.setattr(
        selinux,
        "service_context",
        lambda _service: "system_u:system_r:example_t:s0",
    )
    monkeypatch.setattr(selinux, "matching_child_active", lambda *_args: True)

    config = selinux.ReconcileConfig(
        policy_module="example",
        policy_directory=tmp_path,
        hash_file=tmp_path / "state",
        service="example",
        domain="example_t",
        restore_targets=(),
        restart_when_inactive=True,
        defer_child_pattern="protected child",
        allow_reload=False,
    )
    result = selinux.reconcile(
        config,
        check_mode=False,
    )

    assert not result.changed
    assert result.deferred
    assert result.enabled


def test_reconcile_check_mode_does_not_apply_changes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = selinux.ReconcileConfig(
        policy_module="example",
        policy_directory=tmp_path,
        hash_file=tmp_path / "state",
        service="example",
        domain="example_t",
        restore_targets=(),
        restart_when_inactive=True,
        defer_child_pattern=None,
        allow_reload=False,
    )
    state = selinux.ConfinementState(
        names=("example.te", "example.fc", "example.if"),
        digest="digest",
        unit="example.service",
        expected_context="system_u:system_r:example_t:s0",
        dropin=tmp_path / "dropin",
        dropin_content="content",
        policy_stale=True,
        dropin_stale=True,
        context="",
        restart_required=True,
    )
    monkeypatch.setattr(selinux, "selinux_enabled", lambda: True)
    monkeypatch.setattr(selinux, "confinement_state", lambda _config: state)
    monkeypatch.setattr(selinux, "matching_child_active", lambda *_args: False)
    monkeypatch.setattr(
        selinux,
        "apply_confinement",
        lambda *_args: pytest.fail("check mode mutated the host"),
    )

    result = selinux.reconcile(config, check_mode=True)

    assert result.changed
    assert not result.deferred
