import hashlib
import os
import re
import tempfile
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from workstation.apps.installer_support import (
    extract_application_directory,
)
from workstation.automation import automation_check_mode
from workstation.automation_models import OperationResult
from workstation.console import console
from workstation.errors import DotfilesError
from workstation.lib.commands import require_commands, run, which
from workstation.lib.files import (
    ensure_directory,
    install_file_if_changed,
    remove_path,
    write_if_changed,
)
from workstation.lib.http import download
from workstation.lib.manifests import listed_files
from workstation.lib.paths import asset_path
from workstation.lib.platform import machine_architecture
from workstation.lib.settings import EnvironmentSettings
from workstation.lib.sources import SOURCES

GHOSTTY_PIN = SOURCES.require("ghostty")
GHOSTTY_REVISION = GHOSTTY_PIN.require_revision()
GHOSTTY_VERSION = GHOSTTY_PIN.require_version()
GHOSTTY_SOURCE = GHOSTTY_PIN.require_artifact("source")
GHOSTTY_ZIG = GHOSTTY_PIN.require_component("zig")


def _ghostty_patches() -> tuple[Path, ...]:
    return listed_files(
        asset_path("apps", "ghostty", "patches"),
        "series",
        suffix=".patch",
    )


def _ghostty_patch_key(patches: tuple[Path, ...]) -> str:
    digest = hashlib.sha256()
    for patch in patches:
        digest.update(patch.name.encode())
        digest.update(b"\0")
        digest.update(patch.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _apply_ghostty_patches(source: Path, patches: tuple[Path, ...]) -> None:
    arguments = tuple(os.fspath(patch) for patch in patches)
    result = run(("git", "apply", "--check", *arguments), cwd=source, check=False)
    if result.returncode != 0:
        raise DotfilesError("Ghostty patch series does not apply to the tip source")
    run(("git", "apply", *arguments), cwd=source)


def _merge_install_tree(source: Path, destination: Path) -> None:
    """Merge a staged prefix without copying directory ownership or timestamps."""
    ensure_directory(destination)
    for source_path in source.iterdir():
        destination_path = destination / source_path.name
        source_info = source_path.info
        destination_info = destination_path.info
        if source_info.is_symlink():
            remove_path(destination_path)
            destination_path.symlink_to(source_path.readlink())
        elif source_info.is_dir():
            if destination_info.exists(follow_symlinks=False) and (
                not destination_info.is_dir(follow_symlinks=False)
            ):
                remove_path(destination_path)
            _merge_install_tree(source_path, destination_path)
        else:
            if destination_path.is_dir():
                remove_path(destination_path)
            install_file_if_changed(
                source_path,
                destination_path,
                f"{source_path.stat().st_mode & 0o777:04o}",
            )


class InstallerSettings(EnvironmentSettings):
    configuration_name: ClassVar[str] = "Ghostty installer"

    ghostty_tip_check_interval_seconds: int = Field(86400, ge=0)
    ghostty_build_container_image: str = "registry.fedoraproject.org/fedora:latest"


class BuildState(BaseModel):
    """One validated freshness record for a source-built application."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal[1] = 1
    revision: str = Field(min_length=1)
    checked_at: int = Field(ge=0)
    inputs: dict[str, str] = Field(default_factory=dict)

    @classmethod
    def read(cls, path: Path) -> BuildState | None:
        try:
            return cls.model_validate_json(path.read_bytes())
        except OSError, ValidationError:
            return None

    @classmethod
    def write(
        cls, path: Path, revision: str, *, inputs: dict[str, str] | None = None
    ) -> BuildState:
        state = cls(
            revision=revision,
            checked_at=int(time.time()),
            inputs=inputs or {},
        )
        write_if_changed(path, state.model_dump_json(indent=2) + "\n")
        return state

    def is_fresh(self, interval: int) -> bool:
        age = int(time.time()) - self.checked_at
        return 0 <= age < interval


def _missing_libraries(executable: Path) -> list[str]:
    if not executable.is_file() or not os.access(executable, os.X_OK):
        return []
    result = run(("ldd", executable), check=False, capture=True, env={"LC_ALL": "C"})
    return [
        line.split()[0]
        for line in result.stdout.splitlines()
        if line.rstrip().endswith("=> not found")
    ]


def _verify_ghostty_runtime(executable: Path) -> None:
    missing = _missing_libraries(executable)
    if not missing:
        return
    details = "\n".join(f"  {name}" for name in missing)
    message = f"Ghostty is missing runtime libraries:\n{details}"
    if "libgtk4-layer-shell.so.0" in missing:
        message += (
            "\nAdd gtk4-layer-shell to the Spectrum image, boot into it, and retry."
        )
    raise DotfilesError(message)


def _ghostty_version_current(executable: Path) -> bool:
    if not executable.is_file() or not os.access(executable, os.X_OK):
        return False
    result = run((executable, "+version"), check=False, capture=True)
    return result.returncode == 0 and GHOSTTY_VERSION in result.stdout


def _zig_architecture() -> str:
    return machine_architecture().zig_linux


def _rewrite_ghostty_files(prefix: Path, executable: Path) -> None:
    desktop = prefix / "share/applications/com.mitchellh.ghostty.desktop"
    if desktop.is_file():
        content = desktop.read_text()
        content = re.sub(
            r"^TryExec=.*$", f"TryExec={executable}", content, flags=re.MULTILINE
        )
        content = re.sub(
            r"^Exec=.*ghostty --gtk-single-instance=true$",
            f"Exec={executable} --gtk-single-instance=true",
            content,
            flags=re.MULTILINE,
        )
        content = re.sub(
            r"^DBusActivatable=.*$",
            "DBusActivatable=false",
            content,
            flags=re.MULTILINE,
        )
        write_if_changed(desktop, content)
    for service in (
        prefix / "share/dbus-1/services/com.mitchellh.ghostty.service",
        prefix / "share/systemd/user/app-com.mitchellh.ghostty.service",
    ):
        if service.is_file():
            content = service.read_text().replace(
                "Exec=/work/stage/bin/ghostty", f"Exec={executable}"
            )
            content = content.replace(
                "ExecStart=/work/stage/bin/ghostty", f"ExecStart={executable}"
            )
            write_if_changed(service, content)


def _run_logged_build(
    argv: Sequence[str | os.PathLike[str]],
    build_log: Path,
    *,
    label: str,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> None:
    result = run(argv, cwd=cwd, env=env, check=False, capture=True)
    write_if_changed(build_log, result.stdout + result.stderr)
    if result.returncode != 0:
        tail = "\n".join(build_log.read_text(encoding="utf-8").splitlines()[-160:])
        raise DotfilesError(
            f"{label} build failed; tail of {build_log} follows:\n{tail}"
        )


def _build_ghostty(
    cache_dir: Path,
    install_prefix: Path,
    executable: Path,
    patches: tuple[Path, ...],
    container_image: str,
) -> None:
    build_log = cache_dir / "ghostty-tip-build.log"
    with tempfile.TemporaryDirectory(prefix="build-", dir=cache_dir) as temporary:
        work = Path(temporary)
        source_dir = ensure_directory(work / "source")
        stage_dir = ensure_directory(work / "stage")
        source_archive = work / "ghostty-source.tar.gz"
        download(
            GHOSTTY_SOURCE.url,
            source_archive,
            expected_sha256=GHOSTTY_SOURCE.sha256,
        )
        extracted = extract_application_directory(
            source_archive, source_dir, label="Ghostty source"
        )
        ghostty_source = work / "ghostty"
        extracted.replace(ghostty_source)
        _apply_ghostty_patches(ghostty_source, patches)
        container_script = asset_path("apps", "install-ghostty-tip-linux.container.py")
        zig_architecture = _zig_architecture()
        zig_artifact = GHOSTTY_ZIG.require_artifact(zig_architecture)
        _run_logged_build(
            (
                "podman",
                "run",
                "--rm",
                "--security-opt",
                "label=disable",
                "--volume",
                f"{work}:/work",
                "--volume",
                f"{container_script}:/tmp/ghostty-build.py:ro",
                "--workdir",
                "/work/ghostty",
                "--env",
                f"ZIG_ARCH={zig_architecture}",
                "--env",
                f"ZIG_VERSION={GHOSTTY_ZIG.require_version()}",
                "--env",
                f"ZIG_URL={zig_artifact.url}",
                "--env",
                f"ZIG_SHA256={zig_artifact.sha256}",
                "--env",
                f"GHOSTTY_VERSION={GHOSTTY_VERSION}",
                container_image,
                "sh",
                "-ceu",
                (
                    "dnf -y install --setopt=install_weak_deps=False python3.14 && "
                    "exec python3.14 /tmp/ghostty-build.py"
                ),
            ),
            build_log,
            label="Ghostty",
        )
        built_binary = stage_dir / "bin/ghostty"
        pending = work / ".ghostty-bin"
        if built_binary.is_file():
            built_binary.replace(pending)
        _merge_install_tree(stage_dir, install_prefix)
        if pending.is_file():
            ensure_directory(executable.parent)
            install_file_if_changed(
                pending,
                executable,
                f"{pending.stat().st_mode & 0o777:04o}",
            )


def install_ghostty_tip_linux(
    cache_dir: Path,
    install_prefix: Path,
) -> OperationResult:
    """Build the Ghostty tip release in a disposable Fedora container."""
    executable = install_prefix / "bin/ghostty"
    state_path = install_prefix / ".ghostty-tip-state.json"
    patches = _ghostty_patches()
    patch_key = _ghostty_patch_key(patches)
    settings = InstallerSettings.load()
    interval = settings.ghostty_tip_check_interval_seconds
    state = BuildState.read(state_path)
    current = (
        state is not None
        and state.revision == GHOSTTY_REVISION
        and state.inputs == {"patches": patch_key}
        and executable.is_file()
        and not _missing_libraries(executable)
        and _ghostty_version_current(executable)
    )
    fresh = current and state.is_fresh(interval)
    if automation_check_mode():
        return OperationResult(
            changed=not fresh,
            msg=(
                "Ghostty tip is current"
                if fresh
                else "Would check and install the current Ghostty tip"
            ),
        )
    require_commands("git", "podman")
    cache_dir = ensure_directory(cache_dir)
    install_prefix = ensure_directory(install_prefix)
    if fresh:
        console.print(
            f"Ghostty tip was checked less than {interval} seconds ago; skipping."
        )
        return OperationResult(msg="Ghostty tip was checked recently")
    if executable.exists():
        _verify_ghostty_runtime(executable)
    if current:
        BuildState.write(
            state_path,
            GHOSTTY_REVISION,
            inputs={"patches": patch_key},
        )
        console.print("Ghostty tip source is already current.")
        return OperationResult(
            msg="Ghostty tip source is already current",
            data={"source_key": GHOSTTY_REVISION},
        )

    _build_ghostty(
        cache_dir,
        install_prefix,
        executable,
        patches,
        settings.ghostty_build_container_image,
    )

    _rewrite_ghostty_files(install_prefix, executable)
    desktop_dir = install_prefix / "share/applications"
    if which("update-desktop-database") is not None and desktop_dir.is_dir():
        run(("update-desktop-database", desktop_dir), check=False, capture=True)
    _verify_ghostty_runtime(executable)
    BuildState.write(
        state_path,
        GHOSTTY_REVISION,
        inputs={"patches": patch_key},
    )
    console.print(f"Installed native Ghostty tip release build into {install_prefix}.")
    return OperationResult(
        changed=True,
        msg=f"Installed native Ghostty tip release build into {install_prefix}",
        data={"source_key": GHOSTTY_REVISION},
    )
