# frozen_string_literal: true

require_relative "../packages/source-lock/flake_lock"

class YtDlpScript < Formula
  tap_root = Pathname(__dir__).parent
  pin = DotfilesFlakeLock.input(tap_root, "source-yt-dlp-script")

  desc "Opinionated yt-dlp download and media conversion workflow"
  homepage "https://github.com/euvlok/pkgs"
  url DotfilesFlakeLock.repository(pin), revision: pin.fetch("rev")
  version "git-#{pin.fetch("rev")[0, 8]}"
  license "MIT"

  depends_on "bash"
  depends_on "ffmpeg"
  depends_on "jq"
  depends_on "yt-dlp"

  def install
    bin.install "pkgs/by-name/yt/yt-dlp-script/yt-dlp-script.sh" => "yt-dlp-script"
  end
end
