#!/usr/bin/env python3.14
"""Validate chezmoi's rendered target state without applying it."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import tomllib
from collections.abc import Callable
from fnmatch import fnmatchcase
from functools import partial
from pathlib import Path

from defusedxml.ElementTree import fromstring

REPOSITORY = Path(__file__).resolve().parents[2]
PLATFORMS = {
    "darwin": {"os": "darwin", "arch": "arm64", "osRelease": {}},
    "fedora": {"os": "linux", "arch": "amd64", "osRelease": {"id": "fedora"}},
    "nixos": {"os": "linux", "arch": "amd64", "osRelease": {"id": "nixos"}},
    "windows": {"os": "windows", "arch": "amd64", "osRelease": {}},
}
CONTENT_PARSERS: dict[str, Callable[[str], object]] = {
    ".json": json.loads,
    ".toml": tomllib.loads,
    ".plist": fromstring,
    ".xml": fromstring,
    ".tmTheme": fromstring,
}
BASH_SYNTAX = ("bash", "-n")
ZSH_SYNTAX = ("zsh", "-n")
SHELLCHECK = ("shellcheck", "-x", "--shell=bash")
# First matching rule wins; paths have the .tmpl suffix removed
FILE_CHECKS = (
    (("*.rb",), (("ruby", "-c"),)),
    (("*/dot_zsh*", "*.zsh"), (ZSH_SYNTAX,)),
    # Upstream completions need syntax checks without repository ShellCheck policy
    (
        (
            "dotfiles/dot_cache/*.sh",
            "dotfiles/dot_cache/*.bash",
            "dotfiles/dot_local/share/bash-completion/*.sh",
            "dotfiles/dot_local/share/bash-completion/*.bash",
        ),
        (BASH_SYNTAX,),
    ),
    # Shared shell fragments must parse in both Bash and Zsh
    (("dotfiles/dot_config/shell/*.sh",), (BASH_SYNTAX, ZSH_SYNTAX, SHELLCHECK)),
    (("*/dot_bash*", "*.bash", "*.sh"), (BASH_SYNTAX, SHELLCHECK)),
)


def run(
    *arguments: str, env: dict[str, str] | None = None, stdin: str | None = None
) -> str:
    return subprocess.check_output(
        arguments,
        cwd=REPOSITORY,
        text=True,
        env=env,
        input=stdin,
    )


def source_paths() -> set[str]:
    return set(
        run(
            "git",
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            "dotfiles",
        )
        .rstrip("\0")
        .split("\0")
    )


def record_paths() -> set[str]:
    if not (REPOSITORY / ".records-unpacked").exists():
        return set()
    exclude = Path(run("git", "rev-parse", "--git-path", "info/exclude").strip())
    lines = (REPOSITORY / exclude).read_text().splitlines()
    start = lines.index("# BEGIN dotfiles encrypted records") + 1
    end = lines.index("# END dotfiles encrypted records")
    return {line.removeprefix("/") for line in lines[start:end]}


def validate_source_mapping(
    managed: dict[str, dict[str, str]], tracked: set[str]
) -> None:
    forbidden = {"README.md", "package.json", "tsconfig.json"}.intersection(managed)
    if forbidden:
        raise ValueError(f"chezmoi manages workspace metadata: {sorted(forbidden)}")
    for target, paths in managed.items():
        source = Path(paths["sourceAbsolute"])
        if source.is_dir(follow_symlinks=False):
            continue
        relative = source.relative_to(REPOSITORY).as_posix()
        if relative not in tracked:
            raise ValueError(
                f"chezmoi manages an ignored source artifact: {relative} ({target})"
            )


def validate_python(source: str, contents: str) -> None:
    compile(contents, source, "exec")
    run("uv", "run", "ruff", "check", "--stdin-filename", source, "-", stdin=contents)


def validate_contents(source: str, contents: str, directory: Path) -> None:
    if not contents.strip():
        return
    source = source.removesuffix(".tmpl")
    suffix = Path(source).suffix
    if parser := CONTENT_PARSERS.get(suffix):
        parser(contents)
        return
    if suffix == ".py":
        validate_python(source, contents)
        return
    commands = next(
        (
            commands
            for patterns, commands in FILE_CHECKS
            if any(fnmatchcase(source, pattern) for pattern in patterns)
        ),
        (),
    )
    if not commands:
        return
    rendered = directory / source
    rendered.parent.mkdir(parents=True, exist_ok=True)
    rendered.write_text(contents)
    for command in commands:
        run(*command, str(rendered))


def check_platform(platform: str) -> None:
    with tempfile.TemporaryDirectory(prefix=f"chezmoi-check-{platform}-") as temporary:
        directory = Path(temporary)
        destination = directory / "home"
        destination.mkdir()
        command = (
            "chezmoi",
            "--source",
            str(REPOSITORY),
            "--config",
            str(directory / "chezmoi.toml"),
            "--destination",
            str(destination),
            "--persistent-state",
            str(directory / "chezmoi.boltdb"),
            "--override-data",
            json.dumps({"chezmoi": PLATFORMS[platform]}),
            "--refresh-externals=never",
            "--no-tty",
        )
        # Encrypted records have their own validation; source checks need no keys
        environment = {
            **os.environ,
            "HOME": str(destination),
            "DOTFILES_RECORDS_DISABLED": "1",
        }
        chezmoi = partial(run, *command, env=environment)
        chezmoi("init")
        config = json.loads(chezmoi("dump-config", "--format=json"))
        expected = {
            "add": {"secrets": "error", "templateSymlinks": True},
            "edit": {"apply": False, "hardlink": True, "watch": True},
        }
        if config["umask"] != 0o022 or any(
            config[section][key] != value
            for section, settings in expected.items()
            for key, value in settings.items()
        ):
            raise ValueError("chezmoi init changed the repository's add/edit policy")
        state = json.loads(
            chezmoi(
                "dump",
                "--exclude=encrypted,externals",
                "--format=json",
            )
        )
        managed = json.loads(
            chezmoi(
                "managed",
                "--exclude=externals",
                "--path-style=all",
                "--format=json",
            )
        )
        tracked = source_paths()
        validate_source_mapping(managed, tracked | record_paths())
        checked = 0
        for target, paths in managed.items():
            source = Path(paths["sourceAbsolute"]).relative_to(REPOSITORY).as_posix()
            entry = state.get(target)
            if (
                source not in tracked
                or not source.endswith(".tmpl")
                or not entry
                or entry["type"] not in {"file", "script"}
            ):
                continue
            try:
                validate_contents(source, entry["contents"], directory / "rendered")
            except (SyntaxError, ValueError) as error:
                error.add_note(f"Rendered template: {source} ({platform})")
                raise
            checked += 1
        print(
            f"{platform}: rendered {len(state)} targets, including {checked} tracked templates"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, suggest_on_error=True)
    parser.add_argument("platform", choices=PLATFORMS)
    arguments = parser.parse_args()
    try:
        check_platform(arguments.platform)
    except subprocess.CalledProcessError as error:
        if error.stdout:
            print(error.stdout, file=sys.stderr, end="")
        raise SystemExit(error.returncode) from error
