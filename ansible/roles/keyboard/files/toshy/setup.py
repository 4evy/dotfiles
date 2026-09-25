#!/usr/bin/env python3.14
"""Run Toshy's interactive installer predictably from Ansible."""

import argparse
import builtins
import os
import re
import runpy
import shlex
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TypeGuard, cast

type RunCallable = Callable[..., subprocess.CompletedProcess[str]]

ORIGINAL_RUN = cast("RunCallable", subprocess.run)
SUDO_SHIM_DIR = os.environ.get("TOSHY_SUDO_SHIM_DIR")
SUDO_NAMES = {"sudo", "sudo-rs"}
SUDO_K_RE = re.compile(r"(^|[;&|]\s*)(?:/usr/bin/)?sudo(?:-rs)?\s+-k(?=\s*(?:[;&|]|$))")
SUDO_CMD_RE = re.compile(r"(^|[;&|]\s*)((?:/usr/bin/)?sudo(?:-rs)?)\s+")
PROMPT_RESPONSES = (
    ("have you updated your system recently", "y"),
    ("run admin commands", "y"),
    ("folder is not in path", "y"),
    ("install a kwin script", "n"),
)


def resolve_sudo() -> str:
    if env_sudo := os.environ.get("TOSHY_SUDO"):
        return env_sudo

    for candidate in ("/run/wrappers/bin/sudo", "/usr/bin/sudo", "/bin/sudo"):
        if Path(candidate).is_file():
            return candidate

    for path_dir in os.environ.get("PATH", "").split(os.pathsep):
        if not path_dir:
            continue
        if SUDO_SHIM_DIR and Path(path_dir).resolve() == Path(SUDO_SHIM_DIR).resolve():
            continue
        candidate = Path(path_dir) / "sudo"
        if candidate.is_file():
            return str(candidate)

    return shutil.which("sudo") or "/usr/bin/sudo"


SUDO = resolve_sudo()


def is_command_sequence(command: object) -> TypeGuard[Sequence[object]]:
    return isinstance(command, Sequence) and not isinstance(command, (str, bytes))


def rewrite_sudo_argv(argv: list[str]) -> list[str] | None:
    if not argv or Path(argv[0]).name not in SUDO_NAMES:
        return argv
    arguments = argv[1:]
    if arguments == ["-k"]:
        return None
    if arguments[:1] == ["-n"]:
        arguments = arguments[1:]
    return [SUDO, "-n", *arguments]


def rewrite_sudo_shell(command: str) -> str:
    command = SUDO_K_RE.sub(r"\1true", command)
    return SUDO_CMD_RE.sub(rf"\1{shlex.quote(SUDO)} -n ", command)


def split_rpm_ostree_live_install(
    argv: list[str],
) -> tuple[list[str], list[str]] | None:
    """Stage and apply rpm-ostree installs with the supported live API."""
    for index, argument in enumerate(argv[:-1]):
        if Path(argument).name != "rpm-ostree" or argv[index + 1] != "install":
            continue
        if "--apply-live" not in argv[index + 2 :]:
            return None

        staged_argv = [argument for argument in argv if argument != "--apply-live"]
        apply_argv = [
            *argv[: index + 1],
            "apply-live",
            "--allow-replacement",
        ]
        return staged_argv, apply_argv

    return None


def automated_run(
    *popenargs: object, **kwargs: object
) -> subprocess.CompletedProcess[str]:
    if not popenargs:
        return ORIGINAL_RUN(*popenargs, **kwargs)

    command = popenargs[0]
    if kwargs.get("shell") and isinstance(command, str):
        popenargs = (rewrite_sudo_shell(command), *popenargs[1:])
    elif is_command_sequence(command):
        argv = [str(part) for part in command]
        rewritten = rewrite_sudo_argv(argv)
        if rewritten is None:
            return subprocess.CompletedProcess(argv, 0, "", "")
        popenargs = (rewritten, *popenargs[1:])

        if live_install := split_rpm_ostree_live_install(rewritten):
            staged_result = ORIGINAL_RUN(live_install[0], *popenargs[1:], **kwargs)
            if staged_result.returncode != 0:
                return staged_result
            popenargs = (live_install[1], *popenargs[1:])

    return ORIGINAL_RUN(*popenargs, **kwargs)


def answer_for(prompt: str) -> str:
    secret_match = re.search(
        r"(?:enter the )?secret code ['\"]([^'\"]+)['\"]",
        prompt,
        re.IGNORECASE,
    )
    if secret_match:
        return secret_match.group(1)

    lowered = prompt.casefold()
    if response := next(
        (response for phrase, response in PROMPT_RESPONSES if phrase in lowered),
        None,
    ):
        return response
    if "barebones" in lowered and 'enter "yes" to proceed' in lowered:
        return "YES"
    if 'enter "yes" to proceed' in lowered:
        return "n"
    return ""


def automated_input(prompt: object = "") -> str:
    prompt_text = str(prompt)
    if prompt_text:
        print(prompt_text, end="", flush=True)
    response = answer_for(prompt_text)
    print(response, flush=True)
    return response


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("setup_path", type=Path)
    parser.add_argument("setup_args", nargs=argparse.REMAINDER)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    setup_path = args.setup_path.resolve()
    setup_dir = setup_path.parent

    os.chdir(setup_dir)
    sys.path.insert(0, str(setup_dir))
    builtins.input = automated_input  # ty: ignore[invalid-assignment]
    subprocess.run = automated_run  # ty: ignore[invalid-assignment]
    sys.argv = [str(setup_path), *args.setup_args]
    _ = runpy.run_path(str(setup_path), run_name="__main__")


if __name__ == "__main__":
    main()
