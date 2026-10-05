#!/usr/bin/env python3.14
"""Materialize Spectrum source pins and native package identities."""

import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from typing import NotRequired, TypedDict

ROOT = Path(__file__).resolve().parents[3]


class SourcePin(TypedDict):
    owner: str
    repo: str
    rev: str
    ref: NotRequired[str | None]


class LockNode(TypedDict):
    inputs: dict[str, str]
    locked: SourcePin
    original: dict[str, str]


class FlakeLock(TypedDict):
    root: str
    nodes: dict[str, LockNode]


def input_pin(lock: FlakeLock, name: str) -> SourcePin:
    node_name = lock["nodes"][lock["root"]]["inputs"][name]
    node = lock["nodes"][node_name]
    return node["locked"] | {"ref": node["original"].get("ref")}


def prepare_omp() -> None:
    """Give each native source snapshot a distinct RPM identity."""
    paths = [
        ROOT / ".dockerignore",
        ROOT / "bluebuild/recipes/spectrum.yml",
        ROOT / "bluebuild/recipes/spectrum/stages/omp.yml",
        ROOT / "packages/omp/source.json",
        ROOT / "packages/omp/broker-environment.patch",
        ROOT / "packages/omp/immutable-update.patch",
        ROOT / "packages/omp/upstream/package.json",
        ROOT / "packages/omp/upstream/bun.lock",
        ROOT / "packages/omp-helper/package.json",
        ROOT / "packages/omp-helper/bun.lock",
        ROOT / "packages/omp-helper/manifest.json",
        ROOT / "packages/omp-helper/desktop/Cargo.toml",
        ROOT / "packages/omp-helper/desktop/Cargo.lock",
    ]
    paths.extend((ROOT / "packages/omp-helper").glob("*.in"))
    for directory in [
        "packages/omp/patches",
        "packages/omp/npm-patches",
        "packages/omp-helper/packaging",
        "packages/omp-helper/gateway",
        "packages/omp-helper/gnome",
        "packages/omp-helper/desktop/src",
        "dotfiles/dot_omp/agent/lib/helper",
        "dotfiles/dot_omp/agent/lib/desktop",
    ]:
        paths.extend(
            path
            for path in (ROOT / directory).rglob("*")
            if path.is_file()
            and not any(
                part in {".DS_Store", "__pycache__", "node_modules", "target"}
                for part in path.relative_to(ROOT).parts
            )
        )
    digest = hashlib.sha256()
    for path in sorted(paths):
        content = path.read_bytes()
        digest.update(str(path.relative_to(ROOT)).encode() + b"\0")
        digest.update(str(len(content)).encode() + b"\0" + content)
    source = json.loads(
        (ROOT / "packages/omp-helper/packaging/source.json").read_text(encoding="utf-8")
    )
    metadata = {
        "sourceDateEpoch": source["sourceDateEpoch"],
        "sourceSha256": digest.hexdigest(),
        "release": str(int(digest.hexdigest(), 16) or 1),
    }
    (ROOT / "bluebuild/recipes/spectrum/sources/omp.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def main() -> None:
    nix = shutil.which("nix")
    if nix is None:
        raise FileNotFoundError("nix is required to prepare Spectrum sources")
    lock = json.loads((ROOT / "flake.lock").read_text(encoding="utf-8"))
    stack_sources = json.loads(
        subprocess.check_output(
            [nix, "eval", ".#patchStackSources", "--json", "--no-write-lock-file"],
            cwd=ROOT,
            text=True,
        )
    )
    directory = ROOT / "bluebuild/recipes/spectrum/sources"
    directory.mkdir(exist_ok=True)
    prepare_omp()
    groups = {
        "ghostty": ["ghostty", "ghostty-zig-x86-64-linux"],
        "kanata": ["kanata-homebrew"],
    }
    for group, names in groups.items():
        pins = {}
        for name in names:
            stack_name = "kanata" if name == "kanata-homebrew" else name
            if stack_name in stack_sources:
                source = stack_sources[stack_name]
                pins[name] = {
                    "owner": source["canonical"].split("/")[-2],
                    "repo": source["canonical"].split("/")[-1].removesuffix(".git"),
                    "rev": source["revision"],
                    "type": "github",
                }
            else:
                pins[name] = input_pin(lock, f"source-{name}")
        (directory / f"{group}.json").write_text(
            json.dumps({"pins": pins}, indent=2, sort_keys=True) + "\n"
        )
    patches = input_pin(lock, "patches")
    (directory / "patches.json").write_text(
        json.dumps(
            {
                "repository": f"https://github.com/{patches['owner']}/{patches['repo']}.git",
                "revision": patches["rev"],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
