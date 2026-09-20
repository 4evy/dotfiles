# frozen_string_literal: true

require_relative "../packages/source-lock/flake_lock"

class HelixTip < Formula
  tap_root = Pathname(__dir__).parent
  pin = DotfilesFlakeLock.input(tap_root, "source-helix")

  desc "Helix Unstable editor build pinned by the dotfiles lock"
  homepage "https://github.com/Helix-Unstable/helix-unstable"
  url DotfilesFlakeLock.repository(pin), revision: pin.fetch("rev")
  version "git-#{pin.fetch("rev")[0, 8]}"
  license "MPL-2.0"
  head DotfilesFlakeLock.repository(pin), branch: pin.fetch("ref")

  depends_on "rust" => :build

  conflicts_with "helix", because: "both install an hx binary"

  def install
    runtime = libexec/"runtime"
    ENV["HELIX_DEFAULT_RUNTIME"] = runtime

    # GitLab rejects anonymous Git fetches for these grammar repositories.
    # Keep the rest of Helix's pinned grammar set available instead of making
    # the entire editor build depend on the unavailable remotes.
    inreplace "languages.toml",
              'use-grammars = { except = [ "wren", "gemini" ] }',
              'use-grammars = { except = [ "wren", "gemini", "lpf", "blueprint", "t32", ' \
              '"rpmspec", "nginx", "debian" ] }'

    system "cargo", "install", *std_cargo_args(path: "helix-term")
    runtime.install Dir["runtime/*"]
    rm_r runtime/"grammars/sources"
  end
end
