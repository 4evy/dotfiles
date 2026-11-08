#!/usr/bin/env nix
#! nix shell nixpkgs#python315 --command python3.15

import contextlib
import fcntl
import math
import os
import resource
import select
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CACHE_TTL = 600
MAX_IDENTITY_BYTES = 16 * 1024
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
GROUP_OTHER_PERMISSION_MASK = 0o077
CLIENT_TIMEOUT_SECONDS = 2
SERVER_CLIENT_TIMEOUT_SECONDS = 1
PASSWORD_READ_ATTEMPTS = 3
PASSWORD_RETRY_DELAY_SECONDS = 2
MAX_REQUEST_BYTES = 32
START_TIMEOUT_SECONDS = 3
START_POLL_INTERVAL_SECONDS = 0.05
COMMAND_NOT_FOUND_EXIT = 127
USAGE_ERROR_EXIT = 64
AGE_IDENTITY_PREFIX = b"AGE-SECRET-KEY-"
ITEM_REFERENCE = "op://Personal/SOPS-age-identity/password"
RUNTIME_DIR = Path(tempfile.gettempdir()) / f"sops-records-key-{os.getuid()}"
SOCKET_PATH = RUNTIME_DIR / "cache.sock"
LOCK_PATH = RUNTIME_DIR / "cache.lock"


def valid_identity(identity: bytes | bytearray) -> bool:
    return 0 < len(identity) <= MAX_IDENTITY_BYTES and any(
        line.startswith(AGE_IDENTITY_PREFIX) for line in identity.splitlines()
    )


def ensure_runtime_dir() -> None:
    RUNTIME_DIR.mkdir(mode=PRIVATE_DIRECTORY_MODE, exist_ok=True)
    info = RUNTIME_DIR.lstat()
    if not (
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == os.getuid()
        and info.st_mode & GROUP_OTHER_PERMISSION_MASK == 0
    ):
        raise RuntimeError(f"unsafe records key cache directory: {RUNTIME_DIR}")


def secure_socket() -> bool:
    try:
        info = SOCKET_PATH.lstat()
    except FileNotFoundError:
        return False
    if not (
        stat.S_ISSOCK(info.st_mode)
        and info.st_uid == os.getuid()
        and info.st_mode & GROUP_OTHER_PERMISSION_MASK == 0
    ):
        raise RuntimeError(f"unsafe records key cache socket: {SOCKET_PATH}")
    return True


def request_cache(request: str) -> bytes:
    if not secure_socket():
        return b""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(CLIENT_TIMEOUT_SECONDS)
            client.connect(str(SOCKET_PATH))
            client.sendall(f"{request}\n".encode())
            response = bytearray()
            while len(response) <= MAX_IDENTITY_BYTES:
                chunk = client.recv(MAX_IDENTITY_BYTES + 1 - len(response))
                if not chunk:
                    break
                response.extend(chunk)
            return bytes(response)
    except ConnectionRefusedError, FileNotFoundError, TimeoutError:
        return b""


def remove_stale_socket() -> None:
    try:
        info = SOCKET_PATH.lstat()
    except FileNotFoundError:
        return
    if not (stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid()):
        raise RuntimeError(f"refusing to remove unsafe cache socket: {SOCKET_PATH}")
    SOCKET_PATH.unlink()


def read_from_1password() -> bytes:
    for attempt in range(PASSWORD_READ_ATTEMPTS):
        try:
            result = subprocess.run(
                ["op", "read", ITEM_REFERENCE], stdout=subprocess.PIPE, check=False
            )
        except FileNotFoundError:
            print("sops-age-key-cache: 1Password CLI is not installed", file=sys.stderr)
            raise SystemExit(COMMAND_NOT_FOUND_EXIT) from None
        if result.returncode == 0 and valid_identity(result.stdout):
            return result.stdout.rstrip(b"\n") + b"\n"
        if attempt < PASSWORD_READ_ATTEMPTS - 1:
            time.sleep(PASSWORD_RETRY_DELAY_SECONDS)
    raise RuntimeError("could not read the SOPS age identity from 1Password")


