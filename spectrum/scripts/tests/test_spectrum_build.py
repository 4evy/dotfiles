import os
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING

import pytest

from spectrum_build.core.common import BuildError, CommandRunner, atomic_write
from spectrum_build.features import kmscon
from spectrum_build.image import platform_info
from spectrum_build.image.shell import (
    BLUEFIN_OPEN_ALIAS,
    BREW_PROFILE_BAD_PATH_GUARD,
    BREW_PROFILE_PATH_GUARD,
    patch_brew_profile_guard,
    remove_bluefin_open_alias,
)
from spectrum_build.integrations import github, repositories
from spectrum_build.integrations.dnf import Dnf
from spectrum_build.integrations.source_build import (
    PinnedGitProject,
    clone_pinned_git_ref,
    pinned_git_project,
)
from spectrum_build.settings import BuildConfig, ImageConfig

if TYPE_CHECKING:
    from collections.abc import Sequence


def test_image_config_derives_defaults_and_honors_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("IMAGE_NAME", "custom")
    monkeypatch.setenv("IMAGE_VENDOR", "example")
    monkeypatch.setenv("IMAGE_TAG", "testing")

    image = ImageConfig()

    assert image.resolved_ref == "ostree-image:docker://ghcr.io/example/custom"
    assert image.resolved_version == "testing"
    assert image.image_info()["image-ref"] == image.resolved_ref


def test_image_config_records_pinned_base_and_fedora_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    digest = f"sha256:{'a' * 64}"
    monkeypatch.setenv(
        "BLUEFIN_BASE_IMAGE", f"ghcr.io/ublue-os/bluefin:stable@{digest}"
    )

    image = ImageConfig()
    metadata = image.image_info(fedora_version="44")

    assert image.base_image_ref == "ghcr.io/ublue-os/bluefin:stable"
    assert image.base_image_digest == digest
    assert metadata["base-image-digest"] == digest
    assert metadata["fedora-version"] == "44"


def test_build_config_prefers_context_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    configured = tmp_path / "configured"
    monkeypatch.setenv("CTX_DIR", os.fspath(configured))

    config = BuildConfig.from_environment(default_context=tmp_path / "default")

    assert config.context_dir == configured


def test_atomic_write_is_idempotent_but_repairs_mode(tmp_path: Path) -> None:
    destination = tmp_path / "nested/value"
    atomic_write(destination, b"content", 0o600)
    destination.chmod(0o644)
    original_inode = destination.stat().st_ino

    atomic_write(destination, b"content", 0o600)

    assert destination.read_bytes() == b"content"
    assert destination.stat().st_ino == original_inode
    assert destination.stat().st_mode & 0o777 == 0o600


def test_dnf_cli_preserves_optional_and_signature_flags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = CommandRunner()
    commands: list[tuple[str, ...]] = []

    def record(
        args: Sequence[str | Path], *, check: bool = True, stdout: int | None = None
    ) -> None:
        del check, stdout
        commands.append(tuple(map(str, args)))

    monkeypatch.setattr(runner, "run", record)
    dnf = Dnf(runner)
    dnf.__dict__["command"] = ("dnf5",)

    dnf.install(
        ["https://example.invalid/package.rpm"],
        optional=True,
        nogpgcheck=True,
        enabled_repositories=("vendor",),
    )

    assert commands == [
        (
            "dnf5",
            "-y",
            "install",
            "--setopt=install_weak_deps=False",
            "--enablerepo=vendor",
            "--skip-unavailable",
            "--nogpgcheck",
            "https://example.invalid/package.rpm",
        )
    ]


def test_repository_configuration_is_disabled_and_validated() -> None:
    content = b"[vendor]\nname=Vendor\nenabled=1\nbaseurl=https://example.invalid\n"

    result = repositories.disabled_repository_config(content, ("vendor",)).decode()

    assert "[vendor]" in result
    assert "enabled=0" in result
    with pytest.raises(BuildError, match="missing sections: other"):
        repositories.disabled_repository_config(content, ("other",))


def test_installed_repository_configuration_is_redisabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    destination = tmp_path / "vendor.repo"
    destination.write_text(
        "[vendor]\nname=Vendor\nenabled=1\nbaseurl=https://example.invalid\n"
    )
    repository = repositories.RepositoryFile(
        destination=destination,
        source=destination,
        repo_ids=("vendor",),
    )
    monkeypatch.setattr(repositories, "repository_files", lambda _: (repository,))

    repositories.disable_repositories(tmp_path)

    assert "enabled=0" in destination.read_text()


