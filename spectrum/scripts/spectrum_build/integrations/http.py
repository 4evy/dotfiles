import httpx

from spectrum_build.core.common import fail
from workstation.lib.http import get


def download(url: str) -> bytes:
    try:
        return get(url).content
    except httpx.HTTPError as error:
        fail(f"failed to download {url}: {error}")
