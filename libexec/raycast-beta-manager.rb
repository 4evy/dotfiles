#!/usr/bin/env ruby
# frozen_string_literal: true

require "fileutils"
require "json"
require "net/http"
require "open3"
require "optparse"
require "pathname"
require "rubygems/version"
require "shellwords"
require "tmpdir"
require "uri"

# Installs and configures the public Raycast Beta using dotfiles-managed data.
module RaycastBeta
  PROGRAM_NAME = "raycast-beta-manager"
  EXPECTED_BUNDLE_ID = "com.raycast-x.macos"
  RELEASE_URL_PATTERN = %r{
    https://x-r2\.raycast-releases\.com/
    Raycast_Beta_(\d+(?:\.\d+)+)_[a-f0-9]+_arm64\.dmg
  }ix

  Release = Data.define(:uri, :version).freeze
  Profile = Data.define(
    :current_user,
    :oauth_token,
    :avatar_url,
    :command_aliases,
  ).freeze

  class Error < StandardError; end

  # Resolves runtime paths once and supports explicit environment overrides.
  class Configuration
    attr_reader :app,
                :app_support,
                :avatar_source,
                :data_addon,
                :database_cli,
                :keydump_hook,
                :lock_file,
                :profile_file,
                :release_page

    def initialize(environment: ENV, home: Pathname(Dir.home))
      @app = path(environment.fetch("RAYCAST_APP", "/Applications/Raycast Beta.app"))
      @app_support = path(
        environment.fetch(
          "RAYCAST_APP_SUPPORT",
          home/"Library/Application Support/com.raycast-x.macos",
        ),
      )
      profile_directory = path(
        environment.fetch("RAYCAST_PROFILE_DIR", home/".config/raycast"),
      )
      @profile_file = path(
        environment.fetch(
          "RAYCAST_PROFILE_FILE",
          profile_directory/"profile.json",
        ),
      )
      @keydump_hook = path(
        environment.fetch(
          "RAYCAST_KEYDUMP_HOOK",
          profile_directory/"keydump.cjs",
        ),
      )
      @database_cli = path(
        environment.fetch(
          "RAYCAST_DB_CLI",
          profile_directory/"raycast-db.mjs",
        ),
      )
      @data_addon = path(
        environment.fetch(
          "RAYCAST_DATA_ADDON",
          @app/"Contents/Resources/macos-app_RaycastDesktopApp.bundle/Contents/Resources/backend/data.darwin-arm64.node",
        ),
      )
      @avatar_source = optional_path(environment.fetch("RAYCAST_AVATAR_SRC", nil))
      @release_page = URI(
        environment.fetch("RAYCAST_RELEASE_PAGE", "https://www.raycast.com/new"),
      )
      @lock_file = path(
        environment.fetch(
          "RAYCAST_LOCK_FILE",
          Pathname(Dir.tmpdir)/"#{PROGRAM_NAME}-#{Process.uid}.lock",
        ),
      )
    rescue URI::InvalidURIError => error
      raise Error, "invalid Raycast release page URL: #{error.message}"
    end

    private

    def path(value)
      Pathname(value).expand_path.freeze
    end

    def optional_path(value)
      path(value) if value
    end
  end

  # Runs external macOS and Raycast commands with consistent diagnostics.
  class CommandRunner
    def run(*command, environment: {}, allow_failure: false, quiet: false)
      arguments = command.map(&:to_s)
      options = quiet ? { out: File::NULL, err: File::NULL } : {}
      success = system(environment, *arguments, **options)
      return true if success
      return false if allow_failure

      status = Process.last_status
      detail = status ? " (exit #{status.exitstatus})" : ""
      raise Error, "command failed#{detail}: #{arguments.shelljoin}"
    end

    def capture(*command)
      arguments = command.map(&:to_s)
      stdout, stderr, status = Open3.capture3(*arguments)
      return stdout if status.success?

      detail = stderr.strip
      detail = "command failed (exit #{status.exitstatus}): #{arguments.shelljoin}" if detail.empty?
      raise Error, detail
    end
  end

  # Streams HTTP(S) responses with bounded redirects and timeouts.
  class HTTPClient
    USER_AGENT = "#{PROGRAM_NAME}/3".freeze
    MAX_REDIRECTS = 5

    def initialize(open_timeout: 30, read_timeout: 300, write_timeout: 30)
      @open_timeout = open_timeout
      @read_timeout = read_timeout
      @write_timeout = write_timeout
    end

    def read(uri)
      body = +""
      request(uri) { |response| response.read_body { |chunk| body << chunk } }
      body
    end

    def download(uri, destination)
      destination = Pathname(destination)
      temporary = Pathname("#{destination}.part-#{Process.pid}")
      destination.dirname.mkpath
      temporary.open("wb", 0o600) do |file|
        request(uri) do |response|
          response.read_body { |chunk| file.write(chunk) }
        end
        file.flush
        file.fsync
      end
      File.rename(temporary, destination)
      destination
    ensure
      FileUtils.rm_f(temporary) if defined?(temporary)
    end

    private

    def request(uri, redirects_remaining: MAX_REDIRECTS, &block)
      uri = URI(uri.to_s)
      raise Error, "unsupported download URL: #{uri}" if !uri.is_a?(URI::HTTP) || !uri.host

      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.is_a?(URI::HTTPS)
      http.open_timeout = @open_timeout
      http.read_timeout = @read_timeout
      http.write_timeout = @write_timeout
      http_request = Net::HTTP::Get.new(
        uri.request_uri,
        "Accept" => "*/*",
        "User-Agent" => USER_AGENT,
      )
      http.request(http_request) do |response|
        case response
        when Net::HTTPSuccess
          block.call(response)
        when Net::HTTPRedirection
          raise Error, "too many redirects while downloading #{uri}" if redirects_remaining.zero?

          location = response["location"]
          raise Error, "redirect from #{uri} did not include a location" if location.to_s.empty?

          request(
            URI.join(uri.to_s, location),
            redirects_remaining: redirects_remaining - 1,
            &block
          )
        else
          raise Error, "download failed for #{uri}: HTTP #{response.code} #{response.message}"
        end
      end
    rescue Error
      raise
    rescue IOError,
           Net::HTTPBadResponse,
           OpenSSL::SSL::SSLError,
           SocketError,
           SystemCallError,
           Timeout::Error => error
      raise Error, "download failed for #{uri}: #{error.message}"
    end
  end

  # Owns Raycast installation, local database configuration, and lifecycle.
  class Manager
    WAIT_TIMEOUT = 30
    WAIT_INTERVAL = 1

    def initialize(
      configuration: Configuration.new,
      commands: CommandRunner.new,
      http: HTTPClient.new,
      sleeper: ->(seconds) { sleep(seconds) }
    )
      @configuration = configuration
      @commands = commands
      @http = http
      @sleeper = sleeper
    end

    def with_lock(&block)
      @configuration.lock_file.dirname.mkpath
      @configuration.lock_file.open(
        File::RDWR | File::CREAT,
        0o600,
      ) do |lock|
        lock.flock(File::LOCK_EX)
        block.call
      end
    end

    def install_latest(force: false)
      release = latest_release
      installed_version = app_version(@configuration.app)
      if !force && installed_version && installed_version >= release.version
        log "Raycast Beta #{installed_version} is current"
        return false
      end

      Dir.mktmpdir("raycast-beta-") do |directory|
        root = Pathname(directory)
        image = root/"Raycast_Beta.dmg"
        mount = root/"mount"
        mount.mkpath
        log "downloading Raycast Beta #{release.version}"
        @http.download(release.uri, image)
        @commands.run "/usr/bin/hdiutil", "verify", image, quiet: true
        attached = false
        begin
          @commands.run(
            "/usr/bin/hdiutil",
            "attach",
            image,
            "-nobrowse",
            "-readonly",
            "-mountpoint",
            mount,
            quiet: true,
          )
          attached = true
          install_app(mount/"Raycast Beta.app", force:)
        ensure
          if attached
            @commands.run(
              "/usr/bin/hdiutil",
              "detach",
              mount,
              allow_failure: true,
              quiet: true,
            )
          end
        end
      end
      true
    end

    def configure(if_present: false)
      require_directory(@configuration.app)
      require_file(@configuration.data_addon)
      profile = load_profile(if_present:)
      return false unless profile

      require_file(@configuration.keydump_hook)
      require_file(@configuration.database_cli)
      node, key_file = extract_key
      avatar = ensure_avatar(profile)
      current_user = profile.current_user.dup
      if avatar
        current_user["image"] = file_url(avatar)
        current_user["avatar"] = file_url(avatar)
      end
      environment = {
        "RAYCAST_APP_SUPPORT" => @configuration.app_support.to_s,
        "RAYCAST_DATA_ADDON" => @configuration.data_addon.to_s,
        "RAYCAST_KEY_FILE" => key_file.to_s,
      }
      @commands.run(
        node,
        @configuration.database_cli,
        "profile",
        "apply",
        JSON.generate(current_user),
        JSON.generate(profile.oauth_token),
        environment:,
      )
      unless profile.command_aliases.empty?
        @commands.run(
          node,
          @configuration.database_cli,
          "aliases",
          "apply",
          JSON.generate(profile.command_aliases),
          environment:,
        )
      end
      @commands.run "/usr/bin/open", @configuration.app
      log "Raycast Beta configured and started"
      true
    end

    def refresh(force: false)
      install_latest(force:)
      configure(if_present: true)
    end

    def installed_version
      app_version(@configuration.app)
    end

    def latest_release
      page = @http.read(@configuration.release_page)
      releases = page.to_enum(:scan, RELEASE_URL_PATTERN).map do
        match = Regexp.last_match
        Release.new(
          uri: URI(match[0]),
          version: parse_version(match[1]),
        )
      end
      release = releases.max_by(&:version)
      unless release
        raise Error, "Raycast release page did not include an Apple Silicon Beta DMG URL"
      end

      release
    rescue URI::InvalidURIError => error
      raise Error, "Raycast release page included an invalid DMG URL: #{error.message}"
    end

    def file_url(path)
      escaped = URI::DEFAULT_PARSER.escape(Pathname(path).expand_path.to_s)
      URI::File.build(path: escaped).to_s
    end

    private

    def install_app(source, force: false)
      source = Pathname(source).expand_path
      source_version = validate_app(source)
      installed_version = app_version(@configuration.app)
      if !force && installed_version && installed_version >= source_version
        log "keeping Raycast Beta #{installed_version} in #{@configuration.app}"
        return
      end

      destination = @configuration.app
      staging = destination.dirname/".#{destination.basename}.install-#{Process.pid}"
      backup = destination.dirname/".#{destination.basename}.backup-#{Process.pid}"
      remove_path(staging)
      remove_path(backup)
      @commands.run "/usr/bin/ditto", source, staging
      validate_app(staging)
      @commands.run(
        "/usr/bin/killall",
        "Raycast Beta",
        allow_failure: true,
        quiet: true,
      )

      File.rename(destination, backup) if path_exists?(destination)
      begin
        File.rename(staging, destination)
      rescue StandardError
        File.rename(backup, destination) if path_exists?(backup) && !path_exists?(destination)
        raise
      end
      remove_path(backup)
      log "installed Raycast Beta #{source_version} in #{destination}"
    ensure
      remove_path(staging) if defined?(staging)
      if defined?(backup) && path_exists?(backup) && !path_exists?(@configuration.app)
        File.rename(backup, @configuration.app)
      end
    end

    def validate_app(app)
      require_directory(app)
      plist = require_file(app/"Contents/Info.plist")
      executable = require_file(app/"Contents/MacOS/Raycast Beta")
      raise Error, "Raycast executable is not executable: #{executable}" unless executable.executable?

      bundle_id = plist_value(plist, "CFBundleIdentifier")
      unless bundle_id == EXPECTED_BUNDLE_ID
        raise Error, "unexpected Raycast bundle identifier: #{bundle_id.inspect}"
      end

      app_version(app) || raise(Error, "Raycast app is missing its version")
    end

    def app_version(app)
      plist = Pathname(app)/"Contents/Info.plist"
      return unless plist.file?

      parse_version(plist_value(plist, "CFBundleShortVersionString"))
    end

    def plist_value(plist, key)
      @commands.capture(
        "/usr/bin/plutil",
        "-extract",
        key,
        "raw",
        "-o",
        "-",
        plist,
      ).strip
    end

    def parse_version(value)
      Gem::Version.new(value.to_s)
    rescue ArgumentError => error
      raise Error, "invalid Raycast version #{value.inspect}: #{error.message}"
    end

    def node_directory
      runtime = @configuration.app_support/"node/runtime"
      unless runtime.directory?
        log "starting Raycast Beta once to initialize its Node runtime"
        @commands.run "/usr/bin/open", @configuration.app
        wait_until("Raycast Node runtime", timeout: WAIT_TIMEOUT) { runtime.directory? }
      end

      candidates = runtime.glob("node-v*/bin").select do |directory|
        (directory/"node").file? || (directory/"node.real").file?
      end
      raise Error, "Raycast Node runtime not found under #{runtime}" if candidates.empty?

      candidates.max_by do |directory|
        parse_version(directory.parent.basename.to_s.delete_prefix("node-v"))
      end
    end

    def extract_key
      directory = node_directory
      hook = directory/".keydump.cjs"
      key_file = directory/".raycast-key-cache"
      node = directory/"node"
      real = directory/"node.real"
      restore_node(node, real, hook) if real.file?

      if read_key(key_file)
        log "using cached Raycast DB key: #{key_file}"
        return [node, key_file]
      end

      require_file(@configuration.keydump_hook)
      hook.write("require(#{@configuration.keydump_hook.to_s.to_json});\n")
      @commands.run(
        "/usr/bin/killall",
        "Raycast Beta",
        allow_failure: true,
        quiet: true,
      )
      File.rename(node, real)
      begin
        write_node_wrapper(node, real, hook, key_file)
        log "extracting Raycast DB key"
        @commands.run "/usr/bin/open", @configuration.app
        wait_until("Raycast DB key", timeout: WAIT_TIMEOUT) { key_file.file? }
        @commands.run(
          "/usr/bin/killall",
          "Raycast Beta",
          allow_failure: true,
          quiet: true,
        )
        @sleeper.call(2)
        key = read_key(key_file)
        raise Error, "failed to read captured Raycast DB key" unless key

        log "Raycast DB key extracted (#{key.bytesize} bytes)"
      ensure
        restore_node(node, real, hook)
      end
      [node, key_file]
    end

    def read_key(path)
      return unless path.file?

      path.chmod(0o600)
      value = path.read.strip
      if value.empty?
        FileUtils.rm_f(path)
        return
      end

      value
    end

    def restore_node(node, real, hook)
      return unless real.file?

      FileUtils.rm_f(node)
      File.rename(real, node)
      FileUtils.rm_f(hook)
    end

    def write_node_wrapper(node, real, hook, key_file)
      node.write <<~SH
        #!/bin/sh
        export RAYCAST_KEYDUMP_FILE=#{key_file.to_s.shellescape}
        exec #{real.to_s.shellescape} --require #{hook.to_s.shellescape} "$@"
      SH
      node.chmod(0o755)
    end

    def load_profile(if_present: false)
      path = @configuration.profile_file
      unless path.file?
        if if_present
          warning "profile not found; skipping configuration: #{path}"
          return
        end
        raise Error, "required file not found: #{path}"
      end

      data = JSON.parse(path.read)
      current_user = require_object(data, "current_user")
      oauth_token = require_object(data, "oauth_token")
      require_nonempty_string(current_user, "id", "current_user")
      require_nonempty_string(current_user, "name", "current_user")
      require_nonempty_string(oauth_token, "access_token", "oauth_token")
      aliases = data.fetch("command_aliases", [])
      unless aliases.is_a?(Array) && aliases.all?(Hash)
        raise Error, "command_aliases must be an array of objects"
      end

      Profile.new(
        current_user:,
        oauth_token:,
        avatar_url: data.fetch("avatar_url", ""),
        command_aliases: aliases,
      )
    rescue JSON::ParserError, KeyError => error
      raise Error, "invalid Raycast profile: #{error.message}"
    end

    def require_object(object, key)
      value = object.fetch(key)
      raise Error, "#{key} must be an object" unless value.is_a?(Hash)

      value
    end

    def require_nonempty_string(object, key, context)
      value = object.fetch(key)
      return value if value.is_a?(String) && !value.empty?

      raise Error, "#{context}.#{key} must be a non-empty string"
    end

    def ensure_avatar(profile)
      @configuration.app_support.mkpath
      destination = @configuration.app_support/"avatar.png"
      source_path = @configuration.avatar_source
      if source_path&.file?
        render_avatar(source_path, destination)
        log "avatar resized from #{source_path}"
        return destination
      end

      if profile.avatar_url.to_s.empty?
        warning "profile is missing avatar_url; continuing without an avatar"
        return destination if destination.file?

        return
      end

      Dir.mktmpdir("raycast-avatar-") do |directory|
        source = Pathname(directory)/"avatar"
        @http.download(URI(profile.avatar_url), source)
        render_avatar(source, destination)
      end
      log "avatar downloaded and resized from #{profile.avatar_url}"
      destination
    rescue Error, URI::InvalidURIError => error
      warning "failed to prepare Raycast avatar: #{error.message}"
      destination if destination&.file?
    end

    def render_avatar(source, destination)
      temporary = Pathname("#{destination}.part-#{Process.pid}")
      @commands.run(
        "/usr/bin/sips",
        "--resampleHeightWidthMax",
        "256",
        "--setProperty",
        "format",
        "png",
        source,
        "--out",
        temporary,
        quiet: true,
      )
      File.rename(temporary, destination)
    ensure
      FileUtils.rm_f(temporary) if defined?(temporary)
    end

    def wait_until(description, timeout:)
      attempts = (timeout.to_f/WAIT_INTERVAL).ceil
      attempts.times do
        return true if yield

        @sleeper.call(WAIT_INTERVAL)
      end
      raise Error, "timed out waiting for #{description}"
    end

    def require_file(path)
      raise Error, "required file not found: #{path}" unless path.file?

      path
    end

    def require_directory(path)
      raise Error, "required directory not found: #{path}" unless path.directory?

      path
    end

    def path_exists?(path)
      path.exist? || path.symlink?
    end

    def remove_path(path)
      return unless path && path_exists?(path)

      FileUtils.rm_rf(path)
    end

    def log(message)
      warn "#{PROGRAM_NAME}: #{message}"
    end

    def warning(message)
      warn "#{PROGRAM_NAME}: warning: #{message}"
    end
  end

  # Parses the small subcommand interface with Ruby's standard OptionParser.
  class CLI
    def initialize(manager: Manager.new, output: $stdout)
      @manager = manager
      @output = output
    end

    def run(arguments)
      command = arguments.shift
      case command
      when "install"
        options = parse_options(
          arguments,
          "Usage: #{PROGRAM_NAME} install [--force]",
          force: "Replace the installed app even when it is current",
        )
        return 0 unless options

        @manager.with_lock { @manager.install_latest(force: options.fetch(:force, false)) }
      when "configure"
        options = parse_options(
          arguments,
          "Usage: #{PROGRAM_NAME} configure [--if-present]",
          if_present: "Skip configuration when the profile is absent",
        )
        return 0 unless options

        @manager.with_lock do
          @manager.configure(if_present: options.fetch(:if_present, false))
        end
      when "refresh"
        options = parse_options(
          arguments,
          "Usage: #{PROGRAM_NAME} refresh [--force]",
          force: "Replace the installed app even when it is current",
        )
        return 0 unless options

        @manager.with_lock { @manager.refresh(force: options.fetch(:force, false)) }
      when "version"
        reject_arguments(arguments)
        @output.puts(@manager.installed_version || "not installed")
      when "help", "--help", "-h", nil
        @output.puts help
      else
        raise Error, "unknown command: #{command}"
      end
      0
    rescue OptionParser::ParseError => error
      raise Error, error.message
    end

    def help
      <<~TEXT
        Usage: #{PROGRAM_NAME} <command> [options]

        Commands:
          install [--force]      Download and install the latest Beta
          configure             Apply the local profile and command aliases
          refresh [--force]      Install latest, then apply local configuration
          version               Print the installed Raycast Beta version
      TEXT
    end

    private

    def parse_options(arguments, banner, definitions)
      options = {}
      help_requested = false
      parser = OptionParser.new do |option_parser|
        option_parser.banner = banner
        definitions.each do |name, description|
          switch = "--#{name.to_s.tr("_", "-")}"
          option_parser.on(switch, description) { options[name] = true }
        end
        option_parser.on("-h", "--help", "Show this help") { help_requested = true }
      end
      parser.parse!(arguments)
      reject_arguments(arguments)
      if help_requested
        @output.puts parser
        return
      end

      options
    end

    def reject_arguments(arguments)
      return if arguments.empty?

      raise OptionParser::InvalidArgument, arguments.join(" ")
    end
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    exit RaycastBeta::CLI.new.run(ARGV)
  rescue RaycastBeta::Error => error
    warn "#{RaycastBeta::PROGRAM_NAME}: error: #{error.message}"
    exit 1
  end
end
