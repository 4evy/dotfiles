import grp
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from spectrum_build.core.common import fail, require_readable_file
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.repositories import (
    RepositoryFile,
    disable_repositories,
    disable_repository_files,
    install_repositories,
)


@dataclass(frozen=True, slots=True)
class PackageResolver:
    resolve: Callable[[BuildContext], Iterable[str]]


type PackageSource = tuple[str, ...] | PackageResolver


@dataclass(frozen=True, slots=True)
class SystemGroup:
    name: str
    gid: int


class FileOperationKind(StrEnum):
    ENSURE_DIRECTORY = "ensure-directory"
    REQUIRE_FILE = "require-file"
    UNLINK = "unlink"
    REMOVE_EMPTY_DIRECTORY = "remove-empty-directory"
    SYMLINK = "symlink"


@dataclass(frozen=True, slots=True)
class FileOperation:
    """One generic filesystem mutation surrounding a package installation."""

    kind: FileOperationKind
    path: Path
    target: Path | None = None

    def execute(self) -> None:
        match self.kind:
            case FileOperationKind.ENSURE_DIRECTORY:
                self.path.mkdir(parents=True, exist_ok=True)
            case FileOperationKind.REQUIRE_FILE:
                require_readable_file(self.path)
            case FileOperationKind.UNLINK:
                self.path.unlink(missing_ok=True)
            case FileOperationKind.REMOVE_EMPTY_DIRECTORY:
                self.path.rmdir()
            case FileOperationKind.SYMLINK:
                if self.target is None:
                    fail(f"symlink operation has no target: {self.path}")
                self.path.symlink_to(self.target)


def execute_file_operations(operations: Iterable[FileOperation]) -> None:
    for operation in operations:
        operation.execute()


class Program(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def validation_packages(self) -> tuple[str, ...]: ...

    def install(self, context: BuildContext) -> None: ...


def resolve_packages(source: PackageSource, context: BuildContext) -> tuple[str, ...]:
    if isinstance(source, PackageResolver):
        return tuple(source.resolve(context))
    return source


def ensure_system_groups(groups: Iterable[SystemGroup], context: BuildContext) -> None:
    for group in groups:
        try:
            current_group = grp.getgrnam(group.name)
        except KeyError:
            current_group = None

        try:
            gid_group = grp.getgrgid(group.gid)
        except KeyError:
            gid_group = None

        if gid_group is not None and gid_group.gr_name != group.name:
            fail(f"GID {group.gid} is already used by group: {gid_group.gr_name}")

        if current_group is None:
            context.runner.run([
                "groupadd",
                "--system",
                "--gid",
                str(group.gid),
                group.name,
            ])
        elif current_group.gr_gid != group.gid:
            context.runner.run([
                "groupmod",
                "--gid",
                str(group.gid),
                group.name,
            ])


@dataclass(frozen=True, slots=True)
class DnfProgram:
    """A program installed from packages, URLs, or isolated repositories."""

    name: str
    packages: PackageSource
    repositories: tuple[RepositoryFile, ...] = ()
    repository_packages: PackageSource = ()
    generated_repository_files: tuple[Path, ...] = ()
    enabled_repositories: tuple[str, ...] = ()
    system_groups: tuple[SystemGroup, ...] = ()
    before_install: tuple[FileOperation, ...] = ()
    after_install: tuple[FileOperation, ...] = ()
    validation_packages: tuple[str, ...] = ()
    nogpgcheck: bool = False

    def disable_repositories(self, *, missing_ok: bool = False) -> None:
        repositories = self.repositories
        generated_files = self.generated_repository_files
        if missing_ok:
            repositories = tuple(
                repository
                for repository in repositories
                if repository.destination.is_file()
            )
            generated_files = tuple(path for path in generated_files if path.is_file())
        disable_repositories(repositories)
        disable_repository_files(generated_files)

    def install(self, context: BuildContext) -> None:
        execute_file_operations(self.before_install)
        install_repositories(context, self.repositories)
        ensure_system_groups(self.system_groups, context)

        try:
            repository_packages = resolve_packages(self.repository_packages, context)
            if repository_packages:
                context.dnf.install(repository_packages)
            context.dnf.install(
                resolve_packages(self.packages, context),
                enabled_repositories=self.enabled_repositories,
                nogpgcheck=self.nogpgcheck,
            )
        except BaseException as install_error:
            try:
                self.disable_repositories(missing_ok=True)
            except Exception as cleanup_error:  # ruff: ignore[blind-except]
                install_error.add_note(
                    f"repository cleanup also failed: {cleanup_error}"
                )
            raise
        else:
            self.disable_repositories()
            execute_file_operations(self.after_install)


@dataclass(frozen=True, slots=True)
class CustomProgram:
    """Escape hatch for programs whose build is more than package installation."""

    name: str
    installer: Callable[[BuildContext], None]
    validation_packages: tuple[str, ...] = ()

    def install(self, context: BuildContext) -> None:
        self.installer(context)
