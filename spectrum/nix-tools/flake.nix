{
  description = "Self-contained Nix editor tools for the Spectrum image";

  inputs = {
    bundlers = {
      url = "github:NixOS/bundlers";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { bundlers, nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      tools = pkgs.writeShellApplication {
        name = "spectrum-nix-tools";
        runtimeInputs = with pkgs; [
          deadnix
          nil
          nixd
          nixfmt
        ];
        text = ''
          if (( $# == 0 )); then
            printf '%s\n' 'usage: spectrum-nix-tools (deadnix|nil|nixd|nixfmt) [arguments...]' >&2
            exit 2
          fi

          tool=$1
          shift
          case "$tool" in
            deadnix | nil | nixd | nixfmt)
              exec "$tool" "$@"
              ;;
            *)
              printf 'unsupported Nix editor tool: %s\n' "$tool" >&2
              exit 2
              ;;
          esac
        '';
      };
    in
    {
      packages.${system} = {
        default = tools;
        bundle = bundlers.bundlers.${system}.toAppImage tools;
      };
    };
}
