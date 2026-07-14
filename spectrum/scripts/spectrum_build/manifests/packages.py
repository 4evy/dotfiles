from collections.abc import Mapping, Sequence

from spectrum_build.core.common import fail

type PackageGroups = Mapping[str, Sequence[str]]


REQUIRED_PACKAGES: PackageGroups = {
    "bootstrap": (
        "bootc",
        "bubblewrap",
        "curl",
        "file",
        "findutils",
        "git",
        "just",
        "procps-ng",
        "python3",
    ),
    "toolchain": (
        "binutils",
        "blueprint-compiler",
        "clang",
        "cmake",
        "dbus-devel",
        "fontconfig-devel",
        "freetype-devel",
        "gcc",
        "gcc-c++",
        "gettext",
        "glibc-devel",
        "gtk4-devel",
        "gtk4-layer-shell-devel",
        "libadwaita-devel",
        "libxml2-devel",
        "libdrm-devel",
        "libglvnd-devel",
        "libxkbcommon-devel",
        "lld",
        "lldb",
        "make",
        "mesa-libgbm-devel",
        "meson",
        "ninja-build",
        "openssl-devel",
        "pango-devel",
        "patch",
        "perl",
        "pkgconf-pkg-config",
        "rpm-build",
        "systemd-devel",
        "tar",
        "zlib-devel",
        "xz",
    ),
    "editors": ("vim-enhanced",),
    "fonts": (
        "google-noto-color-emoji-fonts",
        "google-noto-emoji-fonts",
        "google-noto-sans-cjk-fonts",
        "google-noto-sans-mono-cjk-vf-fonts",
        "google-noto-sans-mono-vf-fonts",
        "google-noto-sans-symbols-2-fonts",
        "google-noto-sans-symbols-vf-fonts",
        "google-noto-sans-vf-fonts",
        "liberation-mono-fonts",
        "liberation-sans-fonts",
        "liberation-serif-fonts",
    ),
    "system": (
        "opensc",
        "openssh-clients",
        "openssl",
        "ncurses",
        "pcsc-lite",
        "pinentry",
        "pinentry-gnome3",
        "gtk4-layer-shell",
        "libxdo",
        "podman",
        "podman-compose",
        "pipewire-gstreamer",
        "selinux-policy-devel",
        "systemd-oomd-defaults",
        "uresourced",
        "vulkan-tools",
        "xdg-desktop-portal",
        "xdg-desktop-portal-gnome",
        "xdg-desktop-portal-gtk",
    ),
}

OPTIONAL_PACKAGES: PackageGroups = {}

VALIDATION_PACKAGES: Sequence[str] = (
    "bootc",
    "git",
    "just",
    "podman",
    "systemd-oomd-defaults",
    "uresourced",
)


def validate_package_groups() -> None:
    for label, groups in {
        "required": REQUIRED_PACKAGES,
        "optional": OPTIONAL_PACKAGES,
    }.items():
        if not isinstance(groups, dict):
            fail(f"{label} packages must be grouped in a dict")

        for group_name, packages in groups.items():
            if not isinstance(group_name, str) or not group_name:
                fail(f"{label} package group names must be non-empty strings")
            if not isinstance(packages, tuple) or not all(
                isinstance(package, str) for package in packages
            ):
                fail(f"{label}.{group_name} packages must be a tuple of strings")
