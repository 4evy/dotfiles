from pathlib import Path

from spectrum_build.core.context import BuildContext
from spectrum_build.programs.models import DnfProgram, PackageResolver

RPMFUSION_FREE_RELEASE_URL = (
    "https://download1.rpmfusion.org/free/fedora/"
    "rpmfusion-free-release-{fedora_version}.noarch.rpm"
)
RPMFUSION_FREE_REPOSITORY_FILES = (
    Path("/etc/yum.repos.d/rpmfusion-free.repo"),
    Path("/etc/yum.repos.d/rpmfusion-free-updates.repo"),
    Path("/etc/yum.repos.d/rpmfusion-free-updates-testing.repo"),
)


def rpmfusion_free_release(context: BuildContext) -> tuple[str, ...]:
    fedora_version = context.runner.output(["rpm", "-E", "%fedora"])
    return (RPMFUSION_FREE_RELEASE_URL.format(fedora_version=fedora_version),)


PROGRAM = DnfProgram(
    name="Telegram",
    packages=("telegram-desktop",),
    repository_packages=PackageResolver(rpmfusion_free_release),
    generated_repository_files=RPMFUSION_FREE_REPOSITORY_FILES,
    enabled_repositories=("rpmfusion-free", "rpmfusion-free-updates"),
    validation_packages=("telegram-desktop",),
)
