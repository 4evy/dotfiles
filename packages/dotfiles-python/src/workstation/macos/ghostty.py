"""Stable signing for the Homebrew-owned patched Ghostty application."""

from pathlib import Path

from workstation.macos.codesigning import (
    DOTFILES_SIGNING_IDENTITY,
    SYSTEM_KEYCHAIN,
    bundle_has_signing_identity,
    ensure_signing_identity,
    sign_bundle,
)


def sign_ghostty(
    app: Path = Path("/opt/homebrew/opt/ghostty-patched/Ghostty.app"),
    check: bool = False,
) -> None:
    """Ensure the Homebrew Ghostty bundle retains the stable local identity."""
    if bundle_has_signing_identity(app, DOTFILES_SIGNING_IDENTITY):
        return
    if check:
        return
    ensure_signing_identity(DOTFILES_SIGNING_IDENTITY, SYSTEM_KEYCHAIN)
    sign_bundle(app, DOTFILES_SIGNING_IDENTITY, SYSTEM_KEYCHAIN)
