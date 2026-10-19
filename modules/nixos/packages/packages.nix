{
  inputs,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.attrsets) attrValues;
  inherit (lib.strings) makeSearchPath;
  inherit (pkgs) eupkgs stdenv unstable;
  inherit (unstable)
    llvmPackages
    luaPackages
    nh
    openssh_hpn
    openssl
    rustPlatform
    zlib
    ;
  inherit (llvmPackages) libclang;
  rustPkgConfigPath = makeSearchPath "lib/pkgconfig" (attrValues {
    openssl = openssl.dev;
    zlib = zlib.dev;
  });
in
{
  _class = "nixos";

  config = {
    programs = {
      ai.enable = true;

      nh = {
        enable = true;
        package = nh;
      };

      # Select the HPN implementation for both the client and the server;
      # installing it as an extra package leaves the NixOS modules on OpenSSH.
      ssh.package = openssh_hpn;
    };

    environment.systemPackages = attrValues {
      hjem = inputs.hjem.packages.${stdenv.hostPlatform.system}.hjem;
      ghostty = inputs.patches.packages.${stdenv.hostPlatform.system}.ghostty;
      inherit (pkgs)
        helix
        jj-patched
        just
        yamllint
        ;
      inherit (pkgs) theme-run;
      inherit (pkgs) dotfiles-workstation;
      inherit (unstable) python314;

      # Host/session spine and editor dependencies.
      inherit (unstable)
        actionlint
        age
        autoconf
        automake
        bash-language-server
        binutils
        biome
        broot
        bubblewrap
        bun
        chafa
        coreutils
        cargo
        clang
        clippy
        cmake
        deadnix
        delta
        delve
        diffutils
        dockerfmt
        duf
        dust
        fd
        ffmpeg
        file
        findutils
        gawk
        gcc
        gh
        git
        git-filter-repo
        git-lfs
        gitui
        gnupg
        gnugrep
        gnused
        gnutar
        go
        golangci-lint
        gopls
        gradle
        gnumake
        gum
        hadolint
        imagemagick
        jdk
        jj
        just-lsp
        less
        libtool
        lld
        lldb
        lua
        lua-language-server
        luarocks
        maven
        mediainfo
        ncdu
        netcat
        nil
        ninja
        nixd
        nixfmt
        nix-output-monitor
        nix-tree
        nodejs
        opensc
        openssl
        pandoc
        pass
        patch
        p7zip
        perl
        pinact
        pinentry-gnome3
        pkg-config
        poppler-utils
        quilt
        resvg
        ripgrep
        rsync
        rumdl
        rust-bindgen
        rust-analyzer
        rustc
        rustfmt
        sd
        selene
        shellcheck
        shfmt
        sops
        sqlcipher
        sshpass
        stylua
        taplo
        tlrc
        tokei
        tree
        ty
        unzip
        uv
        vulkan-tools
        watchexec
        wget
        which
        xz
        vscode
        yaml-language-server
        yq-go
        yt-dlp
        zip
        zizmor
        zstd
        ;

      inherit (luaPackages) luacheck;

      inherit (eupkgs)
        yt-dlp-script
        ;

      # Hardware and platform tools.
      inherit (unstable)
        pciutils
        podman-compose
        smartmontools
        wl-clipboard
        xclip
        ;
      inherit (pkgs) dotool;
    };

    environment.sessionVariables = {
      LIBCLANG_PATH = "${libclang.lib}/lib";
      PKG_CONFIG_PATH = rustPkgConfigPath;
      RUST_SRC_PATH = "${rustPlatform.rustLibSrc}";
    };
  };
}
