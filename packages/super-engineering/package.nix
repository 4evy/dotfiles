{
  lib,
  stdenvNoCC,
  fetchurl,
  buildFHSEnv,
  _7zz,
  autoPatchelfHook,
  makeBinaryWrapper,
  makeShellWrapper,
  stdenv,
  libxcb,
  libglvnd,
  libxkbcommon,
  openssl,
  fontconfig,
  freetype,
  vulkan-loader,
  mesa,
  nix-gl-host,
  wayland,
  xdg-utils,
  zenity,
  writeShellApplication,
  coreutils,
  curl,
  jq,
  nix,
  useFHSEnv ? true,
}:

let
  pins = lib.importJSON ./sources.json;

  sources = {
    aarch64-darwin = {
      arch = "arm64";
    };
    x86_64-linux = {
      arch = "x86_64";
    };
    aarch64-linux = {
      arch = "aarch64";
    };
  };
  source = sources.${stdenvNoCC.hostPlatform.system};
  sourceHash = pins.hashes.${stdenvNoCC.hostPlatform.system};
  linuxSystems = builtins.filter (lib.strings.hasSuffix "-linux") (builtins.attrNames sources);
  meta = {
    description = "Workspace for coding agents, terminals, and Git worktrees";
    homepage = "https://super.engineering";
    license = lib.licenses.unfree;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    maintainers = [ lib.maintainers._4evy ];
    mainProgram = "super-engineering";
  };

  # Isolate strict manifest generation from the FHS launcher's shell options
  nvidiaIcd = writeShellApplication {
    name = "super-engineering-nvidia-icd";
    runtimeInputs = [
      coreutils
      jq
    ];
    text = ''
      for icd in /etc/vulkan/icd.d/nvidia*.json \
        /usr/local/share/vulkan/icd.d/nvidia*.json /usr/share/vulkan/icd.d/nvidia*.json; do
        [ -r "$icd" ] || continue

        driver_cache="''${XDG_CACHE_HOME:-$HOME/.cache}/super-engineering"
        mkdir -p "$driver_cache"
        icd_tmp=$(mktemp "$driver_cache/nvidia-icd.XXXXXX")
        trap 'rm -f "$icd_tmp"' EXIT

        # Keep the host API version and resolve the library through nix-gl-host
        jq '.ICD.library_path |= split("/")[-1]' "$icd" > "$icd_tmp"
        mv -f "$icd_tmp" "$driver_cache/nvidia-icd.json"
        printf '%s\n' "$driver_cache/nvidia-icd.json"
        exit 0
      done
    '';
  };

  # Vulkan accepts ICD directories, but host NVIDIA paths need rewriting
  # NixOS keeps its system drivers from /run/opengl-driver
  graphicsEnvironment = ''
    if [ ! -e /etc/NIXOS ]; then
      driver_files="''${VK_ADD_DRIVER_FILES:+$VK_ADD_DRIVER_FILES:}${mesa}/share/vulkan/icd.d"
      if [ -d /sys/module/nvidia ]; then
        host_driver_path=$(${lib.getExe nix-gl-host} --print-ld-library-path) || exit "$?"
        export LD_LIBRARY_PATH="$host_driver_path''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
        nvidia_icd=$(${lib.getExe nvidiaIcd}) || exit "$?"
        driver_files="$driver_files''${nvidia_icd:+:$nvidia_icd}"
      fi
      if [ -z "''${VK_DRIVER_FILES:-}" ] && [ -z "''${VK_ICD_FILENAMES:-}" ]; then
        export VK_DRIVER_FILES="$driver_files"
      fi
    fi
  '';

  unwrapped =
    finalAttrs:
    stdenvNoCC.mkDerivation {
      pname = "${finalAttrs.pname}-unwrapped";
      inherit (finalAttrs) version src meta;
      passthru = { inherit updateScript; };

      dontConfigure = true;
      dontBuild = true;
      # Keep the bundled CLI helpers for both architectures unchanged
      dontFixup = true;

      installPhase = ''
        runHook preInstall

        mkdir -p "$out"
        cp -r bin share BUILD-MANIFEST.txt "$out/"

        runHook postInstall
      '';
    };

  mkNative =
    finalAttrs:
    finalAttrs.passthru.unwrapped.overrideAttrs {
      pname = "${finalAttrs.pname}-native";
      dontFixup = false;
      dontStrip = true;
      dontPatchELF = true;
      dontAutoPatchelf = true;
      dontPatchShebangs = true;
      nativeBuildInputs = [
        autoPatchelfHook
        makeBinaryWrapper
        makeShellWrapper
      ];
      buildInputs = [
        (lib.attrsets.getLib stdenv.cc.cc)
        libxcb
        libxkbcommon
        openssl
      ];
      installPhase = ''
        runHook preInstall

        mkdir -p "$out/lib/super-engineering" "$out/bin"
        cp -r bin BUILD-MANIFEST.txt "$out/lib/super-engineering/"
        cp -r share "$out/"

        runHook postInstall
      '';
      postFixup = ''
        # Remote helpers must remain usable outside the Nix store
        autoPatchelf "$out/lib/super-engineering/bin/super-engineering" \
          "$out/lib/super-engineering/bin/sc"
        makeShellWrapper "$out/lib/super-engineering/bin/super-engineering" \
          "$out/bin/super-engineering" \
          --prefix LD_LIBRARY_PATH : "${
            lib.strings.makeLibraryPath [
              fontconfig
              freetype
              # NVIDIA's Vulkan ICD dlopens EGL and XCB extension libraries
              libglvnd
              libxcb
              vulkan-loader
              wayland
            ]
          }" \
          --prefix PATH : "${
            lib.strings.makeBinPath [
              xdg-utils
              zenity
            ]
          }" \
          --run ${lib.escapeShellArg graphicsEnvironment}
        makeBinaryWrapper "$out/lib/super-engineering/bin/sc" "$out/bin/sc"
      '';
      passthru = {
        inherit (finalAttrs.passthru) rev unwrapped updateScript;
      };
    };

  cli =
    finalAttrs:
    buildFHSEnv {
      pname = "${finalAttrs.pname}-cli";
      inherit (finalAttrs) version;
      executableName = "sc";
      runScript = lib.meta.getExe' finalAttrs.passthru.unwrapped "sc";
      passthru = { inherit updateScript; };
      meta = finalAttrs.meta // {
        mainProgram = "sc";
      };
    };

  # Run from the repository root to refresh every platform, including same-day builds
  updateScript = lib.getExe (writeShellApplication {
    name = "update-super-engineering";
    runtimeInputs = [
      coreutils
      curl
      jq
      nix
    ];
    text = ''
      file=packages/super-engineering/sources.json
      payload=$(curl -fsSL https://releases.super.engineering/linux/nightly/manifest.json \
        | jq -er '.payload | @base64d | fromjson')
      darwin_payload=$(curl -fsSL https://releases.super.engineering/latest-v2.json \
        | jq -ec '.nightly')
      rev=$(jq -er '.artifacts["x86_64-unknown-linux-gnu"].commit' <<< "$payload")
      version="0-unstable-$(jq -er '.date' <<< "$payload")"
      darwin_rev=$(jq -er '.artifacts["aarch64-apple-darwin"].sha' <<< "$darwin_payload")
      darwin_version="0-unstable-$(jq -er '.date' <<< "$darwin_payload")"
      hashes='{}'

      ${lib.concatMapStringsSep "\n" (
        system:
        let
          isDarwin = lib.hasSuffix "-darwin" system;
          target = if isDarwin then "aarch64-apple-darwin" else "${sources.${system}.arch}-unknown-linux-gnu";
        in
        ''
          url=$(jq -er --arg target ${lib.escapeShellArg target} '.artifacts[$target].url' \
            <<< "${if isDarwin then "$darwin_payload" else "$payload"}")
          hash=$(nix --extra-experimental-features nix-command store prefetch-file --json "$url" \
            | jq -er '.hash')
          hashes=$(jq --arg system ${lib.escapeShellArg system} --arg hash "$hash" \
            '. + {($system): $hash}' <<< "$hashes")
        ''
      ) (builtins.attrNames sources)}

      staged=$(mktemp "$file.XXXXXX")
      trap 'rm -f "$staged"' EXIT
      jq -n \
        --arg version "$version" --arg rev "$rev" \
        --arg darwin_version "$darwin_version" --arg darwin_rev "$darwin_rev" \
        --argjson hashes "$hashes" \
        '{
          linux: {version: $version, rev: $rev},
          darwin: {version: $darwin_version, rev: $darwin_rev},
          hashes: $hashes
        }' > "$staged"
      chmod --reference="$file" "$staged"
      mv "$staged" "$file"
    '';
  });

  commonAttrs = finalAttrs: {
    pname = "super-engineering";
    inherit (pins.linux) version;

    src = fetchurl {
      url = "https://releases.super.engineering/linux/nightly/${finalAttrs.passthru.rev}/super-engineering-nightly-${
        builtins.substring 0 8 finalAttrs.passthru.rev
      }-linux-${source.arch}.tar.gz";
      hash = sourceHash;
    };

    passthru = {
      inherit (pins.linux) rev;

      # Share the fixed point so overrideAttrs updates every variant
      unwrapped = unwrapped finalAttrs;
      native = mkNative finalAttrs;
      cli = cli finalAttrs;
      inherit updateScript;
    };

    meta = meta // {
      platforms = linuxSystems;
    };
  };

  # Keep native evaluation independent of the FHS builder
  native = mkNative (lib.fixedPoints.fix commonAttrs);

  fhs = buildFHSEnv (
    finalAttrs:
    commonAttrs finalAttrs
    // {
      targetPkgs =
        pkgs:
        lib.attrsets.attrVals [
          "fontconfig"
          "freetype"
          "libglvnd"
          "libxcb"
          "libxkbcommon"
          "openssl"
          "vulkan-loader"
          "wayland"
          "xdg-utils"
          "zenity"
          "zsh"
        ] pkgs;

      extraPreBwrapCmds = graphicsEnvironment;

      runScript = lib.meta.getExe finalAttrs.passthru.unwrapped;

      extraInstallCommands = ''
        ln -s "${finalAttrs.passthru.unwrapped}/share" "$out/share"
        ln -s "${lib.meta.getExe finalAttrs.passthru.cli}" "$out/bin/sc"
      '';
    }
  );

  darwin = stdenvNoCC.mkDerivation (finalAttrs: {
    pname = "super-engineering";
    inherit (pins.darwin) version;

    src = fetchurl {
      url = "https://releases.super.engineering/nightly/super.engineering-nightly-${
        builtins.substring 0 8 finalAttrs.passthru.rev
      }-${source.arch}.dmg";
      hash = sourceHash;
    };

    nativeBuildInputs = [
      _7zz
      makeBinaryWrapper
    ];
    unpackPhase = ''
      runHook preUnpack

      # APFS alternate streams become extra files and invalidate the signature
      7zz x -y -sns- "$src"

      runHook postUnpack
    '';
    dontConfigure = true;
    dontBuild = true;
    # Preserve the signed bundle and every bundled remote CLI helper
    dontFixup = true;
    installPhase = ''
      runHook preInstall

      mkdir -p "$out/Applications" "$out/bin"
      cp -R super.engineering.app "$out/Applications/"
      makeWrapper "$out/Applications/super.engineering.app/Contents/MacOS/super.engineering" \
        "$out/bin/super-engineering"
      makeWrapper "$out/Applications/super.engineering.app/Contents/MacOS/sc" "$out/bin/sc"

      runHook postInstall
    '';

    passthru = {
      inherit (pins.darwin) rev;
      inherit updateScript;
    };
    meta = meta // {
      platforms = [ "aarch64-darwin" ];
    };
  });
in
if stdenvNoCC.hostPlatform.isDarwin then
  darwin
else if useFHSEnv then
  fhs
else
  native
