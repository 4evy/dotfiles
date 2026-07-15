import stat
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Literal

from pydantic import BaseModel, ValidationError

from spectrum_build.core.common import fail, require_readable_file
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.github import latest_github_asset_url
from spectrum_build.integrations.http import download
from spectrum_build.programs.models import CustomProgram
from workstation.lib.files import remove_path

UUID = "copyous@boerdereinar.dev"
REPOSITORY = "boerdereinar/copyous"
DESTINATION = Path("/usr/share/gnome-shell/extensions") / UUID
DEPENDENCIES = ("libgda", "libgda-sqlite", "gsound")


class ExtensionMetadata(BaseModel):
    uuid: Literal["copyous@boerdereinar.dev"]


def _extract_archive(archive: bytes, destination: Path) -> None:
    try:
        with zipfile.ZipFile(BytesIO(archive)) as bundle:
            for member in bundle.infolist():
                path = PurePosixPath(member.filename)
                mode = member.external_attr >> 16
                if path.is_absolute() or ".." in path.parts or stat.S_ISLNK(mode):
                    fail(f"unsafe Copyous release archive member: {member.filename}")
            bundle.extractall(destination)
    except zipfile.BadZipFile as error:
        fail(f"invalid Copyous release archive: {error}")


def _validate_extension(source: Path) -> None:
    metadata_path = source / "metadata.json"
    require_readable_file(metadata_path)
    require_readable_file(source / "extension.js")
    require_readable_file(
        source / "schemas/org.gnome.shell.extensions.copyous.gschema.xml"
    )
    try:
        ExtensionMetadata.model_validate_json(metadata_path.read_bytes())
    except (OSError, ValidationError) as error:
        fail(f"invalid Copyous extension metadata: {error}")


def install(context: BuildContext) -> None:
    context.dnf.install(DEPENDENCIES)
    asset_url = latest_github_asset_url(REPOSITORY, rf"{UUID}\.zip")
    with tempfile.TemporaryDirectory(prefix="spectrum-copyous-") as work_name:
        source = Path(work_name) / UUID
        source.mkdir()
        _extract_archive(download(asset_url), source)
        _validate_extension(source)
        context.runner.run(["glib-compile-schemas", source / "schemas"])
        DESTINATION.parent.mkdir(parents=True, exist_ok=True)
        remove_path(DESTINATION)
        source.copy(DESTINATION, preserve_metadata=True)


PROGRAM = CustomProgram(
    name="Copyous",
    installer=install,
    validation_packages=DEPENDENCIES,
)
