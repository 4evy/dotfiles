from pathlib import Path
from typing import TYPE_CHECKING

from workstation.lib import paths

if TYPE_CHECKING:
    import pytest


def test_installed_assets_do_not_require_a_repository(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    installed = tmp_path / "share/dotfiles-python"
    installed.mkdir(parents=True)

    def no_repository() -> Path:
        raise FileNotFoundError

    monkeypatch.setattr(paths, "installed_data_roots", lambda: (installed,))
    monkeypatch.setattr(paths, "repository_root", no_repository)
    paths.assets_root.cache_clear()

    try:
        assert paths.assets_root() == installed
    finally:
        paths.assets_root.cache_clear()


def test_asset_path_accepts_domain_owned_development_source(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    installed = tmp_path / "installed"
    repository = tmp_path / "repository"
    installed.mkdir()
    source = repository / "domain/source.txt"
    source.parent.mkdir(parents=True)
    source.write_text("source")
    monkeypatch.setattr(paths, "assets_root", lambda: installed)
    monkeypatch.setattr(paths, "repository_root", lambda: repository)

    assert (
        paths.asset_path(
            "installed/source.txt",
            development_source=("domain", "source.txt"),
        )
        == source
    )
