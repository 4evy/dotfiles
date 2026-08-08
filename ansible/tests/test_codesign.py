import importlib.util
import sys
from pathlib import Path
from subprocess import CompletedProcess
from types import ModuleType
from typing import TYPE_CHECKING, Any, cast


def _codesigning_module() -> ModuleType:
    path = Path(__file__).parents[1] / "library/dotfiles_codesign.py"
    spec = importlib.util.spec_from_file_location("dotfiles_codesign", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


codesigning = cast("Any", _codesigning_module())

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
        lambda *_args, **_kwargs: CompletedProcess(
            (),
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
        CompletedProcess(
            (),
            0,
            "",
            f"Authority={codesigning.DOTFILES_SIGNING_IDENTITY}\n",
        ),
        CompletedProcess((), 1, "", "sealed resource is missing"),
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
    ) -> CompletedProcess[str]:
        calls.append(argv)
        return CompletedProcess(argv, 0, "", "")

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
        "--deep",
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
