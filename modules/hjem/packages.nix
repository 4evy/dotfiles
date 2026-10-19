{ pkgs }:
let
  inherit (pkgs) lib nerd-fonts unstable;
in
lib.attrValues {
  # Bootstrap tools also remain available before the first Hjem activation
  inherit (pkgs)
    bash
    bash-completion
    zsh
    zstd
    ;
  inherit (unstable) bun just uv;

  # Shell tools and everyday command-line applications
  inherit (pkgs)
    age
    broot
    btop
    chafa
    coreutils
    curl
    delta
    diffstat
    diffutils
    duf
    dust
    eza
    fastfetch
    fd
    file
    findutils
    fzf
    gawk
    getopt
    gh
    git
    git-filter-repo
    git-lfs
    gitui
    gnugrep
    gnused
    gnutar
    gum
    jq
    less
    ncdu
    p7zip
    pass
    resvg
    ripgrep
    rsync
    ruff
    sd
    shellcheck
    shfmt
    sops
    starship
    tlrc
    tokei
    tree
    ty
    unzip
    wget
    which
    wl-clipboard
    xclip
    xz
    yazi
    yq-go
    yt-dlp
    zip
    zoxide
    ;

  # User fonts belong to the same generation as the user environment
  inherit (nerd-fonts) jetbrains-mono;
  inherit (pkgs) noto-fonts-color-emoji;
}
