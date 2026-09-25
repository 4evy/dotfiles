import os
import shutil
import subprocess
import sys
from filecmp import cmp
from pathlib import Path


def main() -> None:
    home = Path(os.environ["CHEZMOI_HOME_DIR"])
    command = home / ".local/bin/discord-equicord"
    if not command.is_file():
        command = Path(shutil.which("discord-equicord") or command)
    if command.is_file() and os.access(command, os.X_OK):
        subprocess.run((command, "--repair-only"), check=True)

    nix = shutil.which("nix")
    if nix is None:
        print("Equicord settings install skipped: nix is not available")
        raise SystemExit(0)

    repository = Path(os.environ["CHEZMOI_WORKING_TREE"])
    result = subprocess.run(
        (
            nix,
            "build",
            "--no-link",
            "--print-out-paths",
            "path:.#equicord-settings",
        ),
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    )
    outputs = result.stdout.splitlines()
    if len(outputs) != 1:
        raise SystemExit(
            f"Equicord settings install failed: expected one Nix output, got {outputs!r}"
        )

    package = Path(outputs[0])
    settings = home / (
        "Library/Application Support/Equicord/settings"
        if sys.platform == "darwin"
        else ".config/Equicord/settings"
    )
    settings.mkdir(parents=True, exist_ok=True)
    for name in ("settings.json", "quickCss.css"):
        source = package / name
        destination = settings / name
        if not destination.is_file() or not cmp(source, destination, shallow=False):
            source.copy(destination)
        destination.chmod(0o644)
