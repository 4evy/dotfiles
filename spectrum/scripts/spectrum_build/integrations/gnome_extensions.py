"""Generic installation support for GitHub-released GNOME Shell extensions."""

import json
import stat
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path, PurePosixPath

from spectrum_build.core.common import fail, require_readable_file
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.github import latest_github_asset_url
from spectrum_build.integrations.http import download
from workstation.lib.files import remove_path

EXTENSION_ROOT = Path("/usr/share/gnome-shell/extensions")


def extract_extension_archive(
    archive: bytes,
    destination: Path,
    *,
    label: str,
) -> None:
    """Safely extract one ZIP release without links or path traversal."""
    try:
        with zipfile.ZipFile(BytesIO(archive)) as bundle:
            for member in bundle.infolist():
                path = PurePosixPath(member.filename)
                mode = member.external_attr >> 16
                if path.is_absolute() or ".." in path.parts or stat.S_ISLNK(mode):
                    fail(f"unsafe {label} release archive member: {member.filename}")
            bundle.extractall(destination)
    except zipfile.BadZipFile as error:
        fail(f"invalid {label} release archive: {error}")


def validate_extension(
    source: Path,
    *,
    uuid: str,
    required_files: tuple[Path, ...],
) -> None:
    """Validate extension identity and its manifest-declared file contract."""
    metadata_path = source / "metadata.json"
    require_readable_file(metadata_path)
    try:
        metadata = json.loads(metadata_path.read_bytes())
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid GNOME extension metadata: {error}")
    if not isinstance(metadata, dict) or metadata.get("uuid") != uuid:
        fail(f"GNOME extension metadata UUID does not match {uuid}")
    for relative_path in required_files:
        require_readable_file(source / relative_path)


def install_gnome_shell_extension(
    context: BuildContext,
    *,
    name: str,
    repository: str,
    uuid: str,
    asset_pattern: str,
    packages: tuple[str, ...],
    required_files: tuple[Path, ...],
    schema_directories: tuple[Path, ...],
) -> None:
    """Install one manifest-defined extension from its latest GitHub release."""
    context.dnf.install(packages)
    asset_url = latest_github_asset_url(repository, asset_pattern)
    with tempfile.TemporaryDirectory(prefix="spectrum-extension-") as work_name:
        source = Path(work_name) / uuid
        source.mkdir()
        extract_extension_archive(download(asset_url), source, label=name)
        validate_extension(source, uuid=uuid, required_files=required_files)
        for schema_directory in schema_directories:
            context.runner.run(["glib-compile-schemas", source / schema_directory])
        destination = EXTENSION_ROOT / uuid
        destination.parent.mkdir(parents=True, exist_ok=True)
        remove_path(destination)
        source.copy(destination, preserve_metadata=True)
