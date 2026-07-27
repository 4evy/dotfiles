from typing import ClassVar

from workstation.lib.settings import EnvironmentSettings


class JjSettings(EnvironmentSettings):
    configuration_name: ClassVar[str] = "jj"

    jj_workspace_root: str | None = None
    jj_get_repo: str | None = None
    jj_get_pr_remote: str = "github-pr"
    jj_get_base: str | None = None


def settings() -> JjSettings:
    return JjSettings.load()
