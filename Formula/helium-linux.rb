# frozen_string_literal: true

require_relative "../packages/source-lock/flake_lock"
require_relative "../packages/source-lock/nix_file_download_strategy"

class HeliumLinux < Formula
  tap_root = Pathname(__dir__).parent
  binary = DotfilesFlakeLock.input(tap_root, "source-helium-linux-binary")
  digest = binary.fetch("narHash").delete_prefix("sha256-").unpack1("m0").unpack1("H*")

  desc "Chromium-based Helium browser for Linux"
  homepage "https://helium.computer/"
  url binary.fetch("url"), using: NixFileDownloadStrategy
  sha256 digest
  license "GPL-3.0-only"

  depends_on arch: :x86_64
  depends_on :linux

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"helium" => "helium"
  end
end
