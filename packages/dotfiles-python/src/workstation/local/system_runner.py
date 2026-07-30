import os
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from cyclopts import App, Parameter
from cyclopts.exceptions import CycloptsError, MissingArgumentError

from workstation.errors import UsageError
from workstation.lib.commands import exec_process, which
from workstation.lib.files import is_executable

DEFAULT_RUNNER_PATH = ":".join((
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
    "/usr/local/sbin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/home/linuxbrew/.linuxbrew/sbin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/run/wrappers/bin",
    "/run/current-system/sw/bin",
    "/nix/var/nix/profiles/default/bin",
    "/etc/profiles/per-user/root/bin",
))


@dataclass(frozen=True, slots=True)
class Invocation:
    environment: dict[str, str]
    program: str
    arguments: tuple[str, ...]


def _parse_environment(value: str) -> tuple[str, str]:
    if "=" not in value:
        raise UsageError("--env requires KEY=VALUE")
    key, setting = value.split("=", 1)
    if not key:
        raise UsageError("--env variable name must not be empty")
    if "=" in key or "\0" in key:
        raise UsageError(f"invalid environment variable name: {key!r}")
    return key, setting


def _runner_arguments(
    command: str | None = None,
    *arguments: Annotated[str, Parameter(allow_leading_hyphen=True)],
    version: Annotated[bool, Parameter(negative="")] = False,
    env: Annotated[
        list[str] | None,
        Parameter(negative_iterable="", negative_none=""),
    ] = None,
) -> tuple[bool, dict[str, str], list[str]]:
    argv = [command, *arguments] if command is not None else []
    return version, dict(map(_parse_environment, env or [])), argv


_parser = App(
    default_command=_runner_arguments,
    exit_on_error=False,
    help_flags=[],
    print_error=False,
    version_flags=[],
    result_action="return_value",
)


def _parse_arguments(argv: Sequence[str]) -> tuple[bool, dict[str, str], list[str]]:
    try:
        command, bound, _ = _parser.parse_args(argv)
    except MissingArgumentError as error:
        if error.keyword == "--env":
            raise UsageError("--env requires KEY=VALUE") from error
        raise UsageError(str(error)) from error
    except CycloptsError as error:
        message = str(error)
        if message.startswith("Unknown option:"):
            message = message.replace("Unknown option:", "unknown flag:", 1)
        raise UsageError(message) from error
    return command(*bound.args, **bound.kwargs)


def parse_invocation(argv: Sequence[str]) -> Invocation | None:
    version, overrides, command = _parse_arguments(argv)
    if version:
        return None
    if not command:
        raise UsageError("expected COMMAND [ARG...]")

    path_value = overrides.get("PATH", DEFAULT_RUNNER_PATH)
    program, *arguments = command
    if "/" in program:
        candidate = Path(program)
        if candidate.info.is_file() and not is_executable(candidate):
            arguments.insert(0, program)
            program = "/bin/cat"
    else:
        resolved = which(program, path=path_value)
        if resolved is not None:
            program = os.fspath(resolved)

    environment = dict(os.environ)
    environment.update(overrides)
    environment["PATH"] = path_value
    return Invocation(environment, program, tuple(arguments))


def main(argv: Sequence[str] | None = None) -> int:
    arguments = tuple(sys.argv[1:] if argv is None else argv)
    try:
        invocation = parse_invocation(arguments)
    except UsageError as error:
        print(f"system-runner: {error}", file=sys.stderr)
        return 2
    if invocation is None:
        print("system-runner version dev")
        return 0
    exec_process(
        invocation.program,
        invocation.arguments,
        invocation.environment,
    )
    return 127


def entrypoint() -> None:
    try:
        raise SystemExit(main())
    except OSError as error:
        raise SystemExit(f"system-runner: {error}") from error


if __name__ == "__main__":
    entrypoint()
