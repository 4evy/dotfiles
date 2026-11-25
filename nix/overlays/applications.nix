{ inputs, lib }:
final: _prev:
let
  inherit (final)
    callPackage
    dotfilesPackageUpdaters
    eupkgs
    fetchurl
    linkFarm
    nix-gl-host
    runCommand
    stdenv
    symlinkJoin
    writeShellApplication
    ;
  inherit (eupkgs) yt-dlp-script;
  upstreamHelium = eupkgs.helium-browser;
  system = stdenv.hostPlatform.system;
  patched = inputs.patches.packages.${system};

  /**
    Attach a flake-input updater without dropping the package's other passthru
    attributes.

    # Inputs

    `names`: Upstream flake input names.
    `package`: Derivation to override.

    # Type

    `withInputs :: [String] -> Derivation -> Derivation`

    # Examples

    ```nix
    (withInputs [ "patches" ] jj).updateScript
    => "/nix/store/…-update-inputs-patches/bin/update-inputs-patches"
    ```
  */
  withInputs =
    names: package:
    package.overrideAttrs (old: {
      passthru = (old.passthru or { }) // {
        updateScript = dotfilesPackageUpdaters.flakeInputs names;
      };
    });
  inherit (patched) jj kanata;
  inherit (inputs.nixcord.packages.${system}) discord equicord;
  heliumDarwin = upstreamHelium.overrideAttrs (
    finalAttrs: old: {
      version = "0.22.4.1";
      src = fetchurl {
        url = "https://github.com/imputnet/helium-macos/releases/download/${finalAttrs.version}/helium_${finalAttrs.version}_arm64-macos.dmg";
        hash = "sha256-MiolsE6dgiIH54reheLyTRTxvvQjOVEeBtBAHKN5XLI=";
      };
      passthru = (old.passthru or { }) // {
        upstreamVersion = finalAttrs.version;
        updateScript = dotfilesPackageUpdaters.binaryPin "helium-darwin";
      };
    }
  );

  /**
    Route the main program and selected aliases through the host graphics
    launcher on Linux outside NixOS. Return the package unchanged on Darwin.

    # Inputs

    `package`: Derivation with `meta.mainProgram` and an updater.
    `aliases`: Additional executable names to wrap.

    # Type

    `hostGraphics :: Derivation -> [String] -> Derivation`

    # Examples

    ```nix
    (hostGraphics (withInputs [ "eupkgs" ] upstreamHelium) [ "helium" ]).meta.mainProgram
    => "helium-browser"
    ```
  */
  hostGraphics =
    package: aliases:
    if stdenv.hostPlatform.isDarwin then
      package
    else
      let
        executables = {
          ${package.meta.mainProgram} = lib.meta.getExe package;
        }
        // lib.attrsets.genAttrs aliases (lib.meta.getExe' package);
      in
      symlinkJoin {
        name = "${package.name}-host-graphics";
        paths = [ package ];
        postBuild = lib.strings.concatMapAttrsStringSep "\n" (
          command: executable:
          let
            wrapper = writeShellApplication {
              name = command;
              meta.mainProgram = command;
              bashOptions = [ ];
              text = ''
                if [ -e /etc/NIXOS ]; then
                  exec ${executable} "$@"
                fi
                exec ${lib.meta.getExe nix-gl-host} --driver-directory /usr/lib64 \
                  ${executable} "$@"
              '';
            };
          in
          ''
            rm "$out/bin/${command}"
            ln -s ${lib.meta.getExe wrapper} "$out/bin/${command}"
          ''
        ) executables;
        inherit (package) meta;
        passthru = (package.passthru or { }) // {
          inherit (package) updateScript;
        };
      };
in
{
  nix-gl-host = callPackage ../../packages/nix/graphics/package.nix { };
  helium-browser =
    if stdenv.hostPlatform.isDarwin then
      heliumDarwin
    else
      hostGraphics (withInputs [ "eupkgs" ] upstreamHelium) [ "helium" ];
  helium-configured =
    let
      inherit (final) helium-browser;
      launcher = writeShellApplication {
        name = "helium-configured";
        meta.mainProgram = "helium-configured";
        bashOptions = [ ];
        text = ''
          launcher="$HOME/.local/bin/helium-browser"
          if [ -x "$launcher" ]; then
            exec "$launcher" "$@"
          fi
          exec ${lib.meta.getExe helium-browser} "$@"
        '';
      };
      desktop = runCommand "helium.desktop" { } ''
        substitute ${helium-browser}/share/applications/helium.desktop "$out" \
          --replace-fail 'Exec=${lib.meta.getExe upstreamHelium}' 'Exec=helium'
      '';
    in
    (linkFarm "helium-configured" {
      "bin/helium" = lib.meta.getExe launcher;
      "bin/helium-browser" = lib.meta.getExe launcher;
      "share/applications/helium.desktop" = desktop;
      "share/applications/helium-browser.desktop" = "helium.desktop";
    }).overrideAttrs
      (old: {
        passthru = old.passthru // {
          inherit (helium-browser) updateScript;
        };
      });
  mitos = withInputs [ "source-mitos" ] (
    (callPackage (inputs.source-mitos + "/default.nix") {
      gitRev = inputs.source-mitos.rev;
      grammarOverlays = lib.lists.optionals stdenv.hostPlatform.isLinux [
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
              passthru = (old.passthru or { }) // {
                updateScript = dotfilesPackageUpdaters.flakeInputs [ "source-mitos" ];
              };
            });
          }
        )
      ];
      /**
        Exclude grammars whose GitLab repositories reject anonymous fetches.

        # Inputs

        `grammar`: Upstream grammar descriptor with a `name`.

        # Type

        `includeGrammarIf :: { name :: String; ... } -> Bool`

        # Examples

        ```nix
        includeGrammarIf { name = "lpf"; }
        => false
        ```
      */
      includeGrammarIf =
        grammar:
        !(lib.lists.elem grammar.name [
          "lpf"
          "blueprint"
          "t32"
          "rpmspec"
          "nginx"
          "debian"
        ]);
    }).overrideAttrs
      (old: {
        postInstall = (old.postInstall or "") + ''
          ln -s ms "$out/bin/hx"
          ln -s ms "$out/bin/mi"
        '';
      })
  );
  nixcord-discord = hostGraphics (withInputs [ "nixcord" ] (
    discord.override {
      withEquicord = true;
      inherit equicord;
      withKrisp = true;
      commandLineArgs = lib.lists.optionals stdenv.hostPlatform.isLinux (
        lib.trivial.importJSON ../../home/applications/discord/flags.json
      );
    }
  )) [ ];
  jj-patched = withInputs [ "patches" ] jj;
  kanata-with-cmd = kanata.overrideAttrs (old: {
    cargoBuildFeatures = [ "cmd" ];
    cargoCheckFeatures = [ "cmd" ];
    passthru = (old.passthru or { }) // {
      updateScript = dotfilesPackageUpdaters.flakeInputs [ "patches" ];
    };
  });
  tweezle = withInputs [ "tweezle" ] (callPackage (inputs.tweezle + "/nix/package.nix") { });
  yt-dlp-script = withInputs [ "eupkgs" ] yt-dlp-script;
}
