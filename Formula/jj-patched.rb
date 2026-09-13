# frozen_string_literal: true

require_relative "../packages/source-lock/flake_lock"

class JjPatched < Formula
  patches_tap = Tap.fetch("4evy", "patches")
  raise "Tap 4evy/patches before installing jj-patched" unless patches_tap.installed?

  manifest = JSON.load_file(patches_tap.path/"stacks/jj/stack.json")
  jj = DotfilesFlakeLock.stack_source(patches_tap.path, "jj")
  result_tree = manifest.fetch("result").fetch("tree").fetch("oid")

  desc "Jujutsu build with the 4evy patch stack"
  homepage "https://github.com/jj-vcs/jj"
  url DotfilesFlakeLock.repository(jj), revision: jj.fetch("rev")
  version "0.44.0-head-#{result_tree[0, 8]}"
  license "Apache-2.0"
  revision 1
  depends_on "rust" => :build

  conflicts_with "jj", because: "both install a jj binary"

  def install
    patch_dir = Tap.fetch("4evy", "patches").path/"stacks/jj/patches"
    patches = (patch_dir/"series").readlines(chomp: true).map { |name| patch_dir/name }
    odie "jj patch series is empty: #{patch_dir}" if patches.empty?

    # Homebrew's temporary directory can be inside its own Git checkout.
    # Give the source its own root so git apply cannot silently skip patches.
    system "git", "init", "--quiet"
    system "git", "apply", *patches
    system "cargo", "install", "--bin", "jj", *std_cargo_args(path: "cli")

    generate_completions_from_executable(bin/"jj", shell_parameter_format: :clap)
    system bin/"jj", "util", "install-man-pages", man
  end
end
