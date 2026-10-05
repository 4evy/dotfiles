{
  lib,
  stdenv,
  rustPlatform,
  bun,
  bun2nix,
  makeWrapper,
  pkg-config,
  glib,
  dbus,
  libsysprof-capture,
  pcre2,
  libselinux,
  libsepol,
  util-linux,
  libunwind,
  elfutils,
  gst_all_1,
  pipewire,
  libxkbcommon,
  xkeyboard_config,
  wayland,
  zstd,
  omp-runtime,
}:
let
  metadata = lib.importJSON ./package.json;
  nativeInputs = [
    glib
    libsysprof-capture
    pcre2
    libselinux
    libsepol
    util-linux
    libunwind
    elfutils
    gst_all_1.gstreamer
    gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good
    pipewire
    libxkbcommon
    wayland
  ];
  pluginPath = lib.makeSearchPath "lib/gstreamer-1.0" [
    (lib.getLib gst_all_1.gstreamer)
    gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good
    pipewire
  ];
  desktop = rustPlatform.buildRustPackage {
    pname = "omp-helper-desktop";
    inherit (metadata) version;
    src = lib.fileset.toSource {
      root = ./desktop;
      fileset = lib.fileset.unions [
        ./desktop/Cargo.toml
        ./desktop/Cargo.lock
        ./desktop/src
      ];
    };
    cargoLock.lockFile = ./desktop/Cargo.lock;
    nativeBuildInputs = [
      pkg-config
      makeWrapper
    ];
    buildInputs = nativeInputs;
    doCheck = false;
    postInstall = ''
      wrapProgram "$out/bin/omp-helper-desktop" \
        --set GST_PLUGIN_SYSTEM_PATH_1_0 "${pluginPath}" \
        --set GST_PLUGIN_SCANNER_1_0 "${lib.getLib gst_all_1.gstreamer}/libexec/gstreamer-1.0/gst-plugin-scanner" \
        --set XKB_CONFIG_ROOT "${xkeyboard_config}/share/X11/xkb" \
        --set OMP_WORKSPACE_DBUS_CONFIG "${dbus}/share/dbus-1/session.conf" \
        --prefix PATH : "${
          lib.makeBinPath [
            dbus
            util-linux
          ]
        }" \
        --prefix LD_LIBRARY_PATH : "${
          lib.makeLibraryPath [
            libxkbcommon
            wayland
          ]
        }"
    '';
    meta.platforms = lib.platforms.linux;
  };
  patchedDependencies = lib.mapAttrs (_: path: ./. + "/${path}") metadata.patchedDependencies;
in
stdenv.mkDerivation {
  pname = "omp-helper";
  inherit (metadata) version;
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ./package.json
      ./bun.lock
      ./gateway
      ./manifest.json
      ./omp-helper-desktop.service.in
      ./io.github.fourevy.OmpHelper.desktop.in
      ./gnome
      ../omp/npm-patches
      ../../dotfiles/dot_omp/agent/lib/helper
      ../../dotfiles/dot_omp/agent/lib/desktop
    ];
  };
  postUnpack = ''
    sourceRoot="$sourceRoot/packages/omp-helper"
  '';
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
    overrides = bun2nix.patchedDependenciesToOverrides { inherit patchedDependencies; };
  };
  nativeBuildInputs = [
    bun
    bun2nix.hook
    makeWrapper
  ];
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;
  dontBuild = true;
  bunInstallFlags = [
    "--linker=hoisted"
    "--backend=copyfile"
  ];
  strictDeps = true;

  installPhase = ''
    runHook preInstall
    root="$out/lib/omp-helper"
    target="$root/packages/omp-helper"
    mkdir -p "$target" "$root/dotfiles/dot_omp/agent/lib" "$out/bin" "$out/share/omp-helper"
    cp -R gateway package.json node_modules "$target/"
    cp -R ../../dotfiles/dot_omp/agent/lib/{helper,desktop} "$root/dotfiles/dot_omp/agent/lib/"
    ln -s "$target/node_modules" "$root/node_modules"
    rm -rf "$target/node_modules/@oh-my-pi"
    ln -s ${omp-runtime}/lib/omp-runtime/node_modules/@oh-my-pi "$target/node_modules/@oh-my-pi"
    ln -sfn ${omp-runtime}/bin/omp-runtime "$target/node_modules/.bin/omp"
    makeWrapper ${bun}/bin/bun "$out/bin/omp-helper" \
      --set OMP_HELPER_PACKAGE_PATH "$out" \
      --prefix PATH : "${lib.makeBinPath [ zstd ]}" \
      --add-flags "$target/gateway/main.ts"
    ln -s ${desktop}/bin/omp-helper-desktop "$out/bin/omp-helper-desktop"
    cp manifest.json *.in "$out/share/omp-helper/"
    mkdir -p "$out/share/omp-helper/gnome"
    bun build gnome/extension.ts --format=esm --target=browser \
      --external='gi://*' --external='resource:///*' \
      --outfile="$out/share/omp-helper/gnome/extension.js"
    cp gnome/metadata.json "$out/share/omp-helper/gnome/metadata.json"
    runHook postInstall
  '';

  passthru = { inherit desktop nativeInputs; };
  meta = {
    description = "Persistent Wayland desktop service and connection-scoped omp job gateway";
    homepage = "https://github.com/4evy/dotfiles";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
    mainProgram = "omp-helper";
  };
}
