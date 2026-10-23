{ inputs, lib }:
final: _prev:
let
  inherit (final)
    callPackage
    eupkgs
    fetchurl
    nix-gl-host
    runCommand
    stdenv
    symlinkJoin
    writeShellScript
    ;
  inherit (eupkgs) helium-browser yt-dlp-script;
  upstreamHelium = helium-browser;
  system = stdenv.hostPlatform.system;
  patched = inputs.patches.packages.${system};
  inherit (patched) ghostty jj kanata;
  inherit (inputs.nixcord.packages.${system}) discord equicord;
  heliumDarwin = helium-browser.overrideAttrs (
    finalAttrs: old: {
      version = "0.19.4.1";
      src = fetchurl {
        url = "https://github.com/imputnet/helium-macos/releases/download/${finalAttrs.version}/helium_${finalAttrs.version}_arm64-macos.dmg";
        hash = "sha256-Ew5DEAjyXe2dUiEL36hmsKzlnQTNqv8Hx3kx+9f5MyE=";
      };
      passthru = (old.passthru or { }) // {
        upstreamVersion = finalAttrs.version;
      };
    }
  );
  hostGraphics =
    package: commands:
    if stdenv.hostPlatform.isDarwin then
      package
    else
      symlinkJoin {
        name = "${package.name}-host-graphics";
        paths = [ package ];
        postBuild = lib.concatMapStringsSep "\n" (command: ''
          rm "$out/bin/${command}"
          ln -s ${writeShellScript command ''
            if [ -e /etc/NIXOS ]; then
              exec ${package}/bin/${command} "$@"
            fi
            exec ${lib.getExe nix-gl-host} --driver-directory /usr/lib64 \
              ${package}/bin/${command} "$@"
          ''} "$out/bin/${command}"
        '') commands;
        inherit (package) meta;
      };
in
{
  nix-gl-host = callPackage ../packages/nix-gl-host/package.nix { };
  helium-browser =
    if stdenv.hostPlatform.isDarwin then
      heliumDarwin
    else
      hostGraphics helium-browser [
        "helium"
        "helium-browser"
      ];
  helium-configured =
    let
      inherit (final) helium-browser;
      launcher = writeShellScript "helium-configured" ''
        launcher="$HOME/.local/bin/helium-browser"
        if [ -x "$launcher" ]; then
          exec "$launcher" "$@"
        fi
        exec ${lib.getExe helium-browser} "$@"
      '';
    in
    runCommand "helium-configured" { } ''
      mkdir -p "$out/bin" "$out/share/applications"
      ln -s ${launcher} "$out/bin/helium"
      ln -s ${launcher} "$out/bin/helium-browser"
      substitute ${helium-browser}/share/applications/helium.desktop \
        "$out/share/applications/helium.desktop" \
        --replace-fail 'Exec=${lib.getExe upstreamHelium}' 'Exec=helium'
      ln -s helium.desktop "$out/share/applications/helium-browser.desktop"
    '';
  helix = callPackage (inputs.source-helix + "/default.nix") {
    gitRev = inputs.source-helix.rev;
    # Match Nixpkgs' fixes for these grammar revisions on glibc 2.44 and GCC 16
    grammarOverlays = lib.optionals stdenv.hostPlatform.isLinux [
      (
        _grammarFinal: grammarPrev:
        let
          inherit (grammarPrev) haskell perl;
        in
        {
          perl = perl.overrideAttrs {
            postPatch = ''
              rm src/bsearch.c
              substituteInPlace src/tsp_unicode.h \
                --replace-fail '#include "bsearch.c"' ""
            '';
          };
          haskell = haskell.overrideAttrs (old: {
            env = (old.env or { }) // {
              NIX_CFLAGS_COMPILE = (old.env.NIX_CFLAGS_COMPILE or "") + " -fno-strict-aliasing";
            };
          });
        }
      )
    ];
    # These GitLab grammar repositories reject anonymous fetches
    includeGrammarIf =
      grammar:
      !(lib.elem grammar.name [
        "lpf"
        "blueprint"
        "t32"
        "rpmspec"
        "nginx"
        "debian"
      ]);
  };
  nixcord-discord = hostGraphics (discord.override {
    withEquicord = true;
    inherit equicord;
    withKrisp = true;
  }) [ "Discord" ];
  jj-patched = jj;
  kanata-with-cmd = kanata.overrideAttrs {
    cargoBuildFeatures = [ "cmd" ];
    cargoCheckFeatures = [ "cmd" ];
  };
  ghostty-patched =
    if stdenv.hostPlatform.isDarwin then
      callPackage ../packages/ghostty-patched/package.nix {
        patchesSource = inputs.patches;
      }
    else
      ghostty;
  tweezle = callPackage (inputs.tweezle + "/nix/package.nix") { };
  inherit yt-dlp-script;
}
