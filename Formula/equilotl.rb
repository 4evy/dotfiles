# frozen_string_literal: true

require_relative "../packages/source-lock/flake_lock"

class Equilotl < Formula
  tap_root = Pathname(__dir__).parent
  pin = DotfilesFlakeLock.input(tap_root, "source-equilotl")
  UPSTREAM_REVISION = pin.fetch("rev").freeze
  UPSTREAM_TAG = pin.fetch("ref").freeze

  desc "Cross-platform Equicord installer and repair CLI"
  homepage "https://github.com/Equicord/Equilotl"
  url DotfilesFlakeLock.repository(pin), revision: pin.fetch("rev")
  version "release-#{UPSTREAM_TAG.delete_prefix("v")}"
  license "GPL-3.0-only"

  depends_on "go" => :build

  on_macos do
    depends_on arch: :arm64
  end

  on_linux do
    depends_on arch: :x86_64
  end

  def install
    executable = OS.mac? ? "EquilotlCli-darwin-arm64" : "EquilotlCli-linux"
    ldflags = [
      "-X equilotl/buildinfo.InstallerGitHash=#{UPSTREAM_REVISION[0, 7]}",
      "-X equilotl/buildinfo.InstallerTag=#{UPSTREAM_TAG}",
    ]
    system "go", "build", *std_go_args(output: bin/executable, ldflags:, tags: "cli")
    bin.install_symlink executable => "equilotl"
  end
end
