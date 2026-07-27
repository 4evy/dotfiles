import re
from typing import Annotated, cast

from cyclopts import App, ArgumentCollection, Group, Parameter
from pydantic import BaseModel, Field, ValidationError

from workstation.errors import DotfilesError
from workstation.lib.commands import output, run, which

from .repository import (
    git as _git,
    is_shallow as _shallow,
    jj_command as _jj,
    workspace_root as _workspace_root,
)
from .settings import settings as _settings


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


def _fetch_ref(
    source: str,
    source_ref: str,
    remote: str,
    bookmark: str,
    shallow_exclude: str | None,
) -> None:
    args = [
        *_jj(),
        "git",
        "fetch-ref",
        "--source",
        source,
        source_ref,
        "--remote",
        remote,
        "--bookmark",
        bookmark,
        "--track",
    ]
    if shallow_exclude:
        args.extend(("--shallow-exclude", shallow_exclude))
    run(tuple(args))


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
    _fetch_ref(
        _fetch_url(repo),
        f"refs/pull/{number}/head",
        _settings().jj_get_pr_remote,
        info.head_ref_name,
        f"refs/heads/{info.base_ref_name}" if _shallow() else None,
    )


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

    shallow_exclude = None
    if _shallow():
        base = base or _settings().jj_get_base or _infer_base(remote)
        base = base.removeprefix(f"{remote}/")
        shallow_exclude = base if base.startswith("refs/") else f"refs/heads/{base}"
    _fetch_ref(
        remote,
        f"refs/heads/{bookmark}",
        remote,
        bookmark,
        shallow_exclude,
    )


def _validate_arguments(arguments: ArgumentCollection) -> None:
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


_ARGUMENTS = Group("Target", validator=_validate_arguments)


def jj_get(
    target: Annotated[str, Parameter(group=_ARGUMENTS)],
    remote_or_repo: Annotated[str | None, Parameter(group=_ARGUMENTS)] = None,
    base: Annotated[str | None, Parameter(group=_ARGUMENTS)] = None,
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


def entrypoint() -> None:
    try:
        app()
    except DotfilesError as error:
        raise SystemExit(str(error)) from error


app = App(
    default_command=jj_get,
    version_flags=[],
    result_action="return_none",
)
