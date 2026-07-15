if OS.mac?
  cask_args appdir: "/Applications"
  tap "4evy/dotfiles", __dir__
end

# Bootstrap shell and provisioning tools
brew "bash"
brew "chezmoi"
brew "uv"
brew "bun"
brew "go"
brew "gradle"
brew "maven"
brew "node"
brew "openjdk"
brew "ruby"
brew "ruby-lsp"
brew "rustup"

# Shells and prompts
brew "atuin", restart_service: true
brew "direnv"
brew "starship"
brew "zoxide"
brew "zsh"

# CLI replacements
brew "broot"
brew "coreutils"
brew "diffutils"
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
brew "ansible"
brew "ansible-lint"
brew "bash-language-server"
brew "biome"
brew "gh"
brew "git"
brew "git-filter-repo"
brew "git-lfs"
brew "gitui"
brew "golangci-lint"
brew "gopls"
brew "hadolint"
brew "autoconf"
brew "automake"
brew "cmake"
brew "just"
brew "just-lsp"
brew "jj"
brew "libtool"
brew "lld"
brew "lua"
brew "luacheck"
brew "luarocks"
brew "make"
brew "meson"
brew "ninja"
brew "pinact"
brew "gpatch"
brew "pkgconf"
brew "prettier"
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

if OS.linux?
  brew "gdb"
end

# Editors and terminals
# Linux Helix tip is installed by the custom Ansible app script.
if OS.mac?
  brew "helix"
end
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
# Linux Tailscale is a host service managed by the image and host-layer scripts.
if OS.mac?
  # tailscaled requires a boot-level root service; Ansible owns that service.
  brew "tailscale"
end
brew "wget"

# Android device access and screen mirroring
cask "android-platform-tools"
brew "scrcpy"

# Text processing and viewing
brew "jq"
brew "less"
brew "yq"

# System and misc
brew "btop"
brew "fzf"
brew "ghidra"
# Linux Kanata is installed into the host layer with uinput/systemd setup.
# macOS uses a local Ansible-installed Homebrew formula matching the former
# nix-darwin kanata-with-cmd package.
if OS.mac?
  brew "hidapi"
  brew "4evy/dotfiles/kanata-with-cmd"
  brew "4evy/dotfiles/ghostty-patched"
end
brew "lsof"
brew "ncdu"
brew "pass"
brew "pfetch-rs"
brew "ruff"
brew "sops"
brew "tlrc"
brew "tokei"
brew "ty"
brew "yt-dlp"

if OS.linux?
  brew "wl-clipboard"
end

# GUI applications
if OS.mac?
  cask "1password"
  cask "alt-tab"
  cask "appcleaner"
  cask "brave-browser"
  cask "discord"
  cask "docker-desktop", args: { "no-binaries": true }, no_upgrade: true
  cask "firefox"
  cask "google-chrome"
  cask "helium-browser"
  cask "iina"
  cask "imhex"
  cask "itsycal"
  cask "libreoffice"
  cask "prismlauncher"
  cask "rustdesk"
  cask "shottr"
  cask "stats"
  cask "telegram"
  cask "visual-studio-code"
  # Raycast Beta is installed by ansible/roles/applications/tasks/macos.yml.
end

# Fonts
if OS.mac?
  cask "font-jetbrains-mono-nerd-font"
end
