import hashlib
import os
import tarfile
import tempfile
from pathlib import Path

from spectrum_build.core.common import fail, require_readable_file
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.http import download
from spectrum_build.programs.models import CustomProgram
from workstation.errors import DotfilesError
from workstation.lib.files import extract_tar_archive, write_if_changed
from workstation.lib.manifests import listed_files
from workstation.lib.platform import machine_architecture
from workstation.lib.sources import SOURCES

GHOSTTY_PIN = SOURCES.require("ghostty")
REVISION = GHOSTTY_PIN.require_revision()
VERSION = GHOSTTY_PIN.require_version()
SOURCE = GHOSTTY_PIN.require_artifact("source")
ZIG = GHOSTTY_PIN.require_component("zig")
ZIG_BUILD_JOBS = 2


def _verified_download(url: str, expected_sha256: str) -> bytes:
    content = download(url)
    if hashlib.sha256(content).hexdigest() != expected_sha256:
        fail(f"download checksum mismatch: {url}")
    return content


def _zig_architecture() -> str:
    try:
        return machine_architecture().zig_linux
    except DotfilesError as error:
        fail(str(error))


def _zig_build_command(zig: Path) -> tuple[str | Path, ...]:
    return (
        zig,
        "build",
        f"-j{ZIG_BUILD_JOBS}",
        "-p",
        "/usr",
        "-Doptimize=ReleaseFast",
        "-Demit-test-exe=false",
        f"-Dversion-string={VERSION}",
    )


def _zig_build_environment(zig: Path, global_cache: Path) -> dict[str, str]:
    environment = dict(os.environ)
    environment["PATH"] = f"{zig.parent}:{environment['PATH']}"
    environment["ZIG_GLOBAL_CACHE_DIR"] = str(global_cache.resolve())
    return environment


def install(context: BuildContext) -> None:
    runner = context.runner
    runner.require("git", "tar", "xz")
    patch_dir = context.config.context_dir.parent / "patches/ghostty"
    try:
        patches = listed_files(patch_dir, "series", suffix=".patch")
    except DotfilesError as error:
        fail(str(error))

    with tempfile.TemporaryDirectory(prefix="spectrum-ghostty-") as work_name:
        work = Path(work_name)
        source_archive = work / "ghostty.tar.gz"
        write_if_changed(source_archive, _verified_download(SOURCE.url, SOURCE.sha256))
        with tarfile.open(source_archive) as archive:
            extract_tar_archive(archive, work / "source")
        source = next(
            (path for path in (work / "source").iterdir() if path.info.is_dir()), None
        )
        if source is None:
            fail("Ghostty source archive did not contain a source directory")

        runner.run(["git", "apply", "--check", *patches], cwd=source)
        runner.run(["git", "apply", *patches], cwd=source)

        zig_arch = _zig_architecture()
        zig_version = ZIG.require_version()
        zig_name = f"zig-{zig_arch}-{zig_version}"
        zig_source = ZIG.require_artifact(zig_arch)
        zig_archive = work / f"{zig_name}.tar.xz"
        write_if_changed(
            zig_archive,
            _verified_download(zig_source.url, zig_source.sha256),
        )
        with tarfile.open(zig_archive) as archive:
            extract_tar_archive(archive, work / "zig")
        zig = work / "zig" / zig_name / "zig"
        require_readable_file(zig)

        # Bluefin's /root is a symlink to /var/roothome. Zig derives relative
        # run-artifact paths from its global cache, and those paths resolve one
        # directory too deep when the cache is reached through that symlink.
        # Keep the cache beside the source so its logical and physical paths
        # agree, and so build-only cache data is removed with the workspace.
        environment = _zig_build_environment(zig, work / "zig-global-cache")
        runner.run(_zig_build_command(zig), cwd=source, env=environment)

    executable = Path("/usr/bin/ghostty")
    require_readable_file(executable)
    version = runner.output([executable, "+version"])
    if VERSION not in version:
        fail(f"unexpected patched Ghostty version output: {version}")


PROGRAM = CustomProgram(name="Ghostty", installer=install)
