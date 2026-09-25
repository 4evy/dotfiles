#!/usr/bin/env python3.14
"""Match the Codex syntax theme to the terminal appearance."""

import argparse
import json
import os
import selectors
import shutil
import subprocess
import sys
import time
import tomllib
from pathlib import Path
from typing import TypedDict, cast


class ConfigLayer(TypedDict):
    name: dict[str, str]
    config: dict[str, dict[str, str]]
    version: str


class AppServer:
    def __init__(self, binary: str, timeout: float) -> None:
        self.deadline = time.monotonic() + timeout
        self.process = subprocess.Popen(
            [binary, "app-server", "--listen", "stdio://"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("app-server pipes are unavailable")
        self.stdin = self.process.stdin
        self.stdout = self.process.stdout
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.stdout, selectors.EVENT_READ)
        self.buffer = b""
        self.request_id = 0

    def send(self, message: dict[str, object]) -> None:
        self.stdin.write(json.dumps(message).encode() + b"\n")
        self.stdin.flush()

    def request(self, method: str, params: dict[str, object]) -> dict[str, object]:
        self.request_id += 1
        self.send({"id": self.request_id, "method": method, "params": params})
        while True:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                message = json.loads(line)
                if message.get("id") == self.request_id:
                    if "error" in message:
                        raise RuntimeError(f"{method} failed")
                    return message["result"]
            remaining = self.deadline - time.monotonic()
            if remaining <= 0 or not self.selector.select(remaining):
                raise TimeoutError("theme selection timed out")
            chunk = os.read(self.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("app-server disconnected")
            self.buffer += chunk

    def close(self) -> None:
        self.selector.close()
        self.process.terminate()
        try:
            self.process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.stdin.close()
        self.stdout.close()


def select_theme(binary: str) -> None:
    """Match our custom syntax palette to the terminal without CLI overrides."""
    detector = shutil.which("theme-run")
    if detector is None:
        return
    result = subprocess.run(
        [detector, "--print-theme"],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    mode = result.stdout.strip()
    if mode not in {"light", "dark"}:
        raise ValueError("unknown terminal appearance")
    desired = f"t3-chat-{mode}"
    config_path = (
        Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "config.toml"
    )
    current = tomllib.loads(config_path.read_text()).get("tui", {}).get("theme")
    if current == desired or current not in {"t3-chat-light", "t3-chat-dark"}:
        return
    server = AppServer(binary, 10)
    try:
        server.request(
            "initialize",
            {"clientInfo": {"name": "dotfiles_theme", "version": "1"}},
        )
        server.send({"method": "initialized"})
        result = server.request("config/read", {"includeLayers": True})
        layer = next(
            entry
            for entry in cast("list[ConfigLayer]", result["layers"])
            if entry["name"]["type"] == "user" and not entry["name"].get("profile")
        )
        if layer["config"].get("tui", {}).get("theme") != current:
            return
        server.request(
            "config/batchWrite",
            {
                "edits": [
                    {
                        "keyPath": "tui.theme",
                        "value": desired,
                        "mergeStrategy": "replace",
                    }
                ],
                "filePath": layer["name"]["file"],
                "expectedVersion": layer["version"],
            },
        )
    finally:
        server.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", help="Real Codex binary (not the wrapper)")
    args = parser.parse_args()
    try:
        select_theme(args.binary)
    except (
        OSError,
        ValueError,
        RuntimeError,
        KeyError,
        StopIteration,
        TypeError,
        subprocess.SubprocessError,
    ):
        print(
            "codex: theme selection unavailable; keeping configured theme",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
