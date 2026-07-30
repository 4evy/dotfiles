import os
from pathlib import Path

from workstation.console import error_console
from workstation.errors import DotfilesError
from workstation.host.selinux import (
    RestoreTarget,
    SELinuxPolicy,
    ServiceConfinement,
    enabled as _selinux_enabled,
)
from workstation.lib.commands import run, which
from workstation.lib.host import HostRunner, require_root
from workstation.lib.paths import asset_path


def _selinux_policy() -> SELinuxPolicy:
    return SELinuxPolicy(
        module="rustdesk",
        directory=asset_path("host", "apps", "rustdesk-selinux"),
        hash_file=Path("/var/lib/rustdesk/dotfiles-selinux-policy.sha256"),
        restore_targets=tuple(
            RestoreTarget(Path(path), recursive=True)
            for path in (
                "/usr/bin/rustdesk",
                "/usr/share/rustdesk/rustdesk",
                "/etc/systemd/system/rustdesk.service",
                "/usr/lib/systemd/system/rustdesk.service",
                "/var/lib/rustdesk",
                "/run/rustdesk.pid",
                "/var/run/rustdesk.pid",
            )
        ),
    )


def _configure_rustdesk_selinux() -> None:
    if (
        os.environ.get("DOTFILES_RUSTDESK_SELINUX", "1") == "0"
        or not _selinux_enabled()
    ):
        return
    installed = _selinux_policy().install()
    confinement = ServiceConfinement("rustdesk", "rustdesk_t")
    changed = confinement.install_dropin()
    active = confinement.active()
    context = confinement.context() if active else ""
    if (
        active
        and (installed or changed or context != confinement.expected_context)
        and (
            run(("systemctl", "restart", "rustdesk.service"), check=False).returncode
            != 0
        )
    ):
        confinement.remove_dropin()
        run(("systemctl", "reset-failed", "rustdesk.service"), check=False)
        run(("systemctl", "start", "rustdesk.service"), check=False)
        raise DotfilesError(
            "rustdesk-tailscale: rustdesk restart failed under rustdesk_t; "
            "removed SELinuxContext drop-in and restarted unconfined"
        )
    if active:
        context = confinement.context()
    if active and context != confinement.expected_context:
        raise DotfilesError(
            "rustdesk-tailscale: rustdesk is not running in the expected SELinux "
            f"context; got: {context or 'not running'}"
        )


def rustdesk_system() -> None:
    """Configure privileged RustDesk security and service state."""
    require_root("rustdesk-system")
    _configure_rustdesk_selinux()
    if run(("rpm", "-q", "rustdesk"), check=False, capture=True).returncode == 0:
        run(("systemctl", "restart", "rustdesk.service"))


def _prepare_rustdesk_wayland() -> None:
    if os.environ.get("XDG_SESSION_TYPE") != "wayland":
        return
    if which("systemctl") is not None:
        run(
            (
                "systemctl",
                "--user",
                "reset-failed",
                "xdg-desktop-portal.service",
                "xdg-desktop-portal-gnome.service",
                "xdg-desktop-portal-gtk.service",
                "pipewire.service",
                "wireplumber.service",
            ),
            check=False,
            capture=True,
        )
        run(
            (
                "systemctl",
                "--user",
                "start",
                "xdg-desktop-portal.service",
                "pipewire.service",
                "wireplumber.service",
            ),
            check=False,
            capture=True,
        )
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR", "/nonexistent"))
    if not (runtime / "bus").is_socket():
        error_console.print(
            "rustdesk-tailscale: Wayland session bus is not available; RustDesk "
            "portal capture will fail until the user session is healthy"
        )
    if not (runtime / "pipewire-0").is_socket():
        error_console.print(
            "rustdesk-tailscale: PipeWire socket is not available; RustDesk "
            "Wayland screen capture will fail"
        )
    if not Path("/dev/uinput").exists():
        error_console.print(
            "rustdesk-tailscale: /dev/uinput is missing; RustDesk Wayland "
            "keyboard/mouse fallback will not work"
        )


def rustdesk_tailscale(check: bool = False) -> None:
    """Configure native RustDesk for direct Tailscale access and Wayland capture."""
    if which("rustdesk") is None:
        error_console.print(
            "rustdesk-tailscale: rustdesk is not installed; add it to the Spectrum image"
        )
        return
    if check:
        return
    host = HostRunner()
    host.root_python("host", "apps", "rustdesk-system")
    _prepare_rustdesk_wayland()
    if which("tailscale") is not None:
        if run(("tailscale", "status"), check=False, capture=True).returncode != 0:
            error_console.print(
                "rustdesk-tailscale: tailscale is installed but not authenticated; "
                "run tailscale up on this host"
            )
    else:
        error_console.print(
            "rustdesk-tailscale: tailscale is not installed; install the tailscale "
            "host tool before relying on direct IP access"
        )
