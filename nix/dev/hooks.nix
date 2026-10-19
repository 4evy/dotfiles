{ inputs, ... }:
{
  _class = "flake";

  imports = [ inputs.git-hooks-nix.flakeModule ];
  perSystem = {
    pre-commit.settings.hooks = {
      actionlint.enable = true;
      biome.enable = true;
      deadnix = {
        enable = true;
        excludes = [
          "hosts/linux/hardware-configuration.nix"
        ];
      };
      statix.enable = true;
      hadolint = {
        enable = true;
        files = "(Dockerfile|Containerfile)$";
      };
      luacheck.enable = true;
      ruff.enable = true;
      rumdl.enable = true;
      shellcheck.enable = true;
      treefmt.enable = true;
      yamllint.enable = true;
      zizmor = {
        enable = true;
        args = [
          "--offline"
          "--persona=pedantic"
        ];
      };
    };
  };
}
