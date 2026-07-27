from pathlib import Path
from typing import TYPE_CHECKING

from workstation.lib.commands import CommandResult
from workstation.macos import codesigning

if TYPE_CHECKING:
    import pytest


def test_bundle_identity_match_is_exact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bundle = tmp_path / "Example.app"
    bundle.mkdir()
    monkeypatch.setattr(
        codesigning,
        "run",
        lambda *_args, **_kwargs: CommandResult(
            0,
            "",
            "Authority=Not Dotfiles Local Code Signing\n"
            "Authority=Dotfiles Local Code Signing Extra\n",
        ),
    )

    assert not codesigning.bundle_has_signing_identity(
        bundle,
        codesigning.DOTFILES_SIGNING_IDENTITY,
    )


def test_bundle_identity_requires_valid_deep_signature(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bundle = tmp_path / "Example.app"
    bundle.mkdir()
    results = iter((
        CommandResult(
            0,
            "",
            f"Authority={codesigning.DOTFILES_SIGNING_IDENTITY}\n",
        ),
        CommandResult(1, "", "sealed resource is missing"),
    ))
    monkeypatch.setattr(
        codesigning,
        "run",
        lambda *_args, **_kwargs: next(results),
    )

    assert not codesigning.bundle_has_signing_identity(
        bundle,
        codesigning.DOTFILES_SIGNING_IDENTITY,
    )


def test_existing_identity_is_not_recreated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    keychain = tmp_path / "login.keychain-db"
    keychain.touch()
    monkeypatch.setattr(
        codesigning,
        "require_commands",
        lambda *_args: None,
    )
    monkeypatch.setattr(
        codesigning,
        "signing_identity_available",
        lambda _identity, _keychain: True,
    )
    monkeypatch.setattr(
        codesigning,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("an existing identity must not run import commands")
        ),
    )

    assert not codesigning.ensure_signing_identity(
        codesigning.DOTFILES_SIGNING_IDENTITY,
        keychain,
    )


def test_sign_bundle_preserves_identity_and_entitlements(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bundle = tmp_path / "Example.app"
    bundle.mkdir()
    keychain = tmp_path / "login.keychain-db"
    calls: list[tuple[str | Path, ...]] = []

    def fake_run(
        argv: tuple[str | Path, ...],
        **_kwargs: object,
    ) -> CommandResult:
        calls.append(argv)
        return CommandResult(0, "", "")

    monkeypatch.setattr(codesigning, "run", fake_run)
    monkeypatch.setattr(
        codesigning,
        "bundle_has_signing_identity",
        lambda _bundle, _identity: True,
    )

    codesigning.sign_bundle(
        bundle,
        codesigning.DOTFILES_SIGNING_IDENTITY,
        keychain,
    )

    assert calls[0] == (
        "/usr/bin/codesign",
        "--force",
        "--keychain",
        keychain,
        "--options",
        "runtime",
        "--preserve-metadata=identifier,entitlements",
        "--sign",
        codesigning.DOTFILES_SIGNING_IDENTITY,
        "--timestamp=none",
        bundle,
    )
    assert calls[1][:4] == (
        "/usr/bin/codesign",
        "--verify",
        "--deep",
        "--strict",
    )
