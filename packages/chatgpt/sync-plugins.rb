# frozen_string_literal: true

require "fileutils"
require "json"
require "pathname"
require "tempfile"

# Synchronizes optional plugins from ChatGPT's bundled Codex marketplace into
# the compatibility marketplace used by standalone Codex sessions
module CodexPlugins
  MARKETPLACE = ARGV.fetch(1).freeze
  SOURCE = Pathname(ARGV.fetch(0)).freeze
  CODEX_HOME = Pathname(ENV.fetch("CODEX_HOME")).freeze
  MATERIALIZED = (CODEX_HOME/".tmp/bundled-marketplaces/openai-bundled").freeze
  DESTINATION = (CODEX_HOME/".tmp/compatibility-marketplaces"/MARKETPLACE).freeze
  PLUGINS = ARGV.drop(2).freeze

  module_function

  def sync
    unless SOURCE.directory?
      warn "codex-bundled-plugins: ChatGPT is absent; skipping Codex plugins"
      return false
    end
    source_manifest = load_manifest(SOURCE)
    materialized_manifest = MATERIALIZED.directory? ? load_manifest(MATERIALIZED) : { "plugins" => [] }
    source_entries = source_manifest.fetch("plugins").to_h do |entry|
      [entry.fetch("name"), entry]
    end
    materialized_entries = materialized_manifest.fetch("plugins").to_h do |entry|
      [entry.fetch("name"), entry]
    end
    entries = source_entries.merge(materialized_entries)

    destination_entries = PLUGINS.filter_map do |name|
      entry = entries[name]
      next unless entry

      materialized = MATERIALIZED/"plugins"/name
      source = materialized.directory? ? materialized : SOURCE/"plugins"/name
      next unless source.directory?

      destination = DESTINATION/"plugins"/name
      unless destination.symlink? && destination.readlink == source
        FileUtils.rm_rf(destination)
        destination.dirname.mkpath
        FileUtils.ln_s(source, destination)
      end
      entry
    end

    destination_manifest = source_manifest.merge(
      "name"    => MARKETPLACE,
      "plugins" => destination_entries,
    )
    (DESTINATION/".agents/plugins").mkpath
    write_manifest(DESTINATION, destination_manifest)
    codex = codex_cli

    destination_entries.each do |entry|
      system(
        codex.to_s,
        "plugin",
        "add",
        "#{entry.fetch('name')}@#{MARKETPLACE}",
        exception: true,
      )
    end
    warn "codex-bundled-plugins: bundled Codex plugins are current"
    true
  end

  def codex_cli
    Pathname(ENV.fetch("CODEX_CLI_PATH"))
  end

  def load_manifest(root)
    path = root/".agents/plugins/marketplace.json"
    data = JSON.load_file(path)
    unless data.is_a?(Hash) &&
           data["plugins"].is_a?(Array) &&
           data["plugins"].all? do |entry|
             entry.is_a?(Hash) && entry["name"].is_a?(String)
           end
      raise "invalid ChatGPT marketplace manifest: #{path}"
    end

    data
  end

  def write_manifest(root, manifest)
    path = root/".agents/plugins/marketplace.json"
    Tempfile.create([".marketplace.", ".json"], path.dirname.to_s) do |file|
      file.write(JSON.pretty_generate(manifest))
      file.write("\n")
      file.flush
      file.fsync
      file.close
      File.rename(file.path, path)
    end
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    CodexPlugins.sync
  rescue StandardError => e
    warn "codex-bundled-plugins: error: #{e.message}"
    exit 1
  end
end
