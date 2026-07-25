"""Local application license provisioning commands."""

import datetime as dt
import os
import re
import subprocess
from pathlib import Path
from typing import Literal

from cyclopts import App

from workstation.console import console, error_console
from workstation.errors import DotfilesError
from workstation.lib.commands import output, run
from workstation.lib.paths import asset_path, find_repo_root

_ALT_TAB_SERVICE = "com.lwouis.alt-tab-macos.license"
_ALT_TAB_VALUES = {
    "licenseKey": "0000-0000-0000-0000-0000-0000",
    "instanceId": "evy-instance-0",
    "variantId": "pro_lifetime",
}
_ALT_TAB_DEFAULTS = {
    "lastValidation": (
        "float",
        lambda: str(int(dt.datetime.now(dt.UTC).timestamp())),
    ),
    "lastValidationResult": ("bool", lambda: "true"),
    "customerEmail": ("string", lambda: "alt@evy.pink"),
}


def _install_alt_tab_license() -> None:
    for account, value in _ALT_TAB_VALUES.items():
        run(
            (
                "security",
                "add-generic-password",
                "-A",
                "-U",
                "-s",
                _ALT_TAB_SERVICE,
                "-a",
                account,
                "-w",
                value,
            ),
            capture=True,
        )
    for key, (kind, value) in _ALT_TAB_DEFAULTS.items():
        run((
            "defaults",
            "write",
            _ALT_TAB_SERVICE,
            key,
            f"-{kind}",
            value(),
        ))
    error_console.print("alt-tab-license: license installed; restart AltTab to apply")


def _remove_alt_tab_license() -> None:
    for account in _ALT_TAB_VALUES:
        run(
            (
                "security",
                "delete-generic-password",
                "-s",
                _ALT_TAB_SERVICE,
                "-a",
                account,
            ),
            check=False,
            capture=True,
        )
    for key in _ALT_TAB_DEFAULTS:
        run(
            ("defaults", "delete", _ALT_TAB_SERVICE, key),
            check=False,
            capture=True,
        )
    error_console.print(
        "alt-tab-license: license removed; restart AltTab to revert to trial"
    )


def _show_alt_tab_license() -> None:
    console.print("keychain items:")
    for account in _ALT_TAB_VALUES:
        value = (
            output(
                (
                    "security",
                    "find-generic-password",
                    "-s",
                    _ALT_TAB_SERVICE,
                    "-a",
                    account,
                    "-w",
                ),
                check=False,
            )
            or "none"
        )
        console.print(f"  {account + ':':<12} {value}")
    console.print(f"\ndefaults ({_ALT_TAB_SERVICE}):")
    for key in _ALT_TAB_DEFAULTS:
        value = (
            output(("defaults", "read", _ALT_TAB_SERVICE, key), check=False) or "none"
        )
        console.print(f"  {key + ':':<22} {value}")


def alt_tab_license(action: Literal["install", "remove", "status"]) -> None:
    """Install, remove, or display the AltTab license state."""
    actions = {
        "install": _install_alt_tab_license,
        "remove": _remove_alt_tab_license,
        "status": _show_alt_tab_license,
    }
    actions[action]()


_alt_tab_license_app = App(
    default_command=alt_tab_license,
    version_flags=[],
    result_action="return_none",
)


def alt_tab_license_entrypoint() -> None:
    _alt_tab_license_app()


def _shottr_license_key() -> str:
    repository = find_repo_root(Path.cwd())
    secrets = repository / "secrets/secrets.yaml"
    key = output((
        "sops",
        "--decrypt",
        "--extract",
        '["shottr-license-key"]',
        os.fspath(secrets),
    )).strip()
    if not re.fullmatch(r"[A-Z0-9]{6}(?:-[A-Z0-9]{6}){4}", key):
        raise DotfilesError("Shottr license key in SOPS has an unexpected format")
    return key


def _activate_shottr_license(key: str) -> None:
    source = asset_path("macos", "activate-shottr-license.applescript")
    result = subprocess.run(
        ("/usr/bin/osascript", source, key),
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        details = result.stderr.strip() or result.stdout.strip()
        message = "Shottr activation UI automation failed"
        if "not allowed assistive access" in details or "-25211" in details:
            message = (
                f"{message}: macOS denied Accessibility access to osascript. "
                "Grant Accessibility to the terminal running provisioning in "
                "System Settings > Privacy & Security > Accessibility, then rerun "
                "`dotfiles-scripts chezmoi shottr-license install --force`."
            )
        if details:
            message = f"{message}\n{details}"
        raise DotfilesError(message)


def _shottr_is_activated(domain: str) -> bool:
    stored_license = output(
        ("defaults", "read", domain, "kc-license"),
        check=False,
    ).strip()
    vault = output(
        ("defaults", "read", domain, "kc-vault"),
        check=False,
    ).strip()
    return bool(stored_license and vault)


def shottr_license(
    action: Literal["install", "status"], *, force: bool = False
) -> None:
    """Install or display the Shottr license state."""
    domain = "cc.ffitch.shottr"
    if action == "install":
        if _shottr_is_activated(domain) and not force:
            error_console.print(
                "shottr-license: Shottr already has activation state; leaving it in place"
            )
            return
        key = _shottr_license_key()
        _activate_shottr_license(key)
        error_console.print(
            "shottr-license: submitted license key through Shottr activation UI"
        )
        return
    if action == "status":
        if _shottr_is_activated(domain):
            console.print("shottr-license: installed")
        else:
            console.print("shottr-license: not installed")
