import re
import tomllib
from collections.abc import Iterator
from functools import cache, partial
from importlib import import_module
from pathlib import Path
from string import Formatter
from typing import Annotated, Literal, Self, cast

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from spectrum_build.core.common import fail
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.github import ReleaseRpm, github_release_rpm
from spectrum_build.integrations.gnome_extensions import install_gnome_shell_extension
from spectrum_build.integrations.repositories import RepositoryFile
from spectrum_build.programs.models import (
    CustomProgram,
    DnfProgram,
    FileOperation,
    FileOperationKind,
    PackageResolver,
    Program,
    SystemGroup,
)
from workstation.errors import DotfilesError
from workstation.lib.manifests import manifest_path
from workstation.lib.sources import (
    SOURCES,
    GitHubRepository,
    ManifestKey,
    SourceCatalog,
)

SourceReference = Annotated[
    ManifestKey,
    Field(
        description="Key of a repository declared in manifests/sources.json.",
        json_schema_extra={"x-dotfiles-source-filter": "any"},
    ),
]
LatestGitHubReleaseSource = Annotated[
    ManifestKey,
    Field(
        description=(
            "Key of a GitHub source with a latest-release tracking policy in "
            "manifests/sources.json."
        ),
        json_schema_extra={"x-dotfiles-source-filter": "github-latest-release"},
    ),
]


class ManifestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class RepositorySpec(ManifestModel):
    model_config = ConfigDict(
        json_schema_extra={
            "oneOf": [
                {
                    "required": ["source_path"],
                    "not": {"required": ["source_url"]},
                },
                {
                    "required": ["source_url"],
                    "not": {"required": ["source_path"]},
                },
            ]
        }
    )

    destination: Path = Field(
        description="Absolute destination for the repository definition.",
    )
    source_path: Path | None = Field(
        default=None,
        description="Repository-relative file copied to the destination.",
    )
    source_url: str | None = Field(
        default=None,
        pattern=r"^https://",
        description="HTTPS URL downloaded to the destination.",
        json_schema_extra={"format": "uri"},
    )
    repo_ids: tuple[str, ...] = Field(
        default=(),
        description="DNF repository IDs made available during installation.",
        json_schema_extra={"uniqueItems": True},
    )
    import_rpm_key: bool = Field(
        default=False,
        description="Import RPM keys declared by the installed repository.",
    )

    @field_validator("destination")
    @classmethod
    def require_absolute_destination(cls, value: Path) -> Path:
        if not value.is_absolute():
            raise ValueError("repository destination must be absolute")
        return value

    @field_validator("source_path")
    @classmethod
    def require_safe_relative_source(cls, value: Path | None) -> Path | None:
        if value is not None and (value.is_absolute() or ".." in value.parts):
            raise ValueError("repository source path must be a safe relative path")
        return value

    @model_validator(mode="after")
    def validate_repository(self) -> Self:
        if (self.source_path is None) == (self.source_url is None):
            raise ValueError("repository must declare exactly one source")
        if len(self.repo_ids) != len(set(self.repo_ids)):
            raise ValueError("repository IDs must be unique")
        return self


class ProgramSpec(ManifestModel):
    key: str = Field(
        min_length=1,
        pattern=r"^[a-z0-9][a-z0-9-]*$",
        description="Stable program identifier used by automation.",
    )
    group: str = Field(
        min_length=1,
        pattern=r"^[a-z0-9][a-z0-9-]*$",
        description="Ordered Spectrum Containerfile installation/cache group.",
    )


class AbsolutePathSpec(ManifestModel):
    path: Path

    @field_validator("path")
    @classmethod
    def require_absolute_path(cls, value: Path) -> Path:
        if not value.is_absolute():
            raise ValueError("file operation paths must be absolute")
        return value


class EnsureDirectorySpec(AbsolutePathSpec):
    kind: Literal["ensure-directory"]


class RequireFileSpec(AbsolutePathSpec):
    kind: Literal["require-file"]


