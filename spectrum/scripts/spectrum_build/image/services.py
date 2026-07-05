from __future__ import annotations

import shutil
import subprocess

from spectrum_build.core.common import CommandRunner, fail


REQUIRED_UNITS = (
    "pcscd.socket",
    "podman.socket",
    "systemd-oomd.service",
    "systemd-oomd.socket",
    "tailscaled.service",
    "uresourced.service",
)


def disable_authselect_feature(feature: str, runner: CommandRunner) -> None:
    if (
        shutil.which("authselect")
        and runner.run(
            ["authselect", "is-feature-enabled", feature], check=False
        ).returncode
        == 0
    ):
        runner.run(["authselect", "disable-feature", feature])


def enable_required_units(runner: CommandRunner) -> None:
    runner.require("systemctl")
    runner.run(["systemctl", "enable", *REQUIRED_UNITS])


def validate_required_units(runner: CommandRunner) -> None:
    for unit in REQUIRED_UNITS:
        status = runner.run(
            ["systemctl", "is-enabled", unit],
            check=False,
            stdout=subprocess.PIPE,
        )
        if status.stdout.strip() != "enabled":
            fail(f"systemd unit is not enabled: {unit}")
