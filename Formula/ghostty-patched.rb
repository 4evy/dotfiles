# frozen_string_literal: true

require_relative "../packages/source-lock/flake_lock"

class GhosttyPatched < Formula
  patches_tap = Tap.fetch("4evy", "patches")
  raise "Tap 4evy/patches before installing ghostty-patched" unless patches_tap.installed?

  ghostty = DotfilesFlakeLock.stack_source(patches_tap.path, "ghostty")

  desc "Fast, native terminal emulator with the 4evy patch stack"
  homepage "https://ghostty.org"
  url DotfilesFlakeLock.repository(ghostty), revision: ghostty.fetch("rev")
  version "1.3.2-dev.#{ghostty.fetch("rev")[0, 7]}"
  license "MIT"

  depends_on "gettext" => :build
  depends_on xcode: :build
  depends_on "zig" => :build
  depends_on :macos

  def install
    patch_dir = Tap.fetch("4evy", "patches").path/"stacks/ghostty/patches"
    patches = (patch_dir/"series").readlines(chomp: true).map { |name| patch_dir/name }
    odie "Ghostty patch series is empty: #{patch_dir}" if patches.empty?

    system "git", "apply", *patches
    system formula_opt_bin("zig")/"zig", "build",
           "-Doptimize=ReleaseFast",
           "-Demit-test-exe=false",
           "-Dxcframework-target=native",
           "-Dxcodebuild-disable-package-manifest-sandbox=true",
           "-Dversion-string=#{version}"

    prefix.install "zig-out/Ghostty.app"
  end

  def caveats
    <<~CAVEATS
      Ghostty.app is installed at:
        #{opt_prefix}/Ghostty.app

      The dotfiles Ansible role copies it into /Applications so launchers can
      discover the application bundle.
    CAVEATS
  end
end
