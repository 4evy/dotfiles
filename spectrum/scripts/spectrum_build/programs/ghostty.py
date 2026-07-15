import hashlib
import os
import platform
import tarfile
import tempfile
from pathlib import Path

from spectrum_build.core.common import fail, require_readable_file
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.http import download
from spectrum_build.programs.models import CustomProgram
from workstation.lib.files import extract_tar_archive, write_if_changed

REVISION = "a887df42c56f6de86c0fe6da9c4eeca37931e083"
VERSION = "1.3.2-dev.a887df4"
SOURCE_URL = f"https://github.com/ghostty-org/ghostty/archive/{REVISION}.tar.gz"
SOURCE_SHA256 = "fb4b2f9ffa0af125983041fdbe4ef94d3fa79fb9f2d22b9c213c0e3847a866b6"
ZIG_VERSION = "0.15.2"
ZIG_BUILD_JOBS = 2
ZIG_SHA256 = {
    "x86_64-linux": "02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239",
    "aarch64-linux": "958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f",
}


def _verified_download(url: str, expected_sha256: str) -> bytes:
    content = download(url)
    if hashlib.sha256(content).hexdigest() != expected_sha256:
        fail(f"download checksum mismatch: {url}")
    return content


def _zig_architecture() -> str:
    architecture = platform.machine().lower()
    if architecture == "x86_64":
        return "x86_64-linux"
    if architecture in {"aarch64", "arm64"}:
        return "aarch64-linux"
    fail(f"unsupported Ghostty build architecture: {architecture}")


def _zig_build_command(zig: Path) -> tuple[str | Path, ...]:
    return (
        zig,
        "build",
        f"-j{ZIG_BUILD_JOBS}",
        "-p",
        "/usr",
        "-Doptimize=ReleaseFast",
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
    patches = tuple(sorted(patch_dir.glob("*.patch")))
    if not patches:
        fail(f"Ghostty patch series is empty: {patch_dir}")

    with tempfile.TemporaryDirectory(prefix="spectrum-ghostty-") as work_name:
        work = Path(work_name)
        source_archive = work / "ghostty.tar.gz"
        write_if_changed(source_archive, _verified_download(SOURCE_URL, SOURCE_SHA256))
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
        zig_name = f"zig-{zig_arch}-{ZIG_VERSION}"
        zig_archive = work / f"{zig_name}.tar.xz"
        write_if_changed(
            zig_archive,
            _verified_download(
                f"https://ziglang.org/download/{ZIG_VERSION}/{zig_name}.tar.xz",
                ZIG_SHA256[zig_arch],
            ),
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
