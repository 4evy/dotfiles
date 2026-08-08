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
    assert "/var/lib/rustdesk/dotfiles/rustdesk" in file_contexts


def test_rustdesk_service_uses_a_mutable_loader_on_composefs_hosts() -> None:
    tasks = (ROOT / "ansible/roles/system/tasks/rustdesk.yml").read_text(
        encoding="utf-8"
    )

    assert "ansible_facts.user_uid" in tasks
    assert "option: stop-service" in tasks
    assert "- /var/lib/rustdesk\n" in tasks
    assert "dest: /var/lib/rustdesk/dotfiles/rustdesk" in tasks
    assert "ExecStart=/var/lib/rustdesk/dotfiles/rustdesk --service" in tasks
    assert "restorecon\n      - -R\n      - -F" in tasks
    assert "path: /var/lib/rustdesk\n        recursive: true" in tasks
    assert "if system_rustdesk_loader is changed" in tasks


def test_spectrum_provisions_rustdesk_policy_build_and_service() -> None:
    recipe = (ROOT / "bluebuild/recipes/spectrum.yml").read_text(encoding="utf-8")

    assert "        - selinux-policy-devel\n" in recipe
    assert "        - rustdesk.service\n" in recipe
