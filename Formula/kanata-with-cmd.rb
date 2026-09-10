# frozen_string_literal: true

require_relative "../packages/source-lock/flake_lock"

class KanataWithCmd < Formula
  tap_root = Pathname(__dir__).parent
  homebrew = DotfilesFlakeLock.input(tap_root, "source-kanata-homebrew")
  patches_tap = Tap.fetch("4evy", "patches")
  raise "Tap 4evy/patches before installing kanata-with-cmd" unless patches_tap.installed?

  manifest = JSON.load_file(patches_tap.path/"stacks/kanata/stack.json")
  stack_revision = manifest.fetch("source").fetch("revision")
  raise "The Kanata source pin does not match the 4evy/patches stack" if stack_revision != homebrew.fetch("rev")

  desc "Cross-platform keyboard remapper with command actions enabled"
  homepage "https://github.com/jtroo/kanata"
  url DotfilesFlakeLock.repository(homebrew), revision: homebrew.fetch("rev")
  version "git-#{homebrew.fetch("rev")[0, 7]}"
  license "LGPL-3.0-only"
  revision 1
  head DotfilesFlakeLock.repository(homebrew), branch: "main"

  depends_on "rust" => :build

  conflicts_with "kanata", because: "both install a kanata binary"

  def install
    patch_dir = Tap.fetch("4evy", "patches").path/"stacks/kanata/patches"
    patches = (patch_dir/"series").readlines(chomp: true).map { |name| patch_dir/name }
    odie "Kanata patch series is empty: #{patch_dir}" if patches.empty?

    system "git", "apply", *patches

    # Cargo install does not build test targets; only compile the managed
    # executable if upstream adds more binaries to the crate.
    system "cargo", "install", "--bin", "kanata", "--features", "cmd", *std_cargo_args
  end
end
