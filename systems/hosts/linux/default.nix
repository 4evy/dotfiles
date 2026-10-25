{
  inputs,
  nixosModule,
  ...
}:
{
  nixos = inputs.nixpkgs.lib.nixosSystem {
    modules = [
      ./configuration.nix
      nixosModule
      {
        _file = ./default.nix;

        local = {
          user.name = "evy";
          shell.enable = true;
          gnome.enable = true;
          dconf.enable = true;
          nvidia.enable = true;
          amd.enable = true;
          toshy.enable = true;
        };
      }
      inputs.sops-nix.nixosModules.sops
      (
        { config, ... }:
        let
          inherit (config.local.user) group home;
        in
        {
          _file = ./default.nix;

          local.nix.githubTokenFile = config.sops.secrets.github-token.path;

          sops = {
            age.keyFile = "${home}/.config/sops/age/keys.txt";
            defaultSopsFile = ../../../secrets/secrets.yaml;
            validateSopsFiles = false;
            secrets.github-token = {
              mode = "0440";
              inherit group;
            };
          };
        }
      )
    ];
  };
}
