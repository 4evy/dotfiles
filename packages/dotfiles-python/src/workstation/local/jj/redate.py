from itertools import groupby
from operator import itemgetter
from typing import Annotated

from cyclopts import App, Parameter

from workstation.errors import DotfilesError
from workstation.lib.commands import run

from .repository import jj_command as _jj, log as _log
from .selection import _confirm_redate, _redate_revisions, _timestamp


def _timestamp_run(timestamp: str, *args: str) -> None:
    run((*_jj(), "--config", f'debug.commit-timestamp="{timestamp}"', *args))


def _verify_author_timestamps(ids: list[str], timestamp: str) -> bool:
    template = 'author.timestamp().format("%Y-%m-%dT%H:%M:%S%:z") ++ "\\n"'
    for change in ids:
        values = _log(f"change_id({change})", template).splitlines()
        if not values or any(value != timestamp for value in values):
            return False
    return True


def _verify_descendant_timestamps(descendants: list[tuple[str, str]]) -> bool:
    template = 'committer.timestamp().format("%Y-%m-%dT%H:%M:%S%.3f%:z") ++ "\\n"'
    for change, timestamp in descendants:
        values = _log(f"change_id({change})", template).splitlines()
        if not values or any(value != timestamp for value in values):
            return False
    return True


def _verify_signatures(change_ids: list[str]) -> bool:
    template = 'if(signature, "signed", "unsigned") ++ "\\n"'
    for change in change_ids:
        values = _log(f"change_id({change})", template).splitlines()
        if not values or any(value != "signed" for value in values):
            return False
    return True


def _restore_descendant_timestamps(descendants: list[tuple[str, str]]) -> None:
    for change, timestamp in descendants:
        _timestamp_run(
            timestamp,
            "--quiet",
            "metaedit",
            "--force-rewrite",
            "-r",
            f"change_id({change})",
        )


def _sign_redated_changes(
    change_ids: list[str],
    descendants: list[tuple[str, str]],
    timestamp: str,
) -> None:
    intended_timestamps = dict(descendants)
    intended_timestamps.update(dict.fromkeys(change_ids, timestamp))
    revset = " | ".join(f"change_id({change})" for change in intended_timestamps)
    ordered_ids = _log(revset, 'change_id ++ "\\n"', True).splitlines()
    changes = [
        (change, intended_timestamps[change])
        for change in dict.fromkeys(ordered_ids)
        if change in intended_timestamps
    ]
    if len(changes) != len(intended_timestamps):
        raise DotfilesError("jj-redate: could not order all revisions for signing")
    # Signing rewrites a commit and rebases its descendants. Work oldest-to-newest
    # so every later signature restores that commit's intended timestamp.
    for group_timestamp, group in groupby(changes, key=itemgetter(1)):
        revset = " | ".join(f"change_id({change})" for change, _timestamp in group)
        _timestamp_run(
            group_timestamp,
            "--quiet",
            "sign",
            "-r",
            revset,
        )


def _selected_change_ids(revset: str) -> list[str]:
    selected = _log(revset, 'change_id ++ "\\n"', True).splitlines()
    if not selected:
        raise DotfilesError(f"jj-redate: no revisions matched {revset!r}")
    change_ids = list(dict.fromkeys(selected))
    for change in change_ids:
        all_commits = _log(f"change_id({change})", 'commit_id ++ "\\n"').splitlines()
        if selected.count(change) != len(all_commits):
            raise DotfilesError(
                "jj-redate: selection contains only part of divergent change "
                f"{change}; select all of change_id({change})"
            )
    return change_ids


def _descendant_timestamps(revset: str) -> list[tuple[str, str]]:
    value = _log(
        f"({revset}):: ~ ({revset})",
        'change_id ++ "\\t" ++ committer.timestamp().format("%Y-%m-%dT%H:%M:%S%.3f%:z") ++ "\\n"',
        True,
    )
    timestamps: dict[str, str] = {}
    counts: dict[str, int] = {}
    for line in value.splitlines():
        if "\t" not in line:
            raise DotfilesError("jj-redate: malformed descendant metadata")
        change, original = line.split("\t", 1)
        counts[change] = counts.get(change, 0) + 1
        if previous := timestamps.get(change):
            if previous != original:
                raise DotfilesError(
                    "jj-redate: cannot safely preserve different timestamps on "
                    f"divergent descendant {change}"
                )
        else:
            timestamps[change] = original
    for change, count in counts.items():
        all_commits = _log(f"change_id({change})", 'commit_id ++ "\\n"').splitlines()
        if count != len(all_commits):
            raise DotfilesError(
                "jj-redate: descendant set contains only part of divergent change "
                f"{change}"
            )
    return list(timestamps.items())


def jj_redate(
    *revsets: str,
    revision: Annotated[
        list[str] | None,
        Parameter(
            alias="-r",
            negative_iterable="",
            negative_none="",
            help="Revision set",
        ),
    ] = None,
) -> None:
    """Set timestamps and sign rewritten commits while preserving descendants.

    Parameters
    ----------
    revsets
        Additional revision sets.
    revision
        Revision sets selected with ``--revision`` or ``-r``.

    """
    try:  # ruff: ignore[too-many-statements-in-try-clause] - one recovery boundary must restore descendant timestamps
        revisions = _redate_revisions([*(revision or []), *revsets])
        if not revisions:
            return
        revset = " | ".join(f"({value})" for value in revisions)
        ids = _selected_change_ids(revset)
        descendants = _descendant_timestamps(revset)
        timestamp = _timestamp()
        if not _confirm_redate(revisions, timestamp):
            return
        edited = False
        try:
            _timestamp_run(
                timestamp,
                "metaedit",
                "--author-timestamp",
                timestamp,
                "--force-rewrite",
                "-r",
                revset,
            )
            edited = True
            # The Git backend can shift an unsigned committer timestamp to avoid
            # recreating an existing Git object with different jj metadata. The
            # signing pass writes the final Git objects, so only the author
            # timestamps are final here.
            if not _verify_author_timestamps(ids, timestamp):
                raise DotfilesError("jj-redate: author timestamp verification failed")
        finally:
            if edited:
                _restore_descendant_timestamps(descendants)
        signing_complete = False
        try:
            _sign_redated_changes(ids, descendants, timestamp)
            # A signed rewrite can also collide with an object left by an earlier
            # attempt. jj then shifts only the committer timestamp backwards to
            # keep the Git object ID unique; the requested author timestamp is
            # still exact.
            timestamps_valid = _verify_author_timestamps(
                ids, timestamp
            ) and _verify_descendant_timestamps(descendants)
            if not timestamps_valid:
                raise DotfilesError("jj-redate: signed timestamp verification failed")
            if not _verify_signatures([*ids, *(change for change, _ in descendants)]):
                raise DotfilesError("jj-redate: signature verification failed")
            signing_complete = True
        finally:
            if not signing_complete:
                _restore_descendant_timestamps(descendants)
    except DotfilesError as error:
        raise SystemExit(str(error)) from error


def entrypoint() -> None:
    app()


app = App(
    default_command=jj_redate,
    version_flags=[],
    result_action="return_none",
)
