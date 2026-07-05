from __future__ import annotations

import platform
import sys

from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.github import RELEASE_RPMS
from spectrum_build.image.platform_info import fedora_arch


DISCORD_RPM_URL = "https://discord.com/api/download?platform=linux&format=rpm"


def install_release_rpms(context: BuildContext) -> None:
    arch = fedora_arch()
    if arch is None:
        print(
            f"Skipping GitHub release RPMs for unsupported architecture: {platform.machine()}",
            file=sys.stderr,
        )
        return

    for release_rpm in RELEASE_RPMS:
        context.dnf.install([release_rpm.asset_url(arch)])


def install_discord(context: BuildContext) -> None:
    context.dnf.install([DISCORD_RPM_URL], nogpgcheck=True)
