"""Declarative command registry for Chezmoi lifecycle integrations."""

from collections.abc import Callable

from cyclopts import App

from workstation.chezmoi_desktop import (
    alt_tab_license,
    desktop_integrations,
    discord_equicord,
    gnome_accent,
    raycast_beta_patch,
    shottr_license,
)
from workstation.chezmoi_shell import shell_init, vscode_extensions, yazi_init
from workstation.macos.terminal import terminal_profile

ChezmoiCommand = Callable[..., None]

COMMANDS: tuple[tuple[str, ChezmoiCommand], ...] = (
    ("alt-tab-license", alt_tab_license),
    ("shottr-license", shottr_license),
    ("raycast-beta-patch", raycast_beta_patch),
    ("gnome-accent", gnome_accent),
    ("desktop-integrations", desktop_integrations),
    ("discord-equicord", discord_equicord),
    ("vscode-extensions", vscode_extensions),
    ("yazi-init", yazi_init),
    ("shell-init", shell_init),
    ("terminal-profile", terminal_profile),
)

app = App(
    help="Run Chezmoi lifecycle integrations.",
    version_flags=[],
    result_action="return_none",
)
for command_name, command in COMMANDS:
    app.command(command, name=command_name)

__all__ = [
    "COMMANDS",
    "alt_tab_license",
    "app",
    "desktop_integrations",
    "discord_equicord",
    "gnome_accent",
    "raycast_beta_patch",
    "shell_init",
    "shottr_license",
    "terminal_profile",
    "vscode_extensions",
    "yazi_init",
]
