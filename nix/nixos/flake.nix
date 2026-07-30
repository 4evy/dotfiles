{
  description = "NixOS-only inputs for the dotfiles flake partition";

  inputs = {
    browser.inputs.nixpkgs.follows = "";
    browser.url = "github:4evy/browser";

    determinate.url = "https://flakehub.com/f/DeterminateSystems/determinate/3";

    sops-nix.inputs.nixpkgs.follows = "";
    sops-nix.url = "github:Mic92/sops-nix";
  };

  outputs = { ... }: { };
}
