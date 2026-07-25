{
  lib,
  inputs,
  config,
  ...
}:
let
  flakeInputs = lib.attrsets.filterAttrs (_: input: (input._type or null) == "flake") inputs;
  nixPathEntries = lib.attrsets.mapAttrsToList (n: _: "${n}=flake:${n}") flakeInputs;
in
{
  config = {
    nix = {
      extraOptions = ''
        !include ${config.sops.secrets.github-token.path}
      '';

      settings = {
        trusted-users = [
          "4evy"
        ];
        experimental-features = [
          "flakes"
          "nix-command"
        ];
        builders-use-substitutes = true;
        keep-outputs = true;
        substituters = [
          "https://devenv.cachix.org"
          "https://euvlok.cachix.org"
          "https://eupkgs.cachix.org"
          "https://nix-community.cachix.org"
          "https://cache.flox.dev"
        ];
        trusted-public-keys = [
          "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw="
          "euvlok.cachix.org-1:cmFWCSs7rxPiyE1qfaJn8TY7QaRoGOrzKuNvtGw2gcU="
          "eupkgs.cachix.org-1:V9Y0HdASNNSU9U6EkXhR1j85bZGRtNgW7wSyTiQrwGU="
          "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
          "flox-cache-public-1:7F4OyH7ZCnFhcze3fJdfyXYLQw/aV7GEed86nQ7IsOs="
        ];
        extra-sandbox-paths = [
          "/nix/var/cache/ccache"
          "/nix/var/cache/sccache"
        ];
        nix-path = nixPathEntries;
      }
      // lib.attrsets.optionalAttrs config.nixpkgs.hostPlatform.isLinux { flake-registry = ""; };

      channel.enable = false;
      # Opinionated: make flake registry and nix path match flake inputs
      registry = lib.attrsets.mapAttrs (_: flake: { inherit flake; }) flakeInputs;
      nixPath = nixPathEntries;
    };

    sops.secrets.github-token = {
      mode = lib.modules.mkDefault "0440";
      group = lib.modules.mkDefault (if config.nixpkgs.hostPlatform.isDarwin then "staff" else "root");
    };

    system.activationScripts.postActivation.text = lib.modules.mkAfter ''
      install -d -m 0770 -o root -g nixbld /nix/var/cache/ccache
      install -d -m 0770 -o root -g nixbld /nix/var/cache/sccache
    '';
  };
}
