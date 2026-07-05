from __future__ import annotations

from functools import cache

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from spectrum_build.core.common import fail


@cache
def http_session() -> requests.Session:
    retry = Retry(
        total=2,
        connect=2,
        read=2,
        status=2,
        backoff_factor=1,
        allowed_methods=frozenset({"GET"}),
        status_forcelist=(429, 500, 502, 503, 504),
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session = requests.Session()
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def download(url: str, headers: dict[str, str] | None = None) -> bytes:
    try:
        response = http_session().get(url, headers=headers, timeout=60)
        response.raise_for_status()
        return response.content
    except requests.RequestException as error:
        fail(f"failed to download {url}: {error}")
