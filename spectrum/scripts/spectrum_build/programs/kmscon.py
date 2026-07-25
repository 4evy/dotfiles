import tempfile
from pathlib import Path

from spectrum_build.core.common import fail, require_readable_file
from spectrum_build.core.context import BuildContext
from spectrum_build.integrations.source_build import (
    MesonProject,
    clone_pinned_git_ref,
    install_meson_project,
    pinned_git_project,
)
from spectrum_build.programs.models import CustomProgram
from workstation.lib.sources import SOURCES

# Keep this independent of the system Python minor version so image upgrades do
# not invalidate the KMSCON theme helper's import path.
ASTRAL_VENDOR_PATH = Path("/usr/lib/dotfiles/python")

BUILD_COMMANDS = (
    "cp",
    "git",
    "infocmp",
    "install",
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


def install(context: BuildContext) -> None:
    runner = context.runner
    kmscon_pin = SOURCES.require("kmscon")
    astral_pin = SOURCES.require("python_astral")
    libtsm_pin = SOURCES.require("libtsm")
    astral = pinned_git_project(
        "astral",
        repo=astral_pin.repository.clone_url,
        tag=astral_pin.require_version(),
        revision=astral_pin.require_revision(),
    )
    libtsm = pinned_git_project(
        "libtsm",
        repo=libtsm_pin.repository.clone_url,
        tag=f"v{libtsm_pin.require_version()}",
        revision=libtsm_pin.require_revision(),
    )
    kmscon = pinned_git_project(
        "kmscon",
        repo=kmscon_pin.repository.clone_url,
        tag=f"v{kmscon_pin.require_version()}",
        revision=kmscon_pin.require_revision(),
    )
    runner.require(*BUILD_COMMANDS)

    with tempfile.TemporaryDirectory(prefix="spectrum-kmscon-") as work_dir_name:
        work_dir = Path(work_dir_name)
        astral_source = work_dir / astral.name
        libtsm_source = work_dir / LIBTSM.name
        kmscon_source = work_dir / KMSCON.name

        clone_pinned_git_ref(astral, astral_source, runner)
        runner.run(["install", "-d", ASTRAL_VENDOR_PATH])
        runner.run([
            "cp",
            "-a",
            astral_source / "src/astral",
            ASTRAL_VENDOR_PATH,
        ])
        license_dir = Path("/usr/share/licenses/python3-astral")
        runner.run(["install", "-d", license_dir])
        runner.run(["install", "-m", "0644", astral_source / "LICENSE", license_dir])

        clone_pinned_git_ref(libtsm, libtsm_source, runner)
        install_meson_project(LIBTSM, libtsm_source, work_dir / "libtsm-build", runner)
        runner.run(["ldconfig"])

        libtsm_version = runner.output(["pkg-config", "--modversion", "libtsm"])
        if libtsm_version != libtsm_pin.require_version():
            fail(f"unexpected libtsm version: {libtsm_version}")

        clone_pinned_git_ref(kmscon, kmscon_source, runner)
        install_meson_project(KMSCON, kmscon_source, work_dir / "kmscon-build", runner)

        terminfo = kmscon_source / "scripts/terminfo/kmscon.ti"
        require_readable_file(terminfo)
        runner.run(["tic", "-x", "-o", "/usr/share/terminfo", terminfo])
        runner.run(["ldconfig"])

    astral_version = runner.output([
        "/usr/bin/python3.14",
        "-c",
        (
            "import sys; "
            f"sys.path.insert(0, {str(ASTRAL_VENDOR_PATH)!r}); "
            "import astral; print(astral.__version__)"
        ),
    ])
    if astral_version != astral.tag:
        fail(f"unexpected Astral version: {astral_version}")

    expected_version = f"kmscon version {kmscon.tag}"
    actual_version = runner.output(["kmscon", "--version"])
    if actual_version != expected_version:
        fail(f"unexpected kmscon version: {actual_version}")

    require_readable_file(Path("/usr/lib/systemd/system/kmsconvt@.service"))
    runner.run(["infocmp", "kmscon"], discard_output=True)


PROGRAM = CustomProgram(name="KMSCON", installer=install)
