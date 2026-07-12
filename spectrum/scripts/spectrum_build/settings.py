from dataclasses import dataclass
from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ImageConfig(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", validate_default=True)

    name: str = Field("spectrum", validation_alias="IMAGE_NAME", min_length=1)
    vendor: str = Field("4evy", validation_alias="IMAGE_VENDOR", min_length=1)
    ref: str | None = Field(None, validation_alias="IMAGE_REF")
    tag: str = Field("latest", validation_alias="IMAGE_TAG", min_length=1)
    version: str | None = Field(None, validation_alias="IMAGE_VERSION")
    revision: str | None = Field(None, validation_alias="IMAGE_REVISION")
    base_image: str = Field(
        "ghcr.io/ublue-os/bluefin-nvidia-open:stable",
        validation_alias="BLUEFIN_BASE_IMAGE",
        min_length=1,
    )
    base_image_name: str = Field(
        "bluefin-nvidia-open",
        validation_alias="BLUEFIN_BASE_IMAGE_NAME",
        min_length=1,
    )
    base_image_tag: str = Field(
        "stable",
        validation_alias="BLUEFIN_BASE_IMAGE_TAG",
        min_length=1,
    )

    @model_validator(mode="after")
    def derive_defaults(self) -> ImageConfig:
        if self.ref is None:
            self.ref = f"ostree-image:docker://ghcr.io/{self.vendor}/{self.name}"
        if self.version is None:
            self.version = self.tag
        return self

    @property
    def resolved_ref(self) -> str:
        return self.ref or f"ostree-image:docker://ghcr.io/{self.vendor}/{self.name}"

    @property
    def resolved_version(self) -> str:
        return self.version or self.tag

    @property
    def base_image_ref(self) -> str:
        return self.base_image.partition("@")[0]

    @property
    def base_image_digest(self) -> str | None:
        _, separator, digest = self.base_image.partition("@")
        return digest if separator else None

    def image_info(self, *, fedora_version: str | None = None) -> dict[str, str]:
        metadata = {
            "image-name": self.name,
            "image-flavor": "spectrum",
            "image-vendor": self.vendor,
            "image-ref": self.resolved_ref,
            "image-tag": self.tag,
            "base-image-name": self.base_image_name,
            "base-image-ref": self.base_image,
            "base-image-tag": self.base_image_tag,
        }
        if self.base_image_digest:
            metadata["base-image-digest"] = self.base_image_digest
        if fedora_version:
            metadata["fedora-version"] = fedora_version
        return metadata


class BuildEnvironment(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    context_dir: Path | None = Field(None, validation_alias="CTX_DIR")


@dataclass(frozen=True, slots=True)
class BuildConfig:
    context_dir: Path
    image: ImageConfig

    @classmethod
    def from_environment(cls, *, default_context: Path) -> BuildConfig:
        environment = BuildEnvironment()
        return cls(
            context_dir=environment.context_dir or default_context,
            image=ImageConfig(),
        )
