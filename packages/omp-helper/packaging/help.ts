export const help = `Build a distro-owned omp-helper package from the locked sources

Usage: bun run packages/omp-helper/packaging/build.ts --format deb|rpm|pacman|darwin
       --output DIRECTORY [--release NUMBER] [--install-root DIRECTORY]

Darwin: jobs-only Homebrew payload; build on macOS x86_64 or arm64 with the
matching standalone Bun, GNU tar (gtar), patch and SOURCE_DATE_EPOCH
Stage the resulting archive and checksum with remote_helper using manager brew
The local 4evy/dotfiles tap must contain Formula/omp-helper.rb
No Rust, Linux desktop, launchd service or system permission grants are needed

Required: SOURCE_DATE_EPOCH (Unix seconds), Linux glibc x86_64 or aarch64,
Bun matching package.json's packageManager, Rust >= 1.96, cargo, nfpm,
GNU tar, patch, binutils (readelf), ldd, pkg-config and a native C toolchain
Run unprivileged, on the target distro/release and architecture, not in Nix
Use the same pinned build image/toolchains for reproducible rebuilds
No cross-compilation or universal Linux ABI compatibility is implied

Install build and runtime prerequisites in the build image first:
  All formats: systemd; activation needs the target user's running manager
  Debian/Ubuntu: build-essential pkg-config libglib2.0-dev
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libpipewire-0.3-dev
    libwayland-dev libxkbcommon-dev gstreamer1.0-plugins-base
    gstreamer1.0-plugins-good gstreamer1.0-pipewire libasound2-dev libudev-dev
    dbus xdg-desktop-portal ca-certificates binutils patch
  Fedora/RHEL: gcc gcc-c++ pkgconf-pkg-config glib2-devel gstreamer1-devel
    gstreamer1-plugins-base-devel pipewire-devel wayland-devel
    libxkbcommon-devel gstreamer1-plugins-good pipewire-gstreamer
    alsa-lib systemd-libs dbus xdg-desktop-portal ca-certificates binutils patch
  openSUSE/SLES: gcc gcc-c++ make pkg-config glib2-devel gstreamer-devel
    gstreamer-plugins-base-devel pipewire-devel wayland-devel
    libxkbcommon-devel gstreamer-plugins-good gstreamer-plugin-pipewire
    pipewire libasound2 libudev1 dbus xdg-desktop-portal ca-certificates
    binutils patch
  Arch: base-devel glib2 gstreamer gst-plugins-base gst-plugins-good
    gst-plugin-pipewire pipewire wayland libxkbcommon xkeyboard-config
    alsa-lib systemd-libs dbus xdg-desktop-portal ca-certificates
The distro must provide versions satisfying desktop/Cargo.lock; older releases
may not. Install the compositor's portal backend on the runtime host as well
Bun, Rust and nfpm are build prerequisites, not runtime package dependencies

The builder fetches the checksum-pinned OMP source and frozen Bun/Cargo
closures. It keeps source modules, worker entrypoints, native addons and their
assets; it does not turn the gateway into a single-file Bun bundle
The package bundles the running Bun executable and links the Rust desktop
against the build distro's libraries. Runtime dependencies include resolved
ELF library owners and GStreamer/portal/dlopen packages with build-host version
floors. Build separate artifacts for each distro/release and architecture

Linux payload: /opt/omp-helper/<version> by default, plus package-owned
/usr/bin/omp-helper, /usr/bin/omp-runtime and /usr/bin/omp using bundled Bun
For bootc images, pass --install-root /usr/lib/omp-helper so the image owns
the immutable payload under /usr, not the mutable /opt deployment
These are the only supported Linux install roots
omp-runtime uses the patched, locked runtime and refuses runtime self-updates;
update the system package/image instead. Help, update --check and plugin
updates remain available
Increment --release for every rebuilt payload with the same helper version
Recovery compares the full package version/release and architecture, not just
the versioned payload path; never publish different payloads under one identity
No package scripts start services, grant permissions, or modify user state
Install using apt install ./FILE.deb, dnf install ./FILE.rpm,
zypper install ./FILE.rpm, or pacman -U FILE
Then explicitly run omp-helper install as the desktop user
Before removing a package, run omp-helper uninstall as each activated user
Before upgrading, run omp-helper upgrade prepare as each activated user and
retain its maintenanceToken. Upgrade the native package, then run:
  omp-helper upgrade --maintenance-token TOKEN
On failure keep the maintenance gate closed; restore the original package
before running omp-helper upgrade cancel --maintenance-token TOKEN

Build logs go to stderr; the final stdout line is JSON with artifact,
sha256, format, architecture, version, release and build distro metadata
`;
