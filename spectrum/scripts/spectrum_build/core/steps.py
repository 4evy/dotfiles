from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from spectrum_build.core.context import BuildContext


StepAction = Callable[[BuildContext], None]


@dataclass(frozen=True)
class BuildStep:
    name: str
    run: StepAction
