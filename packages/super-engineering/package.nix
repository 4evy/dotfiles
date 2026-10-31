{
  lib,
  stdenvNoCC,
  fetchurl,
  buildFHSEnv,
  _7zz,
  autoPatchelfHook,
  makeBinaryWrapper,
  stdenv,
  libxcb,
  libxkbcommon,
  openssl,
  fontconfig,
  freetype,
  vulkan-loader,
  wayland,
  xdg-utils,
  zenity,
  nix-update-script,
  writeShellApplication,
  curl,
  jq,
  gnused,
  nix,
  useFHSEnv ? true,
}:

let
  darwinVersion = "0-unstable-2026-10-29";
  darwinRev = "c0f9eaa7ea152352346cedd9c489070eb3e291b1";

  sources = {
    aarch64-darwin = {
      arch = "arm64";
      hash = "sha256-AqPGoz9o2k/5OoIFJRob+t2kukI/UYDWTfu+CRDYzmk=";
    };
    x86_64-linux = {
      arch = "x86_64";
      hash = "sha256-imbfUqQkmM4kawfaIz+tG9Nxgju++bnwGPTfchq0tH8=";
    };
    aarch64-linux = {
      arch = "aarch64";
      hash = "sha256-bonnxEe5aJv+2vroik5kD0bQmKz654HDhsipfHXmuv4=";
    };
  };
  source = sources.${stdenvNoCC.hostPlatform.system};
  linuxSystems = builtins.filter (lib.strings.hasSuffix "-linux") (builtins.attrNames sources);
  meta = {
    description = "Workspace for coding agents, terminals, and Git worktrees";
    homepage = "https://super.engineering";
    license = lib.licenses.unfree;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    maintainers = [ lib.maintainers._4evy ];
    mainProgram = "super-engineering";
  };

  unwrapped =
    finalAttrs:
    stdenvNoCC.mkDerivation {
      pname = "${finalAttrs.pname}-unwrapped";
      inherit (finalAttrs) version src meta;

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
        makeWrapper "$out/lib/super-engineering/bin/super-engineering" \
          "$out/bin/super-engineering" \
          --prefix LD_LIBRARY_PATH : "${
            lib.strings.makeLibraryPath [
              fontconfig
              freetype
              vulkan-loader
              wayland
            ]
          }" \
          --prefix PATH : "${
            lib.strings.makeBinPath [
              xdg-utils
              zenity
            ]
          }"
        makeWrapper "$out/lib/super-engineering/bin/sc" "$out/bin/sc"
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
      meta = finalAttrs.meta // {
        mainProgram = "sc";
      };
    };

  # Refresh every source hash even when nightly builds share a date
  updateScript =
    finalAttrs:
    lib.meta.getExe (writeShellApplication {
      name = "update-super-engineering";
      runtimeInputs = [
        curl
        jq
        gnused
        nix
      ];
      text = ''
        file=packages/super-engineering/package.nix
        payload=$(curl -fsSL https://releases.super.engineering/linux/nightly/manifest.json \
          | jq -er '.payload | @base64d | fromjson')
        darwin_payload=$(curl -fsSL https://releases.super.engineering/latest-v2.json \
          | jq -ec '.nightly')
        rev=$(jq -er '.artifacts["x86_64-unknown-linux-gnu"].commit' <<< "$payload")
        version="0-unstable-$(jq -er '.date' <<< "$payload")"
        darwin_rev=$(jq -er '.artifacts["aarch64-apple-darwin"].sha' <<< "$darwin_payload")
        darwin_version="0-unstable-$(jq -er '.date' <<< "$darwin_payload")"

        sed -i -E \
          "s/(rev = \")[^\"]+(\";)/\1$rev\2/; s/(version = \")[^\"]+(\";)/\1$version\2/; s/(darwinRev = \")[^\"]+(\";)/\1$darwin_rev\2/; s/(darwinVersion = \")[^\"]+(\";)/\1$darwin_version\2/" \
          "$file"

        # Prefetch other targets without requiring cross-platform builders
        ${lib.strings.concatMapStringsSep "\n" (
          system:
          let
            info = sources.${system};
            target =
              if lib.strings.hasSuffix "-darwin" system then
                "aarch64-apple-darwin"
              else
                "${info.arch}-unknown-linux-gnu";
          in
          if system == stdenvNoCC.hostPlatform.system then
            ""
          else
            ''
              url=$(jq -er --arg target ${lib.strings.escapeShellArg target} '.artifacts[$target].url' \
                <<< "${if lib.strings.hasSuffix "-darwin" system then "$darwin_payload" else "$payload"}")
              hash=$(nix store prefetch-file --json "$url" | jq -er '.hash')
              old_hash=$(nix eval --raw --impure --expr ${lib.strings.escapeShellArg ''
                let
                  flake = builtins.getFlake (toString ./.);
                  pkgs = import flake.inputs.nixpkgs {
                    system = "${system}";
                    config.allowUnfree = true;
                  };
                in
                (pkgs.callPackage ./packages/super-engineering/package.nix { }).src.outputHash
              ''})
              sed -i "s|$old_hash|$hash|g" "$file"
            ''
        ) (builtins.attrNames sources)}

        ${
          lib.strings.escapeShellArgs (nix-update-script {
            attrPath = finalAttrs.pname;
            extraArgs = [
              "--flake"
              "--override-filename"
              "packages/super-engineering/package.nix"
            ];
          })
        } --version=skip --system=${stdenvNoCC.hostPlatform.system}
      '';
    });

  commonAttrs = finalAttrs: {
    pname = "super-engineering";
    version = "0-unstable-2026-10-29";

    src = fetchurl {
      url = "https://releases.super.engineering/linux/nightly/${finalAttrs.passthru.rev}/super-engineering-nightly-${
        builtins.substring 0 8 finalAttrs.passthru.rev
      }-linux-${source.arch}.tar.gz";
      inherit (source) hash;
    };

    passthru = {
      rev = "3248f5deeb4b1b9e3765333d3a5c81d8fd9524c2";

      # Share the fixed point so overrideAttrs updates every variant
      unwrapped = unwrapped finalAttrs;
      native = mkNative finalAttrs;
      cli = cli finalAttrs;
      updateScript = updateScript finalAttrs;
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
          "libxcb"
          "libxkbcommon"
          "openssl"
          "vulkan-loader"
          "wayland"
          "xdg-utils"
          "zenity"
          "zsh"
        ] pkgs;

      runScript = lib.meta.getExe finalAttrs.passthru.unwrapped;

      extraInstallCommands = ''
        ln -s "${finalAttrs.passthru.unwrapped}/share" "$out/share"
        ln -s "${lib.meta.getExe finalAttrs.passthru.cli}" "$out/bin/sc"
      '';
    }
  );

  darwin = stdenvNoCC.mkDerivation (finalAttrs: {
    pname = "super-engineering";
    version = darwinVersion;

    src = fetchurl {
      url = "https://releases.super.engineering/nightly/super.engineering-nightly-${
        builtins.substring 0 8 finalAttrs.passthru.rev
      }-${source.arch}.dmg";
      inherit (source) hash;
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
      rev = darwinRev;
      updateScript = updateScript finalAttrs;
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
