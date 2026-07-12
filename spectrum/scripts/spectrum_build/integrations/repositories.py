import configparser
import io
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from spectrum_build.core.common import atomic_write, fail, require_readable_file
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.http import download


@dataclass(frozen=True, slots=True)
class RepositoryFile:
    destination: Path
    source: Path | str
    repo_ids: tuple[str, ...] = ()
    import_rpm_key: bool = False


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


def disable_repository_files(paths: Iterable[Path]) -> None:
    for path in paths:
        require_readable_file(path)
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(path)
        for repo_id in parser.sections():
            parser[repo_id]["enabled"] = "0"

        output = io.StringIO()
        parser.write(output, space_around_delimiters=False)
        atomic_write(path, output.getvalue().encode())


def install_repositories(
    context: BuildContext, repositories: Iterable[RepositoryFile]
) -> None:
    for source in repositories:
        if isinstance(source.source, Path):
            source_path = source.source
            if not source_path.is_absolute():
                source_path = context.config.context_dir / source_path
            require_readable_file(source_path)
            content = source_path.read_bytes()
        else:
            content = download(source.source)

        if source.repo_ids:
            content = disabled_repository_config(content, source.repo_ids)
        atomic_write(source.destination, content)

        if source.import_rpm_key:
            context.runner.require("rpm")
            context.runner.run(["rpm", "--import", source.destination])


def disable_repositories(repositories: Iterable[RepositoryFile]) -> None:
    for repository in repositories:
        if not repository.repo_ids:
            continue
        require_readable_file(repository.destination)
        atomic_write(
            repository.destination,
            disabled_repository_config(
                repository.destination.read_bytes(), repository.repo_ids
            ),
        )


def validate_repositories_disabled(repositories: Iterable[RepositoryFile]) -> None:
    for repository in repositories:
        if not repository.repo_ids:
            continue
        require_readable_file(repository.destination)
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(repository.destination)
        for repo_id in repository.repo_ids:
            if parser.getboolean(repo_id, "enabled", fallback=True):
                fail(f"external repository is enabled in final image: {repo_id}")


def validate_repository_files_disabled(paths: Iterable[Path]) -> None:
    for path in paths:
        require_readable_file(path)
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(path)
        for repo_id in parser.sections():
            if parser.getboolean(repo_id, "enabled", fallback=True):
                fail(f"external repository is enabled in final image: {repo_id}")
