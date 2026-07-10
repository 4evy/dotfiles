from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, cast

from workstation.errors import DotfilesError
from workstation.lib.commands import output, run, which
from workstation.lib.files import write_if_changed

_REDATE_INTERACTIVE_REVSET = "mutable() & remote_bookmarks().."
_REDATE_INTERACTIVE_LIMIT = "20"
_GET_USAGE = "usage: jj-get TARGET [REMOTE_OR_REPO] [BASE]"


def _workspace_root() -> str | None:
    return os.environ.get("JJ_WORKSPACE_ROOT")


def _jj() -> tuple[str, ...]:
    root = _workspace_root()
    return ("jj", "-R", root) if root else ("jj",)


def _git(*args: str, check: bool = True) -> str:
    return output(("git", *args), check=check, cwd=_workspace_root())


def _shallow() -> bool:
    return _git("rev-parse", "--is-shallow-repository", check=False) == "true"


def _shallow_boundary() -> str:
    git_dir = _git("rev-parse", "--absolute-git-dir", check=False)
    if not git_dir:
        return ""
    try:
        return (Path(git_dir) / "shallow").read_text(encoding="utf-8")
    except OSError:
        return ""


def _reindex_if_shallow_boundary_changed(previous: str) -> None:
    if _shallow_boundary() != previous:
        run((*_jj(), "--quiet", "debug", "reindex"))


def _github_repo(value: str) -> str | None:
    for prefix in ("git@github.com:", "ssh://git@github.com/", "https://github.com/"):
        if value.startswith(prefix):
            value = value.removeprefix(prefix)
            break
    value = value.split("/pull/", 1)[0].removesuffix(".git").strip("/")
    return value if value.count("/") == 1 else None


def _normalize_repo(value: str) -> str | None:
    return _github_repo(_git("remote", "get-url", value, check=False) or value)


def _gh_json(*args: str) -> dict[str, object]:
    if which("gh") is None:
        raise DotfilesError("jj-get: gh is required for PR numbers")
    return json.loads(output(("gh", *args), cwd=_workspace_root()))


def _infer_pr_repo() -> str:
    info = _gh_json("repo", "view", "--json", "nameWithOwner,parent")
    parent = info.get("parent")
    if isinstance(parent, dict):
        parent_info = cast("dict[str, Any]", parent)
        owner_info = parent_info.get("owner")
        if isinstance(owner_info, dict):
            owner = owner_info.get("login")
            if owner and parent_info.get("name"):
                return f"{owner}/{parent_info['name']}"
    value = info.get("nameWithOwner")
    if not isinstance(value, str):
        raise DotfilesError("jj-get: could not infer GitHub repository")
    return value


def _fetch_url(repo: str) -> str:
    info = _gh_json("repo", "view", repo, "--json", "sshUrl,url")
    value = info.get("sshUrl") or (
        f"{info['url']}.git" if isinstance(info.get("url"), str) else None
    )
    if not isinstance(value, str):
        raise DotfilesError(f"jj-get: could not resolve fetch URL for {repo}")
    return value


def _fetch_shallow_stack(source: str, refspec: str, base_ref: str) -> None:
    destination = refspec.rsplit(":", 1)[-1]
    common_args = (
        "--no-write-fetch-head",
        "--no-tags",
        "--",
        source,
        refspec,
    )
    run(
        (
            "git",
            "fetch",
            f"--shallow-exclude={base_ref}",
            "--prune",
            *common_args,
        ),
        cwd=_workspace_root(),
    )
    try:
        stack_depth = int(_git("rev-list", "--count", destination))
    except ValueError as error:
        raise DotfilesError(f"could not determine depth of {destination}") from error
    if stack_depth < 1:
        raise DotfilesError(f"empty shallow stack for {destination}")
    # Include exactly one commit beyond the stack. That commit supplies the
    # oldest change's diff base while remaining a shallow root. In particular,
    # don't deepen through the parents when that base happens to be a merge.
    run(
        ("git", "fetch", f"--depth={stack_depth + 1}", *common_args),
        cwd=_workspace_root(),
    )


def _track_remote_bookmark(bookmark: str, remote: str) -> None:
    tracked = output((
        *_jj(),
        "--ignore-working-copy",
        "bookmark",
        "list",
        "--tracked",
        "--remote",
        f"exact:{remote}",
        f"exact:{bookmark}",
        "--template",
        "name",
    ))
    if not tracked:
        run((*_jj(), "bookmark", "track", f"{bookmark}@{remote}"))


