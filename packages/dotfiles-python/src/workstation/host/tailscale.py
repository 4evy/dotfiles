"""Tailscale service and SELinux integration."""

import os
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from workstation.console import error_console
from workstation.errors import DotfilesError
from workstation.host.selinux import (
    RestoreTarget,
    SELinuxPolicy,
    ServiceConfinement,
    enabled as selinux_enabled,
)
from workstation.lib.commands import output, run, which
from workstation.lib.host import HostRunner, require_root
from workstation.lib.paths import asset_path
from workstation.lib.retry import wait_until


class TailscalePreferences(BaseModel):
    """Subset of Tailscale preferences used to validate SSH confinement."""

    run_ssh: bool = Field(False, alias="RunSSH")


def _selinux_policy() -> SELinuxPolicy:
    recursive_paths = {
        "/var/lib/tailscale",
        "/var/cache/tailscale",
        "/run/tailscale",
        "/var/run/tailscale",
    }
    return SELinuxPolicy(
        module="tailscaled",
        directory=asset_path("host", "apps", "tailscale-selinux"),
        hash_file=Path("/var/lib/tailscale/dotfiles-selinux-policy.sha256"),
        restore_targets=tuple(
            RestoreTarget(Path(path), recursive=path in recursive_paths)
            for path in (
                "/usr/bin/tailscaled",
                "/usr/sbin/tailscaled",
                "/usr/lib/systemd/system/tailscaled.service",
                "/etc/systemd/system/tailscaled.service",
                *sorted(recursive_paths),
            )
        ),
    )


def _ssh_sessions_active() -> bool:
    pid = output(("systemctl", "show", "-P", "MainPID", "tailscaled"), check=False)
    if not pid or pid == "0":
        return False
    return (
        run(
            ("pgrep", "-P", pid, "-f", "tailscaled be-child ssh"),
            check=False,
            capture=True,
        ).returncode
        == 0
    )


def _reload_blocked(allow_reload: bool) -> bool:
    if allow_reload or not _ssh_sessions_active():
        return False
    error_console.print(
        "tailscale-bluefin: active Tailscale SSH session detected; deferring "
        "SELinux changes to avoid interrupting it"
    )
    error_console.print(
        "tailscale-bluefin: rerun locally, after disconnecting SSH, or set "
        "DOTFILES_TAILSCALE_ALLOW_LIVE_RELOAD=1 to force it"
    )
    return True


def _restart(
    confinement: ServiceConfinement, *, required: bool, allow_reload: bool
) -> None:
    if not required or _reload_blocked(allow_reload):
        return
    if run(("systemctl", "restart", "tailscaled"), check=False).returncode == 0:
        return
    confinement.remove_dropin()
    run(("systemctl", "reset-failed", "tailscaled"), check=False)
    run(("systemctl", "start", "tailscaled"), check=False)
    raise DotfilesError(
        "tailscale-bluefin: confined tailscaled restart failed; removed "
        "SELinuxContext drop-in and restarted the unconfined service"
    )


def _configure_selinux() -> None:
    if not selinux_enabled():
        return
    policy = _selinux_policy()
    _digest, policy_change = policy.state()
    confinement = ServiceConfinement("tailscaled", "tailscaled_t")
    dropin_change = confinement.dropin_stale()
    allow_reload = os.environ.get("DOTFILES_TAILSCALE_ALLOW_LIVE_RELOAD") == "1"
    if (policy_change or dropin_change) and _reload_blocked(allow_reload):
        return
    installed = policy.install()
    if dropin_change:
        confinement.install_dropin()
    active = confinement.active()
    restart = (
        not active
        or installed
        or dropin_change
        or confinement.context() != confinement.expected_context
    )
    _restart(confinement, required=restart, allow_reload=allow_reload)
    context = confinement.context()
    if context != confinement.expected_context:
        raise DotfilesError(
            "tailscale-bluefin: tailscaled is not running in the expected "
            f"SELinux context; got: {context or 'not running'}"
        )


def tailscale_system() -> None:
    """Configure the privileged Tailscale service state."""
    require_root("tailscale-system")
    if which("tailscale") is None or which("tailscaled") is None:
        error_console.print(
            "tailscale-bluefin: Tailscale is not installed; add it to the "
            "Spectrum image and switch to the rebuilt image"
        )
        return
    _configure_selinux()


def _validate_selinux(host: HostRunner) -> None:
    if (
        output(("getenforce",), check=False) != "Enforcing"
        or which("tailscale") is None
    ):
        return
    preferences = host.root(("tailscale", "debug", "prefs"), check=False, capture=True)
    try:
        ssh_enabled = TailscalePreferences.model_validate_json(
            preferences.stdout
        ).run_ssh
    except ValidationError:
        ssh_enabled = False
    if not ssh_enabled:
        return
    context = host.root_output(
        ("systemctl", "show", "-P", "MainPID", "tailscaled"), check=False
    )
    if context and context != "0":
        context = host.root_output(("ps", "-p", context, "-o", "label="), check=False)
    if context != "system_u:system_r:tailscaled_t:s0":
        raise DotfilesError(
            "tailscale-bluefin: Tailscale SSH is enabled under enforcing SELinux, "
            f"but tailscaled is running as {context or 'not running'}"
        )
    error_console.print(
        "tailscale-bluefin: Tailscale SSH SELinux policy is installed; tailscale "
        "status may still show the upstream generic SELinux warning"
    )


def tailscale_bluefin(check: bool = False) -> None:
    """Configure Tailscale and its SELinux domain on immutable Fedora hosts."""
    if check:
        return
    host = HostRunner()
    host.root_python("host", "apps", "tailscale-system")
    if which("tailscale") is None:
        error_console.print(
            "tailscale-bluefin: tailscale is not available; add it to the Spectrum image"
        )
        return
    ready = wait_until(
        lambda: (
            run(("tailscale", "status"), check=False, capture=True).returncode == 0
            or host.root(("tailscale", "status"), check=False, capture=True).returncode
            == 0
        ),
        attempts=10,
        interval=1,
    )
    if ready:
        user_result = run(
            ("tailscale", "set", "--auto-update=false"), check=False, capture=True
        )
        if (
            user_result.returncode != 0
            and host.root(
                ("tailscale", "set", "--auto-update=false"), check=False, capture=True
            ).returncode
            != 0
        ):
            error_console.print(
                "tailscale-bluefin: could not disable Tailscale auto-update; "
                "keep updates managed by the Spectrum image"
            )
    else:
        error_console.print(
            "tailscale-bluefin: tailscale is installed but not authenticated; "
            "run tailscale up on this host"
        )
    _validate_selinux(host)
