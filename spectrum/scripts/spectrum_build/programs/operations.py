import sys
from collections.abc import Iterable
from pathlib import Path

from spectrum_build.core.common import fail
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.repositories import RepositoryFile
from spectrum_build.programs.manifest import PROGRAMS
from spectrum_build.programs.models import DnfProgram, Program


def validate_program_manifest(programs: Iterable[Program] = PROGRAMS) -> None:
    names: set[str] = set()
    repository_paths: set[Path] = set()
    validation_packages: set[str] = set()
    for program in programs:
        normalized_name = program.name.strip().casefold()
        if not normalized_name:
            fail("program names must not be empty")
        if normalized_name in names:
            fail(f"duplicate program name: {program.name}")
        if isinstance(program, DnfProgram) and not program.validation_packages:
            fail(f"DNF program has no validation packages: {program.name}")
        for repository in getattr(program, "repositories", ()):
            _register_repository_path(repository.destination, repository_paths)
        for path in getattr(program, "generated_repository_files", ()):
            _register_repository_path(path, repository_paths)
        for package in program.validation_packages:
            if not package.strip():
                fail(f"empty validation package for program: {program.name}")
            if package in validation_packages:
                fail(f"duplicate program validation package: {package}")
            validation_packages.add(package)
        names.add(normalized_name)


def _register_repository_path(path: Path, paths: set[Path]) -> None:
    if not path.is_absolute():
        fail(f"program repository path must be absolute: {path}")
    if path in paths:
        fail(f"duplicate program repository path: {path}")
    paths.add(path)


def install_programs(context: BuildContext) -> None:
    validate_program_manifest()
    for program in PROGRAMS:
        print(f"Installing program: {program.name}", file=sys.stderr)
        program.install(context)


def program_repositories() -> tuple[RepositoryFile, ...]:
    return tuple(
        repository
        for program in PROGRAMS
        if isinstance(program, DnfProgram)
        for repository in program.repositories
    )


def program_generated_repository_files() -> tuple[Path, ...]:
    return tuple(
        path
        for program in PROGRAMS
        if isinstance(program, DnfProgram)
        for path in program.generated_repository_files
    )


def program_validation_packages() -> tuple[str, ...]:
    return tuple(
        package for program in PROGRAMS for package in program.validation_packages
    )
