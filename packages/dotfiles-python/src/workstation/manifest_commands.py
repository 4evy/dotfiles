"""Commands for validating shared manifests and maintaining their schemas."""

from cyclopts import App

from workstation.console import console
from workstation.lib.manifest_schema import (
    MANIFEST_SCHEMAS,
    update_manifest_schemas,
    validate_manifests,
)

app = App(
    help="Validate shared manifests and maintain their generated schemas.",
    version_flags=[],
    result_action="return_none",
)


@app.command
def check() -> None:
    """Validate manifest data and ensure generated schemas are current."""
    validate_manifests()
    console.print(f"Validated {len(MANIFEST_SCHEMAS)} manifests and schemas.")


@app.command(name="update-schemas")
def update_schemas() -> None:
    """Regenerate the checked-in JSON Schema documents."""
    changed = update_manifest_schemas()
    if changed:
        for path in changed:
            console.print(f"Updated {path}")
    else:
        console.print("Manifest schemas are already current.")
