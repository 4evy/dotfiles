# frozen_string_literal: true

require "digest"

class ShottrLicense < Formula
  REPOSITORY_ROOT = Pathname(__dir__).parent.freeze
  MANAGER_SOURCE = (REPOSITORY_ROOT/"libexec/shottr-license.rb").freeze
  ACTIVATION_SCRIPT_SOURCE = (
    REPOSITORY_ROOT/"libexec/activate-shottr-license.applescript"
  ).freeze
  SECRETS_SOURCE = begin
    tap_source = REPOSITORY_ROOT/"secrets/secrets.yaml"
    tap_source.file? ? tap_source : REPOSITORY_ROOT/"libexec/secrets.yaml"
  end.freeze

  desc "Dotfiles-managed Shottr license activation"
  homepage "https://shottr.cc/"
  url "file://#{MANAGER_SOURCE}"
  version "1"
  sha256 Digest::SHA256.file(MANAGER_SOURCE).hexdigest
  license "MIT"

  depends_on macos: :tahoe
  depends_on "ruby"
  depends_on "sops"

  resource "activation-script" do
    url "file://#{ACTIVATION_SCRIPT_SOURCE}"
    sha256 Digest::SHA256.file(ACTIVATION_SCRIPT_SOURCE).hexdigest
  end

  resource "secrets" do
    url "file://#{SECRETS_SOURCE}"
    sha256 Digest::SHA256.file(SECRETS_SOURCE).hexdigest
  end

  def install
    libexec.install "shottr-license.rb"
    resource("activation-script").stage do
      libexec.install "activate-shottr-license.applescript"
    end
    resource("secrets").stage do
      libexec.install "secrets.yaml"
    end
    chmod 0755, libexec/"shottr-license.rb"
    chmod 0600, libexec/"secrets.yaml"
    bin.install_symlink (libexec/"shottr-license.rb") => "shottr-license"
  end

  test do
    assert_predicate libexec/"shottr-license.rb", :executable?
    assert_predicate libexec/"activate-shottr-license.applescript", :file?
    assert_predicate libexec/"secrets.yaml", :file?
    assert_match "Usage:", shell_output("#{bin}/shottr-license --help")
  end
end
