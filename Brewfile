if OS.mac?
  cask_args appdir: "/Applications"
end

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
brew "openjdk"
brew "ruby"
brew "ruby-lsp"
brew "rustup"

# Shells and prompts
brew "atuin", restart_service: true
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
brew "bash-language-server"
brew "biome"
brew "clang-format"
brew "delve"
brew "dockerfmt"
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
brew "4evy/dotfiles/jj-patched"
brew "libtool"
brew "lld"
brew "lua"
brew "lua-language-server"
brew "luacheck"
brew "luarocks"
brew "make"
brew "meson"
brew "ninja"
brew "pinact"
brew "gpatch"
brew "pkgconf"
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

if OS.linux?
  brew "gdb"
end

# Editors and terminals
# Helix tip is built from the pinned source by the applications role.
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
cask "android-platform-tools"
brew "scrcpy"

# Text processing and viewing
brew "jq"
brew "less"
brew "yq"

# System and misc
brew "btop"
brew "fastfetch"
brew "fzf"
brew "ghidra"
# Linux Kanata is installed by the keyboard role with uinput/systemd setup.
# macOS uses a local Ansible-installed Homebrew formula matching the former
# nix-darwin kanata-with-cmd package.
if OS.mac?
  brew "gettext"
  brew "hidapi"
  brew "mas"
  brew "4evy/dotfiles/terminal-theme-tools"
  brew "zig"
  brew "4evy/dotfiles/kanata-with-cmd"
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

if OS.linux?
  brew "wl-clipboard"
  brew "xclip"
end

# GUI applications
if OS.mac?
  cask "1password"
  cask "1password-cli"
  cask "alt-tab"
  brew "4evy/dotfiles/alt-tab-license"
  cask "appcleaner"
  cask "brave-browser"
  cask "chatgpt"
  cask "discord"
  # Ansible installs Docker Desktop separately and excludes it from Bundle so
  # an ordinary userland refresh never removes its root-owned helper tools.
  cask "docker-desktop", args: { "no-binaries": true }, no_upgrade: true
  cask "firefox"
  cask "google-chrome"
  brew "4evy/dotfiles/ghostty-patched"
  cask "helium-browser"
  cask "iina"
  cask "imhex"
  cask "itsycal"
  cask "libreoffice"
  cask "prismlauncher"
  brew "4evy/dotfiles/raycast-beta"
  cask "rustdesk"
  cask "shottr"
  brew "4evy/dotfiles/shottr-license"
  cask "stats"
  cask "telegram"
  cask "visual-studio-code"
end

# Fonts
if OS.mac?
  cask "font-jetbrains-mono-nerd-font"
end
