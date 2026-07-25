require "digest"

class TerminalThemeTools < Formula
  SOURCE_ARCHIVE = (Pathname(__dir__).parent/"Sources/terminal-theme-tools-0.1.0.tar").freeze
  SOURCE_SHA256 = Digest::SHA256.file(SOURCE_ARCHIVE).hexdigest.freeze

  desc "Theme-aware wrappers for terminal applications"
  homepage "https://github.com/4evy/dotfiles"
  url "file://#{SOURCE_ARCHIVE}"
  sha256 SOURCE_SHA256
  license "MIT"

  depends_on "meson" => :build
  depends_on "ninja" => :build
  depends_on "pkgconf" => :build
  depends_on "glib"
  depends_on "libgit2"
  depends_on "libvterm"
  depends_on :macos

  resource "tomlc17" do
    url "https://github.com/cktan/tomlc17/archive/7813bdd218b2b5f54940a9759ec0ffb3b60c1d1f.tar.gz"
    sha256 "5fc91baaf3aa140e88316e1243a2087d340c20fb1975a361bcbd624044c29a92"
  end

  def install
    tomlc17 = buildpath/"subprojects/tomlc17"
    resource("tomlc17").stage tomlc17
    cp buildpath/"subprojects/packagefiles/tomlc17/meson.build", tomlc17/"meson.build"

    system "meson", "setup", "build", *std_meson_args, "--wrap-mode=nodownload"
    system "meson", "compile", "-C", "build"
    system "meson", "install", "-C", "build"

    (pkgshare/"source.sha256").write("#{SOURCE_SHA256}\n")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/terminal-theme-run --version")
    assert_match "Available commands:", shell_output("#{bin}/terminal-theme-run help")
  end
end