def _resolve_pr(number: str, repo_arg: str | None) -> None:
    repo = _normalize_repo(
        repo_arg or os.environ.get("JJ_GET_REPO") or _infer_pr_repo()
    )
    if repo is None:
        raise DotfilesError("jj-get: invalid GitHub repository")
    info = _gh_json(
        "pr",
        "view",
        number,
        "-R",
        repo,
        "--json",
        "baseRefName",
    )
    base = info.get("baseRefName")
    if not isinstance(base, str):
        raise DotfilesError(f"jj-get: could not resolve PR {number} in {repo}")
    url = _fetch_url(repo)
    remote = os.environ.get("JJ_GET_PR_REMOTE", "github-pr")
    bookmark = f"pr/{number}"
    refspec = f"+refs/pull/{number}/head:refs/remotes/{remote}/{bookmark}"
    shallow = _shallow()
    boundary = _shallow_boundary() if shallow else ""
    if shallow:
        _fetch_shallow_stack(url, refspec, f"refs/heads/{base}")
    else:
        run(
            (
                "git",
                "fetch",
                "--prune",
                "--no-write-fetch-head",
                "--no-tags",
                "--",
                url,
                refspec,
            ),
            cwd=_workspace_root(),
        )
    run((*_jj(), "git", "import"))
    if shallow:
        _reindex_if_shallow_boundary_changed(boundary)
    _track_remote_bookmark(bookmark, remote)


def _infer_base(remote: str) -> str:
    value = _git(
        "symbolic-ref",
        "--quiet",
        "--short",
        f"refs/remotes/{remote}/HEAD",
        check=False,
    )
    if value:
        return value.removeprefix(f"{remote}/")
    for line in _git("ls-remote", "--symref", remote, "HEAD", check=False).splitlines():
        fields = line.split()
        if fields[:1] == ["ref:"] and len(fields) > 1:
            return fields[1].removeprefix("refs/heads/")
    raise DotfilesError("jj-get: could not infer default branch; pass BASE")


def _resolve_branch(bookmark: str, remote: str | None, base: str | None) -> None:
    if "@" in bookmark:
        bookmark, suffix = bookmark.rsplit("@", 1)
        if not bookmark or not suffix:
            raise DotfilesError("jj-get: invalid BOOKMARK@REMOTE target")
        base, remote = remote, suffix
    if not remote:
        remotes = _git("remote").splitlines()
        remote = remotes[0] if len(remotes) == 1 else "origin"
    if not _git("remote", "get-url", remote, check=False):
        raise DotfilesError(f"jj-get: unknown remote: {remote}")
    shallow = _shallow()
    boundary = _shallow_boundary() if shallow else ""
    if shallow:
        base = base or os.environ.get("JJ_GET_BASE") or _infer_base(remote)
        base = base.removeprefix(f"{remote}/")
        base_ref = base if base.startswith("refs/") else f"refs/heads/{base}"
        refspec = f"+refs/heads/{bookmark}:refs/remotes/{remote}/{bookmark}"
        _fetch_shallow_stack(remote, refspec, base_ref)
        run((*_jj(), "git", "import"))
        _reindex_if_shallow_boundary_changed(boundary)
    else:
        run((*_jj(), "git", "fetch", "--remote", remote, "--branch", bookmark))
    _track_remote_bookmark(bookmark, remote)


def jj_get_entrypoint() -> None:
    args = sys.argv[1:]
    if args[:1] in (["-h"], ["--help"]):
        print(_GET_USAGE)
        print("  jj-get BOOKMARK [REMOTE] [BASE]")
        print("  jj-get BOOKMARK@REMOTE [BASE]")
        print("  jj-get PR_NUMBER [OWNER/REPO]")
        print("  jj-get GITHUB_PR_URL")
        return
    if not 1 <= len(args) <= 3 or any(value.startswith("-") for value in args):
        raise SystemExit(_GET_USAGE)
    is_pr_number = args[0].isdigit()
    is_pr_url = re.fullmatch(
        r"https://github\.com/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#].*)?", args[0]
    )
    if is_pr_number and len(args) > 2:
        raise SystemExit(_GET_USAGE)
    if is_pr_url and len(args) > 1:
        raise SystemExit(_GET_USAGE)
    if "@" in args[0] and len(args) > 2:
        raise SystemExit(_GET_USAGE)
    if not _git("rev-parse", "--git-dir", check=False):
        raise SystemExit("jj-get: this requires a colocated Git repository")
    try:
        if is_pr_number:
            _resolve_pr(args[0], args[1] if len(args) == 2 else None)
        elif is_pr_url:
            _resolve_pr(
                is_pr_url.group(3),
                f"{is_pr_url.group(1)}/{is_pr_url.group(2)}",
            )
        else:
            _resolve_branch(
                args[0],
                args[1] if len(args) > 1 else None,
                args[2] if len(args) > 2 else None,
            )
    except DotfilesError as error:
        raise SystemExit(str(error)) from error


