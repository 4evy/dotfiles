# frozen_string_literal: true

require "digest"

class AltTabLicense < Formula
  MANAGER_SOURCE = (Pathname(__dir__).parent/"libexec/alt-tab-license.rb").freeze

  desc "Dotfiles-managed AltTab license activation"
  homepage "https://github.com/lwouis/alt-tab-macos"
  url "file://#{MANAGER_SOURCE}"
  version "1"
  sha256 Digest::SHA256.file(MANAGER_SOURCE).hexdigest
  license "MIT"

  depends_on macos: :tahoe
  depends_on "ruby"

  def install
    libexec.install "alt-tab-license.rb"
    chmod 0755, libexec/"alt-tab-license.rb"
    bin.install_symlink (libexec/"alt-tab-license.rb") => "alt-tab-license"
  end

  def post_install
    system bin/"alt-tab-license", "install"
  end

  test do
    assert_predicate libexec/"alt-tab-license.rb", :executable?
    assert_match "Usage:", shell_output("#{bin}/alt-tab-license --help")
  end
end
