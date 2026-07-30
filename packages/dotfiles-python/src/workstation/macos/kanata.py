"""Install and sign the macOS Kanata application."""

from pathlib import Path

from workstation.lib.commands import run
from workstation.lib.files import (
    ensure_directory,
    files_match,
    install_file_if_changed,
    require_executable,
)
from workstation.lib.host import require_root
from workstation.lib.paths import asset_path
from workstation.lib.templates import render_template, render_template_content
from workstation.macos.codesigning import (
    DOTFILES_SIGNING_IDENTITY,
    SYSTEM_KEYCHAIN,
    bundle_has_signing_identity,
    ensure_signing_identity,
    sign_bundle,
)

KANATA_LABEL = "dev.4evy.kanata"
KANATA_APP = Path("/Applications/Kanata.app")
LSREGISTER = Path(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/"
    "LaunchServices.framework/Support/lsregister"
)


def configure_kanata(kanata_bin: Path, check: bool = False) -> None:
    """Install and sign Kanata as a stable macOS application bundle."""
    require_root("kanata")
    kanata_bin = require_executable(kanata_bin)
    source = asset_path("macos")
    app_bin = KANATA_APP / "Contents/MacOS/kanata"
    info_plist = KANATA_APP / "Contents/Info.plist"
    info_template = source / "templates/kanata-app-info.plist.in"
    info_values = {"BUNDLE_IDENTIFIER": KANATA_LABEL}
    identity = DOTFILES_SIGNING_IDENTITY
    keychain = SYSTEM_KEYCHAIN
    files_current = files_match(kanata_bin, app_bin, mode="0755")
    info_current = (
        info_plist.is_file()
        and info_plist.read_text()
        == render_template_content(info_template, info_values)
    )
    signature_current = bundle_has_signing_identity(KANATA_APP, identity)
    current = files_current and info_current and signature_current

    if check:
        return
    if current:
        return

    ensure_directory(app_bin.parent, "0755")
    binary_changed = install_file_if_changed(kanata_bin, app_bin, "0755")
    metadata_changed = render_template(
        info_template,
        info_plist,
        info_values,
    )
    identity_changed = ensure_signing_identity(
        identity,
        keychain,
        administrator_trust=True,
    )
    signing_changed = (
        binary_changed or metadata_changed or identity_changed or not signature_current
    )
    if signing_changed:
        sign_bundle(KANATA_APP, identity, keychain)
        run((LSREGISTER, "-f", KANATA_APP))
