require "json"

class KanataWithCmd < Formula
  tap_root = Pathname(__dir__).parent
  pins = JSON.parse((tap_root/"npins/sources.json").read).fetch("pins")
  upstream = pins.fetch("kanata")
  homebrew = pins.fetch("kanata_homebrew")
  archive = pins.fetch("kanata_homebrew_archive")
  digest = archive.fetch("hash").delete_prefix("sha256-").unpack1("m0").unpack1("H*")

  desc "Cross-platform keyboard remapper with command actions enabled"
  homepage "https://github.com/#{upstream.dig("repository", "owner")}/#{upstream.dig("repository", "repo")}"
  url archive.fetch("url")
  version "git-#{homebrew.fetch("revision")[0, 7]}"
  sha256 digest
  license "LGPL-3.0-only"
  head "https://github.com/#{homebrew.dig("repository", "owner")}/#{homebrew.dig("repository", "repo")}.git", branch: homebrew.fetch("branch")

  depends_on "rust" => :build

  conflicts_with "kanata", because: "both install a kanata binary"

  def install
    system "cargo", "install", "--features", "cmd", *std_cargo_args
  end

  test do
    (testpath/"kanata.kbd").write <<~LISP
      (defsrc
        caps
      )

      (deflayer base
        caps
      )
    LISP

    system bin/"kanata", "--check", "--cfg", testpath/"kanata.kbd", "--no-wait"
  end
end
