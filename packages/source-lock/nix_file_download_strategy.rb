# frozen_string_literal: true

require "download_strategy"
require "tempfile"

# Flake file inputs hash a NAR containing the file, not the bare download.
# Cache that NAR so Homebrew's normal SHA-256 verification uses flake.lock.
class NixFileDownloadStrategy < AbstractDownloadStrategy
  def self.token(value)
    [value.bytesize].pack("Q<") + value + ("\0" * ((-value.bytesize) % 8))
  end

  HEADER = %w[nix-archive-1 ( type regular contents].map { |word| token(word) }.join.freeze
  FOOTER = token(")").freeze

  def cached_location
    @cached_location ||= cache/"downloads/#{Digest::SHA256.hexdigest(url)}--#{name}.nar"
  end

  def fetch(timeout: nil)
    return if cached_location.file?

    download = CurlDownloadStrategy.new(url, name, version, **meta)
    download.fetch(timeout:)
    source = download.cached_location
    cached_location.dirname.mkpath
    Tempfile.create([name, ".nar"], cached_location.dirname) do |temporary|
      temporary.binmode
      temporary.write(HEADER)
      temporary.write([source.size].pack("Q<"))
      source.open("rb") { |input| IO.copy_stream(input, temporary) }
      temporary.write("\0" * ((-source.size) % 8))
      temporary.write(FOOTER)
      temporary.close
      File.rename(temporary.path, cached_location)
    end
  end

  def clear_cache
    super
    CurlDownloadStrategy.new(url, name, version, **meta).clear_cache
  end

  def stage(&block)
    Dir.mktmpdir("nix-file") do |directory|
      archive = Pathname(directory)/File.basename(URI(url).path)
      cached_location.open("rb") do |nar|
        raise "Invalid file NAR: #{cached_location}" if nar.read(HEADER.bytesize) != HEADER

        size = nar.read(8).unpack1("Q<")
        archive.open("wb") { |output| IO.copy_stream(nar, output, size) }
        suffix = ("\0" * ((-size) % 8)) + FOOTER
        raise "Invalid file NAR trailer" if nar.read != suffix
      end
      UnpackStrategy.detect(archive, prioritize_extension: true)
                    .extract_nestedly(basename: archive.basename, prioritize_extension: true)
    end
    chdir(&block) if block
  end
end
