{ inputs, ... }:
{
  nixos = inputs.nixpkgs.lib.nixosSystem {
    specialArgs = { inherit inputs; };
    modules = [
      ./configuration.nix
      inputs.self.nixosModules.default
      {
        local = {
          shell.enable = true;
          gnome.enable = true;
          dconf.enable = true;
          nvidia.enable = true;
          amd.enable = true;
        };
      }
      inputs.sops-nix.nixosModules.sops
      {
        sops = {
          age.keyFile = "/home/4evy/.config/sops/age/keys.txt";
          defaultSopsFile = ../../secrets/secrets.yaml;
          validateSopsFiles = false;
          secrets.github-token = {
            mode = "0440";
            group = "users";
          };
          secrets."github-ssh-key" = {
            uid = 0;
            gid = 0;
          };
        };
      }
    ];
  };
}
