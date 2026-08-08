#!/usr/bin/python
"""Install a local SELinux policy and confine its systemd service."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

try:
    from ansible.module_utils.basic import (  # ty: ignore[unresolved-import]
        AnsibleModule,
    )
except ModuleNotFoundError:
    AnsibleModule = None  # type: ignore[assignment,misc]

DOCUMENTATION = r"""
---
module: dotfiles_selinux_service
short_description: Install a local SELinux module and confine a systemd service
description:
  - Builds and installs local policy sources, then applies a systemd SELinuxContext drop-in.
author: 4evy
options:
  policy_module:
    description: SELinux policy module name and source filename prefix.
    required: true
    type: str
  policy_directory:
    description: Directory containing the te, fc, and if policy sources.
    required: true
    type: path
  hash_file:
    description: State file used to record the installed source digest.
    required: true
    type: path
  service:
    description: systemd service to confine and restart when necessary.
    required: true
    type: str
  domain:
    description: SELinux process domain for the service.
    required: true
    type: str
  restore_targets:
    description: Paths whose labels should be restored after policy installation.
    type: list
    elements: dict
    default: []
    options:
      path:
        description: Host path to pass to restorecon.
        required: true
        type: path
      recursive:
        description: Restore labels recursively below the path.
        type: bool
        default: false
  restart_when_inactive:
    description: Start the service when it is not currently active.
    type: bool
    default: true
  defer_child_pattern:
    description: Child process pattern that makes a required restart unsafe.
    type: str
  allow_reload:
    description: Ignore the protected child pattern and permit a live restart.
    type: bool
    default: false
supports_check_mode: true
"""


class SELinuxError(RuntimeError):
    """The policy or service confinement could not be reconciled safely."""


@dataclass(frozen=True, slots=True)
class ReconcileResult:
    """Observable state returned to the calling role."""

    changed: bool
    deferred: bool
    enabled: bool
    context: str


@dataclass(frozen=True, slots=True)
class ReconcileConfig:
    """Inputs that describe one policy-backed systemd service."""

    policy_module: str
    policy_directory: Path
    hash_file: Path
    service: str
    domain: str
    restore_targets: Sequence[dict[str, Any]]
    restart_when_inactive: bool
    defer_child_pattern: str | None
    allow_reload: bool


@dataclass(frozen=True, slots=True)
class ConfinementState:
    """Current and desired state derived without mutating the host."""

    names: tuple[str, ...]
    digest: str
    unit: str
    expected_context: str
    dropin: Path
    dropin_content: str
    policy_stale: bool
    dropin_stale: bool
    context: str
    restart_required: bool

    @property
    def changed(self) -> bool:
        """Whether reconciliation would mutate the host."""
        return self.policy_stale or self.dropin_stale or self.restart_required


def run(
    arguments: Sequence[str | Path], *, check: bool = True
) -> subprocess.CompletedProcess[str]:
    """Run one host command without a shell."""
    result = subprocess.run(
        tuple(map(str, arguments)),
        check=False,
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise SELinuxError(
            f"command failed ({result.returncode}): {arguments[0]}: {message}"
        )
    return result


def output(arguments: Sequence[str | Path]) -> str:
    """Return stripped stdout for a best-effort host query."""
    return run(arguments, check=False).stdout.strip()


def selinux_enabled() -> bool:
    """Return whether SELinux tools exist and SELinux is enabled."""
    return shutil.which("getenforce") is not None and output(("getenforce",)) not in {
        "",
        "Disabled",
    }


def policy_hash(directory: Path, names: tuple[str, ...]) -> str:
    """Hash policy filenames and contents in a stable order."""
    digest = hashlib.sha256()
    for name in names:
        path = directory / name
        if not path.is_file():
            raise SELinuxError(f"SELinux policy source does not exist: {path}")
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def module_installed(name: str) -> bool:
    """Return whether semodule lists the requested module."""
    return any(
        line.split()[0:1] == [name] for line in output(("semodule", "-l")).splitlines()
    )


def policy_state(
    directory: Path,
    module: str,
    names: tuple[str, ...],
    hash_file: Path,
) -> tuple[str, bool]:
    """Return the source digest and whether the installed policy is stale."""
    digest = policy_hash(directory, names)
    installed_digest = (
        hash_file.read_text(encoding="utf-8").strip() if hash_file.is_file() else None
    )
    return digest, not module_installed(module) or installed_digest != digest


def write_if_changed(path: Path, content: str, mode: int = 0o644) -> bool:
    """Atomically replace a small text file when its contents differ."""
    if path.is_file() and path.read_text(encoding="utf-8") == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(dir=path.parent, prefix=path.name)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            target.write(content)
        temporary.chmod(mode)
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return True


def install_policy(
    *,
    directory: Path,
    module: str,
    names: tuple[str, ...],
    hash_file: Path,
    digest: str,
    restore_targets: Sequence[dict[str, Any]],
) -> None:
    """Build and install one SELinux policy module."""
    policy_makefile = Path("/usr/share/selinux/devel/Makefile")
    if not policy_makefile.is_file():
        raise SELinuxError(
            f"{module}: selinux-policy-devel is required to build the policy"
        )
    with tempfile.TemporaryDirectory(prefix=f"{module}-selinux-") as temporary:
        build = Path(temporary)
        for name in names:
            shutil.copy2(directory / name, build / name)
        run(("make", "-C", build, "-f", policy_makefile, f"{module}.pp"))
        run(("semodule", "-i", build / f"{module}.pp"))
    hash_file.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    write_if_changed(hash_file, f"{digest}\n", 0o600)
    if shutil.which("restorecon") is not None:
        for target in restore_targets:
            path = Path(target["path"])
            if path.exists():
                arguments: tuple[str | Path, ...] = (
                    ("restorecon", "-R", path)
                    if target.get("recursive", False)
                    else ("restorecon", path)
                )
                run(arguments, check=False)


def service_context(service: str) -> str:
    """Return the SELinux context of a systemd service's main process."""
    pid = output(("systemctl", "show", "-P", "MainPID", service))
    if not pid or pid == "0":
        return ""
    lines = output(("ps", "-p", pid, "-o", "label=")).splitlines()
    return lines[0].strip() if lines else ""


