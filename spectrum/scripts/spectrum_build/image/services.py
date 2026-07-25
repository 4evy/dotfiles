from functools import cache

from spectrum_build.core.common import CommandRunner, fail
from workstation.errors import DotfilesError
from workstation.lib.manifests import line_manifest, manifest_path


@cache
def required_units() -> tuple[str, ...]:
    try:
        return line_manifest(manifest_path("spectrum-systemd-units.txt"))
    except DotfilesError as error:
        fail(str(error))


def validate_required_units(runner: CommandRunner) -> None:
    for unit in required_units():
        status = runner.run(
            ["systemctl", "is-enabled", unit],
            check=False,
            capture=True,
        )
        if status.stdout.strip() != "enabled":
            fail(f"systemd unit is not enabled: {unit}")
