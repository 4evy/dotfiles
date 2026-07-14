{
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
  ghosttyRevision = "a887df42c56f6de86c0fe6da9c4eeca37931e083";
  ghosttyVersion = "1.3.2-dev.${builtins.substring 0 7 ghosttyRevision}";
  ghosttySource = pkgs.fetchFromGitHub {
    owner = "ghostty-org";
    repo = "ghostty";
    rev = ghosttyRevision;
    hash = "sha256-1Zz65SCk3rkJ9+Q0MmyNOTNiDSLBRIHRd3IvFM4iNXw=";
  };
  ghosttyPatched = pkgs.unstable.ghostty.overrideAttrs (
    finalAttrs: _: {
      version = ghosttyVersion;
      src = ghosttySource;
      deps = pkgs.callPackage (ghosttySource + "/build.zig.zon.nix") {
        name = "ghostty-cache-${finalAttrs.version}";
      };
      patches = [
        ../../patches/ghostty/0001-surface-export-the-active-screen-with-scrollback.patch
        ../../patches/ghostty/0002-apprt-identify-terminal-scrollback-text.patch
        ../../patches/ghostty/0003-embedded-honor-command-wait-after-command-setting.patch
        ../../patches/ghostty/0004-gtk-edit-scrollback-in-a-temporary-surface.patch
        ../../patches/ghostty/0005-macos-edit-scrollback-in-a-temporary-surface.patch
      ];
    }
  );
in
{
  _class = "nixos";

  config = {
    environment.systemPackages = attrValues {
      inherit (pkgs)
        ansible
        ansible-lint
        dotfiles-python
        system-runner
        yamllint
        terminal-theme-tools
        ;

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
        diffutils
        direnv
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
        luarocks
        maven
        mediainfo
        meson
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
        prettier
        resvg
        ripgrep
        rsync
        ruby
        ruby-lsp
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
        agent-statusline
        agent-statusline-pi
        pi-ssh-tools
        web-search-pi
        yt-dlp-script
        ;

      # Hardware and platform tools.
      ghostty = ghosttyPatched;
      inherit (pkgs.unstable)
        chezmoi
        nh
        pciutils
        podman-compose
        smartmontools
        wl-clipboard
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
