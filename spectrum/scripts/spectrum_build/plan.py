import sys

from spectrum_build.core.context import BuildContext
from spectrum_build.core.steps import BuildStep
from spectrum_build.image.boot import report_boot_artifacts
from spectrum_build.image.cleanup import cleanup_paths
from spectrum_build.image.metadata import validate_image, write_image_metadata
from spectrum_build.image.services import (
    disable_authselect_feature,
    enable_required_units,
)
from spectrum_build.image.shell import align_shell_defaults
from spectrum_build.manifests.packages import (
    OPTIONAL_PACKAGES,
    REQUIRED_PACKAGES,
    validate_package_groups,
)
from spectrum_build.programs.operations import install_programs


def install_package_manifest(context: BuildContext) -> None:
    for group_name, packages in REQUIRED_PACKAGES.items():
        print(f"Installing required package group: {group_name}", file=sys.stderr)
        context.dnf.install(packages)

    for group_name, packages in OPTIONAL_PACKAGES.items():
        print(f"Installing optional package group: {group_name}", file=sys.stderr)
        context.dnf.install(packages, optional=True)


def configure_system(context: BuildContext) -> None:
    disable_authselect_feature("with-fingerprint", context.runner)
    align_shell_defaults()
    enable_required_units(context.runner)


def clean_transient_image_state(_: BuildContext) -> None:
    # Package-manager and uv caches live on Containerfile cache mounts, outside
    # the committed image. Leave those populated for the next rebuild.
    cleanup_paths()


BUILD_STEPS = (
    BuildStep("validate package manifest", lambda _: validate_package_groups()),
    BuildStep("install Fedora package manifest", install_package_manifest),
    BuildStep("install program manifest", install_programs),
    BuildStep(
        "configure image metadata",
        lambda context: write_image_metadata(context.config.image),
    ),
    BuildStep("configure system", configure_system),
    BuildStep(
        "validate image",
        lambda context: validate_image(context.config.image.name, context.runner),
    ),
    BuildStep("report boot artifacts", lambda _: report_boot_artifacts()),
    BuildStep("clean transient image state", clean_transient_image_state),
)
