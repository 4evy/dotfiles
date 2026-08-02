#!/usr/bin/env ruby
# frozen_string_literal: true

require "open3"

# Installs and inspects the local AltTab license state.
module AltTabLicense
  class Error < StandardError; end

  SECURITY = ENV.fetch("ALT_TAB_SECURITY", "/usr/bin/security").freeze
  DEFAULTS = ENV.fetch("ALT_TAB_DEFAULTS", "/usr/bin/defaults").freeze
  SERVICE = ENV.fetch(
    "ALT_TAB_LICENSE_SERVICE",
    "com.lwouis.alt-tab-macos.license",
  ).freeze
  KEYCHAIN_VALUES = {
    "licenseKey" => "0000-0000-0000-0000-0000-0000",
    "instanceId" => "evy-instance-0",
    "variantId" => "pro_lifetime",
  }.freeze
  DEFAULT_VALUES = {
    "lastValidation" => ["float", -> { Time.now.to_i.to_s }],
    "lastValidationResult" => ["bool", -> { "true" }],
    "customerEmail" => ["string", -> { "alt@evy.pink" }],
  }.freeze

  module_function

  def execute(*command, allow_failure: false)
    stdout, stderr, status = Open3.capture3(*command)
    unless status.success? || allow_failure
      details = stderr.strip
      details = stdout.strip if details.empty?
      message = "command failed (#{status.exitstatus}): #{command.join(" ")}"
      message = "#{message}\n#{details}" unless details.empty?
      raise Error, message
    end
    [stdout, status.success?]
  rescue Errno::ENOENT => error
    raise Error, "command not found: #{command.first} (#{error.message})"
  end

  def remove_keychain_items
    KEYCHAIN_VALUES.each_key do |account|
      execute(
        SECURITY,
        "delete-generic-password",
        "-s",
        SERVICE,
        "-a",
        account,
        allow_failure: true,
      )
    end
  end

  def installed?
    keychain_items_present = KEYCHAIN_VALUES.each_key.all? do |account|
      _, succeeded = execute(
        SECURITY,
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        account,
        allow_failure: true,
      )
      succeeded
    end
    defaults_present = DEFAULT_VALUES.each_key.all? do |key|
      _, succeeded = execute(DEFAULTS, "read", SERVICE, key, allow_failure: true)
      succeeded
    end
    keychain_items_present && defaults_present
  end

  def install(force: false)
    if installed? && !force
      warn "alt-tab-license: AltTab already has license state; leaving it in place"
      return
    end
    remove_keychain_items
    KEYCHAIN_VALUES.each do |account, value|
      execute(
        SECURITY,
        "add-generic-password",
        "-A",
        "-U",
        "-s",
        SERVICE,
        "-a",
        account,
        "-w",
        value,
      )
    end
    DEFAULT_VALUES.each do |key, (kind, value)|
      execute(DEFAULTS, "write", SERVICE, key, "-#{kind}", value.call)
    end
    warn "alt-tab-license: license installed; restart AltTab to apply"
  end

  def remove
    remove_keychain_items
    DEFAULT_VALUES.each_key do |key|
      execute(DEFAULTS, "delete", SERVICE, key, allow_failure: true)
    end
    warn "alt-tab-license: license removed; restart AltTab to revert to trial"
  end

  def read(*command)
    stdout, succeeded = execute(*command, allow_failure: true)
    value = stdout.strip
    succeeded && !value.empty? ? value : "none"
  end

  def status
    puts "keychain items:"
    KEYCHAIN_VALUES.each_key do |account|
      value = read(
        SECURITY,
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        account,
        "-w",
      )
      puts format("  %-12s %s", "#{account}:", value)
    end
    puts "\ndefaults (#{SERVICE}):"
    DEFAULT_VALUES.each_key do |key|
      value = read(DEFAULTS, "read", SERVICE, key)
      puts format("  %-22s %s", "#{key}:", value)
    end
  end

  def usage
    <<~TEXT
      Usage: alt-tab-license <command>

      Commands:
        install [--force]  Install or refresh the local AltTab license state
        remove   Remove the local AltTab license state
        status   Show the installed AltTab license state
    TEXT
  end

  def main(arguments)
    command = arguments.shift
    raise Error, "unexpected arguments: #{arguments.join(" ")}" unless arguments.empty?

    case command
    when "install"
      force = arguments.delete("--force")
      raise Error, "unexpected arguments: #{arguments.join(" ")}" unless arguments.empty?

      install(force: !force.nil?)
    when "remove"
      remove
    when "status"
      status
    when "--help", "-h", "help", nil
      puts usage
    else
      raise Error, "unknown command: #{command}"
    end
    0
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    exit AltTabLicense.main(ARGV)
  rescue AltTabLicense::Error => error
    warn "alt-tab-license: error: #{error.message}"
    exit 1
  end
end
