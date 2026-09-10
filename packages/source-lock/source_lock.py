"""Read flake locks and verify downloads of non-executable file inputs."""

import base64
import hashlib
import shutil
import struct
import urllib.request
from pathlib import Path


def token(value: bytes) -> bytes:
    """Encode one NAR string, including eight-byte alignment."""
    return struct.pack("<Q", len(value)) + value + b"\0" * (-len(value) % 8)


def download_file(pin: dict[str, str], destination: Path) -> None:
    """Verify the file's NAR hash against the immutable flake lock."""
    if not pin["url"].startswith("https://"):
        raise ValueError("Source downloads require HTTPS")
    with (
        urllib.request.urlopen(pin["url"], timeout=120) as response,  # ruff: ignore[suspicious-url-open-usage]
        destination.open("wb") as output,
    ):
        shutil.copyfileobj(response, output)
    digest = hashlib.sha256()
    for value in (b"nix-archive-1", b"(", b"type", b"regular", b"contents"):
        digest.update(token(value))
    size = destination.stat().st_size
    digest.update(struct.pack("<Q", size))
    with destination.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    digest.update(b"\0" * (-size % 8))
    digest.update(token(b")"))
    actual = "sha256-" + base64.b64encode(digest.digest()).decode()
    if actual != pin["narHash"]:
        destination.unlink()
        raise ValueError(f"NAR hash mismatch for {pin['url']}: {actual}")
