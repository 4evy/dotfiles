#!/usr/bin/env python3.14
"""Provision Toshy's user files against the pinned external runtime."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(
    *arguments: str | Path,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> None:
    subprocess.run(tuple(map(str, arguments)), check=True, cwd=cwd, env=env)


def main() -> None:
    home = Path.home()
    state = Path(os.environ.get("XDG_STATE_HOME", home / ".local/state")) / "toshy"
    state.mkdir(parents=True, exist_ok=True)
    runtime = state / "runtime"
    if not Path("/etc/NIXOS").exists():
        run("nix", "build", ".#toshy-runtime", "--out-link", runtime, cwd=ROOT)
    if not runtime.is_dir():
        raise RuntimeError("Rebuild NixOS before provisioning Toshy's user files")
    source = runtime / "share/toshy/source"
    revision = (runtime / "share/toshy/revision").read_text().strip()
    config_dir = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "toshy"
    config = config_dir / "toshy_config.py"
    stamp = state / "installed-revision"
    env = dict(os.environ, TOSHY_RUNTIME_DIR=str(runtime))
    if (
        os.environ.get("TOSHY_RUN_INSTALLER") == "1"
        or not config.is_file()
        or not stamp.is_file()
        or stamp.read_text().strip() != revision
    ):
        provision_user_files(source, runtime, env)
        stamp.write_text(revision + "\n")
    run("systemctl", "--user", "daemon-reload")
    with tempfile.TemporaryDirectory(prefix="toshy-config.") as temporary:
        merged = Path(temporary) / "toshy_config.py"
        run(
            runtime / "bin/python",
            ROOT / "packages/toshy/user/setup/slices.py",
            config,
            ROOT / "packages/toshy/user/slices",
            merged,
            "--upstream-config",
            source / "default-toshy-config/toshy_config_barebones.py",
            "--reset-slice",
            "keymapper_api",
        )
        compile(merged.read_text(), str(config), "exec")
        if config.read_bytes() != merged.read_bytes():
            shutil.copy2(merged, config)
            run("systemctl", "--user", "restart", "toshy-config.service")
    subprocess.run(
        ["systemctl", "--user", "disable", "--now", "toshy-tray.service"],
        check=False,
        stderr=subprocess.DEVNULL,
    )
    # Arming the path watcher is enough: running its oneshot here restarts a
    # healthy remapper on every apply, discarding any keys currently held
    run(
        "systemctl",
        "--user",
        "start",
        "toshy-config.service",
        "toshy-kanata-device.path",
    )
    hide_desktop_surfaces(home)
    run("systemctl", "is-active", "--quiet", "kanata-main.service")
    run("systemctl", "--user", "is-active", "--quiet", "toshy-config.service")
    device = Path("/run/kanata-main/main")
    if not device.is_symlink() or not str(device.readlink()).startswith(
        "/dev/input/event"
    ):
        raise RuntimeError("Kanata has not published its virtual input device")


def provision_user_files(
    source: Path,
    runtime: Path,
    env: dict[str, str],
) -> None:
    with tempfile.TemporaryDirectory(prefix="toshy.") as temporary:
        checkout = Path(temporary) / "source"
        copy_mutable_tree(source, checkout)
        run(
            runtime / "bin/python",
            ROOT / "packages/toshy/user/setup/setup.py",
            checkout / "setup_toshy.py",
            cwd=checkout,
            env=env,
        )


def copy_mutable_tree(source: Path, destination: Path) -> None:
    destination.mkdir(mode=0o755)
    for entry in source.iterdir():
        target = destination / entry.name
        if entry.is_symlink():
            target.symlink_to(entry.readlink())
        elif entry.is_dir():
            copy_mutable_tree(entry, target)
        else:
            shutil.copyfile(entry, target)
            target.chmod(entry.stat().st_mode | 0o200)


def hide_desktop_surfaces(home: Path) -> None:
    for directory in (home / ".local/share/applications", home / ".config/autostart"):
        for name in ("Toshy_Tray.desktop", "app.toshy.preferences.desktop"):
            path = directory / name
            if path.is_file():
                text = path.read_text()
                if "NoDisplay=true" not in text:
                    text = text.replace(
                        "[Desktop Entry]", "[Desktop Entry]\nNoDisplay=true"
                    )
                    path.write_text(text)


if __name__ == "__main__":
    main()
