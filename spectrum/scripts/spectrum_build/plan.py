from __future__ import annotations

import sys

import spectrum_build.features.kmscon as kmscon
from spectrum_build.image.boot import report_boot_artifacts
from spectrum_build.image.cleanup import cleanup_paths
from spectrum_build.core.context import BuildContext
from spectrum_build.features.external_rpms import install_discord, install_release_rpms
from spectrum_build.image.metadata import validate_image, write_image_metadata
from spectrum_build.manifests.packages import (
    OPTIONAL_PACKAGES,
    REQUIRED_PACKAGES,
    validate_package_groups,
)
from spectrum_build.integrations.repositories import install_repositories
from spectrum_build.image.rootfs import install_rootfs_files
from spectrum_build.image.services import (
    disable_authselect_feature,
    enable_required_units,
)
from spectrum_build.core.steps import BuildStep


def install_package_manifest(context: BuildContext) -> None:
    for group_name, packages in REQUIRED_PACKAGES.items():
        print(f"Installing required package group: {group_name}", file=sys.stderr)
        context.dnf.install(packages)

    for group_name, packages in OPTIONAL_PACKAGES.items():
        print(f"Installing optional package group: {group_name}", file=sys.stderr)
        context.dnf.install(packages, optional=True)


def configure_system(context: BuildContext) -> None:
    disable_authselect_feature("with-fingerprint", context.runner)
    install_rootfs_files(context.config.context_dir)
    enable_required_units(context.runner)


def clean_dnf_metadata(context: BuildContext) -> None:
    context.dnf.clean()
    cleanup_paths()


BUILD_STEPS = (
    BuildStep("validate package manifest", lambda _: validate_package_groups()),
    BuildStep("install repositories", install_repositories),
    BuildStep("install package manifest", install_package_manifest),
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
