require "digest"

class TerminalThemeTools < Formula
  SOURCE_ARCHIVE = (Pathname(__dir__).parent/"Sources/terminal-theme-tools-0.2.0.tar").freeze
  SOURCE_SHA256 = Digest::SHA256.file(SOURCE_ARCHIVE).hexdigest.freeze

  desc "Theme-aware launcher for terminal applications"
  homepage "https://github.com/4evy/dotfiles"
  url "file://#{SOURCE_ARCHIVE}"
  sha256 SOURCE_SHA256
  license "MIT"

  depends_on "zig" => :build
  depends_on :macos

  resource "ghostty" do
    url "https://github.com/ghostty-org/ghostty/archive/4d605bf0d819df901a0332bbb320dc849fdd82e4.tar.gz"
    sha256 "60835a65be4c18d50d2766bf9b9ff63847e19622f7704a916709edb044c2a780"
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

    system "zig", "build", "--release=small", "--prefix", prefix
    (pkgshare/"source.sha256").write("#{SOURCE_SHA256}\n")
  end

  test do
    assert_predicate include/"terminal_theme_tools.h", :exist?
    assert_predicate lib/"libterminal_theme_tools.a", :exist?
    assert_match version.to_s, shell_output("#{bin}/terminal-theme-run --version")
    assert_match "Usage: terminal-theme-run", shell_output("#{bin}/terminal-theme-run --help")
    system bin/"terminal-theme-run", "true"
  end
end
