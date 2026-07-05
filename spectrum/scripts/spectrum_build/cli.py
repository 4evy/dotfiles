from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from spectrum_build.core.common import BuildError, CommandRunner
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.dnf import Dnf
from spectrum_build.settings import BuildConfig
from spectrum_build.manifests.packages import validate_package_groups
from spectrum_build.plan import BUILD_STEPS


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the Spectrum bootc image layer."
    )
    parser.add_argument(
        "command",
        nargs="?",
        choices=("build", "check"),
        default="build",
        help="operation to run",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)

    if args.command == "check":
        validate_package_groups()
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


def entrypoint() -> None:
    try:
        raise SystemExit(main())
    except BuildError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
