import datetime as dt
import re
import shutil
import sys
from dataclasses import dataclass
from itertools import groupby
from operator import itemgetter
from pathlib import Path
from typing import Annotated, cast

import questionary
from cyclopts import App, ArgumentCollection, Group, Parameter
from cyclopts.exceptions import CycloptsError
from pydantic import BaseModel, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict
from rich.text import Text

from workstation.errors import DotfilesError
from workstation.lib.commands import output, run, which
from workstation.lib.files import write_if_changed

_REDATE_INTERACTIVE_REVSET = "mutable() & remote_bookmarks().."
_REDATE_INSTRUCTION = "(↑↓ move · space toggle · enter confirm)"
_REDATE_STYLE = questionary.Style([
    ("qmark", "fg:ansimagenta bold"),
    ("question", "bold"),
    ("answer", "fg:ansimagenta bold"),
    ("pointer", "fg:ansimagenta bold"),
    ("selected", "fg:ansimagenta bold"),
    ("instruction", "fg:ansibrightblack"),
    ("validation-toolbar", "fg:ansired"),
    ("redate-working-copy", "fg:ansimagenta bold"),
    ("redate-change", "fg:ansicyan bold"),
    ("redate-empty", "fg:ansibrightblack italic"),
    ("redate-time", "fg:ansibrightblack"),
])


@dataclass(frozen=True)
class _RedateItem:
    change: str
    marker: str
    short_change: str
    email: str
    timestamp: str
    short_commit: str
    summary: str

    @property
    def revset(self) -> str:
        return f"change_id({self.change})"


class JjSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    jj_workspace_root: str | None = None
    jj_get_repo: str | None = None
    jj_get_pr_remote: str = "github-pr"
    jj_get_base: str | None = None
    jj_git_fetch_depth: int = Field(1, ge=1)
    jj_git_fetch_shallow_shim: bool = True
    jj_git_fetch_shim_state: Path | None = None
    jj_redate_no_prompt: bool = False
    jj_redate_revset: str = _REDATE_INTERACTIVE_REVSET
    jj_redate_limit: int | None = Field(None, ge=1)


def _settings() -> JjSettings:
    try:
        return JjSettings()
    except ValidationError as error:
        raise DotfilesError(f"invalid jj configuration: {error}") from error


class _GitHubOwner(BaseModel):
    login: str = Field(min_length=1)


class _GitHubRepository(BaseModel):
    name: str = Field(min_length=1)
    owner: _GitHubOwner


class _GitHubRepositoryInfo(BaseModel):
    name_with_owner: str = Field(alias="nameWithOwner", min_length=3)
    parent: _GitHubRepository | None = None


class _GitHubRepositoryUrls(BaseModel):
    ssh_url: str | None = Field(None, alias="sshUrl")
    url: str | None = None


class _GitHubPullRequest(BaseModel):
    base_ref_name: str = Field(alias="baseRefName", min_length=1)
    head_ref_name: str = Field(alias="headRefName", min_length=1)


def _workspace_root() -> str | None:
    return _settings().jj_workspace_root


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


def _gh_json[Model: BaseModel](model: type[Model], *args: str) -> Model:
    if which("gh") is None:
        raise DotfilesError("jj-get: gh is required for PR numbers")
    try:
        return model.model_validate_json(output(("gh", *args), cwd=_workspace_root()))
    except ValidationError as error:
        raise DotfilesError(f"jj-get: invalid gh response: {error}") from error


def _infer_pr_repo() -> str:
    info = _gh_json(
        _GitHubRepositoryInfo, "repo", "view", "--json", "nameWithOwner,parent"
    )
    if info.parent:
        return f"{info.parent.owner.login}/{info.parent.name}"
    return info.name_with_owner


def _fetch_url(repo: str) -> str:
    info = _gh_json(_GitHubRepositoryUrls, "repo", "view", repo, "--json", "sshUrl,url")
    value = info.ssh_url or (f"{info.url}.git" if info.url else None)
    if value is None:
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
    repo = _normalize_repo(repo_arg or _settings().jj_get_repo or _infer_pr_repo())
    if repo is None:
        raise DotfilesError("jj-get: invalid GitHub repository")
    info = _gh_json(
        _GitHubPullRequest,
        "pr",
        "view",
        number,
        "-R",
        repo,
        "--json",
        "baseRefName,headRefName",
    )
    url = _fetch_url(repo)
    remote = _settings().jj_get_pr_remote
    bookmark = info.head_ref_name
    refspec = f"+refs/pull/{number}/head:refs/remotes/{remote}/{bookmark}"
    shallow = _shallow()
    boundary = _shallow_boundary() if shallow else ""
    if shallow:
        _fetch_shallow_stack(url, refspec, f"refs/heads/{info.base_ref_name}")
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
        base = base or _settings().jj_get_base or _infer_base(remote)
        base = base.removeprefix(f"{remote}/")
        base_ref = base if base.startswith("refs/") else f"refs/heads/{base}"
        refspec = f"+refs/heads/{bookmark}:refs/remotes/{remote}/{bookmark}"
        _fetch_shallow_stack(remote, refspec, base_ref)
        run((*_jj(), "git", "import"))
        _reindex_if_shallow_boundary_changed(boundary)
    else:
        run((*_jj(), "git", "fetch", "--remote", remote, "--branch", bookmark))
    _track_remote_bookmark(bookmark, remote)


