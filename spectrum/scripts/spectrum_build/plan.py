import grp
import sys

from spectrum_build.core.common import fail
from spectrum_build.core.context import BuildContext
from spectrum_build.core.steps import BuildStep
from spectrum_build.features import kmscon
from spectrum_build.features.external_rpms import install_discord, install_release_rpms
from spectrum_build.image.boot import report_boot_artifacts
from spectrum_build.image.cleanup import cleanup_paths
from spectrum_build.image.metadata import validate_image, write_image_metadata
from spectrum_build.image.rootfs import install_rootfs_files
from spectrum_build.image.services import (
    disable_authselect_feature,
    enable_required_units,
)
from spectrum_build.image.shell import align_shell_defaults
from spectrum_build.integrations.repositories import (
    disable_repositories,
    install_repositories,
)
from spectrum_build.manifests.packages import (
    EXTERNAL_REPOSITORY_PACKAGES,
    OPTIONAL_PACKAGES,
    REQUIRED_PACKAGES,
    validate_package_groups,
)

ONEPASSWORD_GROUPS = {
    "onepassword-mcp": 954,
    "onepassword-cli": 955,
    "onepassword": 956,
}


def ensure_1password_groups(context: BuildContext) -> None:
    for name, gid in ONEPASSWORD_GROUPS.items():
        try:
            current_group = grp.getgrnam(name)
        except KeyError:
            current_group = None

        try:
            gid_group = grp.getgrgid(gid)
        except KeyError:
            gid_group = None

        if gid_group is not None and gid_group.gr_name != name:
            fail(f"GID {gid} is already used by group: {gid_group.gr_name}")

        if current_group is None:
            context.runner.run(["groupadd", "--system", "--gid", str(gid), name])
        elif current_group.gr_gid != gid:
            context.runner.run(["groupmod", "--gid", str(gid), name])


def install_package_manifest(context: BuildContext) -> None:
    for group_name, packages in REQUIRED_PACKAGES.items():
        print(f"Installing required package group: {group_name}", file=sys.stderr)
        context.dnf.install(packages)

    for group_name, packages in OPTIONAL_PACKAGES.items():
        print(f"Installing optional package group: {group_name}", file=sys.stderr)
        context.dnf.install(packages, optional=True)


def install_external_repository_packages(context: BuildContext) -> None:
    for repo_id, packages in EXTERNAL_REPOSITORY_PACKAGES.items():
        print(
            f"Installing packages from isolated repository: {repo_id}", file=sys.stderr
        )
        context.dnf.install(packages, enabled_repositories=(repo_id,))
        disable_repositories(context.config.context_dir)


def configure_system(context: BuildContext) -> None:
    disable_authselect_feature("with-fingerprint", context.runner)
    align_shell_defaults()
    install_rootfs_files(context.config.context_dir)
    enable_required_units(context.runner)


def clean_dnf_metadata(context: BuildContext) -> None:
    context.dnf.clean()
    cleanup_paths()


BUILD_STEPS = (
    BuildStep("validate package manifest", lambda _: validate_package_groups()),
    BuildStep("install Fedora package manifest", install_package_manifest),
    BuildStep("install repositories", install_repositories),
    BuildStep("ensure 1Password helper groups", ensure_1password_groups),
    BuildStep(
        "install external repository packages", install_external_repository_packages
    ),
    BuildStep("install GitHub release RPMs", install_release_rpms),
    BuildStep("install Discord RPM", install_discord),
    BuildStep("install KMSCON", lambda context: kmscon.install(context.runner)),
    BuildStep(
        "configure image metadata",
        lambda context: write_image_metadata(context.config.image),
    ),
    BuildStep("configure system", configure_system),
    BuildStep(
        "validate image",
        lambda context: validate_image(
            context.config.context_dir, context.config.image.name, context.runner
        ),
    ),
    BuildStep("report boot artifacts", lambda _: report_boot_artifacts()),
    BuildStep("clean DNF metadata", clean_dnf_metadata),
)
