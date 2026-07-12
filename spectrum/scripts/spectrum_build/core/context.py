from dataclasses import dataclass

from spectrum_build.core.common import CommandRunner
from spectrum_build.integrations.dnf import Dnf
from spectrum_build.settings import BuildConfig


@dataclass(frozen=True, slots=True)
class BuildContext:
    config: BuildConfig
    runner: CommandRunner
    dnf: Dnf
