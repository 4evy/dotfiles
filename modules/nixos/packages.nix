{
  dotfilesPackages,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.attrsets) attrValues;
  inherit (lib.strings) makeSearchPath;
  rustPkgConfigPath = makeSearchPath "lib/pkgconfig" [
    pkgs.unstable.openssl.dev
    pkgs.unstable.zlib.dev
  ];
  codex = pkgs.eupkgs.codex;
in
{
  _class = "nixos";

  config = {
    programs.nh = {
      enable = true;
      package = pkgs.unstable.nh;
    };

    environment.systemPackages = attrValues {
      inherit (pkgs)
        ansible
        ansible-lint
        yamllint
        ;
      inherit (dotfilesPackages) dotfiles-python terminal-theme-tools;

      # Host/session spine and editor dependencies.
      inherit (pkgs.unstable)
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
        helix
        imagemagick
        jdk
        jj
        just
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
        openssh_hpn
        pandoc
        pass
        patch
        p7zip
        perl
        pinact
        pinentry-gnome3
        pkg-config
        poppler-utils
        resvg
        ripgrep
        rsync
        ruby
        ruby-lsp
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
        ;

      inherit (pkgs.unstable.luaPackages) luacheck;

      inherit (pkgs.eupkgs)
        yt-dlp-script
        ;

      # Hardware and platform tools.
      inherit (dotfilesPackages) ghostty-patched;
      inherit (pkgs.unstable)
        chezmoi
        pciutils
        podman-compose
        smartmontools
        wl-clipboard
        xclip
        ;
      inherit (pkgs) dotool;
    };

    environment.sessionVariables = {
      CODEX_REAL_BIN = lib.meta.getExe codex;
      LIBCLANG_PATH = "${pkgs.unstable.llvmPackages.libclang.lib}/lib";
      PKG_CONFIG_PATH = rustPkgConfigPath;
      RUST_SRC_PATH = "${pkgs.unstable.rustPlatform.rustLibSrc}";
    };
  };
}
