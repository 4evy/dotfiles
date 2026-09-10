{
  description = "Cross-platform dotfiles packages and NixOS configuration";

  inputs = {
    # Only browser's NixOS module is consumed; omit unused module inputs.
    browser = {
      inputs = {
        home-manager.follows = "";
        nix-darwin.follows = "";
        nixpkgs.follows = "";
      };
      url = "github:4evy/browser";
    };

    determinate.url = "https://flakehub.com/f/DeterminateSystems/determinate/3";

    sops-nix.inputs.nixpkgs.follows = "";
    sops-nix.url = "github:Mic92/sops-nix";

    vicinae.url = "github:vicinaehq/vicinae";

    git-hooks-nix = {
      inputs = {
        flake-compat.follows = "";
        nixpkgs.follows = "nixpkgs";
      };
      url = "github:cachix/git-hooks.nix";
    };

    source-bluebuild-cli = {
      flake = false;
      url = "github:blue-build/cli/main";
    };

    source-browser = {
      flake = false;
      url = "github:4evy/browser/master";
    };

    source-equilotl = {
      flake = false;
      url = "github:Equicord/Equilotl/v2.2.6";
    };

    source-ghostty = {
      flake = false;
      url = "github:ghostty-org/ghostty/c81f0b26871c7fbbe2fc35549fdad1f64ed29094";
    };

    source-ghostty-zig-aarch64-linux = {
      flake = false;
      url = "file+https://ziglang.org/download/0.16.0/zig-aarch64-linux-0.16.0.tar.xz";
    };

    source-ghostty-zig-x86-64-linux = {
      flake = false;
      url = "file+https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz";
    };

    source-helium-linux-binary = {
      flake = false;
      url = "file+https://github.com/imputnet/helium-linux/releases/download/0.16.4.1/helium-0.16.4.1-x86_64_linux.tar.xz";
    };

    source-helix = {
      flake = false;
      url = "github:helix-editor/helix/master";
    };

    source-jj = {
      flake = false;
      url = "github:jj-vcs/jj/1d41436bfe6f9410b573f8ef39169c5253bbccdf";
    };

    source-kanata = {
      flake = false;
      url = "github:jtroo/kanata/main";
    };

    source-kanata-homebrew = {
      flake = false;
      url = "github:jtroo/kanata/565d5070e9e61992af5b4e844d512a9ce2f2d8c1";
    };

    source-karabiner-vhid-package = {
      flake = false;
      url = "file+https://github.com/pqrs-org/Karabiner-DriverKit-VirtualHIDDevice/releases/download/v8.2.0/Karabiner-DriverKit-VirtualHIDDevice-8.2.0.pkg";
    };

    source-kmscon = {
      flake = false;
      url = "github:kmscon/kmscon/baa2bcc5bde55318dcfbff0dd0090271e1f88674";
    };

    source-libtsm = {
      flake = false;
      url = "github:kmscon/libtsm/ef0a1a40c30d164913f413c47de5bbd8383a6daa";
    };

    source-python-astral = {
      flake = false;
      url = "file+https://files.pythonhosted.org/packages/source/a/astral/astral-3.2.tar.gz";
    };

    source-toshy = {
      flake = false;
      url = "github:RedBearAK/Toshy/Toshy_v26.08.0";
    };

    source-uresourced = {
      flake = false;
      url = "git+https://gitlab.freedesktop.org/benzea/uresourced.git?ref=v0.5.4&rev=68668042c91afd53cf3119bdfb62b0e1345e8ad6";
    };

    source-yt-dlp-script = {
      flake = false;
      url = "github:euvlok/pkgs/master";
    };

    bun2nix = {
      inputs = {
        flake-parts.follows = "flake-parts";
        nixpkgs.follows = "nixpkgs";
        treefmt-nix.follows = "treefmt-nix";
      };
      url = "github:nix-community/bun2nix";
    };

    eupkgs.inputs.nixpkgs.follows = "nixpkgs-unstable";
    eupkgs.url = "github:euvlok/pkgs";

    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
    flake-parts.url = "github:hercules-ci/flake-parts";

    nixcord = {
      inputs = {
        nixpkgs.follows = "nixpkgs-unstable";
        treefmt-nix.follows = "treefmt-nix";
      };
      url = "github:4evy/nixcord";
    };

    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable-small";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    patches = {
      inputs.nixpkgs.follows = "nixpkgs";
      url = "github:4evy/patches";
    };

    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
    treefmt-nix.url = "github:numtide/treefmt-nix";
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.flake-parts.flakeModules.partitions
        ./lib/flake.nix
      ];
    };
}
