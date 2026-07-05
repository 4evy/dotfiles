from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ImageConfig:
    name: str
    vendor: str
    ref: str
    tag: str
    version: str
    revision: str | None
    base_image: str
    base_image_name: str
    base_image_tag: str

    @classmethod
    def from_environment(cls) -> ImageConfig:
        getenv = os.environ.get
        name = getenv("IMAGE_NAME", "spectrum")
        vendor = getenv("IMAGE_VENDOR", "4evy")
        tag = getenv("IMAGE_TAG", "latest")

        return cls(
            name=name,
            vendor=vendor,
            ref=getenv("IMAGE_REF", f"ostree-image:docker://ghcr.io/{vendor}/{name}"),
            tag=tag,
            version=getenv("IMAGE_VERSION", tag),
            revision=getenv("IMAGE_REVISION"),
            base_image=getenv(
                "BLUEFIN_BASE_IMAGE",
                "ghcr.io/ublue-os/bluefin-nvidia-open:stable",
            ),
            base_image_name=getenv("BLUEFIN_BASE_IMAGE_NAME", "bluefin-nvidia-open"),
            base_image_tag=getenv("BLUEFIN_BASE_IMAGE_TAG", "stable"),
        )

    def image_info(self) -> dict[str, str]:
        return {
            "image-name": self.name,
            "image-flavor": "spectrum",
            "image-vendor": self.vendor,
            "image-ref": self.ref,
            "image-tag": self.tag,
            "base-image-name": self.base_image_name,
            "base-image-ref": self.base_image,
            "base-image-tag": self.base_image_tag,
        }


@dataclass(frozen=True)
class BuildConfig:
    context_dir: Path
    image: ImageConfig

    @classmethod
    def from_environment(cls, *, default_context: Path) -> BuildConfig:
        return cls(
            context_dir=Path(os.environ.get("CTX_DIR", default_context)),
            image=ImageConfig.from_environment(),
        )
