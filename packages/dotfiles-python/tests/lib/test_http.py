import hashlib
from pathlib import Path
from types import TracebackType
from typing import Self

import pytest

from workstation.errors import DotfilesError
from workstation.lib import http


class FakeResponse:
    def __init__(self, chunks: tuple[bytes, ...]) -> None:
        self.chunks = chunks

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc_value: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    def iter_bytes(self) -> tuple[bytes, ...]:
        return self.chunks


class FakeClient:
    def __init__(self, chunks: tuple[bytes, ...]) -> None:
        self.chunks = chunks

    def stream(self, method: str, url: str) -> FakeResponse:
        assert method == "GET"
        assert url == "https://example.invalid/archive"
        return FakeResponse(self.chunks)


def test_download_verifies_sha256_before_replacing_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = b"verified content"
    monkeypatch.setattr(http, "client", lambda: FakeClient((content[:8], content[8:])))
    destination = tmp_path / "archive"

    http.download(
        "https://example.invalid/archive",
        destination,
        expected_sha256=f"sha256:{hashlib.sha256(content).hexdigest()}",
    )
    assert destination.read_bytes() == content

    destination.write_bytes(b"existing")
    with pytest.raises(DotfilesError, match="SHA-256 mismatch"):
        http.download(
            "https://example.invalid/archive",
            destination,
            expected_sha256="0" * 64,
        )
    assert destination.read_bytes() == b"existing"


@pytest.mark.parametrize("digest", ["short", "g" * 64, "sha512:" + "0" * 64])
def test_download_rejects_invalid_sha256(
    tmp_path: Path, digest: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(http, "client", lambda: FakeClient((b"content",)))
    with pytest.raises(DotfilesError, match="invalid SHA-256 digest"):
        http.download(
            "https://example.invalid/archive",
            tmp_path / "archive",
            expected_sha256=digest,
        )


def test_file_matches_normalized_sha256(tmp_path: Path) -> None:
    path = tmp_path / "archive"
    path.write_bytes(b"content")
    digest = hashlib.sha256(b"content").hexdigest()

    assert http.file_matches_sha256(path, digest)
    assert http.file_matches_sha256(path, f"sha256:{digest.upper()}")
    assert not http.file_matches_sha256(path, "0" * 64)
    assert not http.file_matches_sha256(tmp_path / "missing", None)
