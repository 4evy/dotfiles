from __future__ import annotations

import json
import subprocess
from pathlib import Path

from spectrum_build.core.common import (
    CommandRunner,
    atomic_write,
    fail,
    require_readable_file,
)
from spectrum_build.settings import ImageConfig
from spectrum_build.manifests.packages import VALIDATION_PACKAGES
from spectrum_build.image.platform_info import (
    OS_RELEASE,
    read_os_release,
    set_os_release_value,
)
from spectrum_build.image.rootfs import validate_rootfs_files
from spectrum_build.image.services import validate_required_units


IMAGE_INFO = Path("/usr/share/ublue-os/image-info.json")
VALIDATION_COMMANDS = (
    "bootc",
    "distrobox",
    "git",
    "just",
    "podman",
    "rpm",
    "systemctl",
)


def write_image_metadata(image: ImageConfig) -> None:
    atomic_write(IMAGE_INFO, json.dumps(image.image_info(), indent=2).encode() + b"\n")

    for key, value in {
        "VARIANT_ID": image.name,
        "IMAGE_ID": image.name,
        "IMAGE_VERSION": image.version,
        "OSTREE_VERSION": image.version,
    }.items():
        set_os_release_value(key, value)

    if image.revision:
        set_os_release_value("BUILD_ID", image.revision)


def validate_image(context_dir: Path, image_name: str, runner: CommandRunner) -> None:
    runner.require(*VALIDATION_COMMANDS)
    require_readable_file(IMAGE_INFO)

    with IMAGE_INFO.open(encoding="utf-8") as handle:
        image_info = json.load(handle)
    match image_info:
        case {
            "image-name": str(name),
            "image-flavor": "spectrum",
            "base-image-ref": str(base_image_ref),
        } if name == image_name and base_image_ref:
            pass
        case _:
            fail(f"invalid Spectrum image metadata: {IMAGE_INFO}")

    os_release = read_os_release()
    for key in ("IMAGE_ID", "IMAGE_VERSION"):
        if key not in os_release:
            fail(f"missing {key} in {OS_RELEASE}")

    for package in VALIDATION_PACKAGES:
        runner.run(["rpm", "-q", package], stdout=subprocess.DEVNULL)

    validate_rootfs_files(context_dir)
    validate_required_units(runner)
