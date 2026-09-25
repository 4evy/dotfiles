#!/usr/bin/python
"""Reconcile the system role's SELinux policy-backed services."""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import tempfile
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from ansible.module_utils.basic import AnsibleModule

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
    service: str
    domain: str
    restore_targets: Sequence[dict[str, Any]]
    restart_when_inactive: bool
    defer_child_pattern: str | None
    allow_reload: bool


@dataclass(frozen=True, slots=True)
class ConfinementState:
    """Current and desired state derived without mutating the host."""

    package: Path
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


def build_policy(
    directory: Path,
    module: str,
    names: tuple[str, ...],
    build: Path,
) -> Path:
    """Build policy sources in an isolated directory and return the package."""
    policy_makefile = Path("/usr/share/selinux/devel/Makefile")
    if not policy_makefile.is_file():
        raise SELinuxError(
            f"{module}: selinux-policy-devel is required to build the policy"
        )
    for name in names:
        source = directory / name
        if not source.is_file():
            raise SELinuxError(f"SELinux policy source does not exist: {source}")
        shutil.copy2(source, build / name)
    package = build / f"{module}.pp"
    run(("make", "-C", build, "-f", policy_makefile, package.name))
    if not package.is_file():
        raise SELinuxError(f"SELinux policy build did not create {package}")
    return package


def package_checksum(package: Path) -> str:
    """Return the checksum semodule computes from normalized CIL."""
    converter = Path("/usr/libexec/selinux/hll/pp")
    if not converter.is_file():
        raise SELinuxError(f"SELinux HLL converter does not exist: {converter}")
    translated = subprocess.run(
        (converter, package),
        check=False,
        capture_output=True,
    )
    if translated.returncode != 0:
        message = translated.stderr.decode(errors="replace").strip()
        raise SELinuxError(f"failed to normalize {package.name}: {message}")
    return f"sha256:{hashlib.sha256(translated.stdout).hexdigest()}"


def installed_module_checksum(name: str) -> str | None:
    """Read one installed module's authoritative semodule checksum."""
    for line in output(("semodule", "-l", "-m")).splitlines():
        fields = line.split()
        if fields[0:1] == [name]:
            return next(
                (field for field in fields[1:] if field.startswith("sha256:")),
                None,
            )
    return None


def policy_stale(package: Path, module: str) -> bool:
    """Return whether the built package differs from installed CIL."""
    return installed_module_checksum(module) != package_checksum(package)


def write_if_changed(path: Path, content: str, mode: int = 0o644) -> bool:
    """Atomically replace a small text file when its contents differ."""
    if path.is_file() and path.read_text(encoding="utf-8") == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=path.name,
            delete=False,
        ) as target:
            temporary = Path(target.name)
            target.write(content)
        temporary.chmod(mode)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return True


def install_policy(
    *,
    package: Path,
    restore_targets: Sequence[dict[str, Any]],
) -> None:
    """Install one built SELinux policy module and restore affected labels."""
    run(("semodule", "-i", package))
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


def confinement_state(config: ReconcileConfig, build: Path) -> ConfinementState:
    """Inspect the policy, systemd declaration, and running process."""
    names = tuple(
        f"{config.policy_module}.{extension}" for extension in ("te", "fc", "if")
    )
    package = build_policy(
        config.policy_directory,
        config.policy_module,
        names,
        build,
    )
    policy_changed = policy_stale(package, config.policy_module)
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
        policy_changed
        or dropin_stale
        or (active and context != expected_context)
        or (config.restart_when_inactive and not active)
    )
    return ConfinementState(
        package=package,
        unit=unit,
        expected_context=expected_context,
        dropin=dropin,
        dropin_content=dropin_content,
        policy_stale=policy_changed,
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
            package=state.package,
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
    with tempfile.TemporaryDirectory(
        prefix=f"{config.policy_module}-selinux-"
    ) as temporary:
        state = confinement_state(config, Path(temporary))
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
    module = AnsibleModule(
        argument_spec={
            "policy_module": {"type": "str", "required": True},
            "policy_directory": {"type": "path", "required": True},
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
    except (OSError, SELinuxError) as error:
        module.fail_json(msg=str(error))
        return
    module.exit_json(**asdict(result))


if __name__ == "__main__":
    main()
