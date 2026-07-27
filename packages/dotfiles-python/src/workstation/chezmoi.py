"""Declarative command registry for Chezmoi lifecycle integrations."""

from collections.abc import Callable

from cyclopts import App

from workstation.chezmoi_desktop import (
    desktop_integrations,
    discord_equicord,
    gnome_accent,
)
from workstation.chezmoi_shell import shell_init, vscode_extensions, yazi_init
from workstation.macos.terminal import terminal_profile

ChezmoiCommand = Callable[..., None]

COMMANDS: tuple[tuple[str, ChezmoiCommand], ...] = (
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
    "app",
    "desktop_integrations",
    "discord_equicord",
    "gnome_accent",
    "shell_init",
    "terminal_profile",
    "vscode_extensions",
    "yazi_init",
]
