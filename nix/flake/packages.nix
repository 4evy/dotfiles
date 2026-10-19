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
        dotfiles-workstation
        helium-configured
        stdenv
        ;
      inherit (stdenv.hostPlatform) isDarwin isLinux system;
    in
    {
      packages = {
        inherit (pkgs)
          bun2nix
          dotfiles-workstation
          ghostty-patched
          helium-browser
          helix
          jj-patched
          kanata-with-cmd
          theme-run
          tweezle
          yt-dlp-script
          ;
        dotfiles-apps = buildEnv {
          name = "dotfiles-apps";
          paths =
            lib.attrValues {
              inherit (pkgs)
                helium-browser
                helix
                jj-patched
                kanata-with-cmd
                theme-run
                tweezle
                yt-dlp-script
                ;
            }
            ++ lib.optionals isLinux (
              lib.attrValues {
                helium-configured = lib.hiPrio helium-configured;
                inherit (pkgs) nixcord-discord;
              }
            );
        };
        inherit (aiTools)
          ai-tools
          ai-configs
          farstep
          farstep-native
          ghidra-mcp
          ;
        default = dotfiles-workstation;
        dotfiles-nix-tools = buildEnv {
          name = "dotfiles-nix-tools";
          paths =
            lib.attrValues {
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
            ++ lib.optionals isDarwin (
              lib.attrValues {
                inherit (inputs.raycast.packages.${system}) raycast raycast-manager;
              }
            );
        };
        equicord-settings = callPackage ../../packages/equicord-settings/package.nix {
          inherit (equicord) quickCss;
          settings = equicord.settings.jsonConfig;
        };
      }
      // lib.optionalAttrs isLinux {
        dotfiles-user-tools = buildEnv {
          name = "dotfiles-user-tools";
          paths = import ../../modules/hjem/packages.nix { inherit pkgs; };
          extraOutputsToInstall = [ "man" ];
        };
        inherit (pkgs)
          nixcord-discord
          bluebuild-v2
          check-jsonschema
          hyper-window-tiling-gnome
          hyper-window-tiling-kde
          kmscon
          toshy-runtime
          uresourced
          ;
      };
    };
}
