cask_args appdir: "/Applications" if OS.mac?

tap "4evy/hide-disply-audio", "https://github.com/4evy/hide-disply-audio", trusted: true

# Linux shell and everyday CLI packages are declared in modules/hjem/packages.nix
# Bootstrap installs only the tools needed before Hjem can run
brew "bash" if OS.mac?
brew "bash-completion@2" if OS.mac?
brew "uv" if OS.mac?
brew "bun" if OS.mac?
brew "zstd" if OS.mac?
brew "go"
brew "gradle"
brew "maven"
brew "node"
brew "rustup"

if OS.mac?
  cask "temurin"
else
  brew "openjdk"
end

# Shells and prompts
brew "atuin", restart_service: true
brew "starship" if OS.mac?
brew "zoxide" if OS.mac?
brew "zsh" if OS.mac?

# CLI replacements
brew "broot" if OS.mac?
brew "coreutils" if OS.mac?
brew "diffutils" if OS.mac?
brew "diffstat" if OS.mac?
brew "duf" if OS.mac?
brew "dust" if OS.mac?
brew "eza" if OS.mac?
brew "fd" if OS.mac?
brew "findutils" if OS.mac?
brew "gawk" if OS.mac?
brew "git-delta" if OS.mac?
brew "gnu-getopt" if OS.mac?
brew "gnu-sed" if OS.mac?
brew "gnu-tar" if OS.mac?
brew "gnu-which" if OS.mac?
brew "grep" if OS.mac?
brew "gum" if OS.mac?
brew "ripgrep" if OS.mac?
brew "sd" if OS.mac?

# Development
brew "actionlint"
brew "bash-language-server"
brew "biome"
brew "clang-format"
brew "delve"
brew "dockerfmt" if OS.linux?
brew "gh" if OS.mac?
brew "git" if OS.mac?
brew "git-filter-repo" if OS.mac?
brew "git-lfs" if OS.mac?
brew "gitui" if OS.mac?
brew "golangci-lint"
brew "gopls"
brew "hadolint" if OS.linux?
brew "autoconf"
brew "automake"
brew "cmake"
brew "just" if OS.mac?
brew "just-lsp"
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
brew "shellcheck" if OS.mac?
brew "shfmt" if OS.mac?
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
brew "yazi" if OS.mac?

# File management and archives
brew "chafa" if OS.mac?
brew "file-formula" if OS.mac?
brew "resvg" if OS.mac?
brew "rsync" if OS.mac?
brew "sevenzip" if OS.mac?
brew "tree" if OS.mac?
brew "unzip" if OS.mac?
brew "xz" if OS.mac?
brew "zip" if OS.mac?

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
brew "age" if OS.mac?
brew "curl" if OS.mac?
brew "bind"
brew "gnupg"
brew "netcat"
brew "nmap"
brew "openssh"
brew "sshpass"
# Linux Tailscale is a host service managed by the image and system role.
if OS.mac?
  # tailscaled requires a boot-level root service configured by nix-darwin
  brew "tailscale"
end
brew "wget" if OS.mac?

# Android device access and screen mirroring
cask "android-commandlinetools"
cask "android-platform-tools"
brew "scrcpy"

# Text processing and viewing
brew "jq" if OS.mac?
brew "less" if OS.mac?
brew "yq" if OS.mac?

# System and misc
brew "btop" if OS.mac?
brew "fastfetch" if OS.mac?
brew "fzf" if OS.mac?
brew "ghidra"
brew "ipsw" if OS.mac?

# Linux's image owns Kanata's executable, configuration, and host integration.
# macOS uses its Nix-provided binary and a Darwin launch daemon
if OS.mac?
  brew "4evy/hide-disply-audio/hide-display-audio", args: ["HEAD"]
  brew "gettext"
  brew "hidapi"
  brew "zig"
end
brew "lsof"
brew "ncdu" if OS.mac?
brew "pass" if OS.mac?
brew "ruff" if OS.mac?
brew "sops" if OS.mac?
brew "tlrc" if OS.mac?
brew "tokei" if OS.mac?
brew "ty" if OS.mac?
brew "yt-dlp" if OS.mac?

# GUI applications
if OS.mac?
  cask "1password"
  cask "1password-cli"
  cask "alt-tab"
  cask "appcleaner"
  cask "brave-browser"
  cask "firefox"
  cask "google-chrome"
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
  # VS Code keymap and Catppuccin are managed in home/files/.config/zed
  # Compare files with: zed --diff OLD NEW
  cask "zed"
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
vscode "typescriptteam.native-preview"
vscode "usernamehw.errorlens"
vscode "xembly.gomplate"
vscode "yoavbls.pretty-ts-errors"

# Fonts
cask "font-jetbrains-mono-nerd-font" if OS.mac?

# Evaluate private entries in the same Bundle DSL without copying the manifest
private_brewfile = File.expand_path("~/.config/homebrew/Brewfile.private")
instance_eval(File.read(private_brewfile), private_brewfile) if File.file?(private_brewfile)
