import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from spectrum_build.core.common import (
    CommandRunner,
    atomic_write,
    fail,
    require_readable_file,
)
from spectrum_build.image.platform_info import (
    OS_RELEASE,
    read_os_release,
    set_os_release_value,
)
from spectrum_build.image.rootfs import validate_rootfs_files
from spectrum_build.image.services import validate_required_units
from spectrum_build.image.shell import validate_shell_defaults
from spectrum_build.integrations.repositories import validate_repositories_disabled
from spectrum_build.manifests.packages import VALIDATION_PACKAGES
from spectrum_build.settings import ImageConfig

IMAGE_INFO = Path("/usr/share/ublue-os/image-info.json")
VALIDATION_COMMANDS = (
    "bootc",
    "git",
    "just",
    "podman",
    "rpm",
    "systemctl",
)


class ImageInfo(BaseModel):
    name: str = Field(alias="image-name", min_length=1)
    flavor: Literal["spectrum"] = Field(alias="image-flavor")
    base_image_ref: str = Field(alias="base-image-ref", min_length=1)
    base_image_digest: str = Field(alias="base-image-digest", pattern=r"^sha256:.+")
    fedora_version: str = Field(alias="fedora-version", min_length=1)


def write_image_metadata(image: ImageConfig) -> None:
    os_release = read_os_release()
    atomic_write(
        IMAGE_INFO,
        json.dumps(
            image.image_info(fedora_version=os_release.get("VERSION_ID")), indent=2
        ).encode()
        + b"\n",
    )

    for key, value in {
        "VARIANT_ID": image.name,
        "IMAGE_ID": image.name,
        "IMAGE_VERSION": image.resolved_version,
        "OSTREE_VERSION": image.resolved_version,
    }.items():
        set_os_release_value(key, value)

    if image.revision:
        set_os_release_value("BUILD_ID", image.revision)


def validate_image(context_dir: Path, image_name: str, runner: CommandRunner) -> None:
    runner.require(*VALIDATION_COMMANDS)
    require_readable_file(IMAGE_INFO)

    try:
        image_info = ImageInfo.model_validate_json(IMAGE_INFO.read_bytes())
    except OSError, ValidationError:
        fail(f"invalid Spectrum image metadata: {IMAGE_INFO}")
    if image_info.name != image_name:
        fail(f"invalid Spectrum image metadata: {IMAGE_INFO}")

    os_release = read_os_release()
    for key in ("IMAGE_ID", "IMAGE_VERSION"):
        if key not in os_release:
            fail(f"missing {key} in {OS_RELEASE}")

    for package in VALIDATION_PACKAGES:
        runner.run(["rpm", "-q", package], discard_output=True)

    validate_rootfs_files(context_dir)
    validate_repositories_disabled(context_dir)
    validate_required_units(runner)
    validate_shell_defaults()
