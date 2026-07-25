from pathlib import Path

import pytest

from workstation.errors import DotfilesError
from workstation.local.hyper_window_tiling_build import (
    _manifest_value,
    infer_source_directory,
    repo_root_from_source,
)


def test_infer_nested_source_and_repo_root(tmp_path: Path) -> None:
    source = tmp_path / "dotfiles"
    nested = source / "nested"
    nested.mkdir(parents=True)
    (source / ".chezmoiignore").touch()
    package = tmp_path / "packages/hyper-window-tiling"
    package.mkdir(parents=True)
    (package / "package.json").write_text("{}")

    assert infer_source_directory(nested) == source
    assert repo_root_from_source(source) == tmp_path


def test_missing_source_is_actionable(tmp_path: Path) -> None:
    with pytest.raises(DotfilesError, match="pass --source-dir"):
        infer_source_directory(tmp_path)


def test_package_identity_comes_from_native_metadata(tmp_path: Path) -> None:
    metadata = tmp_path / "metadata.json"
    metadata.write_text('{"KPlugin": {"Id": "manifest-owned"}}')

    assert _manifest_value(metadata, "KPlugin", "Id") == "manifest-owned"

    metadata.write_text('{"KPlugin": {}}')
    with pytest.raises(DotfilesError, match="missing Id"):
        _manifest_value(metadata, "KPlugin", "Id")
