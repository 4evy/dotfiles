#!/usr/bin/env ruby
# frozen_string_literal: true

exit unless RUBY_PLATFORM.include?("darwin")

require "pathname"

home = Pathname(Dir.home)
source = Pathname("/Applications/Nix Apps/Raycast.app")
manager = Pathname("/run/current-system/sw/bin/raycast-manager")
target = Pathname("/Applications/Raycast.app")
config = home/".config/raycast/config.json"
brew = Pathname("/opt/homebrew/bin/brew")

abort "raycast: missing Nix app #{source}, run just darwin" unless source.directory?
abort "raycast: missing Nix manager #{manager}, run just darwin" unless manager.executable?
abort "raycast: missing configuration #{config}" unless config.file?

if target.symlink?
  abort "raycast: #{target} points elsewhere" unless target.readlink == source
elsif target.exist?
  unless brew.executable? && system(brew.to_s, "list", "--cask", "raycast", out: File::NULL, err: File::NULL)
    abort "raycast: #{target} is not the Homebrew installation"
  end

  system brew.to_s, "uninstall", "--cask", "raycast", exception: true
  abort "raycast: Homebrew left #{target} in place" if target.exist? || target.symlink?
  File.symlink(source, target)
else
  File.symlink(source, target)
end

system manager.to_s, "configure", config.to_s, exception: true
