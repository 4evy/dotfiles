import os
from dataclasses import dataclass
from pathlib import Path

from spectrum_build.core.common import CommandRunner, fail


@dataclass(frozen=True, slots=True)
class PinnedGitProject:
    name: str
    repo: str
    tag: str
    revision: str


def pinned_git_project(
    name: str, *, repo: str, tag: str, revision: str
) -> PinnedGitProject:
    env_prefix = f"SPECTRUM_{name.upper()}"
    getenv = os.environ.get
    return PinnedGitProject(
        name=name,
        repo=getenv(f"{env_prefix}_REPO", repo),
        tag=getenv(f"{env_prefix}_TAG", tag),
        revision=getenv(f"{env_prefix}_REVISION", revision),
    )


@dataclass(frozen=True, slots=True)
class MesonProject:
    name: str
    options: tuple[str, ...] = ()


def clone_pinned_git_ref(
    project: PinnedGitProject, destination: Path, runner: CommandRunner
) -> None:
    runner.run([
        "git",
        "clone",
        "--depth",
        "1",
        "--branch",
        project.tag,
        "--filter=blob:none",
        project.repo,
        destination,
    ])
    actual_revision = runner.output(["git", "-C", destination, "rev-parse", "HEAD"])
    if actual_revision != project.revision:
        fail(
            f"unexpected {project.name} {project.tag} revision: "
            f"got {actual_revision}, want {project.revision}"
        )


def install_meson_project(
    project: MesonProject, source: Path, build_dir: Path, runner: CommandRunner
) -> None:
    runner.run([
        "meson",
        "setup",
        build_dir,
        source,
        "--prefix=/usr",
        "--libdir=lib64",
        "--buildtype=release",
        *project.options,
    ])
    runner.run(["meson", "compile", "-C", build_dir])
    runner.run(["meson", "install", "-C", build_dir])
