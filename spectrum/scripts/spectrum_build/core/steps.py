from collections.abc import Callable
from dataclasses import dataclass

from spectrum_build.core.context import BuildContext

type StepAction = Callable[[BuildContext], None]


@dataclass(frozen=True, slots=True)
class BuildStep:
    name: str
    run: StepAction
