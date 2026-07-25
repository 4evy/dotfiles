"""Shared SELinux policy installation primitives for host integrations."""

import hashlib
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar

from workstation.console import error_console
from workstation.lib.commands import output, run, which
from workstation.lib.files import (
    ensure_directory,
    install_file_if_changed,
    require_file,
    write_if_changed,
)


@dataclass(frozen=True, slots=True)
class RestoreTarget:
    """A path whose SELinux label should be restored after policy installation."""

    path: Path
    recursive: bool = False


@dataclass(frozen=True, slots=True)
class SELinuxPolicy:
    """Declarative description of a local SELinux policy module."""

    source_extensions: ClassVar[tuple[str, ...]] = ("te", "fc", "if")

    module: str
    directory: Path
    hash_file: Path
    restore_targets: tuple[RestoreTarget, ...] = ()
    state_mode: int | str = "0700"

    @property
    def source_names(self) -> tuple[str, ...]:
        return tuple(
            f"{self.module}.{extension}" for extension in self.source_extensions
        )

    def state(self) -> tuple[str, bool]:
        """Return the source digest and whether the installed policy is stale."""
        return policy_state(
            self.directory,
            self.module,
            self.source_names,
            self.hash_file,
        )

    def install(self) -> bool:
        """Install stale policy sources and restore configured path labels."""
        installed = build_install_policy(
            policy_dir=self.directory,
            module=self.module,
            source_names=self.source_names,
            hash_file=self.hash_file,
            state_mode=self.state_mode,
        )
        if installed:
            restore(self.restore_targets)
        return installed


@dataclass(frozen=True, slots=True)
class ServiceConfinement:
    """Declarative systemd drop-in for one SELinux service domain."""

    service: str
    domain: str

    @property
    def unit(self) -> str:
        return (
            self.service
            if self.service.endswith(".service")
            else f"{self.service}.service"
        )

    @property
    def dropin(self) -> Path:
        return Path(f"/etc/systemd/system/{self.unit}.d/10-selinux-context.conf")

    @property
    def expected_context(self) -> str:
        return f"system_u:system_r:{self.domain}:s0"

    @property
    def dropin_content(self) -> str:
        return f"[Service]\nSELinuxContext={self.expected_context}\n"

    def dropin_stale(self) -> bool:
        return (
            not self.dropin.is_file()
            or self.dropin.read_text(encoding="utf-8") != self.dropin_content
        )

    def install_dropin(self) -> bool:
        """Write the service context drop-in when its declaration changed."""
        if not self.dropin_stale():
            return False
        write_if_changed(self.dropin, self.dropin_content)
        run(("systemctl", "daemon-reload"))
        return True

    def remove_dropin(self) -> None:
        """Remove a failed confinement declaration and reload systemd."""
        self.dropin.unlink(missing_ok=True)
        run(("systemctl", "daemon-reload"))

    def active(self) -> bool:
        return (
            run(
                ("systemctl", "is-active", "--quiet", self.unit),
                check=False,
                capture=True,
            ).returncode
            == 0
        )

    def context(self) -> str:
        return service_context(self.unit)


def service_context(service: str) -> str:
    """Return the SELinux context of a systemd service's main process."""
    pid = output(("systemctl", "show", "-P", "MainPID", service), check=False)
    if not pid or pid == "0":
        return ""
    lines = output(("ps", "-p", pid, "-o", "label="), check=False).splitlines()
    return lines[0].strip() if lines else ""


def enabled() -> bool:
    """Return whether SELinux tooling is available and SELinux is enabled."""
    return (
        which("getenforce") is not None
        and output(("getenforce",), check=False) != "Disabled"
    )


def _policy_hash(directory: Path, names: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    for name in names:
        path = require_file(directory / name)
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _module_installed(name: str) -> bool:
    modules = output(("semodule", "-l"), check=False)
    return any(line.split()[0:1] == [name] for line in modules.splitlines())


def policy_state(
    policy_dir: Path,
    module: str,
    source_names: tuple[str, ...],
    hash_file: Path,
) -> tuple[str, bool]:
    """Return a policy digest and whether the installed policy is stale."""
    digest = _policy_hash(policy_dir, source_names)
    installed_digest = (
        hash_file.read_text(encoding="utf-8").strip() if hash_file.is_file() else None
    )
    return digest, not _module_installed(module) or installed_digest != digest


def build_install_policy(
    *,
    policy_dir: Path,
    module: str,
    source_names: tuple[str, ...],
    hash_file: Path,
    state_mode: int | str,
) -> bool:
    """Build and install a local SELinux module when its sources changed."""
    policy_makefile = Path("/usr/share/selinux/devel/Makefile")
    if not policy_makefile.is_file():
        error_console.print(
            f"{module}: selinux-policy-devel is not installed; add it to the "
            "Spectrum image to build the SELinux policy"
        )
        return False
    digest, needs_install = policy_state(policy_dir, module, source_names, hash_file)
    if not needs_install:
        return False
    with tempfile.TemporaryDirectory(prefix=f"{module}-selinux-") as temporary:
        build = Path(temporary)
        for name in source_names:
            install_file_if_changed(policy_dir / name, build / name)
        run(("make", "-C", build, "-f", policy_makefile, f"{module}.pp"))
        run(("semodule", "-i", build / f"{module}.pp"))
    ensure_directory(hash_file.parent, state_mode)
    write_if_changed(hash_file, digest + "\n")
    return True


def restore(targets: tuple[RestoreTarget, ...]) -> None:
    """Restore SELinux labels for existing paths."""
    if which("restorecon") is None:
        return
    for target in targets:
        if target.path.exists():
            arguments: tuple[str | os.PathLike[str], ...] = (
                ("restorecon", "-R", target.path)
                if target.recursive
                else ("restorecon", target.path)
            )
            run(arguments, check=False)
