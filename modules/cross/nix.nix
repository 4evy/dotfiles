{
  lib,
  inputs,
  config,
  ...
}:
let
  flakeInputs = lib.attrsets.filterAttrs (_: input: (input._type or null) == "flake") inputs;
  nixPathEntries = lib.attrsets.mapAttrsToList (n: _: "${n}=flake:${n}") flakeInputs;
  githubTokenFile = config.local.nix.githubTokenFile;
in
{
  options.local.nix.githubTokenFile = lib.options.mkOption {
    type = lib.types.nullOr lib.types.externalPath;
    default = null;
    example = "/run/secrets/github-token";
    description = ''
      Optional Nix configuration fragment containing GitHub access-token
      settings. The file is included at runtime and must not be copied into
      the Nix store.
    '';
  };

  config = {
    nix = {
      extraOptions = lib.modules.mkIf (githubTokenFile != null) "!include ${toString githubTokenFile}";

      settings = {
        trusted-users = [
          config.local.user.name
        ];
        experimental-features = [
          "flakes"
          "nix-command"
          "parallel-eval"
        ];
        builders-use-substitutes = true;
        # Append public caches without replacing Determinate's and Nix's
        # defaults. Keeping build-time-only outputs would also prevent
        # Determinate Nixd's managed garbage collector from reclaiming them.
        extra-substituters = [
          "https://devenv.cachix.org"
          "https://euvlok.cachix.org"
          "https://eupkgs.cachix.org"
          "https://nix-community.cachix.org"
          "https://cache.flox.dev"
          "https://vicinae.cachix.org"
        ];
        extra-trusted-public-keys = [
          "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw="
          "euvlok.cachix.org-1:cmFWCSs7rxPiyE1qfaJn8TY7QaRoGOrzKuNvtGw2gcU="
          "eupkgs.cachix.org-1:V9Y0HdASNNSU9U6EkXhR1j85bZGRtNgW7wSyTiQrwGU="
          "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
          "flox-cache-public-1:7F4OyH7ZCnFhcze3fJdfyXYLQw/aV7GEed86nQ7IsOs="
          "vicinae.cachix.org-1:1kDrfienkGHPYbkpNj1mWTr7Fm1+zcenzgTizIcI3oc="
        ];
        nix-path = nixPathEntries;
        flake-registry = lib.modules.mkIf config.nixpkgs.hostPlatform.isLinux "";
      };

      channel.enable = false;
      # Opinionated: make flake registry and nix path match flake inputs
      registry = lib.attrsets.mapAttrs (_: flake: { inherit flake; }) flakeInputs;
      nixPath = nixPathEntries;
    };
  };
}
