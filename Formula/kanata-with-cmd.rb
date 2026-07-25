require "json"

class KanataWithCmd < Formula
  tap_root = Pathname(__dir__).parent
  sources = tap_root/"sources.json"
  sources = tap_root/"manifests/sources.json" unless sources.exist?
  kanata_source = JSON.parse(
    sources.read,
  ).fetch("sources").fetch("kanata")
  upstream_repository = kanata_source.fetch("repository")
  homebrew_source = kanata_source.fetch("variants").fetch("homebrew")
  homebrew_repository = homebrew_source.fetch("repository")
  homebrew_artifact = homebrew_source.fetch("artifacts").fetch("source")

  desc "Cross-platform keyboard remapper with command actions enabled"
  homepage "https://github.com/#{upstream_repository.fetch("owner")}/#{upstream_repository.fetch("name")}"
  url homebrew_artifact.fetch("url")
  version homebrew_source.fetch("version")
  sha256 homebrew_artifact.fetch("sha256")
  license "LGPL-3.0-only"
  head "https://github.com/#{homebrew_repository.fetch("owner")}/#{homebrew_repository.fetch("name")}.git", branch: "main"

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