def _shim_state(value: str) -> None:
    if path := os.environ.get("JJ_GIT_FETCH_SHIM_STATE"):
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
    value = os.environ.get("JJ_GIT_FETCH_DEPTH", "1")
    if not value.isdigit() or int(value) < 1:
        raise DotfilesError("JJ_GIT_FETCH_DEPTH must be a positive integer")
    return value


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


def _jj_git_fetch() -> None:
    # The native fetch command accepts branch/remote string expressions but does not
    # expose the depth passed to GitFetch. Handle only literal names here and let jj
    # retain its full expression semantics for everything else.
    _shim_state("delegate")
    args = list(sys.argv[1:])
    if (
        os.environ.get("JJ_GIT_FETCH_SHALLOW_SHIM", "1") == "0"
        or args[:2] != ["git", "fetch"]
        or not _shallow()
    ):
        return
    remotes: list[str] = []
    branches: list[str] = []
    all_remotes = explicit = False
    args = args[2:]
    index = 0
    while index < len(args):
        value = args[index]
        if value == "--remote" and index + 1 < len(args):
            remotes.append(args[index + 1])
            index += 2
        elif value.startswith("--remote="):
            remotes.append(value.split("=", 1)[1])
            index += 1
        elif value in {"-b", "--branch", "--bookmark"} and index + 1 < len(args):
            branches.append(args[index + 1])
            explicit = True
            index += 2
        elif value.startswith(("--branch=", "--bookmark=")):
            branches.append(value.split("=", 1)[1])
            explicit = True
            index += 1
        elif value == "--all-remotes":
            all_remotes = True
            index += 1
        else:
            return
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


def jj_git_fetch_entrypoint() -> None:
    try:
        _jj_git_fetch()
    except DotfilesError as error:
        raise SystemExit(str(error)) from error


def _redate_args(args: list[str]) -> list[str]:
    result: list[str] = []
    while args:
        value = args.pop(0)
        if value in {"-h", "--help"}:
            raise SystemExit("usage: jj-redate [-r REVSET] [REVSETS]...")
        if value in {"-r", "--revision"}:
            if not args:
                raise SystemExit("jj-redate: --revision requires a value")
            result.append(args.pop(0))
        elif value.startswith("--revision="):
            result.append(value.split("=", 1)[1])
        elif value == "--":
            result.extend(args)
            break
        elif value.startswith("-"):
            raise SystemExit(f"jj-redate: unknown option: {value}")
        else:
            result.append(value)
    return result


def _gum() -> str | None:
    path = which("gum")
    return os.fspath(path) if path is not None else None


def _redate_selectable_revset() -> str:
    return os.environ.get("JJ_REDATE_REVSET", _REDATE_INTERACTIVE_REVSET)


def _redate_selectable_limit() -> str:
    return os.environ.get("JJ_REDATE_LIMIT", _REDATE_INTERACTIVE_LIMIT)


def _prompt(label: str, default: str) -> str:
    gum = _gum()
    if (
        not os.environ.get("JJ_REDATE_NO_GUM")
        and sys.stdin.isatty()
        and sys.stdout.isatty()
        and gum is not None
    ):
        result = subprocess.run(
            (gum, "input", "--prompt", label, "--value", default),
            check=False,
            stdout=subprocess.PIPE,
            text=True,
        )
        if result.returncode == 0:
            return result.stdout.rstrip("\n")
        raise DotfilesError(f"command failed ({result.returncode}): gum input")
    try:
        return input(label) or default
    except EOFError:
        if sys.stdin.isatty():
            return default
        raise DotfilesError(f"no input received for {label}") from None


def _timestamp() -> str:
    now = dt.datetime.now().astimezone()
    date_value = _prompt("Date (YYYY-MM-DD): ", now.strftime("%Y-%m-%d"))
    time_value = _prompt("Time (HH[:MM[:SS]]): ", now.strftime("%H:%M:%S"))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_value):
        raise DotfilesError(f"invalid date: {date_value!r}")
    if re.fullmatch(r"\d{1,2}", time_value):
        time_value += ":00:00"
    elif re.fullmatch(r"\d{1,2}:\d{2}", time_value):
        time_value += ":00"
    elif not re.fullmatch(r"\d{1,2}:\d{2}:\d{2}", time_value):
        raise DotfilesError(f"invalid time: {time_value!r}")
    try:
        value = dt.datetime.strptime(
            f"{date_value} {time_value}", "%Y-%m-%d %H:%M:%S"
        ).astimezone()
    except ValueError as error:
        raise DotfilesError(str(error)) from error
    return value.isoformat(timespec="seconds")


