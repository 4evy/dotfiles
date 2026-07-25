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
  helix = pkgs.unstable.helix.overrideAttrs {
    doCheck = false;
    doInstallCheck = false;
  };
  ghosttyVersion = pkgs.dotfilesSources.ghostty.version;
  # The dependency expression is imported below during evaluation. An
  # evaluator-side fixed-output fetch keeps that import host-independent, so a
  # macOS workstation can evaluate the x86_64-linux NixOS configuration.
  ghosttySource = builtins.fetchTarball {
    inherit (pkgs.dotfilesSources.ghostty.artifacts.source) url;
    sha256 = pkgs.dotfilesSources.ghostty.hashes.nix_source;
  };
  ghosttyPatchDirectory = ../../patches/ghostty;
  ghosttyPatchNames = lib.filter (name: name != "") (
    lib.splitString "\n" (builtins.readFile (ghosttyPatchDirectory + /series))
  );
  ghosttyPatched = pkgs.unstable.ghostty.overrideAttrs (
    finalAttrs: _: {
      version = ghosttyVersion;
      src = ghosttySource;
      deps = pkgs.callPackage (ghosttySource + "/build.zig.zon.nix") {
        name = "ghostty-cache-${finalAttrs.version}";
      };
      patches = map (name: ghosttyPatchDirectory + "/${name}") ghosttyPatchNames;
      doCheck = false;
      doInstallCheck = false;
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
        yamllint
        terminal-theme-tools
        ;
      inherit helix;

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
