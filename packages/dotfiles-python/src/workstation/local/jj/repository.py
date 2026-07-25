from pathlib import Path

from workstation.lib.commands import output, run

from .settings import settings


def workspace_root() -> str | None:
    return settings().jj_workspace_root


def jj_command() -> tuple[str, ...]:
    root = workspace_root()
    return ("jj", "-R", root) if root else ("jj",)


def git(*args: str, check: bool = True) -> str:
    return output(("git", *args), check=check, cwd=workspace_root())


def is_shallow() -> bool:
    return git("rev-parse", "--is-shallow-repository", check=False) == "true"


def shallow_boundary() -> str:
    git_dir = git("rev-parse", "--absolute-git-dir", check=False)
    if not git_dir:
        return ""
    try:
        return (Path(git_dir) / "shallow").read_text(encoding="utf-8")
    except OSError:
        return ""


def reindex_if_shallow_boundary_changed(previous: str) -> None:
    if shallow_boundary() != previous:
        run((*jj_command(), "--quiet", "debug", "reindex"))


def log(revset: str, template: str, reverse: bool = False) -> str:
    args = [*jj_command(), "--color", "never", "--no-pager", "log", "-r", revset]
    if reverse:
        args.append("--reversed")
    return output((*args, "--no-graph", "--template", template))
