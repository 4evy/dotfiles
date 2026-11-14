require "json"

JSON.load_file(File.join(__dir__, "data/homebrew/tools.json")).each do |tool|
  platform = OS.mac? ? "darwin" : "linux"
  brew(tool.fetch("formula")) if tool.fetch("platforms").include?(platform)
end

cask_args(appdir: "/Applications") if OS.mac?

tap("4evy/hide-disply-audio", "https://github.com/4evy/hide-disply-audio", trusted: true)

# Linux shell and everyday CLI packages are declared in modules/hjem/packages.nix
# Bootstrap installs only the tools needed before Hjem can run
brew("bash") if OS.mac?
brew("bash-completion@2") if OS.mac?
brew("uv") if OS.mac?
brew("bun") if OS.mac?
brew("zstd") if OS.mac?
brew("go")
brew("gradle")
brew("maven")
brew("node")
brew("rustup")

if OS.mac?
  cask("temurin")
else
  brew("openjdk")
end

# Shells and prompts
brew("atuin", restart_service: true)
brew("starship") if OS.mac?
brew("zoxide") if OS.mac?
brew("zsh") if OS.mac?

# CLI replacements
brew("broot") if OS.mac?
brew("diffstat") if OS.mac?
brew("duf") if OS.mac?
brew("dust") if OS.mac?
brew("eza") if OS.mac?
brew("fd") if OS.mac?
brew("git-delta") if OS.mac?
brew("gum") if OS.mac?
brew("ripgrep") if OS.mac?
brew("sd") if OS.mac?

# Development
brew("actionlint")
brew("bash-language-server")
brew("biome")
brew("clang-format")
brew("delve")
brew("dockerfmt") if OS.linux?
brew("gh") if OS.mac?
brew("git") if OS.mac?
brew("git-filter-repo") if OS.mac?
brew("git-lfs") if OS.mac?
brew("gitui") if OS.mac?
brew("golangci-lint")
brew("gopls")
brew("hadolint") if OS.linux?
brew("autoconf")
brew("automake")
brew("cmake")
brew("just") if OS.mac?
brew("just-lsp")
brew("libtool")
brew("lld")
brew("lua")
brew("lua-language-server")
brew("luacheck")
brew("luarocks")
brew("ninja")
brew("pinact")
brew("gpatch")
brew("pkgconf")
brew("quilt")
brew("rumdl")
brew("selene")
brew("shellcheck") if OS.mac?
brew("shfmt") if OS.mac?
brew("sqlcipher")
brew("stylua")
brew("taplo")
brew("watchexec")
brew("yamllint")
brew("yaml-language-server")
brew("zizmor")

# Reverse engineering and binary analysis
brew("afl++")
brew("apktool")
brew("binwalk")
brew("capstone")
brew("dex2jar")
brew("jadx")
brew("keystone")
brew("nasm")
brew("qemu")
brew("radare2")
brew("rizin")
brew("unicorn")
brew("upx")
brew("yara")

brew("gdb") if OS.linux?

# Editors and terminals
brew("yazi") if OS.mac?

# File management and archives
brew("chafa") if OS.mac?
brew("resvg") if OS.mac?
brew("rsync") if OS.mac?
brew("sevenzip") if OS.mac?
brew("tree") if OS.mac?
brew("xz") if OS.mac?

# Media and documents
brew("ffmpeg")
brew("imagemagick")
if OS.mac?
  # Used directly because Homebrew ImageMagick has no Pango text delegate.
  brew("pango")
end

brew("media-info")
brew("pandoc")
brew("poppler")

# Networking
brew("age") if OS.mac?
brew("bind")
brew("gnupg")
brew("netcat")
brew("nmap")
brew("openssh")
brew("sshpass")
# Linux Tailscale is a host service managed by the image and system role.
if OS.mac?
  # tailscaled requires a boot-level root service configured by nix-darwin
  brew("tailscale")
end

brew("wget") if OS.mac?

# Android device access and screen mirroring, without the SDK or NDK
cask("android-platform-tools")
brew("scrcpy")

# Text processing and viewing
brew("jq") if OS.mac?
brew("less") if OS.mac?
brew("yq") if OS.mac?

# System and misc
brew("btop") if OS.mac?
brew("fastfetch") if OS.mac?
brew("fzf") if OS.mac?
# macOS uses the Nix-managed Ghidra with extensions
brew("ghidra") if OS.linux?
brew("ipsw") if OS.mac?

# Linux's image owns Kanata's executable, configuration, and host integration.
# macOS uses its Nix-provided binary and a Darwin launch daemon
if OS.mac?
  brew("4evy/hide-disply-audio/hide-display-audio", args: ["HEAD"])
  brew("gettext")
  brew("hidapi")
end

brew("ncdu") if OS.mac?
brew("pass") if OS.mac?
brew("ruff") if OS.mac?
brew("sops") if OS.mac?
brew("tlrc") if OS.mac?
brew("tokei") if OS.mac?
brew("ty") if OS.mac?
brew("yt-dlp") if OS.mac?

# GUI applications
if OS.mac?
  cask("1password")
  cask("1password-cli")
  cask("alt-tab")
  cask("antigravity")
  cask("appcleaner")
  cask("brave-browser")
  cask("firefox")
  cask("google-chrome")
  cask("iina")
  cask("imhex")
  cask("itsycal")
  cask("libreoffice")
  cask("prismlauncher")
  cask("rustdesk")
  cask("shottr")
  cask("stats")
  cask("telegram")
  # Keymap and Catppuccin are managed in home/files/.config/zed
  # Compare files with: zed --diff OLD NEW
  # Open saved Linux/Mac projects with Zed's Remote Projects command
  # Native and Linux Flatpak Zed use the same managed settings and theme
  cask("zed")
end

# Fonts
cask("font-jetbrains-mono-nerd-font") if OS.mac?

# Evaluate private entries in the same Bundle DSL without copying the manifest
private_brewfile = File.expand_path("~/.config/homebrew/Brewfile.private")
instance_eval(File.read(private_brewfile), private_brewfile) if File.file?(private_brewfile)
