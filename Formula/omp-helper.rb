# frozen_string_literal: true

class OmpHelper < Formula
  source = Tap.fetch("4evy", "dotfiles").path/"Sources/omp-helper.json"
  raise "Stage a Darwin payload with remote_helper before installing" unless source.file?
  metadata = JSON.parse(source.read)
  digest = metadata.fetch("sha256")
  payload = source.dirname/metadata.fetch("archive")
  match = payload.basename.to_s.match(/\Aomp-helper-(\d+\.\d+\.\d+)\.([1-9]\d*)-darwin-(arm64|x64)\.tar\.gz\z/)
  raise "Expected a Darwin payload archive filename" unless match && metadata.fetch("archive") == payload.basename.to_s
  raise "Expected a SHA-256 digest" unless digest.match?(/\A[a-fA-F0-9]{64}\z/)
  raise "Build the payload for this Mac's architecture" unless match[3] == (Hardware::CPU.arm? ? "arm64" : "x64")

  desc "Private managed SSH jobs with PTY input, observation and cleanup"
  homepage "https://github.com/4evy/dotfiles"
  url "file://#{payload}"
  version match[1]
  revision match[2].to_i
  sha256 digest.downcase
  license "MIT"

  depends_on :macos

  def install
    libexec.install Dir["*", ".[^.]*"].reject { |entry| [".", ".."].include?(entry) }
    bin.install_symlink libexec/"bin/omp-helper"
  end

  def caveats
    <<~EOS
      Activate for this user with:
        omp-helper install
      macOS supports managed jobs only; Linux desktop tools remain unavailable
      Before upgrading, run omp-helper upgrade prepare and retain its token
      Keep HOMEBREW_NO_INSTALL_CLEANUP=1 until activation or recovery succeeds
      Deactivate with omp-helper uninstall before brew uninstall omp-helper
    EOS
  end
end
