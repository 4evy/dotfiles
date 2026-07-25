"""Build and install the patched native Ghostty macOS application."""

import json
import os
import tempfile
from pathlib import Path

from workstation.apps.ghostty import (
    GHOSTTY_REVISION,
    GHOSTTY_SOURCE,
    GHOSTTY_VERSION,
    BuildState,
    _apply_ghostty_patches,
    _ghostty_patch_key,
    _ghostty_patches,
    _ghostty_version_current,
    _run_logged_build,
)
from workstation.apps.installer_support import (
    extract_application_directory,
    verified_download,
)
from workstation.automation import automation_check_mode
from workstation.automation_models import OperationResult
from workstation.console import console
from workstation.errors import DotfilesError
from workstation.lib.commands import require_commands, run
from workstation.lib.files import (
    ensure_directory,
    replace_directory,
    require_executable,
)


def _ghostty_macos_toolchain() -> str:
    result = run(
        ("/usr/bin/xcodebuild", "-showComponent", "MetalToolchain", "-json"),
        capture=True,
    )
    try:
        component = json.loads(result.stdout)
        status = component["status"]
        identifier = component["toolchainIdentifier"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise DotfilesError(
            "Xcode returned invalid Metal toolchain metadata"
        ) from error
    if status != "installed":
        raise DotfilesError(
            "Xcode Metal toolchain is not installed; run the bootstrap role"
        )
    if not isinstance(identifier, str) or not identifier:
        raise DotfilesError("Xcode returned an invalid Metal toolchain identifier")
    return identifier


def _ghostty_macos_patch_current(executable: Path) -> bool:
    if not executable.is_file() or not os.access(executable, os.X_OK):
        return False
    result = run(
        (executable, "+show-config", "--default", "--no-pager"),
        check=False,
        capture=True,
    )
    return result.returncode == 0 and any(
        line.partition("=")[0].strip() == "scrollback-editor"
        for line in result.stdout.splitlines()
    )


def _build_ghostty_macos(
    cache_dir: Path,
    app_root: Path,
    zig_executable: Path,
    patches: tuple[Path, ...],
) -> None:
    build_log = cache_dir / "ghostty-tip-macos-build.log"
    source_archive = cache_dir / f"ghostty-{GHOSTTY_REVISION}.tar.gz"
    verified_download(
        source_archive,
        GHOSTTY_SOURCE.url,
        f"sha256:{GHOSTTY_SOURCE.sha256}",
    )
    with tempfile.TemporaryDirectory(prefix="build-", dir=cache_dir) as temporary:
        work = Path(temporary)
        source_dir = ensure_directory(work / "source")
        extracted = extract_application_directory(
            source_archive, source_dir, label="Ghostty source"
        )
        ghostty_source = work / "ghostty"
        extracted.replace(ghostty_source)
        _apply_ghostty_patches(ghostty_source, patches)
        _run_logged_build(
            (
                zig_executable,
                "build",
                "-Doptimize=ReleaseFast",
                "-Demit-test-exe=false",
                "-Dxcframework-target=native",
                f"-Dversion-string={GHOSTTY_VERSION}",
            ),
            build_log,
            label="Ghostty macOS",
            cwd=ghostty_source,
            env={
                "PATH": f"{zig_executable.parent}:{os.environ['PATH']}",
                "TOOLCHAINS": _ghostty_macos_toolchain(),
                "ZIG_GLOBAL_CACHE_DIR": os.fspath(cache_dir / "zig"),
            },
        )
        replace_directory(
            ghostty_source / "zig-out/Ghostty.app", app_root / "Ghostty.app"
        )


def install_ghostty_tip_macos(
    cache_dir: Path,
    app_root: Path,
    zig_executable: Path,
) -> OperationResult:
    """Build and install the patched native Ghostty macOS application."""
    app_dir = app_root / "Ghostty.app"
    executable = app_dir / "Contents/MacOS/ghostty"
    state_path = app_root / ".ghostty-tip-state.json"
    patches = _ghostty_patches()
    patch_key = _ghostty_patch_key(patches)
    state = BuildState.read(state_path)
    valid_install = _ghostty_version_current(
        executable
    ) and _ghostty_macos_patch_current(executable)
    current = (
        state is not None
        and state.revision == GHOSTTY_REVISION
        and state.inputs == {"patches": patch_key, "target": "native-macos"}
        and valid_install
    )
    if automation_check_mode():
        return OperationResult(
            changed=not current,
            msg=(
                "Ghostty macOS tip is current"
                if current
                else "Would build and install the patched Ghostty macOS tip"
            ),
        )
    if current:
        return OperationResult(msg="Ghostty macOS tip is current")

    require_commands("/usr/bin/codesign")
    if valid_install and state is None:
        run(("/usr/bin/codesign", "--verify", "--deep", "--strict", app_dir))
        BuildState.write(
            state_path,
            GHOSTTY_REVISION,
            inputs={"patches": patch_key, "target": "native-macos"},
        )
        return OperationResult(
            changed=True,
            msg="Adopted the existing patched Ghostty macOS build",
            data={"source_key": GHOSTTY_REVISION},
        )

    require_commands("git", "/usr/bin/xcodebuild")
    zig_executable = require_executable(zig_executable)
    cache_dir = ensure_directory(cache_dir)
    app_root = ensure_directory(app_root)
    ensure_directory(cache_dir / "zig")
    _build_ghostty_macos(cache_dir, app_root, zig_executable, patches)
    run(("/usr/bin/codesign", "--verify", "--deep", "--strict", app_dir))
    if not _ghostty_version_current(executable) or not _ghostty_macos_patch_current(
        executable
    ):
        raise DotfilesError("installed Ghostty macOS build failed patch verification")
    BuildState.write(
        state_path,
        GHOSTTY_REVISION,
        inputs={"patches": patch_key, "target": "native-macos"},
    )
    console.print(f"Installed patched Ghostty macOS build into {app_root}.")
    return OperationResult(
        changed=True,
        msg=f"Installed patched Ghostty macOS build into {app_root}",
        data={"source_key": GHOSTTY_REVISION},
    )