def _confirm_redate(revisions: list[str], timestamp: str) -> bool:
    label = " ".join(revisions)
    gum = _gum()
    if (
        not os.environ.get("JJ_REDATE_NO_GUM")
        and sys.stdin.isatty()
        and sys.stdout.isatty()
        and gum is not None
    ):
        result = subprocess.run(
            (
                gum,
                "confirm",
                f"Set author and committer timestamp on {label} to {timestamp}?",
            ),
            check=False,
        )
        return result.returncode == 0
    print(
        f"Setting author and committer timestamp on {label} to {timestamp}",
        file=sys.stderr,
    )
    return True


def _log(revset: str, template: str, reverse: bool = False) -> str:
    args = [*_jj(), "--color", "never", "--no-pager", "log", "-r", revset]
    if reverse:
        args.append("--reversed")
    return output((*args, "--no-graph", "--template", template))


def _redate_selectable_items(revset: str, limit: str) -> list[tuple[str, str]]:
    template = (
        'change_id ++ "\\t" ++ '
        'if(current_working_copy, "@", "o") ++ "\\t" ++ '
        'change_id.shortest(8) ++ "\\t" ++ '
        'author.email() ++ "\\t" ++ '
        'committer.timestamp().format("%Y-%m-%d %H:%M:%S") ++ "\\t" ++ '
        'commit_id.shortest(8) ++ "\\t" ++ '
        'description.first_line() ++ "\\n"'
    )
    items: list[tuple[str, str]] = []
    for line in _log(f"latest(({revset}), {limit})", template).splitlines():
        fields = line.split("\t", 6)
        if len(fields) != 7:
            continue
        change, marker, short_change, email, timestamp, short_commit, description = (
            fields
        )
        summary = " ".join(description.split()) or "(no description set)"
        label = f"{marker} {short_change} {email} {timestamp} {short_commit}  {summary}"
        items.append((label, f"change_id({change})"))
    return items


def _interactive_redate_revisions() -> list[str] | None:
    gum = _gum()
    if (
        os.environ.get("JJ_REDATE_NO_GUM")
        or not sys.stdin.isatty()
        or not sys.stdout.isatty()
        or gum is None
    ):
        return None
    revset = _redate_selectable_revset()
    limit = _redate_selectable_limit()
    items = _redate_selectable_items(revset, limit)
    if not items:
        raise DotfilesError(f"jj-redate: no revisions matched {revset!r}")
    labels = [label for label, _ in items]
    revsets_by_label = dict(items)
    height = str(min(max(len(items), 5), 20))
    result = subprocess.run(
        (
            gum,
            "choose",
            "--ordered",
            "--limit",
            str(len(items)),
            "--height",
            height,
            "--header",
            "Select revisions to redate",
            *labels,
        ),
        check=False,
        stdout=subprocess.PIPE,
        text=True,
    )
    if result.returncode == 0:
        selected = [line for line in result.stdout.splitlines() if line]
        if selected:
            return [revsets_by_label[line] for line in selected]
        raise DotfilesError("jj-redate: no revisions selected")
    raise DotfilesError(f"command failed ({result.returncode}): gum choose")


def _redate_revisions(args: list[str]) -> list[str]:
    revisions = _redate_args(args)
    if revisions:
        return revisions
    return _interactive_redate_revisions() or ["@"]


def _timestamp_run(timestamp: str, *args: str) -> None:
    run((*_jj(), "--config", f'debug.commit-timestamp="{timestamp}"', *args))


def _verify(ids: list[str], timestamp: str) -> bool:
    template = (
        'author.timestamp().format("%Y-%m-%dT%H:%M:%S%:z") ++ "\\t" ++ '
        'committer.timestamp().format("%Y-%m-%dT%H:%M:%S%:z") ++ "\\n"'
    )
    return all(
        all(
            line.split("\t") == [timestamp, timestamp]
            for line in _log(f"change_id({change})", template).splitlines()
        )
        for change in ids
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


def jj_redate_entrypoint() -> None:
    try:  # noqa: PLW0717 - one recovery boundary must restore descendant timestamps
        arguments = list(sys.argv[1:])
        if any(value in {"-h", "--help"} for value in arguments):
            print("usage: jj-redate [-r REVSET] [REVSETS]...")
            return
        revisions = _redate_revisions(arguments)
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
            if not _verify(ids, timestamp):
                raise DotfilesError("jj-redate: timestamp verification failed")
        finally:
            if edited:
                for change, original in descendants:
                    _timestamp_run(
                        original,
                        "--quiet",
                        "metaedit",
                        "--force-rewrite",
                        "-r",
                        f"change_id({change})",
                    )
    except DotfilesError as error:
        raise SystemExit(str(error)) from error
