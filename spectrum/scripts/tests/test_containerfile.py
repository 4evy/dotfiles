from pathlib import Path

from spectrum_build.manifests.packages import required_packages

REPOSITORY = Path(__file__).parents[3]
CONTAINERFILE = REPOSITORY / "spectrum" / "Containerfile"
DOCKERIGNORE = REPOSITORY / ".dockerignore"
JUSTFILE = REPOSITORY / "Justfile"
PACKAGE_MANIFEST = REPOSITORY / "spectrum" / "image" / "packages" / "required.txt"
SYSTEMD_MANIFEST = REPOSITORY / "manifests" / "spectrum-systemd-units.txt"


def test_build_context_includes_containerfile_manifests() -> None:
    dockerignore = DOCKERIGNORE.read_text(encoding="utf-8").splitlines()

    assert "!manifests/" in dockerignore
    assert "!manifests/**" in dockerignore


def test_boot_report_can_read_checkout_on_selinux_hosts() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    recipe = justfile.split("spectrum-boot-report target=local_ref:", 1)[1]
    recipe = recipe.split("# Show RPM package differences", 1)[0]

    assert "--security-opt label=disable" in recipe
    assert 'repo_dir + ":/workspace:ro"' in recipe


def test_fedora_package_manifest_is_sorted_unique_and_container_owned() -> None:
    packages = required_packages(PACKAGE_MANIFEST)
    containerfile = CONTAINERFILE.read_text(encoding="utf-8")

    assert packages
    assert "FROM scratch AS package-manifest" in containerfile
    assert (
        "from=package-manifest,source=/required.txt,target=/required-packages.txt"
        in containerfile
    )
    assert "dnf5 -y install" in containerfile
    assert "zlib-ng-compat-devel" in packages
    assert "zlib-devel" not in packages
    assert (
        "COPY spectrum/image/packages/required.txt /src/spectrum/image/packages/"
        in containerfile
    )
    assert not (
        REPOSITORY / "spectrum" / "scripts" / "spectrum_build" / "plan.py"
    ).exists()


def test_systemd_units_have_one_manifest_for_enablement_and_validation() -> None:
    units = SYSTEMD_MANIFEST.read_text(encoding="utf-8").splitlines()
    containerfile = CONTAINERFILE.read_text(encoding="utf-8")

    assert units == sorted(set(units))
    assert "FROM scratch AS systemd-manifest" in containerfile
    assert (
        "from=systemd-manifest,source=/enabled-units.txt,target=/enabled-units.txt"
        in containerfile
    )
    assert "xargs --no-run-if-empty systemctl enable" in containerfile
    assert all(containerfile.count(unit) == 0 for unit in units)


def test_python_build_environment_and_sources_have_separate_cache_inputs() -> None:
    containerfile = CONTAINERFILE.read_text(encoding="utf-8")

    project_stage = containerfile.index("FROM scratch AS python-project")
    common_source_stage = containerfile.index(
        "FROM scratch AS spectrum-program-common-source"
    )
    packaged_source_stage = containerfile.index(
        "FROM spectrum-program-common-source AS spectrum-packaged-source"
    )
    extension_source_stage = containerfile.index(
        "FROM spectrum-program-common-source AS spectrum-extension-source"
    )
    ghostty_source_stage = containerfile.index(
        "FROM spectrum-program-common-source AS spectrum-ghostty-source"
    )
    kmscon_source_stage = containerfile.index(
        "FROM spectrum-program-common-source AS spectrum-kmscon-source"
    )
    image_source_stage = containerfile.index(
        "FROM spectrum-program-common-source AS spectrum-image-source"
    )
    runtime_stage = containerfile.index("FROM ${BLUEFIN_BASE_IMAGE} AS spectrum-python")
    package_step = containerfile.index("dnf5 -y install")
    tool_copy = containerfile.index("COPY --from=nix-tools /spectrum-nix-tools")
    packaged_programs = containerfile.index("install-packaged-programs")
    extension_programs = containerfile.index("install-extension-programs")
    ghostty = containerfile.index("install-ghostty")
    kmscon = containerfile.index("install-kmscon")
    configure = containerfile.index("-m spectrum_build.cli configure")
    rootfs_copy = containerfile.index("COPY --from=rootfs / /")
    volatile_args = containerfile.index("ARG IMAGE_REVISION")
    metadata = containerfile.index("-m spectrum_build.cli write-metadata")

    assert project_stage < runtime_stage
    assert (
        common_source_stage
        < packaged_source_stage
        < extension_source_stage
        < ghostty_source_stage
        < kmscon_source_stage
        < image_source_stage
        < runtime_stage
    )
    assert (
        runtime_stage
        < package_step
        < tool_copy
        < packaged_programs
        < extension_programs
        < ghostty
        < kmscon
        < configure
        < rootfs_copy
        < volatile_args
        < metadata
    )
    assert containerfile.index("COPY manifests/sources.json") < packaged_source_stage
    assert "--no-install-project" in containerfile
    assert (
        "/usr/bin/python3 -c \\\n"
        "    'import sys; assert sys.version_info[:2] == (3, 14), sys.version'"
        in containerfile
    )
    assert "--python /usr/bin/python3" in containerfile
    assert "--no-python-downloads" in containerfile
    for source in ("packaged", "extension", "ghostty", "kmscon", "image"):
        assert f"from=spectrum-{source}-source,source=/src,target=/src" in containerfile
    assert "from=spectrum-image-source,source=/src,target=/src" in containerfile
    assert (
        containerfile.count(
            "packages/dotfiles-python/src/workstation/lib/sources.py"
        )
        == 1
    )
    for metadata_only_module in ("discord", "rustdesk", "sops", "vscode"):
        assert f"programs/{metadata_only_module}.py" not in containerfile
    assert "-m spectrum_build.cli build" not in containerfile
    assert "python3 /tmp/spectrum-src/spectrum/scripts/build.py" not in containerfile


def test_final_validation_runs_after_static_rootfs_overlay() -> None:
    containerfile = CONTAINERFILE.read_text(encoding="utf-8")

    rootfs_copy = containerfile.index("COPY --from=rootfs / /")
    validation = containerfile.index("-m spectrum_build.cli validate")
    bootc_lint = containerfile.index("bootc container lint --fatal-warnings")

    assert rootfs_copy < validation < bootc_lint
