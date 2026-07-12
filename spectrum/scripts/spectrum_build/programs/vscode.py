from pathlib import Path

from spectrum_build.integrations.repositories import RepositoryFile
from spectrum_build.programs.models import DnfProgram

PROGRAM = DnfProgram(
    name="Visual Studio Code",
    packages=("code",),
    repositories=(
        RepositoryFile(
            destination=Path("/etc/yum.repos.d/vscode.repo"),
            source=Path("image/repos/vscode.repo"),
            repo_ids=("code",),
        ),
    ),
    enabled_repositories=("code",),
    validation_packages=("code",),
)
