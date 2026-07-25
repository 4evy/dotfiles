"""Shared primitives for application source and archive installers."""

import tarfile
from pathlib import Path

from workstation.console import error_console
from workstation.errors import DotfilesError
from workstation.lib.files import extract_tar_archive
from workstation.lib.http import download, file_matches_sha256, normalize_sha256


def extract_application_directory(
    archive_path: Path, destination: Path, *, label: str
) -> Path:
    """Extract an archive and require one top-level application directory."""
    with tarfile.open(archive_path) as archive:
        extract_tar_archive(archive, destination)
    extracted = next(
        (path for path in destination.iterdir() if path.info.is_dir()), None
    )
    if extracted is None:
        raise DotfilesError(f"{label} archive did not contain an application directory")
    return extracted


def verified_download(path: Path, url: str, digest: str | None) -> None:
    """Download an artifact unless a cached file matches its SHA-256 digest."""
    expected = normalize_sha256(digest)
    if file_matches_sha256(path, expected):
        error_console.print(f"installer: using cached {path.name}")
        return
    error_console.print(f"installer: downloading {path.name}")
    download(url, path, expected_sha256=expected)
