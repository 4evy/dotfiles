from pathlib import Path
from typing import TYPE_CHECKING

from workstation.lib import paths
from workstation.lib.paths import asset_path, assets_root, repository_root

if TYPE_CHECKING:
    import pytest


def test_repository_owned_paths_resolve_from_one_root() -> None:
    root = repository_root()

    assert (root / "pyproject.toml").is_file()
    assert assets_root() == root / "packages/dotfiles-python/assets"
    assert asset_path("apps", "ghidra-mcp").is_dir()
    assert asset_path("apps", "ghostty", "patches") == root / "patches/ghostty"
    assert asset_path("apps", "helium", "helium.toml") == root / "browser/helium.toml"


def test_installed_assets_do_not_require_a_repository(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    installed = tmp_path / "share/dotfiles-python"
    installed.mkdir(parents=True)

    def no_repository() -> Path:
        raise FileNotFoundError

    monkeypatch.setattr(paths, "_installed_asset_roots", lambda: (installed,))
    monkeypatch.setattr(paths, "repository_root", no_repository)
    paths.assets_root.cache_clear()

    try:
        assert paths.assets_root() == installed
    finally:
        paths.assets_root.cache_clear()
