#!/usr/bin/env python3.14
"""Find and load macOS shared-cache images into the local Ghidra MCP server."""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from enum import IntEnum, StrEnum
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from platformdirs.unix import Unix

CACHE_DIRS = (
    Path("/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld"),
    Path("/System/Library/dyld"),
    Path("/private/var/db/dyld"),
)


@dataclass(frozen=True, slots=True)
class CacheImage:
    cache: Path
    path: Path


class Action(StrEnum):
    FIND = "find"
    EXTRACT = "extract"
    LOAD = "load"


class MatchRank(IntEnum):
    EXACT_PATH = 0
    EXACT_NAME = 1
    SUBSTRING = 2


def caches() -> Iterator[Path]:
    for directory in CACHE_DIRS:
        for cache in sorted(directory.glob("dyld_shared_cache_*")):
            if (
                not cache.suffix
                and cache.is_file()
                and cache.with_suffix(".map").is_file()
            ):
                yield cache


def images(cache: Path) -> Iterator[CacheImage]:
    with cache.with_suffix(".map").open(encoding="utf-8") as mapping:
        for line in mapping:
            image = line.strip()
            if image.startswith("/"):
                yield CacheImage(cache, Path(image))


def matches(query: str) -> Iterator[CacheImage]:
    needle = query.casefold()
    for cache in caches():
        for image in images(cache):
            if needle in str(image.path).casefold():
                yield image


def find_images(query: str) -> list[CacheImage]:
    results = list(matches(query))
    if results or "/" not in query:
        return results
    resolved = Path(query).expanduser().resolve()
    if str(resolved) == query:
        return []
    return [item for item in matches(str(resolved)) if item.path == resolved]


def match_rank(query: str, image: CacheImage) -> MatchRank:
    if str(image.path) == query:
        return MatchRank.EXACT_PATH
    if image.path.name == query:
        return MatchRank.EXACT_NAME
    return MatchRank.SUBSTRING


def select(query: str) -> CacheImage:
    results = find_images(query)
    if results:
        best_rank = min(match_rank(query, image) for image in results)
        results = [image for image in results if match_rank(query, image) == best_rank]
    if len(results) != 1:
        if not results:
            raise ValueError(f"no shared-cache image matches {query!r}")
        examples = "\n".join(
            f"  {image.path} ({image.cache.name})" for image in results[:20]
        )
        raise ValueError(f"ambiguous image {query!r}; use a full path:\n{examples}")
    return results[0]


def extract(image: CacheImage) -> Path:
    state = Path(
        os.getenv("GHIDRA_MCP_STATE") or Unix("ghidra-mcp-headless").user_state_path
    )
    cache_output = (
        state
        / "macos"
        / subprocess.check_output(
            ["/usr/sbin/sysctl", "-n", "kern.osversion"], text=True
        ).strip()
        / image.cache.name
    )
    binary = cache_output / image.path.relative_to("/")
    if binary.is_file():
        return binary
    ipsw = shutil.which("ipsw")
    if not ipsw:
        raise ValueError("ipsw is required: install the Brewfile")
    binary.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=binary.parent) as staging:
        subprocess.run(
            [
                ipsw,
                "dyld",
                "extract",
                str(image.cache),
                str(image.path),
                "--objc",
                "--output",
                staging,
            ],
            check=True,
        )
        staged_binary = Path(staging) / binary.name
        if not staged_binary.is_file():
            raise ValueError(f"ipsw did not create {staged_binary}")
        staged_binary.replace(binary)
    return binary


def load(binary: Path) -> None:
    host = os.environ.get("GHIDRA_MCP_CONNECT_HOST", "127.0.0.1")
    port = os.environ.get("GHIDRA_MCP_PORT", "8089")
    body = json.dumps({"file": str(binary)}).encode()
    request = Request(
        f"http://{host}:{port}/load_program",
        body,
        {"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=1800) as response:
            result: object = json.load(response)
    except HTTPError as error:
        detail = error.read(4096).decode(errors="replace")
        raise ValueError(
            f"Ghidra rejected {binary}: HTTP {error.code}: {detail}"
        ) from error
    except URLError as error:
        raise ValueError(
            f"Ghidra MCP is unavailable: {error}; start cxg first"
        ) from error
    if not isinstance(result, dict) or result.get("success") is not True:
        raise ValueError(f"Ghidra could not load {binary}: {result}")
    print(json.dumps(result, indent=2))


def resolve(query: str) -> Path:
    local = Path(query).expanduser()
    if local.is_dir() and local.suffix == ".framework":
        local /= local.stem
    if local.is_file():
        return local.resolve()
    return extract(select(query))


def find_command(query: str) -> None:
    for image in find_images(query):
        print(f"{image.path}\t{image.cache}")


def extract_command(query: str) -> None:
    print(resolve(query))


def load_command(query: str) -> None:
    load(resolve(query))


COMMANDS: dict[Action, Callable[[str], None]] = {
    Action.FIND: find_command,
    Action.EXTRACT: extract_command,
    Action.LOAD: load_command,
}


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="With cxg running: ghidra-macos load SkyLight",
        suggest_on_error=True,
    )
    parser.add_argument("action", choices=tuple(action.value for action in COMMANDS))
    parser.add_argument("image", help="framework name or full image path")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("macOS shared caches require macOS")
    COMMANDS[Action(args.action)](args.image)


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        sys.exit(f"ghidra-macos: {error}")
