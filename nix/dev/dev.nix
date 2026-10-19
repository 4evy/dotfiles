{
  _class = "flake";

  imports = [
    ./checks.nix
    ./hooks.nix
    ./shells.nix
    ./treefmt/treefmt.nix
  ];
}
