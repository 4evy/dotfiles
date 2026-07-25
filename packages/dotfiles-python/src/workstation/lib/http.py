import hashlib
import string
from collections.abc import Mapping
from functools import cache
from pathlib import Path

import httpx
from httpx_retries import Retry, RetryTransport

from workstation.errors import DotfilesError
from workstation.lib.files import atomic_binary_writer
from workstation.lib.validation import safe_path

_TIMEOUT = httpx.Timeout(60.0, connect=20.0)
_RETRY = Retry(
    total=3,
    allowed_methods={"GET"},
    status_forcelist={429, 500, 502, 503, 504},
    backoff_factor=1,
    max_backoff_wait=8,
)


@cache
def client() -> httpx.Client:
    return httpx.Client(
        transport=RetryTransport(retry=_RETRY),
        follow_redirects=True,
        timeout=_TIMEOUT,
    )


def get(
    url: str,
    *,
    params: Mapping[str, str] | None = None,
    headers: Mapping[str, str] | None = None,
) -> httpx.Response:
    response = client().get(url, params=params, headers=headers)
    response.raise_for_status()
    return response


def normalize_sha256(value: str | None) -> str | None:
    """Normalize and validate an optional SHA-256 digest."""
    if value is None:
        return None
    digest = value.removeprefix("sha256:").lower()
    if len(digest) != 64 or any(
        character not in string.hexdigits for character in digest
    ):
        raise DotfilesError(f"invalid SHA-256 digest: {value}")
    return digest


def file_sha256(path: str | Path) -> str:
    """Return the SHA-256 digest of a file without loading it all into memory."""
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def file_matches_sha256(path: str | Path, expected: str | None) -> bool:
    """Return whether a file exists and matches an optional SHA-256 digest."""
    candidate = Path(path)
    digest = normalize_sha256(expected)
    return candidate.is_file() and (digest is None or file_sha256(candidate) == digest)


def download(
    url: str,
    destination: str | Path,
    mode: int = 0o644,
    *,
    expected_sha256: str | None = None,
) -> Path:
    destination_path = safe_path(destination)
    expected = normalize_sha256(expected_sha256)
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256() if expected is not None else None
    with client().stream("GET", url) as response:
        response.raise_for_status()
        with atomic_binary_writer(destination_path, mode) as target:
            for chunk in response.iter_bytes():
                target.write(chunk)
                if digest is not None:
                    digest.update(chunk)
            if digest is not None and digest.hexdigest() != expected:
                raise DotfilesError(f"SHA-256 mismatch for {destination_path.name}")
    return destination_path