def _validate_jj_get_arguments(arguments: ArgumentCollection) -> None:
    target_argument = arguments.get("--target")
    remote_argument = arguments.get("--remote-or-repo")
    base_argument = arguments.get("--base")
    target = cast("str", target_argument.value)
    remote_or_repo = (
        cast("str", remote_argument.value) if remote_argument.tokens else None
    )
    base = cast("str", base_argument.value) if base_argument.tokens else None
    is_pr_url = re.fullmatch(
        r"https://github\.com/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#].*)?", target
    )
    if target.isdigit() and base is not None:
        raise ValueError("PR numbers accept at most OWNER/REPO")
    if is_pr_url and (remote_or_repo is not None or base is not None):
        raise ValueError("GitHub PR URLs do not accept extra arguments")
    if "@" in target and base is not None:
        raise ValueError("BOOKMARK@REMOTE accepts at most BASE")


_JJ_GET_ARGUMENTS = Group("Target", validator=_validate_jj_get_arguments)


def jj_get(
    target: Annotated[str, Parameter(group=_JJ_GET_ARGUMENTS)],
    remote_or_repo: Annotated[str | None, Parameter(group=_JJ_GET_ARGUMENTS)] = None,
    base: Annotated[str | None, Parameter(group=_JJ_GET_ARGUMENTS)] = None,
) -> None:
    """Fetch a bookmark or GitHub pull request into a colocated jj repository.

    Parameters
    ----------
    target
        Bookmark, PR number, or GitHub PR URL.
    remote_or_repo
        Git remote or OWNER/REPO.
    base
        Base branch for shallow fetches.

    """
    is_pr_number = target.isdigit()
    is_pr_url = re.fullmatch(
        r"https://github\.com/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#].*)?", target
    )
    if not _git("rev-parse", "--git-dir", check=False):
        raise DotfilesError("jj-get: this requires a colocated Git repository")
    if is_pr_number:
        _resolve_pr(target, remote_or_repo)
    elif is_pr_url:
        _resolve_pr(
            is_pr_url.group(3),
            f"{is_pr_url.group(1)}/{is_pr_url.group(2)}",
        )
    else:
        _resolve_branch(target, remote_or_repo, base)


def jj_get_entrypoint() -> None:
    try:
        jj_get_app()
    except DotfilesError as error:
        raise SystemExit(str(error)) from error


jj_get_app = App(
    default_command=jj_get,
    version_flags=[],
    result_action="return_none",
)


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


_shallow_fetch_app = App(
    default_command=_shallow_fetch_arguments,
    help_flags=[],
    version_flags=[],
    result_action="return_value",
)


def _shallow_fetch_options(
    arguments: list[str],
) -> tuple[list[str], list[str], bool] | None:
    try:
        command, bound, unknown, _ = _shallow_fetch_app.parse_known_args(arguments)
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


def jj_git_fetch_entrypoint() -> None:
    try:
        _jj_git_fetch()
    except DotfilesError as error:
        raise SystemExit(str(error)) from error


def _redate_selectable_revset() -> str:
    return _settings().jj_redate_revset


def _redate_selectable_limit() -> int | None:
    return _settings().jj_redate_limit


def _prompt(label: str, default: str) -> str:
    if (
        not _settings().jj_redate_no_prompt
        and sys.stdin.isatty()
        and sys.stdout.isatty()
    ):
        result = questionary.text(
            label.strip().removesuffix(":"),
            default=default,
            qmark="◆",
            style=_REDATE_STYLE,
        ).ask()
        if result is None:
            raise DotfilesError(f"no input received for {label}")
        return result
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
    if len(revisions) == 1:
        label = revisions[0]
        if match := re.fullmatch(r"change_id\(([^)]+)\)", label):
            label = f"change {match[1][:8]}"
    else:
        label = f"{len(revisions)} revisions"
    if (
        not _settings().jj_redate_no_prompt
        and sys.stdin.isatty()
        and sys.stdout.isatty()
    ):
        return bool(
            questionary.confirm(
                f"Redate {label} to {timestamp}?",
                qmark="◆",
                style=_REDATE_STYLE,
            ).ask()
        )
    print(
        f"Redating {label} to {timestamp}",
        file=sys.stderr,
    )
    return True


def _log(revset: str, template: str, reverse: bool = False) -> str:
    args = [*_jj(), "--color", "never", "--no-pager", "log", "-r", revset]
    if reverse:
        args.append("--reversed")
    return output((*args, "--no-graph", "--template", template))