def respond(client: socket.socket, identity: bytearray, deadline: float) -> bool:
    request = bytearray()
    while b"\n" not in request and len(request) < MAX_REQUEST_BYTES:
        chunk = client.recv(MAX_REQUEST_BYTES - len(request))
        if not chunk:
            return False
        request.extend(chunk)
    match request:
        case b"read\n":
            client.sendall(identity)
        case b"status\n":
            remaining = math.ceil(max(deadline - time.monotonic(), 0))
            client.sendall(f"{remaining}\n".encode())
        case b"clear\n":
            client.sendall(b"cleared\n")
            return True
    return False


def serve_client(client: socket.socket, identity: bytearray, deadline: float) -> bool:
    with client:
        client.settimeout(SERVER_CLIENT_TIMEOUT_SECONDS)
        try:
            return respond(client, identity, deadline)
        except TimeoutError, ConnectionError:
            return False


def stop_server(_signum: int, _frame: object) -> None:
    raise SystemExit


def remove_server_socket(inode: int | None) -> None:
    if inode is not None:
        with contextlib.suppress(FileNotFoundError):
            info = SOCKET_PATH.lstat()
            if stat.S_ISSOCK(info.st_mode) and info.st_ino == inode:
                SOCKET_PATH.unlink()


def run_server() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    identity = bytearray(sys.stdin.buffer.read(MAX_IDENTITY_BYTES + 1))
    sys.stdin.close()
    if not valid_identity(identity):
        raise SystemExit(1)

    socket_inode = None
    try:
        ensure_runtime_dir()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(SOCKET_PATH))
            SOCKET_PATH.chmod(PRIVATE_FILE_MODE)
            socket_inode = SOCKET_PATH.lstat().st_ino
            server.listen()
            deadline = time.monotonic() + CACHE_TTL
            for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
                signal.signal(signum, stop_server)
            while (remaining := deadline - time.monotonic()) > 0:
                if not select.select([server], [], [], remaining)[0]:
                    break
                client, _ = server.accept()
                if serve_client(client, identity, deadline):
                    break
    finally:
        remove_server_socket(socket_inode)
        identity[:] = b"\0" * len(identity)


def start_server(identity: bytes) -> None:
    child = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,
    )
    if child.stdin is None:
        raise RuntimeError("records key cache input pipe is unavailable")
    child.stdin.write(identity)
    child.stdin.close()
    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if request_cache("status").strip().isdigit():
            return
        if child.poll() is not None:
            break
        time.sleep(START_POLL_INTERVAL_SECONDS)
    raise RuntimeError("records key cache failed to start")


def cached_identity() -> bytes:
    ensure_runtime_dir()
    identity = request_cache("read")
    if valid_identity(identity):
        return identity

    descriptor = os.open(
        LOCK_PATH, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, PRIVATE_FILE_MODE
    )
    with os.fdopen(descriptor, "rb+") as lock:
        info = os.fstat(lock.fileno())
        if not (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()):
            raise RuntimeError(f"unsafe records key cache lock: {LOCK_PATH}")
        os.fchmod(lock.fileno(), PRIVATE_FILE_MODE)
        fcntl.flock(lock, fcntl.LOCK_EX)
        identity = request_cache("read")
        if valid_identity(identity):
            return identity
        remove_stale_socket()
        identity = read_from_1password()
        start_server(identity)
        return identity


def main() -> None:
    match sys.argv[1:]:
        case ["--serve"]:
            run_server()
        case []:
            sys.stdout.buffer.write(cached_identity())
        case ["--status"]:
            status = request_cache("status").strip()
            if status.isdigit():
                print(f"records key cache expires in {int(status)} seconds")
            else:
                print("records key cache is inactive")
        case ["--clear"]:
            request_cache("clear")
            print("records key cache cleared")
        case _:
            print("usage: sops-age-key-1password [--status|--clear]", file=sys.stderr)
            raise SystemExit(USAGE_ERROR_EXIT)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        print(f"sops-age-key-cache: {error}", file=sys.stderr)
        raise SystemExit(1) from None
