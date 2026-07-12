from pathlib import Path

from spectrum_build.integrations.repositories import RepositoryFile
from spectrum_build.programs.models import DnfProgram

PROGRAM = DnfProgram(
    name="Tailscale",
    packages=("tailscale",),
    repositories=(
        RepositoryFile(
            destination=Path("/etc/yum.repos.d/tailscale.repo"),
            source="https://pkgs.tailscale.com/stable/fedora/tailscale.repo",
            repo_ids=("tailscale-stable",),
        ),
    ),
    enabled_repositories=("tailscale-stable",),
    validation_packages=("tailscale",),
)