def _redate_selectable_items(revset: str, limit: int | None) -> list[_RedateItem]:
    template = (
        'change_id ++ "\\t" ++ '
        'if(current_working_copy, "@", "") ++ "\\t" ++ '
        'change_id.shortest(8) ++ "\\t" ++ '
        'author.email() ++ "\\t" ++ '
        'committer.timestamp().format("%Y-%m-%d %H:%M:%S") ++ "\\t" ++ '
        'commit_id.shortest(8) ++ "\\t" ++ '
        'description.first_line() ++ "\\n"'
    )
    items: list[_RedateItem] = []
    selectable_revset = f"latest(({revset}), {limit})" if limit else revset
    for line in _log(selectable_revset, template).splitlines():
        fields = line.split("\t", 6)
        if len(fields) != 7:
            continue
        change, marker, short_change, email, timestamp, short_commit, description = (
            fields
        )
        summary = " ".join(description.split()) or "(no description set)"
        items.append(
            _RedateItem(
                change=change,
                marker=marker,
                short_change=short_change,
                email=email,
                timestamp=timestamp,
                short_commit=short_commit,
                summary=summary,
            )
        )
    return items


def _friendly_redate_timestamp(value: str) -> str:
    timestamp = dt.datetime.strptime(value, "%Y-%m-%d %H:%M:%S").astimezone()
    today = dt.datetime.now().astimezone().date()
    if timestamp.date() == today:
        return f"today {timestamp:%H:%M}"
    if timestamp.date() == today - dt.timedelta(days=1):
        return f"yesterday {timestamp:%H:%M}"
    if timestamp.year == today.year:
        return timestamp.strftime("%b %d %H:%M")
    return timestamp.strftime("%Y-%m-%d")


def _truncate_redate_summary(value: str, width: int) -> str:
    text = Text(value, no_wrap=True, overflow="ellipsis")
    text.truncate(max(width, 1), overflow="ellipsis")
    return text.plain


def _redate_choice_title(
    item: _RedateItem, terminal_columns: int
) -> list[tuple[str, str]]:
    available = max(terminal_columns - 7, 13)
    marker = f"{item.marker} " if item.marker else "  "
    prefix_width = Text(marker + item.short_change + "  ").cell_len
    friendly_time = _friendly_redate_timestamp(item.timestamp)
    show_time = available >= 60
    time_width = Text(friendly_time).cell_len + 2 if show_time else 0
    summary_width = max(available - prefix_width - time_width, 1)
    summary = _truncate_redate_summary(item.summary, summary_width)
    summary_padding = max(summary_width - Text(summary).cell_len, 0)
    summary_style = (
        "class:redate-empty" if item.summary == "(no description set)" else "class:text"
    )
    title = [
        ("class:redate-working-copy", marker),
        ("class:redate-change", item.short_change),
        ("class:text", "  "),
        (summary_style, summary),
    ]
    if show_time:
        title.extend([
            ("class:text", " " * (summary_padding + 2)),
            ("class:redate-time", friendly_time),
        ])
    return title


def _redate_choices(items: list[_RedateItem]) -> list[questionary.Choice]:
    terminal_columns = shutil.get_terminal_size(fallback=(100, 24)).columns
    return [
        questionary.Choice(
            title=_redate_choice_title(item, terminal_columns),
            value=item.revset,
            description=(
                f"{item.email}  ·  commit {item.short_commit}  ·  {item.timestamp}"
            ),
        )
        for item in items
    ]


def _interactive_redate_revisions() -> list[str] | None:
    if (
        _settings().jj_redate_no_prompt
        or not sys.stdin.isatty()
        or not sys.stdout.isatty()
    ):
        return None
    revset = _redate_selectable_revset()
    limit = _redate_selectable_limit()
    items = _redate_selectable_items(revset, limit)
    if not items:
        raise DotfilesError(f"jj-redate: no revisions matched {revset!r}")
    selected = questionary.checkbox(
        f"Select revisions ({len(items)} available)",
        choices=_redate_choices(items),
        qmark="◆",
        pointer=">",
        instruction=_REDATE_INSTRUCTION,
        style=_REDATE_STYLE,
        validate=lambda choices: bool(choices) or "Select at least one revision",
    )
    revisions = selected.ask()
    if revisions is None:
        return []
    if revisions:
        return cast("list[str]", revisions)
    raise DotfilesError("jj-redate: no revisions selected")


def _redate_revisions(revisions: list[str]) -> list[str]:
    if revisions:
        return revisions
    selected = _interactive_redate_revisions()
    return ["@"] if selected is None else selected


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
    try:  # noqa: PLW0717 - one recovery boundary must restore descendant timestamps
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


def jj_redate_entrypoint() -> None:
    jj_redate_app()


jj_redate_app = App(
    default_command=jj_redate,
    version_flags=[],
    result_action="return_none",
)
