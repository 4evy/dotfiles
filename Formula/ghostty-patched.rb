require "json"

class GhosttyPatched < Formula
  tap_root = Pathname(__dir__).parent
  sources = tap_root/"sources.json"
  sources = tap_root/"manifests/sources.json" unless sources.exist?
  ghostty_source = JSON.parse(
    sources.read,
  ).fetch("sources").fetch("ghostty")
  ghostty_artifact = ghostty_source.fetch("artifacts").fetch("source")

  desc "Fast, native terminal emulator with dotfiles scrollback patches"
  homepage "https://ghostty.org"
  url ghostty_artifact.fetch("url")
  version ghostty_source.fetch("version")
  sha256 ghostty_artifact.fetch("sha256")
  license "MIT"

  depends_on "gettext" => :build
  depends_on xcode: :build
  depends_on "zig" => :build
  depends_on :macos

  def install
    patch_dir = Pathname(__dir__).parent/"Patches/ghostty"
    patches = (patch_dir/"series").readlines(chomp: true)
              .map(&:strip)
              .reject { |line| line.empty? || line.start_with?("#") }
              .map { |name| patch_dir/name }
    odie "Ghostty patch series is empty: #{patch_dir}" if patches.empty?
    odie "Ghostty patch series contains a missing file" unless patches.all?(&:file?)

    system "git", "apply", "--check", *patches
    system "git", "apply", *patches
    system formula_opt_bin("zig")/"zig", "build",
           "-Doptimize=ReleaseFast",
           "-Demit-test-exe=false",
           "-Dversion-string=#{version}"

    prefix.install "zig-out/Ghostty.app"
  end

  def caveats
    <<~EOS
      Ghostty.app is installed at:
        #{opt_prefix}/Ghostty.app

      The dotfiles Ansible role links it into /Applications.
    EOS
  end

  test do
    output = shell_output("#{prefix}/Ghostty.app/Contents/MacOS/ghostty +version")
    assert_match version.to_s, output
  end
end
