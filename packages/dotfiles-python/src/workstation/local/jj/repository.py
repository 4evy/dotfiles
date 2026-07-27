from workstation.lib.commands import output

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
