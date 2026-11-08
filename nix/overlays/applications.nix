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
  inherit (patched) jj kanata;
  inherit (inputs.nixcord.packages.${system}) discord equicord;
  heliumDarwin = helium-browser.overrideAttrs (
    finalAttrs: old: {
      version = "0.21.1.1";
      src = fetchurl {
        url = "https://github.com/imputnet/helium-macos/releases/download/${finalAttrs.version}/helium_${finalAttrs.version}_arm64-macos.dmg";
        hash = "sha256-4L441LObjOEgt8fu2hKOz7oOZhHV0j8vurLjUQwnYzE=";
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
  nix-gl-host = callPackage ../../packages/nix/graphics/package.nix { };
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
    grammarOverlays = [
      (_grammarFinal: grammarPrev: {
        # Preserve the exact Cylc revision after its original repository vanished
        cylc = grammarPrev.cylc.overrideAttrs (old: {
          src = builtins.fetchTree {
            type = "github";
            owner = "seanwallawalla";
            repo = "ElliotFontaine_Tree-Sitter-Cylc";
            rev = old.version;
          };
        });
      })
    ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [
      # Match Nixpkgs' strict-aliasing workaround for the Haskell grammar on GCC 16
      (
        _grammarFinal: grammarPrev:
        let
          inherit (grammarPrev) haskell;
        in
        {
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
    commandLineArgs = lib.optionals stdenv.hostPlatform.isLinux (
      lib.importJSON ../../home/applications/discord/flags.json
    );
  }) [ "Discord" ];
  jj-patched = jj;
  kanata-with-cmd = kanata.overrideAttrs {
    cargoBuildFeatures = [ "cmd" ];
    cargoCheckFeatures = [ "cmd" ];
  };
  tweezle = callPackage (inputs.tweezle + "/nix/package.nix") { };
  inherit yt-dlp-script;
}
