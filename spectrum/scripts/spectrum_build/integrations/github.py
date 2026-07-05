from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

from spectrum_build.core.common import fail
from spectrum_build.integrations.http import download


@dataclass(frozen=True)
class ReleaseRpm:
    repo: str
    asset_pattern: str

    def asset_url(self, arch: str) -> str:
        return latest_github_asset_url(
            self.repo, self.asset_pattern.format(arch=re.escape(arch))
        )


RELEASE_RPMS = (
    ReleaseRpm("getsops/sops", r"sops-[0-9].*-1\.{arch}\.rpm"),
    ReleaseRpm("rustdesk/rustdesk", r"rustdesk-[0-9].*-0\.{arch}\.rpm"),
)


def github_api_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "dotfiles-spectrum-build",
    }
    if token := os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    return headers


def latest_github_asset_url(repo: str, asset_pattern: str) -> str:
    release = json.loads(
        download(
            f"https://api.github.com/repos/{repo}/releases/latest",
            headers=github_api_headers(),
        )
    )
    for asset in release.get("assets", []):
        name = asset.get("name") or ""
        url = asset.get("browser_download_url")
        if url and re.fullmatch(asset_pattern, name):
            return url

    names = ", ".join(asset.get("name") or "" for asset in release.get("assets", []))
    fail(
        f"no asset matching {asset_pattern!r} in {repo} latest release; assets: {names}"
    )
