require "digest"

class RaycastBeta < Formula
  MANAGER_SOURCE = (Pathname(__dir__).parent/"libexec/raycast-beta-manager.rb").freeze

  desc "Next-generation Raycast public beta with dotfiles integration"
  homepage "https://www.raycast.com/new"
  url "file://#{MANAGER_SOURCE}"
  version "3"
  sha256 Digest::SHA256.file(MANAGER_SOURCE).hexdigest
  license :cannot_represent

  depends_on arch: :arm64
  depends_on macos: :tahoe
  depends_on "ruby"

  allow_network_access! :postinstall
  deny_network_access! [:build, :test]

  def install
    libexec.install "raycast-beta-manager.rb"
    inreplace libexec/"raycast-beta-manager.rb",
              "#!/usr/bin/env ruby",
              "#!#{formula_opt_bin("ruby")}/ruby"
    chmod 0755, libexec/"raycast-beta-manager.rb"
    bin.install_symlink (libexec/"raycast-beta-manager.rb") => "raycast-beta-manager"
  end

  def post_install
    system bin/"raycast-beta-manager", "install"
  end

  def caveats
    <<~EOS
      Raycast Beta is copied to:
        /Applications/Raycast Beta.app

      Refresh the app and apply the chezmoi-managed profile and aliases with:
        raycast-beta-manager refresh
    EOS
  end
end
