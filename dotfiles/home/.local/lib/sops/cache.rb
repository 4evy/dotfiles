#!/usr/bin/env ruby
# frozen_string_literal: true

require "open3"
require "pathname"
require "rbconfig"
require "socket"
require "timeout"
require "tmpdir"

CACHE_TTL = 600
MAX_IDENTITY_BYTES = 16 * 1024
ITEM_REFERENCE = "op://Personal/SOPS-age-identity/password"
RUNTIME_DIR = Pathname(Dir.tmpdir)/"sops-records-key-#{Process.uid}"
SOCKET_PATH = RUNTIME_DIR/"cache.sock"
LOCK_PATH = RUNTIME_DIR/"cache.lock"

def monotonic_time
  Process.clock_gettime(Process::CLOCK_MONOTONIC)
end

def valid_identity?(identity)
  return false if identity.nil? || identity.empty?
  return false if identity.bytesize > MAX_IDENTITY_BYTES

  identity.each_line.any? { |line| line.start_with?("AGE-SECRET-KEY-") }
end

def ensure_runtime_dir
  begin
    RUNTIME_DIR.mkdir(0o700)
  rescue Errno::EEXIST
    nil
  end

  stat = RUNTIME_DIR.lstat
  return if stat.directory? && stat.uid == Process.uid && stat.mode.nobits?(0o077)

  raise "unsafe records key cache directory: #{RUNTIME_DIR}"
end

def secure_socket?
  stat = SOCKET_PATH.lstat
  unless stat.socket? && stat.uid == Process.uid && stat.mode.nobits?(0o077)
    raise "unsafe records key cache socket: #{SOCKET_PATH}"
  end

  true
rescue Errno::ENOENT
  false
end

def request_cache(request)
  return nil unless secure_socket?

  Timeout.timeout(2) do
    Socket.unix(SOCKET_PATH.to_s) do |socket|
      socket.write("#{request}\n")
      socket.read(MAX_IDENTITY_BYTES + 1)
    end
  end
rescue Errno::ECONNREFUSED, Errno::ENOENT, Timeout::Error
  nil
end

def remove_stale_socket
  stat = SOCKET_PATH.lstat
  raise "refusing to remove unsafe cache socket: #{SOCKET_PATH}" unless stat.socket? && stat.uid == Process.uid

  SOCKET_PATH.unlink
rescue Errno::ENOENT
  nil
end

def read_from_1password
  3.times do |attempt|
    identity, status = Open3.capture2("op", "read", ITEM_REFERENCE)
    return "#{identity.chomp}\n" if status.success? && valid_identity?(identity)

    sleep 2 if attempt < 2
  end

  raise "could not read the SOPS age identity from 1Password"
rescue Errno::ENOENT
  warn "sops-age-key-cache: 1Password CLI is not installed"
  exit 127
end

def remove_server_socket(inode)
  stat = SOCKET_PATH.lstat
  SOCKET_PATH.unlink if stat.socket? && stat.ino == inode
rescue Errno::ENOENT
  nil
end

def serve_client(client, identity, deadline)
  return false unless client.wait_readable(1)

  case client.gets&.chomp
  when "read"
    client.write(identity)
    false
  when "status"
    client.write("#{[deadline - monotonic_time, 0].max.ceil}\n")
    false
  when "clear"
    client.write("cleared\n")
    true
  else
    false
  end
ensure
  client.close
end

def run_server
  begin
    Process.setsid
    Process.setrlimit(Process::RLIMIT_CORE, 0, 0)
  rescue Errno::EPERM, NotImplementedError
    nil
  end

  identity = $stdin.read(MAX_IDENTITY_BYTES + 1)
  $stdin.close
  exit 1 unless valid_identity?(identity)

  socket_inode = nil
  begin
    ensure_runtime_dir
    UNIXServer.open(SOCKET_PATH.to_s) do |server|
      SOCKET_PATH.chmod(0o600)
      socket_inode = SOCKET_PATH.lstat.ino
      deadline = monotonic_time + CACHE_TTL

      Signal.trap("HUP") { exit }
      Signal.trap("INT") { exit }
      Signal.trap("TERM") { exit }

      loop do
        remaining = deadline - monotonic_time
        break if remaining <= 0
        break unless server.wait_readable(remaining)

        break if serve_client(server.accept, identity, deadline)
      end
    end
  ensure
    remove_server_socket(socket_inode) if socket_inode
    identity.replace("\0" * identity.bytesize)
  end
end

def start_server(identity)
  pid = IO.pipe do |reader, writer|
    child = Process.spawn(
      RbConfig.ruby,
      __FILE__,
      "--serve",
      in:           reader,
      out:          File::NULL,
      err:          File::NULL,
      close_others: true,
    )
    writer.write(identity)
    child
  end
  Process.detach(pid)

  deadline = monotonic_time + 3
  while monotonic_time < deadline
    return if request_cache("status")&.match?(/\A\d+\n\z/)

    sleep 0.05
  end

  raise "records key cache failed to start"
end

def cached_identity
  ensure_runtime_dir
  identity = request_cache("read")
  return identity if valid_identity?(identity)

  LOCK_PATH.open(File::RDWR | File::CREAT, 0o600) do |lock|
    LOCK_PATH.chmod(0o600)
    lock.flock(File::LOCK_EX)

    identity = request_cache("read")
    return identity if valid_identity?(identity)

    remove_stale_socket
    identity = read_from_1password
    start_server(identity)
    identity
  end
end

if ARGV == ["--serve"]
  run_server
  exit
end

case ARGV
when []
  $stdout.write(cached_identity)
when ["--status"]
  status = request_cache("status")
  if status&.match?(/\A\d+\n\z/)
    puts "records key cache expires in #{status.to_i} seconds"
  else
    puts "records key cache is inactive"
  end
when ["--clear"]
  request_cache("clear")
  puts "records key cache cleared"
else
  warn "usage: sops-age-key-1password [--status|--clear]"
  exit 64
end
