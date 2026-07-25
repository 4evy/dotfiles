from pathlib import Path
from typing import ClassVar

from pydantic import Field

from workstation.lib.settings import EnvironmentSettings

REDATE_INTERACTIVE_REVSET = "mutable() & remote_bookmarks().."


class JjSettings(EnvironmentSettings):
    configuration_name: ClassVar[str] = "jj"

    jj_workspace_root: str | None = None
    jj_get_repo: str | None = None
    jj_get_pr_remote: str = "github-pr"
    jj_get_base: str | None = None
    jj_git_fetch_depth: int = Field(1, ge=1)
    jj_git_fetch_shallow_shim: bool = True
    jj_git_fetch_shim_state: Path | None = None
    jj_redate_no_prompt: bool = False
    jj_redate_revset: str = REDATE_INTERACTIVE_REVSET
    jj_redate_limit: int | None = Field(None, ge=1)


def settings() -> JjSettings:
    return JjSettings.load()
