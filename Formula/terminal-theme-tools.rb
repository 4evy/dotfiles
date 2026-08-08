require "digest"

class TerminalThemeTools < Formula
  SOURCE_ARCHIVE = (Pathname(__dir__).parent/"Sources/terminal-theme-tools-0.3.0.tar").freeze
  SOURCE_SHA256 = Digest::SHA256.file(SOURCE_ARCHIVE).hexdigest.freeze

  desc "Theme-aware launcher for terminal applications"
  homepage "https://github.com/4evy/dotfiles"
  url "file://#{SOURCE_ARCHIVE}"
  sha256 SOURCE_SHA256
  license "MIT"

  depends_on "zig" => :build
  depends_on :macos

  resource "ghostty" do
    url "https://github.com/ghostty-org/ghostty/archive/7e567c3f03e914140f0b6beb8b03c20efcc03188.tar.gz"
    sha256 "bff102623a759b453879c6432c1aa4731c035c6be543884e802bbbebac05f1c1"
  end

  resource "uucode" do
    url "https://deps.files.ghostty.org/uucode-2826a37a4562284fdacd8fa029d49509cc9bffcd.tar.gz"
    sha256 "7e76fc7fab1e7ac728c52b35bbb3e5b8c639841abfc7fe1a4bcb13050594bc9e"
  end

  def install
    resources.each do |resource|
      resource.stage buildpath/".deps"/resource.name
    end

    inreplace "build.zig.zon" do |s|
      s.gsub!(/\.ghostty = \.\{.*?^\s*\},/m, '.ghostty = .{ .path = ".deps/ghostty" },')
    end
    inreplace ".deps/ghostty/build.zig.zon" do |s|
      s.gsub!(/\.uucode = \.\{.*?^\s*\},/m, '.uucode = .{ .path = "../uucode" },')
    end
    inreplace ".deps/ghostty/src/build/Config.zig" do |s|
      old_default = <<~ZIG.chomp
        ) orelse emit_xcfw: {
                if (!builtin.target.os.tag.isDarwin()
      ZIG
      dependency_default = <<~ZIG.chomp
        ) orelse emit_xcfw: {
                if (is_dep) break :emit_xcfw false;
                if (!builtin.target.os.tag.isDarwin()
      ZIG
      replaced = s.sub!(
        old_default,
        dependency_default,
      )
      odie "Ghostty dependency-mode default changed upstream" unless replaced
    end

    system "zig", "build", "--release=small", "--prefix", prefix
    (pkgshare/"source.sha256").write("#{SOURCE_SHA256}\n")
  end

  test do
    assert_path_exists include/"terminal_theme_tools.h"
    assert_path_exists lib/"libterminal_theme_tools.a"
    assert_match version.to_s, shell_output("#{bin}/terminal-theme-run --version")
    assert_match "Usage: terminal-theme-run", shell_output("#{bin}/terminal-theme-run --help")
    system bin/"terminal-theme-run", "true"
  end
end
