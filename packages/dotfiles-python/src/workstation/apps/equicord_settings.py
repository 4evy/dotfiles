#!/usr/bin/env python3.14
import os
import sys
from pathlib import Path

from workstation.lib.commands import run, which
from workstation.lib.files import is_executable, write_if_changed


def main() -> None:
    home = Path(os.environ["CHEZMOI_HOME_DIR"])
    command = home / ".local/bin/discord-equicord"
    if not command.is_file():
        command = which("discord-equicord") or command
    if is_executable(command):
        run((command, "--repair-only"))

    nix = which("nix")
    if nix is None:
        print("Equicord settings install skipped: nix is not available")
        raise SystemExit(0)

    repository = Path(os.environ["CHEZMOI_WORKING_TREE"])
    result = run(
        (
            nix,
            "build",
            "--no-link",
            "--print-out-paths",
            "path:.#equicord-settings",
        ),
        cwd=repository,
        capture=True,
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
        write_if_changed(settings / name, (package / name).read_bytes())
