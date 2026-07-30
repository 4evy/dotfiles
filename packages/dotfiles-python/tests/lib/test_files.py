from pathlib import Path

import pytest

from workstation.lib.files import (
    atomic_binary_writer,
    fresh_directory,
    replace_directory,
)


def test_atomic_binary_writer_replaces_only_after_success(tmp_path: Path) -> None:
    destination = tmp_path / "nested/value"
    destination.parent.mkdir()
    destination.write_bytes(b"original")

    def interrupted_write() -> None:
        with atomic_binary_writer(destination, 0o600) as target:
            target.write(b"incomplete")
            raise RuntimeError("interrupted")

    with pytest.raises(RuntimeError, match="interrupted"):
        interrupted_write()

    assert destination.read_bytes() == b"original"
    assert list(destination.parent.iterdir()) == [destination]

    with atomic_binary_writer(destination, 0o600) as target:
        target.write(b"complete")

    assert destination.read_bytes() == b"complete"
    assert destination.stat().st_mode & 0o777 == 0o600


def test_fresh_directory_replaces_a_symlink(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    link = tmp_path / "link"
    link.symlink_to(target, target_is_directory=True)

    assert fresh_directory(link) == link
    assert link.is_dir()
    assert not link.is_symlink()
    assert target.is_dir()


def test_replace_directory_preserves_metadata_and_symlinks(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    executable = source / "executable"
    executable.write_text("new")
    executable.chmod(0o751)
    (source / "link").symlink_to("executable")
    destination = tmp_path / "destination"
    destination.mkdir()
    (destination / "stale").write_text("old")

    replace_directory(source, destination)

    assert (destination / "executable").read_text() == "new"
    assert (destination / "executable").stat().st_mode & 0o777 == 0o751
    assert (destination / "link").is_symlink()
    assert (destination / "link").readlink() == Path("executable")
    assert not (destination / "stale").exists()
