import os
import sys
from pathlib import Path

from workstation.errors import DotfilesError
from workstation.lib.commands import which
from workstation.lib.files import require_executable
from workstation.lib.host import HostRunner


def yaml_language_server_entrypoint() -> None:
    executable = which("bunx")
    if executable is None:
        raise DotfilesError("required command is not available: bunx")
    os.execv(
        executable,
        (
            os.fspath(executable),
            "--bun",
            "-p",
            "yaml-language-server",
            "yaml-language-server",
            *sys.argv[1:],
        ),
    )


def install_yaml_language_server() -> None:
    candidate = Path(sys.argv[0]).resolve().parent / "yaml-language-server"
    source = require_executable(candidate)
    host = HostRunner()
    host.root(("install", "-d", "-m", "0755", "/usr/local/bin"))
    host.root((
        "install",
        "-C",
        "-m",
        "0755",
        "-T",
        source,
        "/usr/local/bin/yaml-language-server",
    ))


def install_entrypoint() -> None:
    try:
        install_yaml_language_server()
    except DotfilesError as error:
        raise SystemExit(f"install-yaml-language-server: {error}") from error
