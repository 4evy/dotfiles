import os
import re
from dataclasses import dataclass

from githubkit import GitHub
from githubkit.exception import GitHubException

from spectrum_build.core.common import fail


@dataclass(frozen=True, slots=True)
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


def latest_github_asset_url(repo: str, asset_pattern: str) -> str:
    try:
        owner, name = repo.split("/", maxsplit=1)
        github = GitHub(
            os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"),
            user_agent="dotfiles-spectrum-build",
            timeout=60,
        )
        response = github.rest.repos.get_latest_release(owner, name)
    except (GitHubException, ValueError) as error:
        fail(f"failed to read the latest {repo} release: {error}")

    release = response.parsed_data
    for asset in release.assets:
        if re.fullmatch(asset_pattern, asset.name):
            return str(asset.browser_download_url)

    names = ", ".join(asset.name for asset in release.assets)
    fail(
        f"no asset matching {asset_pattern!r} in {repo} latest release; assets: {names}"
    )
