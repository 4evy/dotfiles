import platform
import re
from pathlib import Path

from spectrum_build.core.common import fail
from workstation.lib.files import write_if_changed

OS_RELEASE = Path("/usr/lib/os-release")


def read_os_release() -> dict[str, str]:
    try:
        return platform.freedesktop_os_release()
    except OSError as error:
        fail(f"failed to read {OS_RELEASE}: {error}")


def fedora_arch() -> str | None:
    return {"x86_64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(
        platform.machine()
    )


def set_os_release_value(key: str, value: str) -> None:
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
        fail(f"invalid os-release key: {key}")

    lines = OS_RELEASE.read_text(encoding="utf-8").splitlines()
    quoted_value = '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    replacement = f"{key}={quoted_value}"

    for index, line in enumerate(lines):
        if line.startswith(f"{key}="):
            lines[index] = replacement
            break
    else:
        lines.append(replacement)

    write_if_changed(OS_RELEASE, ("\n".join(lines) + "\n").encode())
