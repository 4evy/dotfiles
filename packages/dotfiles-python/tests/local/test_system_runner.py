import os
from pathlib import Path

import pytest

from workstation.local.system_runner import (
    DEFAULT_RUNNER_PATH,
    UsageError,
    parse_invocation,
)


def test_version_has_no_invocation() -> None:
    assert parse_invocation(["--version"]) is None
    assert parse_invocation(["--env", "EXAMPLE=value", "--version"]) is None


def test_environment_and_command_are_preserved(tmp_path: Path) -> None:
    executable = tmp_path / "example"
    executable.write_text("#!/bin/sh\n")
    executable.chmod(0o755)

    invocation = parse_invocation([
        "--env",
        f"PATH={tmp_path}",
        "--env=EXAMPLE=value",
        "example",
        "one",
    ])

    assert invocation is not None
    assert invocation.program == os.fspath(executable)
    assert invocation.arguments == ("one",)
    assert invocation.environment["PATH"] == os.fspath(tmp_path)
    assert invocation.environment["EXAMPLE"] == "value"


def test_non_executable_path_is_printed_with_cat(tmp_path: Path) -> None:
    source = tmp_path / "value.txt"
    source.write_text("hello")

    invocation = parse_invocation([os.fspath(source)])

    assert invocation is not None
    assert invocation.program == "/bin/cat"
    assert invocation.arguments == (os.fspath(source),)
    assert invocation.environment["PATH"] == DEFAULT_RUNNER_PATH


def test_empty_path_does_not_search_current_directory(tmp_path: Path) -> None:
    executable = tmp_path / "example"
    executable.write_text("#!/bin/sh\n")
    executable.chmod(0o755)

    previous = Path.cwd()
    try:
        os.chdir(tmp_path)
        invocation = parse_invocation(["--env", "PATH=", "example"])
    finally:
        os.chdir(previous)

    assert invocation is not None
    assert invocation.program == "example"


@pytest.mark.parametrize(
    ("arguments", "message"),
    [
        ([], "expected COMMAND"),
        (["--unknown"], "unknown flag"),
        (["--env"], "KEY=VALUE"),
        (["--env", "INVALID"], "KEY=VALUE"),
        (["--env", "=value", "command"], "must not be empty"),
    ],
)
def test_invalid_usage(arguments: list[str], message: str) -> None:
    with pytest.raises(UsageError, match=message):
        parse_invocation(arguments)
