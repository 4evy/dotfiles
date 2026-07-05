from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from spectrum_build.core.common import atomic_write, require_readable_file
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.http import download
from spectrum_build.image.platform_info import aitoolkit_repo_url, fedora_version_id


ONEPASSWORD_GPG_KEY = Path("/etc/pki/rpm-gpg/RPM-GPG-KEY-1password")
REPO_DIR = "image/repos"


@dataclass(frozen=True)
class RepositoryFile:
    destination: Path
    source: Path | str
    import_rpm_key: bool = False


def repository_files(context_dir: Path) -> tuple[RepositoryFile, ...]:
    repo_dir = Path("/etc/yum.repos.d")
    return (
        RepositoryFile(
            destination=repo_dir / "vscode.repo",
            source=context_dir / f"{REPO_DIR}/vscode.repo",
        ),
        RepositoryFile(
            destination=ONEPASSWORD_GPG_KEY,
            source="https://downloads.1password.com/linux/keys/1password.asc",
            import_rpm_key=True,
        ),
        RepositoryFile(
            destination=repo_dir / "1password.repo",
            source=context_dir / f"{REPO_DIR}/1password.repo",
        ),
        RepositoryFile(
            destination=repo_dir / "tailscale.repo",
            source="https://pkgs.tailscale.com/stable/fedora/tailscale.repo",
        ),
        RepositoryFile(
            destination=repo_dir / "iolaum-aitoolkit.repo",
            source=aitoolkit_repo_url(fedora_version_id()),
        ),
    )


def install_repositories(context: BuildContext) -> None:
    for source in repository_files(context.config.context_dir):
        if isinstance(source.source, Path):
            require_readable_file(source.source)
            content = source.source.read_bytes()
        else:
            content = download(source.source)

        atomic_write(source.destination, content)

        if source.import_rpm_key:
            context.runner.require("rpm")
            context.runner.run(["rpm", "--import", source.destination])
