{
  alsa-lib,
  at-spi2-atk,
  at-spi2-core,
  autoPatchelfHook,
  callPackage,
  cairo,
  coreutils,
  cups,
  dbus,
  expat,
  fetchurl,
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
  makeWrapper,
  nix-update-script,
  nspr,
  nss,
  openssl,
  pango,
  rpmextract,
  runCommand,
  stdenv,
  systemd,
  tpm2-tss,
  wrapGAppsHook3,
}:
let
  unwrapped = stdenv.mkDerivation (finalAttrs: {
    pname = "chatgpt";
    version = "26.1106.51428";

    src = fetchurl {
      url = "https://persistent.oaistatic.com/codex-app-prod/linux/rpm/x86_64/chatgpt-${finalAttrs.version}-1.x86_64.rpm";
      name = "chatgpt.x86_64.rpm";
      hash = "sha256-0ebWKTMZkPxNuwm96SCYFWaj4S8lcdEXFBDomBy7fWc=";
    };

    nativeBuildInputs = lib.attrsets.attrValues {
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
      # The remote-control device-key module links TPM2 and OpenSSL
      openssl
      pango
      stdenv.cc.cc.lib
      systemd
      tpm2-tss
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

    passthru = {
      # Keep discovery as the public updater and hash repair available to it
      updateScript = lib.meta.getExe (
        callPackage ./update.nix {
          chatgpt = finalAttrs.finalPackage;
        }
      );
      hashUpdateScript = nix-update-script {
        attrPath = "chatgpt.unwrapped";
        extraArgs = [
          "--flake"
          "--version=skip"
        ];
      };
    };

    meta = {
      description = "ChatGPT desktop app for Linux";
      homepage = "https://learn.chatgpt.com/docs/linux/linux-app";
      license = lib.licenses.unfree;
      mainProgram = "chatgpt";
      platforms = [ "x86_64-linux" ];
      sourceProvenance = lib.attrsets.attrValues { inherit (lib.sourceTypes) binaryNativeCode; };
    };
  });
in
runCommand unwrapped.name
  {
    nativeBuildInputs = [ makeWrapper ];
    inherit (unwrapped) meta;
    passthru = {
      inherit unwrapped;
      inherit (unwrapped) updateScript;
    };
  }
  ''
    mkdir -p "$out"
    ln -s ${unwrapped}/* "$out/"
    rm "$out/bin"
    mkdir -p "$out/bin" "$out/libexec"
    ln -s ${unwrapped}/bin/* "$out/bin/"
    rm "$out/bin/chatgpt"
    substitute ${./prepare-bundled-plugins.sh} \
      "$out/libexec/chatgpt-bundled-plugins.sh" \
      --replace-fail '@resources@' '${unwrapped}/lib/chatgpt/resources' \
      --replace-fail '@package@' "$(basename "$out")" \
      --replace-fail '@coreutils@' '${coreutils}/bin'
    makeWrapper ${unwrapped}/bin/chatgpt "$out/bin/chatgpt" \
      --run "source \"$out/libexec/chatgpt-bundled-plugins.sh\""
  ''
