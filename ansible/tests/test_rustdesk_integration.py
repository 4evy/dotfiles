from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_rustdesk_policy_is_enforcing_and_labels_both_rpm_layouts() -> None:
    policy = ROOT / "ansible/roles/system/files/rustdesk-selinux"
    type_enforcement = (policy / "rustdesk.te").read_text(encoding="utf-8")
    file_contexts = (policy / "rustdesk.fc").read_text(encoding="utf-8")

    assert "unconfined_domain(rustdesk_t)" in type_enforcement
    assert "permissive rustdesk_t" not in type_enforcement
    assert "/usr/lib/rustdesk/rustdesk" in file_contexts
    assert "/usr/share/rustdesk/rustdesk" in file_contexts


def test_spectrum_provisions_rustdesk_policy_build_and_service() -> None:
    recipe = (ROOT / "bluebuild/recipes/spectrum.yml").read_text(encoding="utf-8")

    assert "        - selinux-policy-devel\n" in recipe
    assert "        - rustdesk.service\n" in recipe
