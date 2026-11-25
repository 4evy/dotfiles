{ inputs, ... }:
{
  _class = "flake";

  imports = [ inputs.git-hooks-nix.flakeModule ];
  perSystem = { pkgs, ... }: {
    pre-commit.settings.hooks = {
      actionlint.enable = true;
      biome.enable = true;
      deadnix = {
        enable = true;
        excludes = [
          "systems/hosts/linux/hardware-configuration.nix"
        ];
      };
      statix.enable = true;
      hadolint = {
        enable = true;
        files = "(Dockerfile|Containerfile)$";
      };
      luacheck.enable = true;
      rumdl.enable = true;
      shellcheck = {
        enable = true;
        # ShellCheck does not parse Zsh
        exclude_types = [ "zsh" ];
      };
      treefmt.enable = true;
      yamllint.enable = true;
      zizmor = {
        enable = true;
        package = pkgs.unstable.zizmor;
        args = [
          "--offline"
          "--persona=pedantic"
        ];
      };
    };
  };
}