def service_active(service: str) -> bool:
    """Return whether a systemd service is active."""
    return (
        run(("systemctl", "is-active", "--quiet", service), check=False).returncode == 0
    )


def matching_child_active(service: str, pattern: str | None) -> bool:
    """Return whether the service has a child matching the safety pattern."""
    if not pattern:
        return False
    pid = output(("systemctl", "show", "-P", "MainPID", service))
    return (
        bool(pid and pid != "0")
        and run(("pgrep", "-P", pid, "-f", pattern), check=False).returncode == 0
    )


def confinement_state(config: ReconcileConfig) -> ConfinementState:
    """Inspect the policy, systemd declaration, and running process."""
    names = tuple(
        f"{config.policy_module}.{extension}" for extension in ("te", "fc", "if")
    )
    digest, policy_stale = policy_state(
        config.policy_directory,
        config.policy_module,
        names,
        config.hash_file,
    )
    unit = (
        config.service
        if config.service.endswith(".service")
        else f"{config.service}.service"
    )
    expected_context = f"system_u:system_r:{config.domain}:s0"
    dropin = Path(f"/etc/systemd/system/{unit}.d/10-selinux-context.conf")
    dropin_content = f"[Service]\nSELinuxContext={expected_context}\n"
    dropin_stale = (
        not dropin.is_file() or dropin.read_text(encoding="utf-8") != dropin_content
    )
    active = service_active(unit)
    context = service_context(unit) if active else ""
    restart_required = (
        policy_stale
        or dropin_stale
        or (active and context != expected_context)
        or (config.restart_when_inactive and not active)
    )
    return ConfinementState(
        names=names,
        digest=digest,
        unit=unit,
        expected_context=expected_context,
        dropin=dropin,
        dropin_content=dropin_content,
        policy_stale=policy_stale,
        dropin_stale=dropin_stale,
        context=context,
        restart_required=restart_required,
    )


