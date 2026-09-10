# frozen_string_literal: true

require "json"

module DotfilesFlakeLock
  def self.input(root, name)
    lock = JSON.load_file(root/"flake.lock")
    nodes = lock.fetch("nodes")
    inputs = nodes.fetch(lock.fetch("root")).fetch("inputs")
    node = nodes.fetch(inputs.fetch(name))
    node.fetch("locked").merge("ref" => node.fetch("original")["ref"])
  end

  def self.repository(pin)
    "https://github.com/#{pin.fetch('owner')}/#{pin.fetch('repo')}.git"
  end
end
