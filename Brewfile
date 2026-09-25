# frozen_string_literal: true

cask_args appdir: "/Applications" if OS.mac?

tap "4evy/dotfiles", trusted: true
tap "4evy/hide-disply-audio", "https://github.com/4evy/hide-disply-audio", trusted: true
tap "4evy/patches", "https://github.com/4evy/patches", trusted: true

# Bootstrap shell and provisioning tools
brew "bash"
brew "bash-completion@2"
brew "chezmoi"
brew "uv"
brew "bun"
brew "go"
brew "gradle"
brew "maven"
brew "node"
brew "ruby"
brew "ruby-lsp"
brew "rustup"

if OS.mac?
  cask "temurin@21"
else
  brew "openjdk@21"
end

# Shells and prompts
brew "atuin", restart_service: true
brew "starship"
brew "zoxide"
brew "zsh"

# CLI replacements
brew "broot"
brew "coreutils"
brew "diffutils"
brew "diffstat"
brew "duf"
brew "dust"
brew "eza"
brew "fd"
brew "findutils"
brew "gawk"
brew "git-delta"
brew "gnu-getopt"
brew "gnu-sed"
brew "gnu-tar"
brew "gnu-which"
brew "grep"
brew "gum"
brew "ripgrep"
brew "sd"

# Development
brew "actionlint"
brew "bash-language-server"
brew "biome"
brew "clang-format"
brew "delve"
brew "dockerfmt" if OS.linux?
brew "gh"
brew "git"
brew "git-filter-repo"
brew "git-lfs"
brew "gitui"
brew "golangci-lint"
brew "gopls"
brew "hadolint" if OS.linux?
brew "autoconf"
brew "automake"
brew "cmake"
brew "just"
brew "just-lsp"
brew "4evy/dotfiles/jj-patched"
brew "libtool"
brew "lld"
brew "lua"
brew "lua-language-server"
brew "luacheck"
brew "luarocks"
brew "make"
brew "ninja"
brew "pinact"
brew "gpatch"
brew "pkgconf"
brew "quilt"
brew "rumdl"
brew "selene"
brew "shellcheck"
brew "shfmt"
brew "sqlcipher"
brew "stylua"
brew "taplo"
brew "watchexec"
brew "yamllint"
brew "yaml-language-server"
brew "zizmor"

# Reverse engineering and binary analysis
brew "afl++"
brew "apktool"
brew "binutils"
brew "binwalk"
brew "capstone"
brew "dex2jar"
brew "jadx"
brew "keystone"
brew "nasm"
brew "qemu"
brew "radare2"
brew "rizin"
brew "unicorn"
brew "upx"
brew "yara"

brew "gdb" if OS.linux?

# Editors and terminals
brew "4evy/dotfiles/helix-tip"
brew "yazi"

# File management and archives
brew "chafa"
brew "file-formula"
brew "resvg"
brew "rsync"
brew "sevenzip"
brew "tree"
brew "unzip"
brew "xz"
brew "zip"

# Media and documents
brew "ffmpeg"
brew "imagemagick"
if OS.mac?
  # Used directly because Homebrew ImageMagick has no Pango text delegate.
  brew "pango"
end
brew "media-info"
brew "pandoc"
brew "poppler"

# Networking
brew "age"
brew "curl"
brew "bind"
brew "gnupg"
brew "netcat"
brew "nmap"
brew "openssh"
brew "sshpass"
# Linux Tailscale is a host service managed by the image and system role.
if OS.mac?
  # tailscaled requires a boot-level root service; Ansible owns that service.
  brew "tailscale"
end
brew "wget"

# Android device access and screen mirroring
cask "android-commandlinetools"
cask "android-platform-tools"
brew "scrcpy"

# Text processing and viewing
brew "jq"
brew "less"
brew "yq"

# System and misc
brew "btop"
brew "4evy/dotfiles/browser-configurer"
brew "fastfetch"
brew "fzf"
brew "ghidra"
brew "4evy/dotfiles/equilotl"
brew "4evy/dotfiles/theme-run"

# Linux's image owns Kanata's executable, configuration, and host integration.
# macOS keeps its Brew-provided binary and signed launch daemon in Ansible.
if OS.mac?
  brew "4evy/hide-disply-audio/hide-display-audio", args: ["HEAD"]
  brew "4evy/dotfiles/kanata-with-cmd"
  brew "gettext"
  brew "hidapi"
  brew "zig"
end
brew "lsof"
brew "ncdu"
brew "pass"
brew "ruff"
brew "sops"
brew "tlrc"
brew "tokei"
brew "ty"
brew "yt-dlp"
brew "4evy/dotfiles/yt-dlp-script"

if OS.linux?
  brew "wl-clipboard"
  brew "xclip"
end

# GUI applications
if OS.mac?
  cask "1password"
  cask "1password-cli"
  cask "alt-tab"
  cask "appcleaner"
  cask "brave-browser"
  cask "discord"
  cask "firefox"
  cask "google-chrome"
  brew "4evy/dotfiles/ghostty-patched"
  cask "helium-browser"
  cask "iina"
  cask "imhex"
  cask "itsycal"
  cask "libreoffice"
  cask "prismlauncher"
  # Let the official cask adopt installations created by the retired local
  # Raycast manager during the one-time migration.
  cask "raycast", args: { force: true }
  cask "rustdesk"
  cask "shottr"
  cask "stats"
  cask "telegram"
  cask "visual-studio-code"
else
  brew "4evy/dotfiles/helium-linux"
end

# Brew Bundle installs these through the native editor CLI on both Spectrum
# and macOS, keeping editor packages in the same manifest as the editor.
vscode "astral-sh.ty"
vscode "biomejs.biome"
vscode "bradlc.vscode-tailwindcss"
vscode "catppuccin.catppuccin-vsc"
vscode "catppuccin.catppuccin-vsc-icons"
vscode "charliermarsh.ruff"
vscode "christian-kohler.path-intellisense"
vscode "csstools.postcss"
vscode "davidanson.vscode-markdownlint"
vscode "dbaeumer.vscode-eslint"
vscode "editorconfig.editorconfig"
vscode "esbenp.prettier-vscode"
vscode "github.vscode-github-actions"
vscode "golang.go"
vscode "hangxingliu.vscode-systemd-support"
vscode "jnoortheen.nix-ide"
vscode "johnnymorganz.stylua"
vscode "kdl-org.kdl"
vscode "mads-hartmann.bash-ide-vscode"
vscode "mikestead.dotenv"
vscode "mkhl.shfmt"
vscode "ms-azuretools.vscode-containers" if OS.linux?
vscode "ms-python.debugpy"
vscode "ms-python.python"
vscode "ms-python.vscode-python-envs"
vscode "ms-vscode.cpptools"
vscode "ms-vscode.vscode-typescript-next"
vscode "myriad-dreamin.tinymist"
vscode "nefrob.vscode-just-syntax"
vscode "oderwat.indent-rainbow"
vscode "oven.bun-vscode"
vscode "redhat.ansible"
vscode "redhat.vscode-xml"
vscode "redhat.vscode-yaml"
vscode "sumneko.lua"
vscode "svelte.svelte-vscode"
vscode "tamasfe.even-better-toml"
vscode "timonwong.shellcheck"
vscode "tomoki1207.pdf"
vscode "usernamehw.errorlens"
vscode "xembly.gomplate"
vscode "yoavbls.pretty-ts-errors"

# Fonts
cask "font-jetbrains-mono-nerd-font" if OS.mac?
