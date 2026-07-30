{
  description = "Development-only inputs for the dotfiles flake partition";

  inputs = {
    git-hooks-nix.inputs.flake-compat.follows = "";
    git-hooks-nix.inputs.nixpkgs.follows = "";
    git-hooks-nix.url = "github:cachix/git-hooks.nix";
  };

  outputs = { ... }: { };
}
