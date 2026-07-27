#!/usr/bin/env ruby
# frozen_string_literal: true

require "open3"
require "pathname"

# Installs and inspects the local Shottr activation state.
module ShottrLicense
  class Error < StandardError; end

  DOMAIN = ENV.fetch("SHOTTR_DEFAULTS_DOMAIN", "cc.ffitch.shottr").freeze
  DEFAULTS = ENV.fetch("SHOTTR_DEFAULTS", "/usr/bin/defaults").freeze
  OSASCRIPT = ENV.fetch("SHOTTR_OSASCRIPT", "/usr/bin/osascript").freeze
  SOPS = ENV.fetch("SHOTTR_SOPS", "sops").freeze
  LICENSE_PATTERN = /\A[A-Z0-9]{6}(?:-[A-Z0-9]{6}){4}\z/
  ACTIVATION_SCRIPT = Pathname(
    ENV.fetch(
      "SHOTTR_ACTIVATION_SCRIPT",
      Pathname(__FILE__).realpath.dirname/"activate-shottr-license.applescript",
    ),
  ).freeze

  module_function

  def execute(*command, allow_failure: false)
    stdout, stderr, status = Open3.capture3(*command)
    unless status.success? || allow_failure
      details = stderr.strip
      details = stdout.strip if details.empty?
      message = "command failed (#{status.exitstatus}): #{command.first}"
      message = "#{message}\n#{details}" unless details.empty?
      raise Error, message
    end
    [stdout, stderr, status.success?]
  rescue Errno::ENOENT => error
    raise Error, "command not found: #{command.first} (#{error.message})"
  end

  def secrets_file
    configured = ENV["SHOTTR_SECRETS_FILE"]
    return Pathname(configured).expand_path if configured && !configured.empty?

    bundled = Pathname(__FILE__).realpath.dirname/"secrets.yaml"
    return bundled if bundled.file?

    Pathname.pwd.ascend do |directory|
      candidate = directory/"secrets/secrets.yaml"
      return candidate if candidate.file?
    end
    raise Error, "could not find secrets/secrets.yaml from #{Pathname.pwd}"
  end

  def license_key
    stdout, = execute(
      SOPS,
      "--decrypt",
      "--extract",
      '["shottr-license-key"]',
      secrets_file.to_s,
    )
    key = stdout.strip
    unless LICENSE_PATTERN.match?(key)
      raise Error, "Shottr license key in SOPS has an unexpected format"
    end
    key
  end

  def activated?
    %w[kc-license kc-vault].all? do |key|
      stdout, _, succeeded = execute(
        DEFAULTS,
        "read",
        DOMAIN,
        key,
        allow_failure: true,
      )
      succeeded && !stdout.strip.empty?
    end
  end

  def activate(key)
    raise Error, "Shottr activation script not found: #{ACTIVATION_SCRIPT}" unless ACTIVATION_SCRIPT.file?

    stdout, stderr, succeeded = execute(
      OSASCRIPT,
      ACTIVATION_SCRIPT.to_s,
      key,
      allow_failure: true,
    )
    return if succeeded

    details = stderr.strip
    details = stdout.strip if details.empty?
    message = "Shottr activation UI automation failed"
    if details.include?("not allowed assistive access") || details.include?("-25211")
      message = [
        message,
        "macOS denied Accessibility access to osascript.",
        "Grant Accessibility to the terminal running provisioning in",
        "System Settings > Privacy & Security > Accessibility, then rerun",
        "`shottr-license install --force`.",
      ].join(" ")
    end
    message = "#{message}\n#{details}" unless details.empty?
    raise Error, message
  end

  def install(force: false)
    if activated? && !force
      warn "shottr-license: Shottr already has activation state; leaving it in place"
      return
    end
    activate(license_key)
    warn "shottr-license: submitted license key through Shottr activation UI"
  end

  def status
    state = activated? ? "installed" : "not installed"
    puts "shottr-license: #{state}"
  end

  def usage
    <<~TEXT
      Usage: shottr-license <command> [options]

      Commands:
        install [--force]  Activate Shottr with the SOPS-managed license key
        status             Show the installed Shottr activation state

      Environment:
        SHOTTR_SECRETS_FILE       Override the path to secrets/secrets.yaml
        SHOTTR_ACTIVATION_SCRIPT  Override the activation AppleScript path
    TEXT
  end

  def main(arguments)
    command = arguments.shift
    case command
    when "install"
      force = arguments.delete("--force")
      raise Error, "unexpected arguments: #{arguments.join(" ")}" unless arguments.empty?

      install(force: !force.nil?)
    when "status"
      raise Error, "unexpected arguments: #{arguments.join(" ")}" unless arguments.empty?

      status
    when "--help", "-h", "help", nil
      raise Error, "unexpected arguments: #{arguments.join(" ")}" unless arguments.empty?

      puts usage
    else
      raise Error, "unknown command: #{command}"
    end
    0
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    exit ShottrLicense.main(ARGV)
  rescue ShottrLicense::Error => error
    warn "shottr-license: error: #{error.message}"
    exit 1
  end
end