def test_github_sdk_selects_matching_release_asset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assets = [
        SimpleNamespace(name="example.txt", browser_download_url="wrong"),
        SimpleNamespace(
            name="example-1.x86_64.rpm",
            browser_download_url="https://example.invalid/example.rpm",
        ),
    ]
    response = SimpleNamespace(parsed_data=SimpleNamespace(assets=assets))
    repos = SimpleNamespace(get_latest_release=lambda *_args: response)
    client = SimpleNamespace(rest=SimpleNamespace(repos=repos))
    monkeypatch.setattr(github, "GitHub", lambda *_args, **_kwargs: client)

    assert github.latest_github_asset_url(
        "owner/repo", r"example-[0-9]\.x86_64\.rpm"
    ) == ("https://example.invalid/example.rpm")


def test_pinned_project_environment_is_namespaced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SPECTRUM_KMSCON_REPO", "https://example.invalid/repo")
    monkeypatch.setenv("SPECTRUM_KMSCON_TAG", "v2")
    monkeypatch.setenv("SPECTRUM_KMSCON_REVISION", "b" * 40)

    project = pinned_git_project("kmscon", repo="default", tag="v1", revision="a" * 40)

    assert project == PinnedGitProject(
        name="kmscon",
        repo="https://example.invalid/repo",
        tag="v2",
        revision="b" * 40,
    )


def test_kmscon_uses_system_python_site_packages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = CommandRunner()
    calls: list[Sequence[str | Path]] = []

    def fake_output(args: Sequence[str | Path]) -> str:
        calls.append(args)
        return "/usr/lib/python3.14/site-packages"

    monkeypatch.setattr(runner, "output", fake_output)

    assert kmscon.python_system_site_packages(runner) == Path(
        "/usr/lib/python3.14/site-packages"
    )
    assert calls == [
        [
            "/usr/bin/python3",
            "-c",
            kmscon.PYTHON_SYSTEM_SITE_PACKAGES,
        ]
    ]


def test_clone_rejects_tag_resolving_to_unexpected_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = CommandRunner()
    monkeypatch.setattr(runner, "run", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "output", lambda *_args, **_kwargs: "b" * 40)
    project = PinnedGitProject("example", "repo", "v1", "a" * 40)

    with pytest.raises(BuildError, match="unexpected example v1 revision"):
        clone_pinned_git_ref(project, tmp_path / "checkout", runner)


def test_os_release_update_quotes_values_and_rejects_invalid_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    os_release = tmp_path / "os-release"
    os_release.write_text('NAME="Spectrum"\nVERSION_ID="1"\n')
    monkeypatch.setattr(platform_info, "OS_RELEASE", os_release)

    platform_info.set_os_release_value("VERSION_ID", '2"\\candidate')

    assert os_release.read_text() == (
        'NAME="Spectrum"\nVERSION_ID="2\\"\\\\candidate"\n'
    )
    with pytest.raises(BuildError, match="invalid os-release key"):
        platform_info.set_os_release_value("invalid-key", "value")


def test_shell_patches_are_idempotent_and_refuse_unknown_aliases(
    tmp_path: Path,
) -> None:
    alias = tmp_path / "usr/etc/profile.d/open.sh"
    alias.parent.mkdir(parents=True)
    alias.write_text(f"{BLUEFIN_OPEN_ALIAS}\n")
    brew = tmp_path / "etc/profile.d/brew.sh"
    brew.parent.mkdir(parents=True)
    brew.write_text(f"if [[ {BREW_PROFILE_BAD_PATH_GUARD} ]]; then\n  true\nfi\n")

    remove_bluefin_open_alias(tmp_path)
    patch_brew_profile_guard(tmp_path)
    remove_bluefin_open_alias(tmp_path)
    patch_brew_profile_guard(tmp_path)

    assert not alias.exists()
    assert BREW_PROFILE_BAD_PATH_GUARD not in brew.read_text()
    assert BREW_PROFILE_PATH_GUARD in brew.read_text()

    alias.write_text("alias open='unexpected'\n")
    with pytest.raises(BuildError, match="unexpected open alias"):
        remove_bluefin_open_alias(tmp_path)
