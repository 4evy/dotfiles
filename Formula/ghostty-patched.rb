class GhosttyPatched < Formula
  desc "Fast, native terminal emulator with dotfiles scrollback patches"
  homepage "https://ghostty.org"
  url "https://github.com/ghostty-org/ghostty/archive/a887df42c56f6de86c0fe6da9c4eeca37931e083.tar.gz"
  version "1.3.2-dev.a887df4"
  sha256 "fb4b2f9ffa0af125983041fdbe4ef94d3fa79fb9f2d22b9c213c0e3847a866b6"
  license "MIT"

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
           "-Demit-macos-app=false",
           "-Dversion-string=#{version}"

    cd "macos" do
      system "/usr/bin/env", "-i",
             "HOME=#{Dir.home}",
             "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
             "/usr/bin/xcodebuild",
             "-project", "Ghostty.xcodeproj",
             "-target", "Ghostty",
             "-configuration", "Release",
             "SYMROOT=#{buildpath}/macos/build"
    end

    prefix.install "macos/build/Release/Ghostty.app"
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
