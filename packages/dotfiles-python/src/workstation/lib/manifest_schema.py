"""Generate and verify editor schemas from the runtime manifest models."""

from __future__ import annotations

import json
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError

from spectrum_build.programs.manifest import (
    ProgramManifest,
    load_program_manifest,
)
from workstation.errors import DotfilesError
from workstation.lib.files import write_if_changed
from workstation.lib.manifests import manifest_path, manifests_root
from workstation.lib.sources import GitHubRepository, SourceCatalog, load_sources

if TYPE_CHECKING:
    from pydantic import BaseModel

SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"
SCHEMA_BASE_URL = "https://raw.githubusercontent.com/4evy/dotfiles/main/manifests"
LOCAL_FORMAT_COMMENT = (
    "The instance's format_version is a dotfiles-local data contract revision. "
    "The schema's $schema URI independently selects the JSON Schema dialect."
)


def _expand_source_key_enums(value: object, catalog: SourceCatalog) -> None:
    """Turn generic source-reference markers into editor completion enums."""
    if isinstance(value, dict):
        mapping = cast("dict[str, Any]", value)
        source_filter = mapping.pop("x-dotfiles-source-filter", None)
        if source_filter == "any":
            mapping["enum"] = sorted(catalog.sources)
        elif source_filter == "github-latest-release":
            mapping["enum"] = sorted(
                name
                for name, record in catalog.sources.items()
                if isinstance(record.repository, GitHubRepository)
                and record.tracking == "latest-release"
            )
        for child in mapping.values():
            _expand_source_key_enums(child, catalog)
    elif isinstance(value, list):
        for child in value:
            _expand_source_key_enums(child, catalog)


@dataclass(frozen=True, slots=True)
class ManifestSchema:
    filename: str
    model: type[BaseModel]

    @property
    def path(self) -> Path:
        return manifests_root() / self.filename

    @property
    def identifier(self) -> str:
        return f"{SCHEMA_BASE_URL}/{self.filename}"

    def content(self) -> str:
        generated: dict[str, Any] = self.model.model_json_schema(by_alias=True)
        _expand_source_key_enums(generated, load_sources())
        document = {
            "$schema": SCHEMA_DIALECT,
            "$id": self.identifier,
            "$comment": LOCAL_FORMAT_COMMENT,
            **generated,
        }
        return json.dumps(document, indent=2, sort_keys=True) + "\n"


MANIFEST_SCHEMAS = (
    ManifestSchema("sources.schema.json", SourceCatalog),
    ManifestSchema("spectrum-programs.schema.json", ProgramManifest),
)


def update_manifest_schemas() -> tuple[Path, ...]:
    """Write generated schema files and return the paths that changed."""
    return tuple(
        schema.path
        for schema in MANIFEST_SCHEMAS
        if write_if_changed(schema.path, schema.content())
    )


def _validate_schema_instance(
    instance_path: Path,
    instance: object,
    schema: ManifestSchema,
) -> None:
    schema_document = json.loads(schema.content())
    try:
        Draft202012Validator.check_schema(schema_document)
    except SchemaError as error:
        raise DotfilesError(
            f"invalid generated JSON Schema {schema.path}: {error.message}"
        ) from error
    errors = sorted(
        Draft202012Validator(
            schema_document,
            format_checker=FormatChecker(),
        ).iter_errors(instance),
        key=lambda error: tuple(map(str, error.absolute_path)),
    )
    if not errors:
        return
    details = "; ".join(
        f"{'/'.join(map(str, error.absolute_path)) or '<root>'}: {error.message}"
        for error in errors[:10]
    )
    if len(errors) > 10:
        details += f"; and {len(errors) - 10} more"
    raise DotfilesError(f"JSON Schema validation failed for {instance_path}: {details}")


def validate_manifests() -> None:
    """Validate both manifest instances and their checked-in generated schemas."""
    source_manifest = manifest_path("sources.json")
    load_sources(source_manifest)
    program_manifest = manifest_path("spectrum-programs.toml")
    load_program_manifest(program_manifest)
    directive = "#:schema ./spectrum-programs.schema.json"
    if not program_manifest.read_text(encoding="utf-8").startswith(f"{directive}\n"):
        raise DotfilesError(
            f"{program_manifest} must start with the portable schema directive "
            f"{directive!r}"
        )
    stale = tuple(
        schema.path
        for schema in MANIFEST_SCHEMAS
        if not schema.path.is_file()
        or schema.path.read_text(encoding="utf-8") != schema.content()
    )
    if stale:
        paths = ", ".join(str(path) for path in stale)
        raise DotfilesError(
            f"manifest schemas are missing or stale: {paths}; "
            "run `dotfiles-scripts manifests update-schemas`"
        )
    instances = (
        (
            source_manifest,
            json.loads(source_manifest.read_text(encoding="utf-8")),
            MANIFEST_SCHEMAS[0],
        ),
        (
            program_manifest,
            tomllib.loads(program_manifest.read_text(encoding="utf-8")),
            MANIFEST_SCHEMAS[1],
        ),
    )
    for instance_path, instance, schema in instances:
        _validate_schema_instance(instance_path, instance, schema)
