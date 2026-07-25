"""Compatibility exports for the former all-in-one local command module.

New code should import the focused modules directly.
"""

from workstation.local.desktop_audit import (
    _lspci_display_devices,
    desktop_perf_audit_entrypoint,
)
from workstation.local.gnome import (
    _gnome_accent_apply,
    gnome_catppuccin_accent,
    gnome_catppuccin_accent_entrypoint,
)
from workstation.local.licenses import (
    alt_tab_license,
    alt_tab_license_entrypoint,
    shottr_license,
)
from workstation.local.shims import (
    codex_entrypoint,
    python3_entrypoint,
    python_entrypoint,
    vscode_nixd_entrypoint,
    vscode_nixfmt_entrypoint,
)

__all__ = [
    "_gnome_accent_apply",
    "_lspci_display_devices",
    "alt_tab_license",
    "alt_tab_license_entrypoint",
    "codex_entrypoint",
    "desktop_perf_audit_entrypoint",
    "gnome_catppuccin_accent",
    "gnome_catppuccin_accent_entrypoint",
    "python3_entrypoint",
    "python_entrypoint",
    "shottr_license",
    "vscode_nixd_entrypoint",
    "vscode_nixfmt_entrypoint",
]
