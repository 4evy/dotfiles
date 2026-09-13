"""Materialize Spectrum build inputs from the current flake lock."""

import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def input_pin(lock: dict, name: str) -> dict:
    node_name = lock["nodes"][lock["root"]]["inputs"][name]
    node = lock["nodes"][node_name]
    return node["locked"] | {"ref": node["original"].get("ref")}


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
    groups = {
        "astral": ["python-astral"],
        "bluebuild": ["bluebuild-cli"],
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
    recipe = ROOT / "bluebuild/recipes/spectrum.yml"
    shutil.copyfile(recipe, recipe.parent / ".spectrum.generated.yml")


if __name__ == "__main__":
    main()
