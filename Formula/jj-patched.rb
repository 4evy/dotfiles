class JjPatched < Formula
  desc "Jujutsu build with native signing, redate, and shallow workflow patches"
  homepage "https://github.com/jj-vcs/jj"
  url "https://github.com/jj-vcs/jj/archive/5b48bec5eb0e08539e2f0b50395af63972788b23.tar.gz"
  version "0.43.0-head-5b48bec5"
  sha256 "c752aeae21e8acabfb69fcd85ca752e8659c0dc551b1ec7897a77df50801ff8a"
  license "Apache-2.0"
  compatibility_version 1

  depends_on "rust" => :build

  conflicts_with "jj", because: "both install a jj binary"

  def install
    tap_root = Pathname(__dir__).parent
    patch_dir = tap_root/"Patches/jj"
    patch_dir = tap_root/"patches/jj" unless patch_dir.exist?
    patches = (patch_dir/"series").readlines(chomp: true)
              .map(&:strip)
              .reject { |line| line.empty? || line.start_with?("#") }
              .map { |name| patch_dir/name }
    odie "jj patch series is empty: #{patch_dir}" if patches.empty?
    odie "jj patch series contains a missing file" unless patches.all?(&:file?)

    patches.each do |patch|
      system "git", "apply", "--check", patch
      system "git", "apply", patch
    end
    system "cargo", "install", *std_cargo_args(path: "cli")

    generate_completions_from_executable(bin/"jj", shell_parameter_format: :clap)
    system bin/"jj", "util", "install-man-pages", man
  end
end
