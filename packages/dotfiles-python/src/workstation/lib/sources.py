"""Generic typed access to the shared upstream source catalog."""

from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from workstation.errors import DotfilesError
from workstation.lib.manifests import manifest_path

ManifestKey = Annotated[
    str,
    Field(
        min_length=1,
        pattern=r"^[a-z0-9][a-z0-9_-]*$",
        description="A stable machine-readable manifest key.",
    ),
]
RepositoryComponent = Annotated[
    str,
    Field(
        min_length=1,
        pattern=r"^[A-Za-z0-9_.-]+$",
        description="A forge owner or repository path component.",
    ),
]
Revision = Annotated[
    str,
    Field(
        min_length=1,
        pattern=r"^\S+$",
        description="An immutable commit, tag, or release revision.",
    ),
]
Version = Annotated[
    str,
    Field(min_length=1, description="An upstream, tool, or package version."),
]
Sha256 = Annotated[
    str,
    Field(
        pattern=r"^(?:[0-9a-f]{64}|sha256-[A-Za-z0-9+/]{43}=)$",
        description="A hexadecimal or SRI SHA-256 digest.",
    ),
]
TrackingPolicy = Literal["default-branch", "latest-release"]


class SourceModel(BaseModel):
    """Strict immutable base for source catalog records."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class GitHubRepository(SourceModel):
    forge: Literal["github"]
    owner: RepositoryComponent
    name: RepositoryComponent

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.name}"

    @property
    def web_url(self) -> str:
        return f"https://github.com/{self.slug}"

    @property
    def clone_url(self) -> str:
        return f"{self.web_url}.git"


class GitLabRepository(SourceModel):
    forge: Literal["gitlab"]
    host: str = Field(
        pattern=r"^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$",
        description="The GitLab host name.",
        json_schema_extra={"format": "hostname"},
    )
    owner: RepositoryComponent
    name: RepositoryComponent

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.name}"

    @property
    def web_url(self) -> str:
        return f"https://{self.host}/{self.slug}"

    @property
    def clone_url(self) -> str:
        return f"{self.web_url}.git"


type Repository = Annotated[
    GitHubRepository | GitLabRepository,
    Field(discriminator="forge"),
]


class Artifact(SourceModel):
    """One immutable downloadable artifact."""

    url: str = Field(
        pattern=r"^https://",
        description="The complete pinned HTTPS artifact URL.",
        json_schema_extra={"format": "uri"},
    )
    sha256: Sha256


class ComponentPin(SourceModel):
    """A named tool/component version and its platform artifacts."""

    model_config = ConfigDict(
        json_schema_extra={
            "anyOf": [
                {"required": ["version"]},
                {
                    "required": ["artifacts"],
                    "properties": {"artifacts": {"minProperties": 1}},
                },
            ]
        }
    )

    version: Version | None = None
    artifacts: dict[ManifestKey, Artifact] = Field(
        default_factory=dict,
    )

    @model_validator(mode="after")
    def require_version_or_artifacts(self) -> Self:
        if self.version is None and not self.artifacts:
            raise ValueError("component must declare a version or artifacts")
        return self

    def require_version(self) -> str:
        if self.version is None:
            raise DotfilesError("source component does not declare a version")
        return self.version

    def require_artifact(self, name: str) -> Artifact:
        try:
            return self.artifacts[name]
        except KeyError as error:
            raise DotfilesError(
                f"source component has no artifact named {name!r}"
            ) from error


class SourceRecord(SourceModel):
    """A pinned or explicitly tracked upstream source."""

    model_config = ConfigDict(
        json_schema_extra={
            "anyOf": [
                {"required": ["revision"]},
                {"required": ["version"]},
                {"required": ["tracking"]},
                {
                    "required": ["variants"],
                    "properties": {"variants": {"minProperties": 1}},
                },
            ]
        }
    )

    repository: Repository
    revision: Revision | None = None
    version: Version | None = None
    tracking: TrackingPolicy | None = Field(
        default=None,
        description=(
            "An intentional rolling update policy for consumers that resolve "
            "upstream state at runtime."
        ),
    )
    hashes: dict[ManifestKey, Sha256] = Field(
        default_factory=dict,
        description="Named content digests for consumer-specific fetchers.",
    )
    artifacts: dict[ManifestKey, Artifact] = Field(
        default_factory=dict,
        description="Named immutable downloads.",
    )
    components: dict[ManifestKey, ComponentPin] = Field(
        default_factory=dict,
        description="Named tool or package components used by this source.",
    )
    variants: dict[ManifestKey, SourceRecord] = Field(
        default_factory=dict,
        description="Named source variants with their own complete records.",
    )

    @model_validator(mode="after")
    def require_pin(self) -> Self:
        if (
            self.revision is None
            and self.version is None
            and self.tracking is None
            and not self.variants
        ):
            raise ValueError(
                "source must declare a revision, version, tracking policy, or variant"
            )
        return self

    def require_revision(self) -> str:
        if self.revision is None:
            raise DotfilesError("source does not declare a revision")
        return self.revision

    def require_version(self) -> str:
        if self.version is None:
            raise DotfilesError("source does not declare a version")
        return self.version

    def require_hash(self, name: str) -> str:
        try:
            return self.hashes[name]
        except KeyError as error:
            raise DotfilesError(f"source has no hash named {name!r}") from error

    def require_artifact(self, name: str) -> Artifact:
        try:
            return self.artifacts[name]
        except KeyError as error:
            raise DotfilesError(f"source has no artifact named {name!r}") from error

    def require_component(self, name: str) -> ComponentPin:
        try:
            return self.components[name]
        except KeyError as error:
            raise DotfilesError(f"source has no component named {name!r}") from error

    def require_variant(self, name: str) -> SourceRecord:
        try:
            return self.variants[name]
        except KeyError as error:
            raise DotfilesError(f"source has no variant named {name!r}") from error


class SourceCatalog(SourceModel):
    """Catalog of generic upstream records governed by a local format contract."""

    schema_uri: Literal["./sources.schema.json"] = Field(
        alias="$schema",
        description="The editor and validation schema for this manifest.",
    )
    format_version: Literal[2] = Field(
        description=(
            "Revision of this repository's source-catalog contract; this is not "
            "the JSON Schema dialect version."
        ),
    )
    sources: dict[ManifestKey, SourceRecord] = Field(
        min_length=1,
        description="Source records keyed by their stable consumer-facing name.",
    )

    def require(self, name: str) -> SourceRecord:
        try:
            return self.sources[name]
        except KeyError as error:
            raise DotfilesError(
                f"source catalog has no entry named {name!r}"
            ) from error


def load_sources(path: Path | None = None) -> SourceCatalog:
    """Load and strictly validate the shared upstream source catalog."""
    source_path = path or manifest_path("sources.json")
    try:
        return SourceCatalog.model_validate_json(source_path.read_bytes())
    except (OSError, ValidationError) as error:
        raise DotfilesError(
            f"invalid source manifest {source_path}: {error}"
        ) from error


SOURCES = load_sources()
