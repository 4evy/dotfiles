#!/usr/bin/env python3.14
"""Plaintext-aware Jujutsu diff formatter."""

import filecmp
import json
import os
import re
import shutil
import sys
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

from workstation.errors import DotfilesError, UsageError
from workstation.lib.commands import run

_RECORDS_PATH = Path("secrets/records.yaml")
_JUSTFILE_PATH = Path("Justfile")
_STATUS_LINE = re.compile(r"^ ([AMD]) (.*?)( \|.*)$")
_STATUS_STYLES = {
    "A": "\033[32m",
    "D": "\033[31m",
    "M": "\033[36m",
}
_RESET = "\033[0m"


def _safe_relative_path(value: str) -> bool:
    return (
        bool(value)
        and not Path(value).is_absolute()
        and all(component not in {"", ".", ".."} for component in value.split("/"))
    )


def _regular_file(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def _parse_arguments(arguments: Sequence[str]) -> tuple[str, Path, Path, Path, int]:
    if len(arguments) != 5:
        raise UsageError("usage: jj-diff FORMAT LEFT RIGHT DOTFILES_REPOSITORY WIDTH")

    output_format, left_value, right_value, repository_value, width_value = arguments
    if output_format not in {"patch", "stat"}:
        raise UsageError(f"invalid format: {output_format}")
    if not _safe_relative_path(left_value) or not _safe_relative_path(right_value):
        raise UsageError("snapshot paths must be safe relative paths")

    left = Path(left_value)
    right = Path(right_value)
    repository = Path(repository_value)
    if not left.is_dir() or not right.is_dir():
        raise UsageError("snapshot paths must name directories")
    if not (repository / _JUSTFILE_PATH).is_file():
        raise UsageError("dotfiles repository must contain a Justfile")
    if not width_value.isdigit() or int(width_value) < 1:
        raise UsageError(f"invalid output width: {width_value}")
    return output_format, left, right, repository, int(width_value)


def _record_target(metadata: Path) -> str:
    try:
        value: object = json.loads(metadata.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as error:
        raise DotfilesError(f"invalid record metadata: {metadata}") from error
    if not isinstance(value, dict):
        raise DotfilesError(f"invalid record metadata: {metadata}")
    paths: object = value.get("paths")
    if not isinstance(paths, list) or not paths or not isinstance(paths[0], str):
        raise DotfilesError(f"record metadata has no target path: {metadata}")
    target = paths[0]
    if not _safe_relative_path(target):
        raise DotfilesError(f"unsafe record target: {target}")
    return target


def _materialize_records(
    snapshot: Path,
    repository: Path,
    workspaces: list[Path],
) -> None:
    vault = snapshot / _RECORDS_PATH
    if not _regular_file(vault):
        return

    encrypted_vault = vault.with_name(".records.yaml.encrypted")
    if encrypted_vault.exists() or encrypted_vault.is_symlink():
        raise DotfilesError(
            f"temporary encrypted vault already exists: {encrypted_vault}"
        )

    vault.replace(encrypted_vault)
    workspaces.append(vault)
    run(
        (
            "just",
            "--justfile",
            repository / _JUSTFILE_PATH,
            "records-unpack",
            vault.absolute(),
        ),
        env={
            "RECORDS_FILE": os.fspath(encrypted_vault.absolute()),
            "RECORDS_REPOSITORY": os.fspath(repository),
        },
        output_mode="discard",
    )
    encrypted_vault.unlink()

    for metadata in vault.glob("*/*/metadata.json"):
        if not _regular_file(metadata):
            continue
        record = metadata.parent
        body = record / "body"
        if not body.is_file():
            continue
        destination = record / "target" / _record_target(metadata)
        destination.parent.mkdir(parents=True, exist_ok=True)
        body.replace(destination)


def _cleanup_workspaces(workspaces: Sequence[Path]) -> None:
    failures: list[str] = []
    for workspace in workspaces:
        try:
            if workspace.is_symlink() or workspace.is_file():
                workspace.unlink()
            elif workspace.exists():
                shutil.rmtree(workspace)
        except OSError:
            failures.append(os.fspath(workspace))
    if failures:
        raise DotfilesError(
            f"failed to remove plaintext workspace: {', '.join(failures)}"
        )


@contextmanager
def _plaintext_records(
    left: Path,
    right: Path,
    repository: Path,
) -> Iterator[None]:
    workspaces: list[Path] = []
    try:
        left_vault = left / _RECORDS_PATH
        right_vault = right / _RECORDS_PATH
        vaults_match = (
            _regular_file(left_vault)
            and _regular_file(right_vault)
            and filecmp.cmp(left_vault, right_vault, shallow=False)
        )
        if not vaults_match:
            _materialize_records(left, repository, workspaces)
            _materialize_records(right, repository, workspaces)
        yield
    finally:
        _cleanup_workspaces(workspaces)


def _rewrite_record_paths(patch: str, left: Path, right: Path) -> str:
    result: list[str] = []
    replacements = tuple(
        (f"{prefix}/{snapshot.as_posix()}/", f"{prefix}/")
        for prefix in ("a", "b")
        for snapshot in (left, right)
    )
    for line in patch.splitlines(keepends=True):
        rendered = line
        if line.startswith(("diff --git ", "--- ", "+++ ", "Binary files ")):
            for original, replacement in replacements:
                rendered = rendered.replace(original, replacement)
        result.append(rendered)
    return "".join(result)


def _git_diff(left: Path, right: Path, *, color: bool) -> str:
    result = run(
        (
            "git",
            "--no-pager",
            "-c",
            "color.diff.meta=normal",
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            f"--color={'always' if color else 'never'}",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--",
            left,
            right,
        ),
        capture=True,
        check=False,
    )
    if result.returncode not in {0, 1}:
        details = result.stderr.strip()
        message = "failed to generate diff"
        raise DotfilesError(f"{message}: {details}" if details else message)
    return _rewrite_record_paths(result.stdout, left, right)


def _annotate_diffstat_statuses(patch: str) -> str:
    result: list[str] = []
    status = "M"
    for line in patch.splitlines(keepends=True):
        rendered = line
        if line.startswith("diff --git "):
            status = "M"
        elif line.startswith("new file mode "):
            status = "A"
        elif line.startswith("deleted file mode "):
            status = "D"

        if line.startswith("--- a/"):
            rendered = line.replace("--- a/", f"--- a/{status} ", 1)
        elif line.startswith("+++ b/"):
            rendered = line.replace("+++ b/", f"+++ b/{status} ", 1)
        elif line.startswith("Binary files a/"):
            rendered = line.replace("Binary files a/", f"Binary files a/{status} ", 1)
            rendered = rendered.replace(" and b/", f" and b/{status} ", 1)
        result.append(rendered)
    return "".join(result)


def _colorize_diffstat(output: str, *, color: bool) -> str:
    result: list[str] = []
    for line in output.splitlines(keepends=True):
        ending = "\n" if line.endswith("\n") else ""
        content = line.removesuffix("\n")
        match = _STATUS_LINE.fullmatch(content)
        if match is None:
            result.append(line)
            continue
        status, path, suffix = match.groups()
        style = _STATUS_STYLES[status] if color else ""
        reset = _RESET if color else ""
        result.append(f"{style}{status} {path}{reset}{suffix}{ending}")
    return "".join(result)


def _diffstat(patch: str, width: int, *, color: bool) -> str:
    arguments = ["diffstat", "-E", "-p", "1", "-r", "2", "-w", str(width)]
    if color:
        arguments.append("-C")
    result = run(
        arguments,
        capture=True,
        check=False,
        input_text=_annotate_diffstat_statuses(patch),
    )
    if result.returncode != 0:
        details = result.stderr.strip()
        message = "failed to generate diffstat"
        raise DotfilesError(f"{message}: {details}" if details else message)
    return _colorize_diffstat(result.stdout, color=color)


def main(arguments: Sequence[str] | None = None) -> int:
    values = sys.argv[1:] if arguments is None else arguments
    output_format, left, right, repository, width = _parse_arguments(values)
    color = "NO_COLOR" not in os.environ
    with _plaintext_records(left, right, repository):
        patch = _git_diff(left, right, color=color)
        output = (
            patch if output_format == "patch" else _diffstat(patch, width, color=color)
        )
        sys.stdout.write(output)
    return 0


def entrypoint() -> None:
    try:
        raise SystemExit(main())
    except UsageError as error:
        print(f"jj-diff: {error}", file=sys.stderr)
        raise SystemExit(64) from error
    except DotfilesError as error:
        print(f"jj-diff: {error}", file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    entrypoint()
