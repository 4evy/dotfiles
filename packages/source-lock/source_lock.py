"""Read flake locks and verify downloads of non-executable file inputs."""

import argparse
import base64
import hashlib
import shutil
import struct
import urllib.request
from pathlib import Path


def token(value: bytes) -> bytes:
    """Encode one NAR string, including eight-byte alignment."""
    return struct.pack("<Q", len(value)) + value + b"\0" * (-len(value) % 8)


def file_nar_hash(path: Path) -> str:
    """Hash a download as a non-executable regular file in a NAR."""
    digest = hashlib.sha256()
    for value in (b"nix-archive-1", b"(", b"type", b"regular", b"contents"):
        digest.update(token(value))
    size = path.stat().st_size
    digest.update(struct.pack("<Q", size))
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    digest.update(b"\0" * (-size % 8))
    digest.update(token(b")"))
    return "sha256-" + base64.b64encode(digest.digest()).decode()


def download_file(pin: dict[str, str], destination: Path) -> None:
    """Verify the file's NAR hash against the immutable flake lock."""
    if not pin["url"].startswith("https://"):
        raise ValueError("Source downloads require HTTPS")
    with (
        urllib.request.urlopen(pin["url"], timeout=120) as response,  # ruff: ignore[suspicious-url-open-usage]
        destination.open("wb") as output,
    ):
        shutil.copyfileobj(response, output)
    actual = file_nar_hash(destination)
    if actual != pin["narHash"]:
        destination.unlink()
        raise ValueError(f"NAR hash mismatch for {pin['url']}: {actual}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify a flake file input's NAR hash")
    parser.add_argument("path", type=Path)
    parser.add_argument("nar_hash")
    args = parser.parse_args()
    actual = file_nar_hash(args.path)
    if actual != args.nar_hash:
        parser.exit(1, f"NAR hash mismatch for {args.path}: {actual}\n")


if __name__ == "__main__":
    main()
