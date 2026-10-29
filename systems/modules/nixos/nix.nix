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

      # Keep login-shell NIX_PATH and nix.conf on the same input mappings
      nixPath = nixPathEntries;

      settings =
        (import ../../../nix/lib/cache/settings.nix {
          inherit lib;
          platform = "nixos";
        })
        // {
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
          nix-path = config.nix.nixPath;
          flake-registry = lib.modules.mkIf config.nixpkgs.hostPlatform.isLinux "";
        };

      channel.enable = false;
      # Opinionated: make flake registry and nix path match flake inputs
      registry = lib.attrsets.mapAttrs (_: flake: { inherit flake; }) flakeInputs;
    };
  };
}
