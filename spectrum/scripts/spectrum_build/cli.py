import sys
from pathlib import Path
from typing import Literal

from cyclopts import App

from spectrum_build.core.common import BuildError, CommandRunner
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.dnf import Dnf
from spectrum_build.manifests.packages import validate_package_groups
from spectrum_build.plan import BUILD_STEPS
from spectrum_build.programs.operations import validate_program_manifest
from spectrum_build.settings import BuildConfig


def main(
    command: Literal["build", "check"] = "build",
) -> int:
    """Build or statically check the Spectrum bootc image layer.

    Parameters
    ----------
    command
        Operation to run.

    """
    if command == "check":
        validate_package_groups()
        validate_program_manifest()
        return 0

    repo_context = Path.cwd() / "spectrum"
    runner = CommandRunner()
    context = BuildContext(
        config=BuildConfig.from_environment(
            default_context=repo_context
            if (repo_context / "Containerfile").is_file()
            else Path(__file__).resolve().parents[2]
        ),
        runner=runner,
        dnf=Dnf(runner),
    )
    for step in BUILD_STEPS:
        step.run(context)

    return 0


app = App(
    default_command=main,
    version_flags=[],
    result_action="return_int_as_exit_code_else_zero",
)


def entrypoint() -> None:
    try:
        app()
    except BuildError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