class UnlinkSpec(AbsolutePathSpec):
    kind: Literal["unlink"]


class RemoveEmptyDirectorySpec(AbsolutePathSpec):
    kind: Literal["remove-empty-directory"]


class SymlinkSpec(AbsolutePathSpec):
    kind: Literal["symlink"]
    target: Path

    @field_validator("target")
    @classmethod
    def require_absolute_target(cls, value: Path) -> Path:
        if not value.is_absolute():
            raise ValueError("symlink target must be absolute")
        return value


type FileOperationSpec = Annotated[
    EnsureDirectorySpec
    | RequireFileSpec
    | UnlinkSpec
    | RemoveEmptyDirectorySpec
    | SymlinkSpec,
    Field(discriminator="kind"),
]


class SystemGroupSpec(ManifestModel):
    name: str = Field(min_length=1, pattern=r"^[a-z_][a-z0-9_-]*$")
    gid: int = Field(ge=1)


class PackageVariableSpec(ManifestModel):
    name: str = Field(min_length=1, pattern=r"^[a-z_][a-z0-9_]*$")
    command: tuple[str, ...] = Field(min_length=1)

    @field_validator("command")
    @classmethod
    def require_valid_command(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if any(not argument or argument != argument.strip() for argument in value):
            raise ValueError("package variable command arguments must be trimmed")
        return value


class ModuleProgramSpec(ProgramSpec):
    kind: Literal["module"] = Field(
        description="Load a custom Spectrum Python program module.",
    )
    module: str = Field(
        min_length=1,
        pattern=r"^[a-z][a-z0-9_]*$",
        description="Module under spectrum_build.programs containing PROGRAM.",
    )
    sources: tuple[SourceReference, ...] = Field(
        default=(),
        description="Shared source records consumed by the custom module.",
        json_schema_extra={"uniqueItems": True},
    )

    @field_validator("sources")
    @classmethod
    def require_unique_sources(
        cls,
        value: tuple[str, ...],
    ) -> tuple[str, ...]:
        if len(value) != len(set(value)):
            raise ValueError("module source references must be unique")
        return value


class DnfProgramSpec(ProgramSpec):
    kind: Literal["dnf"] = Field(
        description="Install packages directly with DNF.",
    )
    name: str = Field(
        min_length=1,
        description="Human-readable program name.",
    )
    packages: tuple[str, ...] = Field(
        min_length=1,
        description="Package names or HTTPS RPM URLs to install.",
        json_schema_extra={"uniqueItems": True},
    )
    repository_packages: tuple[str, ...] = Field(
        default=(),
        description="Package URL templates installed before the main packages.",
        json_schema_extra={"uniqueItems": True},
    )
    package_variables: tuple[PackageVariableSpec, ...] = Field(
        default=(),
        description="Commands that resolve repository-package template variables.",
    )
    repositories: tuple[RepositorySpec, ...] = Field(
        default=(),
        description="Temporary DNF repository definitions.",
    )
    enabled_repositories: tuple[str, ...] = Field(
        default=(),
        description="Repository IDs enabled for this installation only.",
        json_schema_extra={"uniqueItems": True},
    )
    generated_repository_files: tuple[Path, ...] = Field(
        default=(),
        description="Repository files generated by repository package installation.",
        json_schema_extra={"uniqueItems": True},
    )
    system_groups: tuple[SystemGroupSpec, ...] = Field(
        default=(),
        description="Fixed system groups required before package installation.",
    )
    before_install: tuple[FileOperationSpec, ...] = Field(
        default=(),
        description="Generic filesystem operations run before package installation.",
    )
    after_install: tuple[FileOperationSpec, ...] = Field(
        default=(),
        description="Generic filesystem operations run after repository cleanup.",
    )
    validation_packages: tuple[str, ...] = Field(
        min_length=1,
        description="RPM package names required in the completed image.",
        json_schema_extra={"uniqueItems": True},
    )
    nogpgcheck: bool = Field(
        default=False,
        description="Disable RPM signature checks for this installation.",
    )

    @field_validator(
        "packages",
        "repository_packages",
        "enabled_repositories",
        "validation_packages",
    )
    @classmethod
    def require_unique_values(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if any(not item.strip() or item != item.strip() for item in value):
            raise ValueError("manifest list values must be non-empty and trimmed")
        if len(value) != len(set(value)):
            raise ValueError("manifest list values must be unique")
        return value

    @field_validator("generated_repository_files")
    @classmethod
    def require_absolute_generated_repository_files(
        cls,
        value: tuple[Path, ...],
    ) -> tuple[Path, ...]:
        if any(not path.is_absolute() for path in value):
            raise ValueError("generated repository file paths must be absolute")
        if len(value) != len(set(value)):
            raise ValueError("generated repository file paths must be unique")
        return value

    @model_validator(mode="after")
    def validate_dnf_program(self) -> Self:
        variable_names = [variable.name for variable in self.package_variables]
        if len(variable_names) != len(set(variable_names)):
            raise ValueError("package variable names must be unique")
        placeholders = {
            field_name
            for template in self.repository_packages
            for _literal, field_name, _format, _conversion in Formatter().parse(
                template
            )
            if field_name is not None
        }
        unknown = placeholders.difference(variable_names)
        if unknown:
            raise ValueError(
                f"repository packages use unknown variables: {', '.join(sorted(unknown))}"
            )
        if self.package_variables and not self.repository_packages:
            raise ValueError("package variables require repository packages")
        group_names = [group.name for group in self.system_groups]
        group_ids = [group.gid for group in self.system_groups]
        if len(group_names) != len(set(group_names)) or len(group_ids) != len(
            set(group_ids)
        ):
            raise ValueError("system group names and GIDs must be unique")
        return self


class GitHubReleaseRpmSpec(ProgramSpec):
    kind: Literal["github-release-rpm"] = Field(
        description="Install the newest matching RPM from a GitHub release.",
    )
    name: str = Field(
        min_length=1,
        description="Human-readable program name.",
    )
    source: LatestGitHubReleaseSource
    asset_pattern: str = Field(
        min_length=1,
        description="Release asset regex; {arch} expands to the RPM architecture.",
        json_schema_extra={"format": "regex"},
    )
    validation_packages: tuple[str, ...] = Field(
        min_length=1,
        description="RPM package names required in the completed image.",
        json_schema_extra={"uniqueItems": True},
    )

    @field_validator("asset_pattern")
    @classmethod
    def require_valid_asset_pattern(cls, value: str) -> str:
        if value.count("{arch}") != 1:
            raise ValueError("asset pattern must contain {arch} exactly once")
        try:
            re.compile(value.replace("{arch}", "x86_64"))
        except re.error as error:
            raise ValueError(
                f"asset pattern is not a valid regular expression: {error}"
            ) from error
        return value

    @field_validator("validation_packages")
    @classmethod
    def require_unique_validation_packages(
        cls,
        value: tuple[str, ...],
    ) -> tuple[str, ...]:
        if any(not item.strip() or item != item.strip() for item in value):
            raise ValueError("validation packages must be non-empty and trimmed")
        if len(value) != len(set(value)):
            raise ValueError("validation packages must be unique")
        return value


class GnomeShellExtensionSpec(ProgramSpec):
    kind: Literal["gnome-shell-extension"] = Field(
        description="Install a ZIP-packaged GNOME Shell extension release.",
    )
    name: str = Field(min_length=1, description="Human-readable extension name.")
    source: LatestGitHubReleaseSource
    uuid: str = Field(
        min_length=3,
        pattern=r"^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$",
        description="The GNOME Shell extension UUID.",
    )
    asset_pattern: str = Field(
        min_length=1,
        description="Regular expression selecting the release ZIP asset.",
        json_schema_extra={"format": "regex"},
    )
    packages: tuple[str, ...] = Field(
        default=(),
        description="Runtime packages required by the extension.",
        json_schema_extra={"uniqueItems": True},
    )
    required_files: tuple[Path, ...] = Field(
        min_length=1,
        description="Required paths relative to the extracted extension root.",
        json_schema_extra={"uniqueItems": True},
    )
    schema_directories: tuple[Path, ...] = Field(
        default=(),
        description="Relative directories compiled with glib-compile-schemas.",
        json_schema_extra={"uniqueItems": True},
    )

    @field_validator("asset_pattern")
    @classmethod
    def require_valid_asset_pattern(cls, value: str) -> str:
        try:
            re.compile(value)
        except re.error as error:
            raise ValueError(
                f"asset pattern is not a valid regular expression: {error}"
            ) from error
        return value

    @field_validator("packages")
    @classmethod
    def require_unique_packages(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if any(not item.strip() or item != item.strip() for item in value):
            raise ValueError("extension packages must be non-empty and trimmed")
        if len(value) != len(set(value)):
            raise ValueError("extension packages must be unique")
        return value

    @field_validator("required_files", "schema_directories")
    @classmethod
    def require_safe_relative_paths(cls, value: tuple[Path, ...]) -> tuple[Path, ...]:
        if any(path.is_absolute() or ".." in path.parts for path in value):
            raise ValueError("extension paths must be safe relative paths")
        if len(value) != len(set(value)):
            raise ValueError("extension paths must be unique")
        return value


type ConcreteProgramSpec = Annotated[
    ModuleProgramSpec | DnfProgramSpec | GitHubReleaseRpmSpec | GnomeShellExtensionSpec,
    Field(discriminator="kind"),
]


class ProgramManifest(ManifestModel):
    """Ordered declarative Spectrum program inventory."""

    schema_uri: Literal["./spectrum-programs.schema.json"] = Field(
        alias="$schema",
        description="The editor and validation schema for this manifest.",
    )
    format_version: Literal[1] = Field(
        description=(
            "Revision of this repository's Spectrum-manifest contract; this is "
            "not the TOML or JSON Schema specification version."
        ),
    )
    program: tuple[ConcreteProgramSpec, ...] = Field(
        min_length=1,
        description="Programs in deterministic installation order.",
        json_schema_extra={"uniqueItems": True},
    )

    @model_validator(mode="after")
    def validate_manifest(self) -> Self:
        keys = [program.key for program in self.program]
        if len(keys) != len(set(keys)):
            raise ValueError("program keys must be unique")
        repository_destinations = [
            repository.destination
            for program in self.program
            if isinstance(program, DnfProgramSpec)
            for repository in program.repositories
        ]
        if len(repository_destinations) != len(set(repository_destinations)):
            raise ValueError("repository destinations must be unique")
        return self

    def validate_source_references(
        self,
        catalog: SourceCatalog = SOURCES,
    ) -> None:
        """Ensure every cross-manifest reference names a compatible source."""
        references = (
            (program, source)
            for program in self.program
            for source in (
                program.sources
                if isinstance(program, ModuleProgramSpec)
                else (
                    (program.source,)
                    if isinstance(
                        program,
                        (GitHubReleaseRpmSpec, GnomeShellExtensionSpec),
                    )
                    else ()
                )
            )
        )
        for program, source in references:
            record = catalog.require(source)
            if isinstance(
                program,
                (GitHubReleaseRpmSpec, GnomeShellExtensionSpec),
            ):
                if not isinstance(record.repository, GitHubRepository):
                    raise DotfilesError(
                        f"Spectrum program {program.key!r} requires GitHub source "
                        f"{source!r}, got {record.repository.forge!r}"
                    )
                if record.tracking != "latest-release":
                    raise DotfilesError(
                        f"Spectrum program {program.key!r} requires source "
                        f"{source!r} to track 'latest-release'"
                    )


def load_program_manifest(path: Path | None = None) -> ProgramManifest:
    """Load and strictly validate the Spectrum program manifest."""
    manifest = path or manifest_path("spectrum-programs.toml")
    try:
        with manifest.open("rb") as stream:
            result = ProgramManifest.model_validate(tomllib.load(stream))
    except (OSError, tomllib.TOMLDecodeError, ValidationError) as error:
        raise DotfilesError(
            f"invalid Spectrum program manifest {manifest}: {error}"
        ) from error
    result.validate_source_references()
    return result


@cache
def _manifest() -> ProgramManifest:
    try:
        return load_program_manifest()
    except DotfilesError as error:
        fail(str(error))


def _repository(spec: RepositorySpec) -> RepositoryFile:
    source: Path | str
    if spec.source_path is not None:
        source = spec.source_path
    else:
        source = cast("str", spec.source_url)
    return RepositoryFile(
        destination=spec.destination,
        source=source,
        repo_ids=spec.repo_ids,
        import_rpm_key=spec.import_rpm_key,
    )


def _file_operation(spec: FileOperationSpec) -> FileOperation:
    target = spec.target if isinstance(spec, SymlinkSpec) else None
    return FileOperation(FileOperationKind(spec.kind), spec.path, target)


def _repository_packages(spec: DnfProgramSpec) -> tuple[str, ...] | PackageResolver:
    if not spec.package_variables:
        return spec.repository_packages

    def resolve(context: BuildContext) -> tuple[str, ...]:
        values = {
            variable.name: context.runner.output(list(variable.command))
            for variable in spec.package_variables
        }
        return tuple(
            template.format_map(values) for template in spec.repository_packages
        )

    return PackageResolver(resolve)


def _github_repository(source: str) -> str:
    repository = SOURCES.require(source).repository
    if not isinstance(repository, GitHubRepository):
        raise DotfilesError(f"source {source!r} must identify a GitHub repository")
    return repository.slug


def _program(spec: ConcreteProgramSpec) -> Program:
    if isinstance(spec, ModuleProgramSpec):
        return cast(
            "Program",
            import_module(f"spectrum_build.programs.{spec.module}").PROGRAM,
        )
    if isinstance(spec, GitHubReleaseRpmSpec):
        release = ReleaseRpm(
            spec.name,
            _github_repository(spec.source),
            spec.asset_pattern,
        )
        return DnfProgram(
            name=release.name,
            packages=github_release_rpm(release),
            validation_packages=spec.validation_packages,
        )
    if isinstance(spec, GnomeShellExtensionSpec):
        return CustomProgram(
            name=spec.name,
            installer=partial(
                install_gnome_shell_extension,
                name=spec.name,
                repository=_github_repository(spec.source),
                uuid=spec.uuid,
                asset_pattern=spec.asset_pattern,
                packages=spec.packages,
                required_files=spec.required_files,
                schema_directories=spec.schema_directories,
            ),
            validation_packages=spec.packages,
        )
    return DnfProgram(
        name=spec.name,
        packages=spec.packages,
        repositories=tuple(map(_repository, spec.repositories)),
        repository_packages=_repository_packages(spec),
        generated_repository_files=spec.generated_repository_files,
        enabled_repositories=spec.enabled_repositories,
        system_groups=tuple(
            SystemGroup(group.name, group.gid) for group in spec.system_groups
        ),
        before_install=tuple(map(_file_operation, spec.before_install)),
        after_install=tuple(map(_file_operation, spec.after_install)),
        validation_packages=spec.validation_packages,
        nogpgcheck=spec.nogpgcheck,
    )


@cache
def program_group(name: str) -> tuple[Program, ...]:
    """Load only the program modules needed by one Containerfile cache phase."""
    selected = tuple(spec for spec in _manifest().program if spec.group == name)
    if not selected:
        fail(f"unknown program group: {name}")
    return tuple(map(_program, selected))


def programs() -> Iterator[Program]:
    """Yield the complete manifest in image installation order."""
    group_names = dict.fromkeys(spec.group for spec in _manifest().program)
    for group_name in group_names:
        yield from program_group(group_name)
