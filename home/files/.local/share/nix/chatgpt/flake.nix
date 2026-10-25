{
  description = "Record-managed ChatGPT package";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };
      inherit (pkgs) callPackage;
      chatgpt = callPackage ./package.nix { };
    in
    {
      packages.${system} = {
        inherit chatgpt;
        default = chatgpt;
        update-chatgpt = chatgpt.updateScript;
      };
    };
}
