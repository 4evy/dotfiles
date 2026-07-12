import shutil
from collections.abc import Iterable
from functools import cached_property

from spectrum_build.core.common import CommandRunner, fail


class Dnf:
    def __init__(self, runner: CommandRunner) -> None:
        self.runner = runner

    @cached_property
    def command(self) -> tuple[str, ...]:
        return self._find_command()

    def install(
        self,
        packages: Iterable[str],
        *,
        optional: bool = False,
        nogpgcheck: bool = False,
        enabled_repositories: Iterable[str] = (),
    ) -> None:
        packages = tuple(packages)
        if not packages:
            return

        self.runner.run([
            *self.command,
            "-y",
            "install",
            "--setopt=install_weak_deps=False",
            *(f"--enablerepo={repo_id}" for repo_id in enabled_repositories),
            *(("--skip-unavailable",) if optional else ()),
            *(("--nogpgcheck",) if nogpgcheck else ()),
            *packages,
        ])

    def clean(self) -> None:
        self.runner.run([*self.command, "clean", "all"])

    @staticmethod
    def _find_command() -> tuple[str, ...]:
        if command := shutil.which("dnf5"):
            return (command,)
        fail("required command not found: dnf5")
