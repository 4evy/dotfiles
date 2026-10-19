{
  alsa-lib,
  at-spi2-atk,
  at-spi2-core,
  autoPatchelfHook,
  cairo,
  coreutils,
  cups,
  curl,
  dbus,
  expat,
  fetchurl,
  gnused,
  gzip,
  glib,
  gtk3,
  lib,
  libdrm,
  libgbm,
  libGL,
  libnotify,
  libusb1,
  libx11,
  libxcomposite,
  libxdamage,
  libxext,
  libxfixes,
  libxkbcommon,
  libxrandr,
  libxcb,
  libxml2,
  nix,
  nspr,
  nss,
  pango,
  rpmextract,
  stdenv,
  systemd,
  wrapGAppsHook3,
  writeShellApplication,
}:
stdenv.mkDerivation {
  pname = "chatgpt";
  version = "26.1013.40934";

  src = fetchurl {
    url = "https://persistent.oaistatic.com/codex-app-prod/linux/rpm/x86_64/chatgpt-26.1013.40934-1.x86_64.rpm";
    name = "chatgpt.x86_64.rpm";
    hash = "sha256-SvApu6q2ClIgRm1bZ4taZO47G2PK2o8AAu5mBivIOV8=";
  };

  nativeBuildInputs = lib.attrValues {
    inherit autoPatchelfHook rpmextract wrapGAppsHook3;
  };

  buildInputs = [
    alsa-lib
    at-spi2-atk
    at-spi2-core
    cairo
    cups
    dbus
    expat
    glib
    gtk3
    libdrm
    libgbm
    libGL
    libnotify
    libusb1
    libxkbcommon
    nspr
    nss
    pango
    stdenv.cc.cc.lib
    systemd
    libx11
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    libxcb
  ];

  autoPatchelfIgnoreMissingDeps = [
    "libQt5Core.so.5"
    "libQt5Gui.so.5"
    "libQt5Widgets.so.5"
    "libQt6Core.so.6"
    "libQt6Gui.so.6"
    "libQt6Widgets.so.6"
    "libc.musl-x86_64.so.1"
  ];

  unpackPhase = ''
    runHook preUnpack
    rpmextract "$src"
    runHook postUnpack
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -r usr/* "$out/"
    runHook postInstall
  '';

  passthru.updateScript = writeShellApplication {
    name = "update-chatgpt";
    runtimeInputs = lib.attrValues {
      inherit
        coreutils
        curl
        gnused
        gzip
        libxml2
        nix
        ;
    };
    text = ''
      check_only=false
      case "$#" in
        0) ;;
        1)
          if [ "$1" != "--check" ]; then
            echo "usage: update-chatgpt [--check]" >&2
            exit 2
          fi
          check_only=true
          ;;
        *)
          echo "usage: update-chatgpt [--check]" >&2
          exit 2
          ;;
      esac

      repository_url="https://persistent.oaistatic.com/codex-app-prod/linux/rpm/x86_64"
      repomd="$(mktemp)"
      primary="$(mktemp)"
      trap 'rm -f "$repomd" "$primary"' EXIT

      curl -fsSL "$repository_url/repodata/repomd.xml" -o "$repomd"
      primary_path="$(xmllint --xpath \
        'string(//*[local-name()="data"][@type="primary"]/*[local-name()="location"]/@href)' \
        "$repomd")"
      curl -fsSL "$repository_url/$primary_path" | gzip -dc > "$primary"

      version="$(xmllint --xpath \
        'string(//*[local-name()="package"][*[local-name()="name"]="chatgpt"]/*[local-name()="version"]/@ver)' \
        "$primary")"
      location="$(xmllint --xpath \
        'string(//*[local-name()="package"][*[local-name()="name"]="chatgpt"]/*[local-name()="location"]/@href)' \
        "$primary")"
      checksum="$(xmllint --xpath \
        'string(//*[local-name()="package"][*[local-name()="name"]="chatgpt"]/*[local-name()="checksum"][@type="sha256"])' \
        "$primary")"

      if [ -z "$version" ] || [ -z "$location" ] || [ -z "$checksum" ]; then
        echo "The ChatGPT RPM metadata is incomplete" >&2
        exit 1
      fi

      hash="$(nix hash convert --hash-algo sha256 "$checksum")"
      url="$repository_url/$location"
      package_file="''${CHATGPT_PACKAGE_FILE:-''${XDG_DATA_HOME:-$HOME/.local/share}/nix/chatgpt/package.nix}"

      if [ ! -f "$package_file" ]; then
        echo "The record-managed ChatGPT package is unavailable" >&2
        exit 1
      fi

      current_version="$(sed -n 's/^  version = "\([^"]*\)";/\1/p' "$package_file")"
      current_url="$(sed -n 's/^    url = "\([^"]*\)";/\1/p' "$package_file")"
      current_hash="$(sed -n 's/^    hash = "\([^"]*\)";/\1/p' "$package_file")"

      if [ -z "$current_version" ] || [ -z "$current_url" ] || [ -z "$current_hash" ]; then
        echo "The local ChatGPT package metadata is incomplete" >&2
        exit 1
      fi

      if [ "$current_version" = "$version" ] && \
        [ "$current_url" = "$url" ] && \
        [ "$current_hash" = "$hash" ]; then
        echo "ChatGPT is up to date at $version"
        exit 0
      fi

      if [ "$check_only" = true ]; then
        echo "ChatGPT $version is available; the package has $current_version" >&2
        exit 1
      fi

      updated="$(mktemp "$(dirname "$package_file")/.package.nix.XXXXXX")"
      trap 'rm -f "$repomd" "$primary" "$updated"' EXIT
      sed \
        -e "s|^  version = \"$current_version\";|  version = \"$version\";|" \
        -e "s|^    url = \"$current_url\";|    url = \"$url\";|" \
        -e "s|^    hash = \"$current_hash\";|    hash = \"$hash\";|" \
        "$package_file" > "$updated"
      chmod --reference="$package_file" "$updated"
      mv "$updated" "$package_file"
      echo "Updated ChatGPT from $current_version to $version"
    '';
  };

  meta = {
    description = "ChatGPT desktop app for Linux";
    homepage = "https://learn.chatgpt.com/docs/linux/linux-app";
    license = lib.licenses.unfree;
    mainProgram = "chatgpt";
    platforms = [ "x86_64-linux" ];
    sourceProvenance = lib.attrValues { inherit (lib.sourceTypes) binaryNativeCode; };
  };
}
