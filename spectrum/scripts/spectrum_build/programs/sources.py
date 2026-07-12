import platform
import sys

from spectrum_build.core.context import BuildContext
from spectrum_build.image.platform_info import fedora_arch
from spectrum_build.integrations.github import ReleaseRpm
from spectrum_build.programs.models import PackageResolver


def github_release_rpm(release: ReleaseRpm) -> PackageResolver:
    def resolve(_: BuildContext) -> tuple[str, ...]:
        arch = fedora_arch()
        if arch is None:
            print(
                f"Skipping {release.name} for unsupported architecture: "
                f"{platform.machine()}",
                file=sys.stderr,
            )
            return ()
        return (release.asset_url(arch),)

    return PackageResolver(resolve)
