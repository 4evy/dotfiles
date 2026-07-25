import sys
from collections.abc import Callable
from functools import Placeholder, partial
from pathlib import Path
from typing import Literal, cast

from cyclopts import App

from spectrum_build.core.common import BuildError, CommandRunner
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.dnf import Dnf
from spectrum_build.settings import BuildConfig

type Command = Literal[
    "check",
    "configure",
    "install-extension-programs",
    "install-ghostty",
    "install-kmscon",
    "install-packaged-programs",
    "validate",
    "write-metadata",
]


def _build_context() -> BuildContext:
    repo_context = Path.cwd() / "spectrum"
    runner = CommandRunner()
    return BuildContext(
        config=BuildConfig.from_environment(
            default_context=repo_context
            if (repo_context / "Containerfile").is_file()
            else Path(__file__).resolve().parents[2]
        ),
        runner=runner,
        dnf=Dnf(runner),
    )


def _check() -> None:
    # Import command-specific modules lazily. The Containerfile's narrow
    # program-source stages intentionally omit image-only modules, so
    # changes to metadata or shell policy cannot invalidate program layers.
    from spectrum_build.manifests.packages import (  # ruff: ignore[import-outside-top-level]
        validate_package_manifest,
    )
    from spectrum_build.programs.operations import (  # ruff: ignore[import-outside-top-level]
        validate_program_manifest,
    )

    validate_package_manifest()
    validate_program_manifest()


def _install_program_group(context: BuildContext, group: str) -> None:
    from spectrum_build.programs.operations import (  # ruff: ignore[import-outside-top-level]
        install_program_group,
    )

    install_program_group(context, group)


def _configure(_context: BuildContext) -> None:
    from spectrum_build.image.shell import (  # ruff: ignore[import-outside-top-level]
        align_shell_defaults,
    )

    align_shell_defaults()


def _write_metadata(context: BuildContext) -> None:
    from spectrum_build.image.metadata import (  # ruff: ignore[import-outside-top-level]
        write_image_metadata,
    )

    write_image_metadata(context.config.image)


def _validate(context: BuildContext) -> None:
    from spectrum_build.image.metadata import (  # ruff: ignore[import-outside-top-level]
        validate_image,
    )

    validate_image(context.config.image.name, context.runner)


def _program_group_handler(group: str) -> Callable[[BuildContext], None]:
    """Bind a group after the context slot using Python 3.14's Placeholder."""
    handler = partial(
        _install_program_group,
        cast("BuildContext", Placeholder),
        group,
    )
    return cast("Callable[[BuildContext], None]", handler)


_CONTEXT_HANDLERS: dict[str, Callable[[BuildContext], None]] = {
    "configure": _configure,
    "install-extension-programs": _program_group_handler("extension"),
    "install-ghostty": _program_group_handler("ghostty"),
    "install-kmscon": _program_group_handler("kmscon"),
    "install-packaged-programs": _program_group_handler("packaged"),
    "validate": _validate,
    "write-metadata": _write_metadata,
}


def main(
    command: Command,
) -> int:
    """Run one Containerfile-owned Spectrum image assembly phase.

    Parameters
    ----------
    command
        Operation to run.

    """
    if command == "check":
        _check()
        return 0

    _CONTEXT_HANDLERS[command](_build_context())
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


if __name__ == "__main__":
    entrypoint()
