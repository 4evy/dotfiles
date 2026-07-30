"""Availability helpers for the GNOME settings command."""

from workstation.lib.commands import which


def available() -> bool:
    """Return whether the host exposes the gsettings command."""
    return which("gsettings") is not None
