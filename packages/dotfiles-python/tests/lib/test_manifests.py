import json
import tomllib
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from spectrum_build.programs.manifest import load_program_manifest
from workstation.errors import DotfilesError
from workstation.lib.manifest_schema import MANIFEST_SCHEMAS, validate_manifests
from workstation.lib.manifests import listed_files, manifest_path
from workstation.lib.sources import SourceCatalog, load_sources


def test_shared_manifests_resolve_from_checkout() -> None:
    assert manifest_path("sources.json").is_file()
    assert manifest_path("spectrum-programs.toml").is_file()
    assert manifest_path("sources.schema.json").is_file()
    assert manifest_path("spectrum-programs.schema.json").is_file()


def test_manifest_instances_and_generated_schemas_are_current() -> None:
    validate_manifests()
    assert all(
        schema.path.read_text(encoding="utf-8") == schema.content()
        for schema in MANIFEST_SCHEMAS
    )


def test_format_versions_are_local_and_schema_dialect_is_explicit() -> None:
    sources = json.loads(manifest_path("sources.json").read_text(encoding="utf-8"))
    programs = tomllib.loads(
        manifest_path("spectrum-programs.toml").read_text(encoding="utf-8")
    )

    assert sources["format_version"] == 2
    assert programs["format_version"] == 1
    assert "schema_version" not in sources
    assert "schema_version" not in programs
    assert sources["$schema"] == "./sources.schema.json"
    assert programs["$schema"] == "./spectrum-programs.schema.json"

    for schema in MANIFEST_SCHEMAS:
        document = json.loads(schema.path.read_text(encoding="utf-8"))
        assert document["$schema"] == ("https://json-schema.org/draft/2020-12/schema")
        assert "dotfiles-local data contract revision" in document["$comment"]


def test_program_schema_completes_shared_source_references() -> None:
    source_keys = set(load_sources().sources)
    release_source_keys = {"copyous", "rustdesk", "sops"}
    schema = json.loads(
        manifest_path("spectrum-programs.schema.json").read_text(encoding="utf-8")
    )

    assert (
        set(schema["$defs"]["GitHubReleaseRpmSpec"]["properties"]["source"]["enum"])
        == release_source_keys
    )
    assert (
        set(schema["$defs"]["GnomeShellExtensionSpec"]["properties"]["source"]["enum"])
        == release_source_keys
    )
    assert (
        set(
            schema["$defs"]["ModuleProgramSpec"]["properties"]["sources"]["items"][
                "enum"
            ]
        )
        == source_keys
    )


def test_program_schema_independently_rejects_unknown_source_reference() -> None:
    release_source_keys = {"copyous", "rustdesk", "sops"}
    instance = tomllib.loads(
        manifest_path("spectrum-programs.toml").read_text(encoding="utf-8")
    )
    schema = json.loads(
        manifest_path("spectrum-programs.schema.json").read_text(encoding="utf-8")
    )
    release_program = next(
        program for program in instance["program"] if program.get("source") == "sops"
    )
    release_program["source"] = "missing"

    errors = list(Draft202012Validator(schema).iter_errors(instance))

    def nested(error: ValidationError) -> list[ValidationError]:
        return [error, *(child for item in error.context for child in nested(item))]

    assert any(
        error.validator == "enum"
        and error.instance == "missing"
        and set(error.validator_value) == release_source_keys
        for root_error in errors
        for error in nested(root_error)
    )


def test_program_manifest_rejects_unknown_source_reference(tmp_path: Path) -> None:
    content = manifest_path("spectrum-programs.toml").read_text(encoding="utf-8")
    path = tmp_path / "spectrum-programs.toml"
    path.write_text(content.replace('source = "sops"', 'source = "missing"', 1))

    with pytest.raises(DotfilesError, match="no entry named 'missing'"):
        load_program_manifest(path)


def test_program_manifest_rejects_incompatible_source_policy(tmp_path: Path) -> None:
    content = manifest_path("spectrum-programs.toml").read_text(encoding="utf-8")
    path = tmp_path / "spectrum-programs.toml"
    path.write_text(content.replace('source = "sops"', 'source = "helix"', 1))

    with pytest.raises(DotfilesError, match="track 'latest-release'"):
        load_program_manifest(path)


def test_source_schema_is_generic_and_independently_enforced() -> None:
    instance = json.loads(manifest_path("sources.json").read_text(encoding="utf-8"))
    schema = json.loads(
        manifest_path("sources.schema.json").read_text(encoding="utf-8")
    )
    schema_text = json.dumps(schema)

    assert not any(
        f'"{product_name}"' in schema_text for product_name in instance["sources"]
    )
    Draft202012Validator(schema).validate(instance)

    instance["sources"]["ghostty"]["repository"]["unexpected"] = True
    with pytest.raises(ValidationError, match="not valid"):
        Draft202012Validator(schema).validate(instance)


def test_source_schema_requires_explicit_rolling_policy() -> None:
    instance = json.loads(manifest_path("sources.json").read_text(encoding="utf-8"))
    schema = json.loads(
        manifest_path("sources.schema.json").read_text(encoding="utf-8")
    )
    del instance["sources"]["copyous"]["tracking"]

    with pytest.raises(ValidationError, match="not valid"):
        Draft202012Validator(schema).validate(instance)


def test_source_manifest_is_strict_and_retains_every_pin(tmp_path: Path) -> None:
    manifest = SourceCatalog.model_validate_json(
        manifest_path("sources.json").read_bytes()
    )
    content = manifest.model_dump(mode="json", by_alias=True)
    content["unexpected"] = True
    path = tmp_path / "sources.json"
    path.write_text(json.dumps(content))

    with pytest.raises(DotfilesError, match="unexpected"):
        load_sources(path)

    assert manifest.require("tomlc17").require_version()


def test_listed_files_preserve_order_and_require_complete_inventory(
    tmp_path: Path,
) -> None:
    first = tmp_path / "first.patch"
    second = tmp_path / "second.patch"
    first.touch()
    second.touch()
    (tmp_path / "series").write_text("second.patch\nfirst.patch\n")

    assert listed_files(tmp_path, "series", suffix=".patch") == (second, first)

    (tmp_path / "unlisted.patch").touch()
    with pytest.raises(DotfilesError, match="files missing from"):
        listed_files(tmp_path, "series", suffix=".patch")


@pytest.mark.parametrize("entry", ["../outside.patch", "not-a-patch.txt"])
def test_listed_files_reject_unsafe_or_wrongly_typed_entries(
    tmp_path: Path,
    entry: str,
) -> None:
    (tmp_path / "series").write_text(f"{entry}\n")

    with pytest.raises(DotfilesError, match="invalid entry"):
        listed_files(tmp_path, "series", suffix=".patch")
