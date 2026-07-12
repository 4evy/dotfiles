import configparser
import io
from dataclasses import dataclass
from pathlib import Path

from spectrum_build.core.common import atomic_write, fail, require_readable_file
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.http import download

ONEPASSWORD_GPG_KEY = Path("/etc/pki/rpm-gpg/RPM-GPG-KEY-1password")
REPO_DIR = "image/repos"


@dataclass(frozen=True, slots=True)
class RepositoryFile:
    destination: Path
    source: Path | str
    repo_ids: tuple[str, ...] = ()
    import_rpm_key: bool = False


def repository_files(context_dir: Path) -> tuple[RepositoryFile, ...]:
    repo_dir = Path("/etc/yum.repos.d")
    return (
        RepositoryFile(
            destination=repo_dir / "vscode.repo",
            source=context_dir / f"{REPO_DIR}/vscode.repo",
            repo_ids=("code",),
        ),
        RepositoryFile(
            destination=ONEPASSWORD_GPG_KEY,
            source="https://downloads.1password.com/linux/keys/1password.asc",
            import_rpm_key=True,
        ),
        RepositoryFile(
            destination=repo_dir / "1password.repo",
            source=context_dir / f"{REPO_DIR}/1password.repo",
            repo_ids=("1password",),
        ),
        RepositoryFile(
            destination=repo_dir / "tailscale.repo",
            source="https://pkgs.tailscale.com/stable/fedora/tailscale.repo",
            repo_ids=("tailscale-stable",),
        ),
    )


def disabled_repository_config(content: bytes, repo_ids: tuple[str, ...]) -> bytes:
    parser = configparser.ConfigParser(interpolation=None)
    parser.read_string(content.decode())
    missing = set(repo_ids).difference(parser.sections())
    if missing:
        fail(
            f"repository configuration is missing sections: {', '.join(sorted(missing))}"
        )
    for repo_id in repo_ids:
        parser[repo_id]["enabled"] = "0"

    output = io.StringIO()
    parser.write(output, space_around_delimiters=False)
    return output.getvalue().encode()


def install_repositories(context: BuildContext) -> None:
    for source in repository_files(context.config.context_dir):
        if isinstance(source.source, Path):
            require_readable_file(source.source)
            content = source.source.read_bytes()
        else:
            content = download(source.source)

        if source.repo_ids:
            content = disabled_repository_config(content, source.repo_ids)
        atomic_write(source.destination, content)

        if source.import_rpm_key:
            context.runner.require("rpm")
            context.runner.run(["rpm", "--import", source.destination])


def disable_repositories(context_dir: Path) -> None:
    for repository in repository_files(context_dir):
        if not repository.repo_ids:
            continue
        require_readable_file(repository.destination)
        atomic_write(
            repository.destination,
            disabled_repository_config(
                repository.destination.read_bytes(), repository.repo_ids
            ),
        )


def validate_repositories_disabled(context_dir: Path) -> None:
    for repository in repository_files(context_dir):
        if not repository.repo_ids:
            continue
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(repository.destination)
        for repo_id in repository.repo_ids:
            if parser.getboolean(repo_id, "enabled", fallback=True):
                fail(f"external repository is enabled in final image: {repo_id}")
