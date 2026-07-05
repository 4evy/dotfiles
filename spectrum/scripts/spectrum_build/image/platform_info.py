from __future__ import annotations

import platform
import re
from pathlib import Path

from spectrum_build.core.common import atomic_write, fail


OS_RELEASE = Path("/usr/lib/os-release")


def read_os_release() -> dict[str, str]:
    try:
        return platform.freedesktop_os_release()
    except OSError as error:
        fail(f"failed to read {OS_RELEASE}: {error}")


def fedora_version_id() -> str:
    if version_id := read_os_release().get("VERSION_ID"):
        return version_id
    fail(f"VERSION_ID is required in {OS_RELEASE}")


def fedora_arch() -> str | None:
    return {"x86_64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(
        platform.machine()
    )


def aitoolkit_repo_url(version_id: str) -> str:
    return (
        f"https://copr.fedorainfracloud.org/coprs/iolaum/aitoolkit/repo/fedora-{version_id}/"
        f"iolaum-aitoolkit-fedora-{version_id}.repo"
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

    atomic_write(OS_RELEASE, ("\n".join(lines) + "\n").encode())
