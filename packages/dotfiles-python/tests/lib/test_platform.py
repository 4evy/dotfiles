import pytest

from workstation.errors import DotfilesError
from workstation.lib import platform as platform_lib


@pytest.mark.parametrize(
    ("machine", "name", "fedora", "zig_linux"),
    [
        ("aarch64", "arm64", "aarch64", "aarch64-linux"),
        ("arm64", "arm64", "aarch64", "aarch64-linux"),
        ("amd64", "x86_64", "x86_64", "x86_64-linux"),
        ("x86_64", "x86_64", "x86_64", "x86_64-linux"),
    ],
)
def test_machine_architecture_normalizes_aliases(
    machine: str,
    name: platform_lib.ArchitectureName,
    fedora: platform_lib.FedoraArchitecture,
    zig_linux: platform_lib.ZigLinuxArchitecture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(platform_lib.platform, "machine", lambda: machine)

    architecture = platform_lib.machine_architecture()

    assert architecture.name == name
    assert architecture.fedora == fedora
    assert architecture.zig_linux == zig_linux


def test_machine_architecture_rejects_unknown_machine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(platform_lib.platform, "machine", lambda: "mips")

    with pytest.raises(DotfilesError, match="unsupported machine architecture: mips"):
        platform_lib.machine_architecture()
