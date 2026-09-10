# frozen_string_literal: true

require_relative "../packages/source-lock/flake_lock"

class BrowserConfigurer < Formula
  tap_root = Pathname(__dir__).parent
  pin = DotfilesFlakeLock.input(tap_root, "source-browser")

  desc "Make Chromium-family browsers declarative"
  homepage "https://github.com/4evy/browser"
  url DotfilesFlakeLock.repository(pin), revision: pin.fetch("rev")
  version "git-#{pin.fetch("rev")[0, 8]}"
  license "MIT"

  depends_on "go" => :build

  def install
    system "go", "build", *std_go_args(output: bin/"browser-configurer"), "./cmd/browser"
  end
end