def restart_confined_service(config: ReconcileConfig, state: ConfinementState) -> None:
    """Restart the service or recover by removing a failed drop-in."""
    restart = run(("systemctl", "restart", state.unit), check=False)
    if restart.returncode == 0:
        return
    state.dropin.unlink(missing_ok=True)
    run(("systemctl", "daemon-reload"))
    run(("systemctl", "reset-failed", state.unit), check=False)
    run(("systemctl", "start", state.unit), check=False)
    raise SELinuxError(
        f"{config.service}: restart failed under {config.domain}; removed the "
        "SELinuxContext drop-in and restarted unconfined"
    )


def apply_confinement(config: ReconcileConfig, state: ConfinementState) -> str:
    """Apply inspected changes and return the resulting process context."""
    if state.policy_stale:
        install_policy(
            directory=config.policy_directory,
            module=config.policy_module,
            names=state.names,
            hash_file=config.hash_file,
            digest=state.digest,
            restore_targets=config.restore_targets,
        )
    if state.dropin_stale:
        write_if_changed(state.dropin, state.dropin_content)
        run(("systemctl", "daemon-reload"))
    if state.restart_required:
        restart_confined_service(config, state)
    active = service_active(state.unit)
    context = service_context(state.unit) if active else ""
    if (active and context != state.expected_context) or (
        config.restart_when_inactive and not active
    ):
        raise SELinuxError(
            f"{config.service}: expected {state.expected_context}, "
            f"got {context or 'not running'}"
        )
    return context


def reconcile(
    config: ReconcileConfig,
    *,
    check_mode: bool,
) -> ReconcileResult:
    """Reconcile the policy, systemd drop-in, and running process context."""
    if not selinux_enabled():
        return ReconcileResult(False, False, False, "")
    state = confinement_state(config)
    if (
        state.changed
        and not config.allow_reload
        and matching_child_active(state.unit, config.defer_child_pattern)
    ):
        return ReconcileResult(False, True, True, state.context)
    if check_mode:
        return ReconcileResult(state.changed, False, True, state.context)
    context = apply_confinement(config, state)
    return ReconcileResult(state.changed, False, True, context)


def main() -> None:
    """Run the module through Ansible's JSON transport."""
    if AnsibleModule is None:
        raise RuntimeError("dotfiles_selinux_service must be run by Ansible")
    module = AnsibleModule(
        argument_spec={
            "policy_module": {"type": "str", "required": True},
            "policy_directory": {"type": "path", "required": True},
            "hash_file": {"type": "path", "required": True},
            "service": {"type": "str", "required": True},
            "domain": {"type": "str", "required": True},
            "restore_targets": {
                "type": "list",
                "elements": "dict",
                "default": [],
                "options": {
                    "path": {"type": "path", "required": True},
                    "recursive": {"type": "bool", "default": False},
                },
            },
            "restart_when_inactive": {"type": "bool", "default": True},
            "defer_child_pattern": {"type": "str"},
            "allow_reload": {"type": "bool", "default": False},
        },
        supports_check_mode=True,
    )
    try:
        config = ReconcileConfig(
            policy_module=module.params["policy_module"],
            policy_directory=Path(module.params["policy_directory"]),
            hash_file=Path(module.params["hash_file"]),
            service=module.params["service"],
            domain=module.params["domain"],
            restore_targets=module.params["restore_targets"],
            restart_when_inactive=module.params["restart_when_inactive"],
            defer_child_pattern=module.params["defer_child_pattern"],
            allow_reload=module.params["allow_reload"],
        )
        result = reconcile(
            config,
            check_mode=module.check_mode,
        )
    except SELinuxError as error:
        module.fail_json(msg=str(error))
        return
    module.exit_json(**asdict(result))


if __name__ == "__main__":
    main()
