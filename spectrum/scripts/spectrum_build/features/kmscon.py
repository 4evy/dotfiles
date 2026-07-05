from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from spectrum_build.core.common import CommandRunner, fail, require_readable_file
from spectrum_build.integrations.source_build import (
    MesonProject,
    clone_pinned_git_ref,
    install_meson_project,
    pinned_git_project,
)


KMSCON_BUILD_COMMANDS = (
    "git",
    "infocmp",
    "ldconfig",
    "meson",
    "ninja",
    "pkg-config",
    "tic",
)

LIBTSM = MesonProject("libtsm", ("-Dtests=false",))
KMSCON = MesonProject(
    "kmscon",
    (
        "-Dtests=false",
        "-Ddocs=disabled",
        "-Dlibseat=disabled",
        "-Ddbus=enabled",
        "-Dvideo_drm2d=enabled",
        "-Dvideo_drm3d=enabled",
        "-Drenderer_gltex=enabled",
        "-Dfont_freetype=enabled",
        "-Dfont_pango=enabled",
        "-Dfont_unifont=enabled",
        "-Dterm=kmscon",
    ),
)


def install(runner: CommandRunner) -> None:
    libtsm = pinned_git_project(
        "libtsm",
        repo="https://github.com/kmscon/libtsm.git",
        tag="v4.6.0",
        revision="e1e4d296f0963d1641456f1f778f0ac090429a3e",
    )
    kmscon = pinned_git_project(
        "kmscon",
        repo="https://github.com/kmscon/kmscon.git",
        tag="v10.0.1",
        revision="c9d0e23336c6bb7645a1f5f48a4a82f1d5a589d9",
    )
    runner.require(*KMSCON_BUILD_COMMANDS)

    with tempfile.TemporaryDirectory(prefix="spectrum-kmscon-") as work_dir_name:
        work_dir = Path(work_dir_name)
        libtsm_source = work_dir / LIBTSM.name
        kmscon_source = work_dir / KMSCON.name

        clone_pinned_git_ref(libtsm, libtsm_source, runner)
        install_meson_project(LIBTSM, libtsm_source, work_dir / "libtsm-build", runner)
        runner.run(["ldconfig"])

        libtsm_version = runner.output(["pkg-config", "--modversion", "libtsm"])
        if libtsm_version != "4.6.0":
            fail(f"unexpected libtsm version: {libtsm_version}")

        clone_pinned_git_ref(kmscon, kmscon_source, runner)
        install_meson_project(KMSCON, kmscon_source, work_dir / "kmscon-build", runner)

        terminfo = kmscon_source / "scripts/terminfo/kmscon.ti"
        require_readable_file(terminfo)
        runner.run(["tic", "-x", "-o", "/usr/share/terminfo", terminfo])
        runner.run(["ldconfig"])

    expected_version = f"kmscon version {kmscon.tag}"
    actual_version = runner.output(["kmscon", "--version"])
    if actual_version != expected_version:
        fail(f"unexpected kmscon version: {actual_version}")

    require_readable_file(Path("/usr/lib/systemd/system/kmsconvt@.service"))
    runner.run(["infocmp", "kmscon"], stdout=subprocess.DEVNULL)
