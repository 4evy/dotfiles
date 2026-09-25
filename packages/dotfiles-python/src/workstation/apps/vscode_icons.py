import hashlib
import json
import re
import shutil
import subprocess
import zipfile
from functools import partial
from pathlib import Path
from tempfile import TemporaryDirectory

from workstation.lib.theme import palettes

UPSTREAM_ID = "catppuccin.catppuccin-vsc-icons"
CUSTOM_ID = "t3-chat-catppuccin-icons"
CUSTOM_NAME = "t3-chat-catppuccin-icons"
CUSTOM_PUBLISHER = "evy"
CUSTOM_EXTENSION_ID = f"{CUSTOM_PUBLISHER}.{CUSTOM_NAME}"
LIGHT_PREFIX = "__t3_chat_light__"
PALETTE_VARIABLE = re.compile(r"var\(--vscode-ctp-([a-z0-9-]+)\)")

T3_CHAT = palettes()

type Association = str | dict[str, str]


def prefix_references(value: Association) -> Association:
    return (
        f"{LIGHT_PREFIX}{value}"
        if isinstance(value, str)
        else {key: f"{LIGHT_PREFIX}{item}" for key, item in value.items()}
    )


def build_theme(upstream: Path) -> dict[str, object]:
    theme = json.loads((upstream / "dist/mocha/theme.json").read_text())
    definitions = theme.pop("iconDefinitions")
    theme["light"] = {
        key: prefix_references(value)
        for key, value in theme.items()
        if key != "hidesExplorerArrows"
    }
    theme["iconDefinitions"] = {
        f"{prefix}{name}": definition
        | {
            "iconPath": definition["iconPath"].replace(
                "./icons/", f"./icons/{variant}/", 1
            )
        }
        for variant, prefix in (("dark", ""), ("light", LIGHT_PREFIX))
        for name, definition in definitions.items()
    }
    return theme


def copy_icon(source: str, destination: str, *, palette: dict[str, str]) -> Path:
    source_path, destination_path = map(Path, (source, destination))
    svg = source_path.read_text(encoding="utf-8")
    destination_path.write_text(
        PALETTE_VARIABLE.sub(lambda match: palette[match[1]], svg), encoding="utf-8"
    )
    return destination_path


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def content_version(extension: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(extension.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(extension).as_posix().encode())
            with path.open("rb") as source:
                hashlib.file_digest(source, lambda: digest)
    return f"1.0.{int.from_bytes(digest.digest()[:4], byteorder='big')}"


def build_vsix(extension: Path, destination: Path, *, version: str) -> None:
    content_types = """\
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
"""
    manifest = f"""\
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0"
  xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="{CUSTOM_NAME}" Version="{version}"
      Publisher="{CUSTOM_PUBLISHER}" Language="en-US" />
    <DisplayName>T3 Chat — Catppuccin Icons</DisplayName>
    <Description xml:space="preserve">
      Catppuccin file icon shapes using the T3 Chat palette.
    </Description>
    <Categories>Themes</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.83.0" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing"
        Value="Free" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest"
      Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"""
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("extension.vsixmanifest", manifest)
        for path in extension.rglob("*"):
            if path.is_file():
                archive.write(path, Path("extension") / path.relative_to(extension))


def main() -> None:
    code = shutil.which("code")
    if code is None:
        return
    located = subprocess.check_output(
        (code, "--locate-extension", UPSTREAM_ID), text=True
    ).strip()
    if not located:
        return

    upstream = Path(located)
    # Catppuccin only recompiles its generated color themes on first activation
    # or a live settings change. Chezmoi can update the palette while Code is
    # closed, so invalidate its activation sentinel for the next launch.
    (upstream / "themes/.flag").unlink(missing_ok=True)
    with TemporaryDirectory(
        prefix=f".{CUSTOM_EXTENSION_ID}-",
        dir=upstream.parent,
    ) as temporary_name:
        temporary = Path(temporary_name)
        extension = temporary / "extension"
        extension.mkdir()
        write_json(extension / "theme.json", build_theme(upstream))

        unflavored = upstream / "dist/unflavored"
        for variant in ("dark", "light"):
            shutil.copytree(
                unflavored,
                extension / "icons" / variant,
                copy_function=partial(copy_icon, palette=T3_CHAT[variant]),
            )

        version = content_version(extension)
        write_json(
            extension / "package.json",
            {
                "name": CUSTOM_NAME,
                "displayName": "T3 Chat — Catppuccin Icons",
                "description": (
                    "Catppuccin file icon shapes using the T3 Chat palette."
                ),
                "version": version,
                "publisher": CUSTOM_PUBLISHER,
                "engines": {"vscode": "^1.83.0"},
                "categories": ["Themes"],
                "contributes": {
                    "iconThemes": [
                        {
                            "id": CUSTOM_ID,
                            "label": "T3 Chat — Catppuccin Icons",
                            "path": "./theme.json",
                        }
                    ]
                },
            },
        )
        vsix = temporary / f"{CUSTOM_EXTENSION_ID}-{version}.vsix"
        build_vsix(extension, vsix, version=version)
        subprocess.run((code, "--install-extension", vsix, "--force"), check=True)


if __name__ == "__main__":
    main()
