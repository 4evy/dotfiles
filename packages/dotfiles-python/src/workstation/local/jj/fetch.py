import re
import sys
from typing import Annotated

from cyclopts import App, Parameter
from cyclopts.exceptions import CycloptsError

from workstation.errors import DotfilesError
from workstation.lib.commands import run
from workstation.lib.files import write_if_changed

from .repository import (
    git as _git,
    is_shallow as _shallow,
    jj_command as _jj,
    shallow_boundary as _shallow_boundary,
    workspace_root as _workspace_root,
)
from .settings import settings as _settings


def _reindex_if_shallow_boundary_changed(previous: str) -> None:
    if _shallow_boundary() != previous:
        run((*_jj(), "--quiet", "debug", "reindex"))


def _shim_state(value: str) -> None:
    if path := _settings().jj_git_fetch_shim_state:
        write_if_changed(path, value + "\n")


def _can_shallow_fetch(remotes: list[str], branches: list[str]) -> bool:
    if any(re.search(r"[*?|~()]", value) for value in (*remotes, *branches)):
        return False
    known_remotes = _git("remote").splitlines()
    if any(remote not in known_remotes for remote in remotes):
        return False
    return all(
        _git("check-ref-format", "--branch", branch, check=False) == branch
        for branch in branches
    )


def _fetch_depth() -> str:
    return str(_settings().jj_git_fetch_depth)


def _fetch_remotes(requested: list[str], all_remotes: bool) -> list[str] | None:
    if all_remotes:
        if requested:
            return None
        return _git("remote").splitlines() or None
    if requested:
        return requested
    found = _git("remote").splitlines()
    if len(found) == 1:
        return found
    if _git("remote", "get-url", "origin", check=False):
        return ["origin"]
    return None


def _shallow_fetch_arguments(
    *,
    remote: Annotated[
        list[str] | None,
        Parameter(negative_iterable="", negative_none=""),
    ] = None,
    branch: Annotated[
        list[str] | None,
        Parameter(
            alias=("-b", "--bookmark"),
            negative_iterable="",
            negative_none="",
        ),
    ] = None,
    all_remotes: bool = False,
) -> tuple[list[str], list[str], bool]:
    return remote or [], branch or [], all_remotes


_app = App(
    default_command=_shallow_fetch_arguments,
    help_flags=[],
    version_flags=[],
    result_action="return_value",
)


def _shallow_fetch_options(
    arguments: list[str],
) -> tuple[list[str], list[str], bool] | None:
    try:
        command, bound, unknown, _ = _app.parse_known_args(arguments)
    except CycloptsError:
        return None
    if unknown:
        return None
    return command(*bound.args, **bound.kwargs)


def _jj_git_fetch() -> None:
    # The native fetch command accepts branch/remote string expressions but does not
    # expose the depth passed to GitFetch. Handle only literal names here and let jj
    # retain its full expression semantics for everything else.
    _shim_state("delegate")
    args = list(sys.argv[1:])
    if (
        not _settings().jj_git_fetch_shallow_shim
        or args[:2] != ["git", "fetch"]
        or not _shallow()
    ):
        return
    options = _shallow_fetch_options(args[2:])
    if options is None:
        return
    remotes, branches, all_remotes = options
    explicit = bool(branches)
    selected_remotes = _fetch_remotes(remotes, all_remotes)
    if selected_remotes is None:
        return
    remotes = selected_remotes
    if not _can_shallow_fetch(remotes, branches):
        return
    depth = _fetch_depth()
    boundary = _shallow_boundary()
    _shim_state("handled")
    for remote in remotes:
        refspecs = (
            [
                f"+refs/heads/{branch}:refs/remotes/{remote}/{branch}"
                for branch in branches
            ]
            or _git(
                "config", "--get-all", f"remote.{remote}.fetch", check=False
            ).splitlines()
            or [f"+refs/heads/*:refs/remotes/{remote}/*"]
        )
        no_tags = ("--no-tags",) if explicit else ()
        run(
            (
                "git",
                "fetch",
                f"--depth={depth}",
                "--prune",
                "--no-write-fetch-head",
                "--verbose",
                "--progress",
                *no_tags,
                "--",
                remote,
                *refspecs,
            ),
            cwd=_workspace_root(),
        )
        # Keep one parent beyond the requested depth so the oldest fetched
        # commit has a real diff base instead of appearing to add the full tree.
        run(
            (
                "git",
                "fetch",
                "--deepen=1",
                "--no-write-fetch-head",
                "--verbose",
                "--progress",
                *no_tags,
                "--",
                remote,
                *refspecs,
            ),
            cwd=_workspace_root(),
        )
    run((*_jj(), "git", "import"))
    _reindex_if_shallow_boundary_changed(boundary)


def entrypoint() -> None:
    try:
        _jj_git_fetch()
    except DotfilesError as error:
        raise SystemExit(str(error)) from error
