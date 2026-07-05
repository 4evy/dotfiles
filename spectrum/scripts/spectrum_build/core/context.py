from __future__ import annotations

from dataclasses import dataclass

from spectrum_build.core.common import CommandRunner
from spectrum_build.settings import BuildConfig
from spectrum_build.integrations.dnf import Dnf


@dataclass(frozen=True)
class BuildContext:
    config: BuildConfig
    runner: CommandRunner
    dnf: Dnf
