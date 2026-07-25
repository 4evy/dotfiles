"""Chezmoi lifecycle hooks for desktop applications."""

import os
from pathlib import Path
from typing import Literal

from workstation.apps.discord import main as discord_main
from workstation.console import error_console
from workstation.lib.commands import run, which
from workstation.lib.paths import find_repo_root
from workstation.local.gnome import _gnome_accent_apply
from workstation.local.licenses import (
    alt_tab_license as update_alt_tab_license,
    shottr_license as update_shottr_license,
)
from workstation.local.raycast import main as raycast_patch


def alt_tab_license() -> None:
    """Show the installed AltTab license state."""
    update_alt_tab_license("status")


def shottr_license(
    action: Literal["install", "status"] = "status",
    *,
    force: bool = False,
) -> None:
    """Install or show the Shottr license state."""
    update_shottr_license(action, force=force)


def raycast_beta_patch() -> None:
    """Refresh the Raycast Beta local user profile."""
    raycast_patch()


def gnome_accent() -> None:
    """Refresh Catppuccin GTK accent CSS and its user service."""
    _gnome_accent_apply()
    if which("systemctl") is not None:
        run(("systemctl", "--user", "daemon-reload"), check=False, capture=True)
        run(
            (
                "systemctl",
                "--user",
                "enable",
                "--now",
                "gnome-catppuccin-accent.service",
            ),
            check=False,
            capture=True,
        )


def desktop_integrations() -> None:
    """Apply the desktop-related subset of the Ansible host playbook."""
    source = Path(
        os.environ.get("CHEZMOI_SOURCE_DIR", Path.home() / "nix-dotfiles/dotfiles")
    )
    try:
        repository = find_repo_root(source)
    except FileNotFoundError:
        error_console.print(
            f"chezmoi desktop integrations skipped: could not find repo root from {source}"
        )
        return
    ansible = which("ansible-playbook")
    if ansible is not None:
        command: tuple[str | os.PathLike[str], ...] = (ansible,)
    elif (uvx := which("uvx")) is not None:
        command = (uvx, "--from", "ansible-core", "ansible-playbook")
    else:
        error_console.print(
            "chezmoi desktop integrations skipped: ansible-playbook/uvx not found"
        )
        return
    run(
        (
            *command,
            "ansible/site.yml",
            "--tags",
            "always,hyper-window-tiling,sushi-preview,emoji-shortcut",
        ),
        cwd=repository,
    )


def discord_equicord() -> None:
    """Repair Equicord after Discord replaces its application bundle."""
    returncode = discord_main(repair_only=True)
    if returncode != 0:
        raise SystemExit(returncode)
