from collections.abc import Iterable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pytest
    from cyclopts import App

from workstation.cli import app


def _invoke(
    cli: App, arguments: Iterable[str], capsys: pytest.CaptureFixture[str]
) -> tuple[int, str]:
    try:
        cli(arguments)
    except SystemExit as error:
        exit_code = error.code if isinstance(error.code, int) else 1
    else:
        exit_code = 0
    captured = capsys.readouterr()
    return exit_code, captured.out + captured.err


def _command_paths(cli: App, prefix: tuple[str, ...] = ()) -> list[tuple[str, ...]]:
    paths: list[tuple[str, ...]] = []
    for name, child in cli.resolved_commands().items():
        if name.startswith("-") or child.show is False:
            continue
        path = (*prefix, name)
        paths.append(path)
        paths.extend(_command_paths(child, path))
    return paths


def test_every_grouped_command_renders_help(
    capsys: pytest.CaptureFixture[str],
) -> None:
    for path in _command_paths(app):
        exit_code, output = _invoke(app, [*path, "--help"], capsys)
        assert exit_code == 0, f"{' '.join(path)}: {output}"
