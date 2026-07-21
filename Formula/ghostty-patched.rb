require "json"

class GhosttyPatched < Formula
  tap_root = Pathname(__dir__).parent
  source_pins = tap_root/"source-pins.json"
  source_pins = tap_root/"spectrum/scripts/spectrum_build/programs/source-pins.json" unless source_pins.exist?
  ghostty_pin = JSON.parse(
    source_pins.read,
  ).fetch("ghostty")

  desc "Fast, native terminal emulator with dotfiles scrollback patches"
  homepage "https://ghostty.org"
  url "https://github.com/ghostty-org/ghostty/archive/#{ghostty_pin.fetch("revision")}.tar.gz"
  version ghostty_pin.fetch("version")
  sha256 ghostty_pin.fetch("source_sha256")
  license "MIT"

  depends_on "gettext" => :build
  depends_on xcode: :build
  depends_on "zig@0.15" => :build
  depends_on :macos

  def install
    patch_dir = Pathname(__dir__).parent/"Patches/ghostty"
    patches = patch_dir.glob("*.patch").sort
    odie "Ghostty patch series is empty: #{patch_dir}" if patches.empty?

    system "git", "apply", "--check", *patches
    system "git", "apply", *patches
    system formula_opt_bin("zig@0.15")/"zig", "build",
           "-Doptimize=ReleaseFast",
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
