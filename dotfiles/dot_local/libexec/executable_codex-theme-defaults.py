#!/usr/bin/env python3.14
"""Match the Codex syntax theme to the terminal appearance."""

import argparse
import asyncio
import os
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import TypedDict, cast

sys.path.insert(0, str(Path.home() / ".local/lib/python"))
from codex_app_server import app_server


class ConfigLayer(TypedDict):
    name: dict[str, str]
    config: dict[str, dict[str, str]]
    version: str


async def select_theme(binary: str) -> None:
    """Match our custom syntax palette to the terminal without CLI overrides."""
    detector = shutil.which("theme-run")
    if detector is None:
        return
    result = await asyncio.to_thread(
        subprocess.run,
        [detector, "--print-theme"],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    mode = result.stdout.strip()
    if mode not in {"light", "dark"}:
        raise ValueError("unknown terminal appearance")
    desired = f"catppuccin-custom-{mode}"
    config_path = (
        Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "config.toml"
    )
    current = tomllib.loads(config_path.read_text()).get("tui", {}).get("theme")
    if current == desired or current not in {
        "catppuccin-custom-light",
        "catppuccin-custom-dark",
    }:
        return
    async with (
        asyncio.timeout(10),
        app_server(binary, client_name="dotfiles_theme") as server,
    ):
        result = cast(
            "dict[str, object]",
            await server.request("config/read", {"includeLayers": True}),
        )
        layer = next(
            entry
            for entry in cast("list[ConfigLayer]", result["layers"])
            if entry["name"]["type"] == "user" and not entry["name"].get("profile")
        )
        if layer["config"].get("tui", {}).get("theme") != current:
            return
        await server.request(
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", help="Real Codex binary (not the wrapper)")
    args = parser.parse_args()
    try:
        asyncio.run(select_theme(args.binary))
    except (
        OSError,
        ValueError,
        RuntimeError,
        TimeoutError,
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
