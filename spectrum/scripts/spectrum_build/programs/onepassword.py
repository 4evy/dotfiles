from pathlib import Path

from spectrum_build.integrations.repositories import RepositoryFile
from spectrum_build.programs.models import DnfProgram, SystemGroup

PROGRAM = DnfProgram(
    name="1Password",
    packages=("1password", "1password-cli"),
    repositories=(
        RepositoryFile(
            destination=Path("/etc/pki/rpm-gpg/RPM-GPG-KEY-1password"),
            source="https://downloads.1password.com/linux/keys/1password.asc",
            import_rpm_key=True,
        ),
        RepositoryFile(
            destination=Path("/etc/yum.repos.d/1password.repo"),
            source=Path("image/repos/1password.repo"),
            repo_ids=("1password",),
        ),
    ),
    enabled_repositories=("1password",),
    system_groups=(
        SystemGroup("onepassword-mcp", 954),
        SystemGroup("onepassword-cli", 955),
        SystemGroup("onepassword", 956),
    ),
    validation_packages=("1password", "1password-cli"),
)
