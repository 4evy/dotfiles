class JjPatched < Formula
  desc "Jujutsu build with native signing, redate, and shallow workflow patches"
  homepage "https://github.com/jj-vcs/jj"
  url "https://github.com/4evy/jj/archive/09339986bac59ef81e7d0bb511e504d329277d63.tar.gz"
  version "0.43.0-head-09339986"
  sha256 "6b1aed823aadf2d6a8f35ef2a64bba8a3d68a9e6f837c419b3e44aaa1d86b14d"
  license "Apache-2.0"
  depends_on "rust" => :build

  conflicts_with "jj", because: "both install a jj binary"

  def install
    tap_root = Pathname(__dir__).parent
    patch_dir = tap_root/"patches/jj"
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
