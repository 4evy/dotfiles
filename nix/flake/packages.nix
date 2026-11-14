{
  equicord,
  inputs,
  lib,
  ...
}:
{
  _class = "flake";

  perSystem =
    { pkgs, ... }:
    let
      inherit (pkgs)
        aiTools
        buildEnv
        callPackage
        dotfilesPackageUpdaters
        dotfiles-workstation
        helium-configured
        stdenv
        writeShellScriptBin
        ;
      inherit (stdenv.hostPlatform) isDarwin isLinux system;
      binaryUpdater =
        name:
        let
          updateScript = dotfilesPackageUpdaters.binaryPin name;
        in
        (writeShellScriptBin "update-${name}" ''
          exec ${lib.strings.escapeShellArg updateScript} "$@"
        '').overrideAttrs
          {
            passthru = { inherit updateScript; };
          };
    in
    {
      packages = {
        update-bun = binaryUpdater "bun";
        update-helium-darwin = binaryUpdater "helium-darwin";
        inherit (pkgs)
          bun
          bun2nix
          dotfiles-workstation
          dotfiles-typescript-tools
          helium-browser
          mitos
          jj-patched
          kanata-with-cmd
          rex
          super-engineering
          theme-run
          tweezle
          yt-dlp-script
          ;
        dotfiles-apps = buildEnv {
          name = "dotfiles-apps";
          passthru.updateScript = dotfilesPackageUpdaters.sequence "update-dotfiles-apps" (
            [
              (dotfilesPackageUpdaters.flakeInputs [
                "eupkgs"
                "source-mitos"
                "patches"
                "tweezle"
                "nixcord"
              ])
              dotfilesPackageUpdaters.localWorkspace
            ]
            ++ lib.lists.optionals isDarwin [
              (dotfilesPackageUpdaters.binaryPin "helium-darwin")
            ]
          );
          paths =
            lib.attrsets.attrValues {
              inherit (pkgs)
                helium-browser
                mitos
                jj-patched
                kanata-with-cmd
                theme-run
                tweezle
                yt-dlp-script
                ;
            }
            ++ lib.lists.optionals isLinux (
              lib.attrsets.attrValues {
                helium-configured = lib.meta.hiPrio helium-configured;
                inherit (pkgs) nixcord-discord;
              }
            );
        };
        inherit (aiTools)
          ai-tools
          ai-configs
          ai-javascript
          farstep
          farstep-desktop
          farstep-service
          ghidra-mcp
          ;
        default = dotfiles-workstation;
        dotfiles-nix-tools = buildEnv {
          name = "dotfiles-nix-tools";
          passthru.updateScript = dotfilesPackageUpdaters.flakeInputs (
            [ "nixpkgs" ] ++ lib.lists.optionals isDarwin [ "raycast" ]
          );
          paths =
            lib.attrsets.attrValues {
              inherit (pkgs)
                deadnix
                nh
                nil
                nix-output-monitor
                nix-tree
                nixd
                nixfmt
                statix
                ;
            }
            ++ lib.lists.optionals isDarwin (
              lib.attrsets.attrValues {
                inherit (inputs.raycast.packages.${system}) raycast raycast-manager;
              }
            );
        };
        equicord-settings = callPackage ../../home/applications/discord/equicord/package.nix {
          inherit (equicord) quickCss;
          settings = equicord.settings.jsonConfig;
        };
      }
      // lib.attrsets.optionalAttrs isLinux {
        dotfiles-user-tools = buildEnv {
          name = "dotfiles-user-tools";
          passthru.updateScript = dotfilesPackageUpdaters.sequence "update-dotfiles-user-tools" [
            (dotfilesPackageUpdaters.flakeInputs [
              "nixpkgs"
              "nixpkgs-unstable"
            ])
            (dotfilesPackageUpdaters.binaryPin "bun")
          ];
          paths = import ../../home/deploy/nix/packages.nix { inherit pkgs; };
          extraOutputsToInstall = [ "man" ];
        };
        inherit (pkgs)
          bluebuild
          nixcord-discord
          check-jsonschema
          helium-configured
          hyper-window-tiling-gnome
          hyper-window-tiling-kde
          kmscon
          libtsm
          nix-gl-host
          solaar
          super-engineering-native
          toshy-runtime
          uresourced
          ;
      };
    };
}
