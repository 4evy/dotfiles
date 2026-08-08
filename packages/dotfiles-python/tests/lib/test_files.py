from pathlib import Path

import pytest

from workstation.lib.files import atomic_binary_writer


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
