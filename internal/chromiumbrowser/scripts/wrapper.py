#!/usr/bin/env python3
from __future__ import annotations

import os
import shlex
import sys
from pathlib import Path

COMMAND: list[str] = __COMMAND_JSON__  # noqa: F821  # ty: ignore[unresolved-reference]

for variable in (
    "DESKTOP_STARTUP_ID",
    "STARTUP_NOTIFICATION_ID",
    "XDG_ACTIVATION_TOKEN",
    "FONTCONFIG_SYSROOT",
):
    os.environ.pop(variable, None)
os.environ.setdefault("FONTCONFIG_FILE", "/etc/fonts/fonts.conf")
os.environ.setdefault("FONTCONFIG_PATH", "/etc/fonts")
data_dirs = os.environ.get("XDG_DATA_DIRS", "").split(":")
if "/usr/share" not in data_dirs and "/usr/share/" not in data_dirs:
    os.environ["XDG_DATA_DIRS"] = ":".join(
        value
        for value in (os.environ.get("XDG_DATA_DIRS"), "/usr/local/share", "/usr/share")
        if value
    )

flags: list[str] = []
config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
flags_file = config_home / "helium-flags.conf"
if flags_file.is_file():
    for line in flags_file.read_text().splitlines():
        value = line.strip()
        if value and not value.startswith("#"):
            flags.extend(shlex.split(value))

os.execvpe(COMMAND[0], (*COMMAND, *flags, *sys.argv[1:]), os.environ)
