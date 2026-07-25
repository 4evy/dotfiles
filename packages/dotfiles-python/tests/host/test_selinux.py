from pathlib import Path

from workstation.host.selinux import (
    RestoreTarget,
    SELinuxPolicy,
    ServiceConfinement,
)


def test_policy_derives_sources_from_module_declaration(tmp_path: Path) -> None:
    target = RestoreTarget(tmp_path / "state", recursive=True)
    policy = SELinuxPolicy(
        module="example",
        directory=tmp_path / "policy",
        hash_file=tmp_path / "example.sha256",
        restore_targets=(target,),
    )

    assert policy.source_names == ("example.te", "example.fc", "example.if")
    assert policy.restore_targets == (target,)


def test_service_confinement_derives_systemd_declaration() -> None:
    confinement = ServiceConfinement("example", "example_t")

    assert confinement.unit == "example.service"
    assert confinement.dropin == Path(
        "/etc/systemd/system/example.service.d/10-selinux-context.conf"
    )
    assert confinement.expected_context == "system_u:system_r:example_t:s0"
    assert confinement.dropin_content == (
        "[Service]\nSELinuxContext=system_u:system_r:example_t:s0\n"
    )


def test_service_confinement_preserves_explicit_unit_suffix() -> None:
    assert ServiceConfinement("example.service", "example_t").unit == "example.service"
