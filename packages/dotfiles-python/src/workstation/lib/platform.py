"""Typed platform metadata shared by application installers."""

import platform
from dataclasses import dataclass
from typing import Literal

from workstation.errors import DotfilesError

type ArchitectureName = Literal["arm64", "x86_64"]
type FedoraArchitecture = Literal["aarch64", "x86_64"]
type ZigLinuxArchitecture = Literal["aarch64-linux", "x86_64-linux"]


@dataclass(frozen=True, slots=True)
class MachineArchitecture:
    """Canonical names used by the installers for one machine architecture."""

    name: ArchitectureName
    aliases: frozenset[str]
    fedora: FedoraArchitecture
    zig_linux: ZigLinuxArchitecture


MACHINE_ARCHITECTURES = (
    MachineArchitecture(
        name="arm64",
        aliases=frozenset({"aarch64", "arm64"}),
        fedora="aarch64",
        zig_linux="aarch64-linux",
    ),
    MachineArchitecture(
        name="x86_64",
        aliases=frozenset({"amd64", "x86_64"}),
        fedora="x86_64",
        zig_linux="x86_64-linux",
    ),
)


def machine_architecture() -> MachineArchitecture:
    """Resolve the current machine to a supported canonical architecture."""
    machine = platform.machine().lower()
    architecture = next(
        (
            candidate
            for candidate in MACHINE_ARCHITECTURES
            if machine in candidate.aliases
        ),
        None,
    )
    if architecture is None:
        raise DotfilesError(f"unsupported machine architecture: {machine}")
    return architecture
